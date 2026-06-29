'use strict';

// SEPOS-PRO-009 — desktop till → ops telemetry.
//
// A packaged till sits behind NAT, so ops can't poll it. Instead the till PUSHES
// a small heartbeat to its tenant cloud (CLOUD_API_URL) on launch + every few
// minutes. The cloud upserts it into `devices`; the cloud's /api/health exposes
// the list; the ops health-cron (which already polls /api/health) records it.
//
// Desktop-only: keyed off SQLITE_PATH (set only by the Electron shell). On the
// cloud SQLITE_PATH is unset → this module is inert (the cloud never heartbeats
// itself). The stable device_id is persisted next to the local DB.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SQLITE_PATH   = process.env.SQLITE_PATH;
const CLOUD_API_URL = process.env.CLOUD_API_URL;
const INTERVAL_MS   = parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 min
const FETCH_TIMEOUT_MS = 8000;
// device-id lives beside the local DB so it survives app updates (userData).
const ID_PATH = SQLITE_PATH ? path.join(path.dirname(SQLITE_PATH), 'device-id') : null;

function deviceId() {
  if (!ID_PATH) return null;
  try {
    if (fs.existsSync(ID_PATH)) {
      const id = fs.readFileSync(ID_PATH, 'utf8').trim();
      if (id) return id;
    }
  } catch (_) {}
  const id = crypto.randomUUID();
  try { fs.writeFileSync(ID_PATH, id); } catch (_) {}
  return id;
}

async function beat() {
  if (!ID_PATH || !CLOUD_API_URL) return; // not a desktop till, or no cloud target
  // SEPOS-ANDROID Phase 1 (host spike) — PULL-ONLY latch: don't POST telemetry
  // to the LIVE cloud while we're only proving the menu/staff/settings pull.
  if (/^(1|true|yes)$/i.test(process.env.SYNC_PULL_ONLY || '')) return;
  const id = deviceId();
  if (!id) return;
  try {
    await fetch(CLOUD_API_URL.replace(/\/+$/, '') + '/api/device/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: id,
        restaurant_id: process.env.RESTAURANT_ID || null,
        app_version: process.env.APP_VERSION || null,   // injected by electron/main.js
        platform: process.platform,                     // darwin | win32 | linux
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (_) {
    // Offline / timeout — ignore; the next tick (or ops marking it stale) covers it.
  }
}

let timer = null;
function start() {
  if (!ID_PATH) return; // cloud / non-desktop → inert
  beat(); // on launch
  timer = setInterval(beat, INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
  console.log('[heartbeat] till telemetry → ops every', Math.round(INTERVAL_MS / 1000), 's');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, beat };
