// SiamEPOS Phase 1 host — embedded Node launcher for the REAL backend.
//
// Runs inside the Android app via libnode (nodejs-mobile). This file is the
// nodejs-project entry; it sets local-DB-mode env and then requires the real
// SiamEPOS backend (backend-src/server.js) so the Sunmi till serves the actual
// POS API over the LAN from on-disk SQLite — exactly like the Mac/Electron
// desktop app does (DB_MODE=local + SQLITE_PATH + PORT).
//
// Design goals (carried over from the host spike — keep these):
//   * Writes a breadcrumb log to <writableDir>/node-host-log.txt at EVERY step,
//     flushed synchronously, so we can read EXACTLY where it died without adb.
//     The native debug card surfaces this file via getHostStatus().
//   * NEVER calls process.exit on error. uncaughtException / unhandledRejection
//     are logged and swallowed so the event loop stays alive and the breadcrumb
//     log stays readable on the card.
//   * A keepAlive timer holds the event loop even if the server fails to bind,
//     so the log can always be retrieved.
//
// What server.js itself provides once it boots:
//   * httpServer.listen(PORT, '0.0.0.0', ...) — logs "✅ EPOS server is running
//     on port 3001". Reachable on the LAN at http://<sunmi-ip>:3001/.
//   * The real POS API: /api/settings, /api/menu, /api/tables, /api/staff, etc.
//   * Cloud services (sync/license/heartbeat/cloudRelay/makeWebhooks) all no-op
//     when their env is unset — and we DELIBERATELY leave CLOUD_API_URL /
//     SYNC_SECRET / RESTAURANT_ID unset here, so this boots fully offline.
//
// NOTE: server.js owns the Express app, so /api/log is NOT served by it. The
// breadcrumb file (node-host-log.txt) is the primary on-device diagnostic and
// is read by the native debug card (getHostStatus). server.js does define
// /api/ping, so a LAN ping still works once it is up.

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1) Breadcrumb log — figure out a writable dir robustly, truncate, then tee.
// ---------------------------------------------------------------------------
//
// The plugin extracts this project into filesDir/nodejs-project and runs node
// with cwd == that dir. It also passes the app files dir via NODE_HOST_DATA_DIR
// env (set Java-side). We try, in order:
//   env NODE_HOST_DATA_DIR -> process.cwd() -> __dirname -> os.tmpdir()
// and pick the first one we can actually write to.
function pickWritableDir() {
  const candidates = [];
  try { if (process.env.NODE_HOST_DATA_DIR) candidates.push(process.env.NODE_HOST_DATA_DIR); } catch (_) {}
  try { candidates.push(process.cwd()); } catch (_) {}
  try { candidates.push(__dirname); } catch (_) {}
  try { candidates.push(require('os').tmpdir()); } catch (_) {}
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const probe = path.join(dir, '.node-host-write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch (_) { /* try next */ }
  }
  // Last resort: __dirname even if the probe failed (appendFileSync may still work).
  return __dirname;
}

const WRITABLE_DIR = pickWritableDir();
const LOG_PATH = path.join(WRITABLE_DIR, 'node-host-log.txt');

// Truncate the log at the start of each run.
try { fs.writeFileSync(LOG_PATH, ''); } catch (_) {}

function ts() {
  try { return new Date().toISOString(); } catch (_) { return String(Date.now()); }
}

function log(msg) {
  const line = '[' + ts() + '] ' + msg + '\n';
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
  // Also emit to the original stdout so logcat still shows it (the console
  // tee below routes through here, so call the raw write to avoid recursion).
  try { origConsoleLog('[nodehost] ' + msg); } catch (_) {}
}

// Tee console.log / console.error into the log file. The real backend logs a
// LOT through console.* (schema migrations, "✅ EPOS server is running", the
// offline no-op breadcrumbs) — capturing them is exactly how we confirm the
// boot reached the listen() callback from the on-device card.
const origConsoleLog = console.log.bind(console);
const origConsoleErr = console.error.bind(console);
console.log = function () {
  const s = Array.prototype.map.call(arguments, stringify).join(' ');
  try { fs.appendFileSync(LOG_PATH, '[' + ts() + '] (log) ' + s + '\n'); } catch (_) {}
  try { origConsoleLog.apply(null, arguments); } catch (_) {}
};
console.error = function () {
  const s = Array.prototype.map.call(arguments, stringify).join(' ');
  try { fs.appendFileSync(LOG_PATH, '[' + ts() + '] (err) ' + s + '\n'); } catch (_) {}
  try { origConsoleErr.apply(null, arguments); } catch (_) {}
};
function stringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

// ---------------------------------------------------------------------------
// 2) Global safety nets — log everything, NEVER exit.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (e) => {
  log('UNCAUGHT EXCEPTION: ' + (e && e.stack ? e.stack : String(e)));
  // Deliberately DO NOT exit — keep the event loop alive so the log stays up.
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + (reason && reason.stack ? reason.stack : String(reason)));
});
process.on('exit', (code) => {
  log('process exit, code=' + code);
});

log('boot start (Phase 1 backend launcher)');
log('writable dir = ' + WRITABLE_DIR);
log('log path = ' + LOG_PATH);
log('node version ' + process.version);
log('cwd = ' + (function () { try { return process.cwd(); } catch (e) { return '(err)'; } })());
log('__dirname = ' + __dirname);

// Keepalive: a never-firing timer guarantees the event loop never empties, so
// even if the backend fails to bind, the process stays alive and the log file
// written above can still be read via the native card.
const keepAlive = setInterval(function () {}, 1 << 30);
void keepAlive;

// ---------------------------------------------------------------------------
// 3) Pre-flight: confirm the native better-sqlite3 addon loads BEFORE we hand
//    off to server.js. server.js requires it via dbAdapter -> localDatabase,
//    and a native dlopen failure there would otherwise be buried in the
//    backend's own stack. Doing it here puts a clear breadcrumb on the card.
//    Isolated + try/caught: a failure is logged but we still attempt the boot
//    so the backend's own (richer) error also lands in the log.
// ---------------------------------------------------------------------------
try {
  log('pre-flight: requiring better-sqlite3 (native arm64 addon)');
  const Database = require('better-sqlite3');
  log('pre-flight: better-sqlite3 module loaded');
  const probePath = path.join(WRITABLE_DIR, 'preflight-probe.db');
  const db = new Database(probePath);
  db.pragma('journal_mode = WAL');
  const v = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  log('pre-flight: better-sqlite3 OK (disk-backed, sqlite ' + v + ')');
} catch (e) {
  log('pre-flight: BETTER-SQLITE3 FAILED: ' + (e && e.stack ? e.stack : String(e)));
  // swallow — let server.js try too so its error is captured as well.
}

// ---------------------------------------------------------------------------
// 4) Local-mode env — mirror what electron/main.js sets when it spawns the
//    backend. DB_MODE=local + SQLITE_PATH route src/db/dbAdapter to SQLite;
//    PORT is what server.js listens on. We do NOT set CLOUD_API_URL,
//    SYNC_SECRET or RESTAURANT_ID — leaving them unset keeps every cloud
//    service a no-op so the till boots and serves the API fully offline.
//    (Cloud sync / seeding is the NEXT Phase 1 step.)
// ---------------------------------------------------------------------------
process.env.DB_MODE = 'local';
process.env.SQLITE_PATH = path.join(WRITABLE_DIR, 'siamepos-local.db');
process.env.PORT = process.env.PORT || '3001';
log('env set: DB_MODE=local PORT=' + process.env.PORT);
log('env set: SQLITE_PATH=' + process.env.SQLITE_PATH);

// ---------------------------------------------------------------------------
// 4b) Cloud→local SYNC — OPT-IN ONLY (v1.13-standalone).
//
//     STANDALONE IS THE DEFAULT. A fresh host till runs PURE LOCAL: no
//     CLOUD_API_URL, no sync engine, no secret needed. The operator builds the
//     menu / staff on the device via Admin. Nothing reaches out to any cloud.
//
//     Cloud sync is an EXPLICIT opt-in: it activates ONLY when host-config.json
//     has cloud_sync_enabled truthy AND a non-empty cloud_api_url. The engine
//     (backend-src/services/syncService.js) auto-starts inside server.js when
//     DB_MODE=local + CLOUD_API_URL is set; with the flag off we leave
//     CLOUD_API_URL unset so the engine stays dormant and the till is offline.
//
//     SAFETY — PULL-ONLY: when sync IS opted in, SYNC_PULL_ONLY=1 means the
//     engine NEVER pushes a local mutation to the cloud (syncOnce is
//     short-circuited; forwardWriteToCloud + heartbeat are gated by the same
//     flag). Only cloud→local pull runs.
//
//     Config source: on-device host-config.json written by the NodeHost plugin
//     (Settings card on the Sunmi). It lives in filesDir, i.e. the PARENT of the
//     project dir we run in (NODE_HOST_DATA_DIR = filesDir/nodejs-project, which
//     is wiped on every start — config must outlive that). Secrets are NEVER
//     hardcoded: sync_secret only comes from the on-device file (and is optional
//     — menu/staff/settings pull without it; only ORDER sync needs it).
// ---------------------------------------------------------------------------
function loadHostConfig() {
  const candidates = [];
  try {
    if (process.env.NODE_HOST_DATA_DIR) {
      candidates.push(path.join(path.dirname(process.env.NODE_HOST_DATA_DIR), 'host-config.json'));
    }
  } catch (_) {}
  // Fallbacks in case the layout differs on a given device.
  try { candidates.push(path.join(WRITABLE_DIR, 'host-config.json')); } catch (_) {}
  try { candidates.push(path.join(path.dirname(WRITABLE_DIR), 'host-config.json')); } catch (_) {}
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        log('sync: loaded host-config.json from ' + p);
        return cfg || {};
      }
    } catch (e) {
      log('sync: host-config.json parse failed at ' + p + ': ' + e.message);
    }
  }
  log('sync: no host-config.json found — standalone (local-only) default');
  return {};
}

// Truthy test for the on-device flag (stored as "1"/"0"/"true"/"false" string,
// or a real boolean if a future config writer uses one).
function flagOn(v) { return v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }

try {
  const cfg = loadHostConfig();
  const cloudUrl = (cfg.cloud_api_url && String(cfg.cloud_api_url).trim()) || '';
  const cloudSyncOn = flagOn(cfg.cloud_sync_enabled) && !!cloudUrl;

  // One-tap host setup: the restaurant name entered on SetupScreen is persisted
  // in host-config.json. Pass it through to server.js as HOST_RESTAURANT_NAME so
  // it can seed the local `company_name`/`restaurant_name` settings on boot —
  // this is how the standalone host shows its name in the POS with no staff
  // logged in. Idempotent + only-if-empty on the server side, so it never
  // clobbers an operator edit or a cloud-synced value.
  const restName = (cfg.restaurant_name && String(cfg.restaurant_name).trim()) || '';
  if (restName) {
    process.env.HOST_RESTAURANT_NAME = restName;
    log('host: restaurant_name from config = ' + restName);
  }

  if (cloudSyncOn) {
    process.env.CLOUD_API_URL = cloudUrl;
    // RESTAURANT_ID is unused by the menu/staff/settings pull (single-tenant
    // cloud), but heartbeat/license read it; set a sane default so logs are clear.
    process.env.RESTAURANT_ID = (cfg.restaurant_id && String(cfg.restaurant_id).trim()) || 'host';
    // sync_secret — ONLY from the on-device file, never a default. Without it the
    // menu/staff/settings/tables pull still works; closed/active ORDER pull stays
    // off (HTTP 401), which is fine.
    if (cfg.sync_secret && String(cfg.sync_secret).trim()) {
      process.env.SYNC_SECRET = String(cfg.sync_secret).trim();
      log('sync: SYNC_SECRET present (order sync enabled)');
    } else {
      log('sync: no SYNC_SECRET (menu/staff/settings pull only — orders skipped)');
    }
    // PULL-ONLY latch — protect the live cloud (see syncService.js).
    process.env.SYNC_PULL_ONLY = '1';
    log('sync: OPTED IN — CLOUD_API_URL=' + process.env.CLOUD_API_URL + ' RESTAURANT_ID=' + process.env.RESTAURANT_ID + ' PULL_ONLY=1');
  } else {
    // STANDALONE DEFAULT — leave CLOUD_API_URL unset so the sync engine never
    // starts. Pure local SQLite; operator manages menu/staff on the device.
    delete process.env.CLOUD_API_URL;
    delete process.env.SYNC_SECRET;
    log('sync: STANDALONE (local-only) — cloud sync not enabled; no CLOUD_API_URL set');
  }
} catch (e) {
  log('sync: config wiring failed (continuing standalone/offline): ' + (e && e.message ? e.message : String(e)));
}

// ---------------------------------------------------------------------------
// 5) Hand off to the REAL backend. server.js runs schema migrations on first
//    require (localDatabase auto-init), then httpServer.listen(PORT,'0.0.0.0').
//    Wrapped in try/catch so any boot failure is logged on the card instead of
//    silently killing the app.
// ---------------------------------------------------------------------------
try {
  log('requiring backend src/server.js …');
  require('./backend-src/server.js');
  log('backend src/server.js require returned (server is starting; watch for "EPOS server is running")');
} catch (e) {
  log('BACKEND REQUIRE/BOOT FAILED: ' + (e && e.stack ? e.stack : String(e)));
  // swallow — keepAlive holds the process so the log remains readable.
}

log('boot end (backend launched; keepAlive holding event loop)');
