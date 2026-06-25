// SEPOS-ANDROID-001 — per-device tenant config for the native Android app.
//
// One APK serves every restaurant/spa, so the backend can't be baked in — each
// device is pointed at its own tenant's cloud URL on first launch and that's
// remembered. On web/desktop these are no-ops (the URL comes from the origin /
// electron / VITE_API_URL as before).

import { Capacitor } from '@capacitor/core';

const KEY = 'siamepos_tenant_url';

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

/** First launch on the app with no tenant chosen yet → show the setup screen. */
export function needsTenantSetup() {
  return isNativePlatform() && !getTenantUrl();
}
