// SEPOS-ANDROID-001 — per-device tenant config for the native Android app.
//
// One APK serves every restaurant/spa, so the backend can't be baked in — each
// device is pointed at its own tenant's cloud URL on first launch and that's
// remembered. On web/desktop these are no-ops (the URL comes from the origin /
// electron / VITE_API_URL as before).

import { Capacitor } from '@capacitor/core';

const KEY = 'siamepos_tenant_url';
// SEPOS host spike — the ONE-TIME setup-screen choice. A host till has NO tenant
// URL (it runs its own embedded server), so we can't recognise "already set up"
// from the tenant URL alone. ROLE_KEY records that setup ran at all; HOST_MODE_KEY
// (see api.js) records the host role. Kept as string literals here to avoid a
// circular import with api.js.
const ROLE_KEY = 'siamepos_setup_done';
const HOST_MODE_KEY = 'siamepos_host_mode';

export function isNativePlatform() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

export function getTenantUrl() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setTenantUrl(url) {
  try { localStorage.setItem(KEY, String(url).trim().replace(/\/+$/, '')); } catch {}
}

export function clearTenant() {
  try { localStorage.removeItem(KEY); } catch {}
}

/** Mark that the one-time setup screen has been completed (any role). */
export function markSetupDone() {
  try { localStorage.setItem(ROLE_KEY, '1'); } catch {}
}

/**
 * True once this device has a role (host, satellite, or cloud). A host till has
 * NO tenant URL, so we can't rely on the tenant URL alone — we also honour the
 * explicit setup-done flag and the host-mode flag.
 */
export function isSetUp() {
  try {
    return localStorage.getItem(ROLE_KEY) === '1'
      || localStorage.getItem(HOST_MODE_KEY) === '1'
      || !!getTenantUrl();
  } catch { return !!getTenantUrl(); }
}

/**
 * Wipe this device's role (host flag + tenant URL + setup-done flag) so the next
 * launch returns to SetupScreen. The DELIBERATE "Re-set up this device" path —
 * never a casual runtime toggle. Local SQLite data is left untouched here; the
 * caller decides whether to wipe it.
 */
export function clearRole() {
  try { localStorage.removeItem(ROLE_KEY); } catch {}
  try { localStorage.removeItem(KEY); } catch {}
  try { localStorage.removeItem(HOST_MODE_KEY); } catch {}
}

/**
 * First launch on the native app with no role chosen yet → show the setup screen.
 * A host till has no tenant URL but IS set up, so check isSetUp().
 */
export function needsTenantSetup() {
  return isNativePlatform() && !isSetUp();
}
