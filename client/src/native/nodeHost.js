// SEPOS host spike (Phase 0) — read the embedded Node.js host server's status.
//
// The Sunmi T2s till runs an embedded Node server (libnode) so it can act as a
// LAN host. When that server crashes or fails to start we still want the app to
// open normally — and we want the operator to be able to read WHY on the till's
// own screen (no USB logcat available). This wrapper is the JS side of that
// debug surface. On web/desktop it is a no-op (isNativeApp() === false).

import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeApp } from './printer';

const NodeHost = registerPlugin('NodeHost');

// SEPOS-IOS-001 follow-up — can THIS build actually run the embedded host?
// The NodeHost native plugin only exists in the Android host APK; the iOS app
// and plain Android till don't carry the engine, so the "set this device up
// as the host till" offer must not show there (tapping it dead-ends with a
// start error — Korakot hit exactly this on the iPad, 13 Aug).
export function hostCapable() {
  try { return isNativeApp() && Capacitor.isPluginAvailable('NodeHost'); }
  catch { return false; }
}

/**
 * Manually starts the embedded Node host (hostspike3 — node no longer auto-starts
 * on launch). Triggers the native preconditions + crash-handler install + node
 * thread, then returns the fresh status. If node SIGABRTs the app dies, but the
 * native crash handler will have written the reason to file — reopen the app and
 * getHostStatus() surfaces it as nativeCrash. Never throws.
 */
export async function startHost() {
  if (!isNativeApp()) {
    return { started: false, error: 'not a native app (web/desktop)' };
  }
  try {
    return await NodeHost.start();
  } catch (e) {
    return { started: false, error: 'NodeHost.start() failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Stops the embedded Node host foreground service (Phase 1 step 4). Removes the
 * ongoing "host running" notification and lets Android reclaim the process; the
 * satellite tills will lose the LAN server. Returns the fresh status. No-op on
 * web/desktop. Never throws.
 */
export async function stopHost() {
  if (!isNativeApp()) {
    return { started: false, error: 'not a native app (web/desktop)' };
  }
  try {
    return await NodeHost.stop();
  } catch (e) {
    return { started: false, error: 'NodeHost.stop() failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Asks Android to exempt SiamEPOS from battery optimisation / Doze so the host
 * foreground service keeps running while the till is idle. Opens the system
 * dialog if not already exempt. Returns { ignoring, requested }. No-op on
 * web/desktop. Never throws.
 */
export async function requestIgnoreBatteryOptimizations() {
  if (!isNativeApp()) {
    return { ignoring: false, requested: false };
  }
  try {
    return await NodeHost.requestIgnoreBatteryOptimizations();
  } catch (e) {
    return { ignoring: false, requested: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Returns the host-server status for the on-device debug card.
 * Shape: { started, port, abi, node, error, sqlite, nativeReady, pinged, nativeCrash, nodeLog }.
 * nativeCrash is the native crash file (signal + backtrace) from the LAST fatal
 * abort, or null. nodeLog is main.js's breadcrumb log (node-host-log.txt) — the
 * step-by-step trail of where the embedded server got to. Never throws.
 */
export async function getHostStatus() {
  if (!isNativeApp()) {
    return { started: false, port: null, abi: null, node: null, error: 'not a native app (web/desktop)', sqlite: false, nativeReady: false, pinged: false, nativeCrash: null, nodeLog: null };
  }

  // 1) Ask the native plugin what it knows (started / abi / startup error).
  let base = { started: false, port: null, abi: null, node: null, error: null, sqlite: false, nativeReady: false };
  try {
    base = { ...base, ...(await NodeHost.status()) };
  } catch (e) {
    base.error = 'NodeHost.status() unavailable: ' + (e && e.message ? e.message : String(e));
  }

  // 2) If Java thinks node started, CONFIRM by hitting a real backend route over
  //    loopback. The host runs the full SiamEPOS server (server.js owns the app)
  //    — there is NO /api/ping route, so we verify against /api/settings, which
  //    the backend always serves. This both proves the server is live and tells
  //    us the real port (3001 normally, 8081 if 3001 was taken). The PRIMARY
  //    running signal is still native `started`; `pinged` is the live-confirm.
  //    (The old code fetched /api/ping which 404s here, so Start never flipped.)
  let pinged = false;
  if (base.started) {
    const ports = [base.port || 3001, base.fallbackPort || 8081].filter((p, i, a) => p && a.indexOf(p) === i);
    for (const p of ports) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        // /api/settings exists on the host backend; /api/menu is the fallback.
        let r = await fetch(`http://127.0.0.1:${p}/api/settings`, { signal: ctrl.signal });
        if (!r.ok) r = await fetch(`http://127.0.0.1:${p}/api/menu`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          base.port = p;
          pinged = true;
          break;
        }
      } catch (_) { /* try next port */ }
    }
    // NOTE: pinged may be false even when running — the Android WebView can
    // sandbox loopback fetches on some OEM builds. We DON'T downgrade `started`
    // on a failed ping; the native service signal stays authoritative so the
    // Start↔Stop button reflects reality regardless of the fetch outcome.
    if (!pinged && !base.error) {
      base.error = 'node thread launched; loopback confirm did not respond (still booting, on another port, or WebView-sandboxed)';
    }
  }

  // 3) Read the native crash file (signal + backtrace from the last fatal abort,
  //    if any). This is the whole point of hostspike3: if tapping Start crashed
  //    the app with a SIGABRT/SIGSEGV, reopening it shows the reason here.
  let nativeCrash = null;
  try {
    const c = await NodeHost.lastCrash();
    nativeCrash = (c && c.crash) ? c.crash : null;
  } catch (_) { /* plugin without lastCrash() — ignore */ }

  // 4) Read the breadcrumb log main.js writes (node-host-log.txt). This is the
  //    self-explain trail: exactly which step the embedded server reached and,
  //    if it threw, the uncaught error. Persists across launches; survives a
  //    clean Node exit that the native crash file can't capture.
  let nodeLog = null;
  try {
    const l = await NodeHost.lastLog();
    nodeLog = (l && l.log) ? l.log : null;
  } catch (_) { /* plugin without lastLog() — ignore */ }

  return { ...base, pinged, nativeCrash, nodeLog };
}

/**
 * Saves the on-device cloud-sync config the operator enters on the Sunmi.
 * { cloud_api_url, restaurant_id, sync_secret } → persisted by the native
 * plugin in app-private storage (never in source). Takes effect on the next
 * host start (main.js reads it at boot). Returns { saved } / { saved:false }.
 * No-op on web/desktop. Never throws.
 */
export async function saveHostConfig({ cloud_sync_enabled, cloud_api_url, restaurant_id, sync_secret, restaurant_name } = {}) {
  if (!isNativeApp()) return { saved: false, error: 'not a native app (web/desktop)' };
  try {
    // restaurant_name is persisted into host-config.json and applied to the
    // local settings (company_name) by main.js on boot, so the standalone host
    // shows the restaurant's name in the POS with no logged-in staff needed.
    // Pass it through even when undefined (plugin keeps the previous value if
    // the key is absent — see NodeHostPlugin.saveConfig).
    const payload = {
      cloud_sync_enabled: !!cloud_sync_enabled,
      cloud_api_url: cloud_api_url || '',
      restaurant_id: restaurant_id || '',
      sync_secret: sync_secret || '',
    };
    if (restaurant_name != null) payload.restaurant_name = String(restaurant_name);
    return await NodeHost.saveConfig(payload);
  } catch (e) {
    return { saved: false, error: 'NodeHost.saveConfig() failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Reads the saved cloud-sync config to pre-fill the Settings form. The secret
 * is never returned in cleartext — only has_sync_secret. Shape:
 * { cloud_api_url, restaurant_id, has_sync_secret }. No-op on web/desktop.
 */
export async function getHostConfig() {
  if (!isNativeApp()) return { cloud_sync_enabled: false, cloud_api_url: '', restaurant_id: '', has_sync_secret: false };
  try {
    return await NodeHost.getConfig();
  } catch (e) {
    return { cloud_sync_enabled: false, cloud_api_url: '', restaurant_id: '', has_sync_secret: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Forces an immediate cloud→local pull on the running host and reports how many
 * menu items landed locally afterwards. Hits the host's own loopback API
 * (POST /api/sync/pull then GET /api/menu). Used by the "Sync now" button on the
 * host card. Shape: { ok, menuCount, error }. No-op on web/desktop.
 */
export async function syncNow(port = 3001) {
  if (!isNativeApp()) return { ok: false, error: 'not a native app (web/desktop)' };
  const base = `http://127.0.0.1:${port}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000); // full pull can take a few s
    const r = await fetch(`${base}/api/sync/pull`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `sync/pull HTTP ${r.status}` };
    // Count the menu after the pull so the card shows real progress.
    let menuCount = null;
    try {
      const m = await fetch(`${base}/api/menu`);
      if (m.ok) {
        const menu = await m.json();
        menuCount = Array.isArray(menu) ? menu.length : null;
      }
    } catch (_) {}
    return { ok: true, menuCount };
  } catch (e) {
    return { ok: false, error: 'syncNow() failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Tells the running host to re-read its saved cloud-sync config (host-config.json)
 * and apply the new cloud URL / sync_secret LIVE — no app restart/reinstall. The
 * host's embedded Node can't restart in-process, so before this the secret only
 * took effect on a full reinstall; now Save applies in seconds. Also fires one
 * immediate sync tick so staff / active orders / bills populate right away.
 * Hits the host's own loopback API (POST /api/host/reload-config), which is
 * gated to localhost on the server. Returns { ok, changed, secret_present } /
 * { ok:false, error }. No-op on web/desktop. Never throws.
 */
export async function reloadHostConfig(port = 3001) {
  if (!isNativeApp()) return { ok: false, error: 'not a native app (web/desktop)' };
  const base = `http://127.0.0.1:${port}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000); // tick can take a few s (full pull)
    const r = await fetch(`${base}/api/host/reload-config`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `reload-config HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    return { ok: true, changed: !!j.changed, secret_present: !!j.secret_present };
  } catch (e) {
    return { ok: false, error: 'reloadHostConfig() failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Returns this device's LAN IPv4 + host port so the "Add a till" card can build
 * the satellite join URL (http://<ip>:3001). A satellite phone/tablet scans that
 * QR in SetupScreen and points its tenant URL at this host. Shape:
 * { ip: "192.168.x.y" | null, port: 3001 }. No-op on web/desktop. Never throws.
 */
export async function getLanIp() {
  if (!isNativeApp()) return { ip: null, port: 3001 };
  try {
    const r = await NodeHost.getLanIp();
    return { ip: (r && r.ip) || null, port: (r && r.port) || 3001 };
  } catch (e) {
    return { ip: null, port: 3001, error: String(e && e.message ? e.message : e) };
  }
}

export { Capacitor };
