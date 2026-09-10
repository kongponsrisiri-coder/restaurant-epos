// SEPOS-RESET-001 — reset a till so it can be handed to a different client.
// Reached via a hidden long-press gesture on the login screen (no visible
// button, so it can't be triggered by accident). What "reset" means depends
// on how the till is running:
//   • Native app (Android/Sunmi) — clear the saved tenant URL + login, reload
//     → the app drops back to the first-launch Setup screen.
//   • Desktop (Electron)         — delete config.json + the local DB and
//     relaunch → the first-run setup wizard.
//   • Web                        — the backend is fixed by the URL it's served
//     from, so we can only log out (a browser can't be repointed to another
//     client). Reload back to the login screen.
//
// Nothing is lost either way: a till is a cloud client, so all real data lives
// on the client's cloud, not on the device.

import { isNativePlatform, clearRole } from '../native/tenant';

function isElectron() {
  return typeof window !== 'undefined' && window.siamepos && window.siamepos.isElectron;
}

// A human-readable label for the backend this till is currently pointed at,
// shown in the confirm dialog so the operator knows what they're disconnecting.
export function currentTillTarget() {
  try {
    if (isNativePlatform()) return localStorage.getItem('siamepos_tenant_url') || '(not set up)';
    if (isElectron()) return 'this desktop install';
    return window.location.origin;
  } catch { return ''; }
}

// True where a device can actually be re-pointed at a different client.
// (Web can't — it's fixed to the origin it's served from.)
export function canSwitchClient() {
  return isNativePlatform() || isElectron();
}

function clearSession() {
  try {
    localStorage.removeItem('siamepos_token');
    localStorage.removeItem('siamepos_auth');
  } catch {}
}

export async function resetDevice() {
  clearSession();

  if (isNativePlatform()) {
    // SEPOS-RESET-002 (Korakot, 9 Sep, on the Xiaomi Pad) — must be clearRole(),
    // NOT clearTenant(). clearTenant() removes only siamepos_tenant_url, but
    // isSetUp() is true if ANY of: setup-done flag, host-mode flag, tenant URL.
    // So a reset wiped the address and left the setup-done flag behind: the app
    // still believed it was configured, skipped the Setup screen, and dropped
    // staff on a login screen pointing at nothing — "Staff list unavailable",
    // no scanner, no address box, and no way back without clearing app data.
    // clearRole() removes all three, which is what a reset has to mean.
    clearRole();                   // setup-done + host-mode + tenant URL → needsTenantSetup() = true
    window.location.reload();      // reboot into the Setup screen
    return;
  }

  if (isElectron() && window.siamepos.resetConfig) {
    // Deletes config.json + siamepos-local.db* in userData, then relaunches
    // into the first-run wizard. The process quits, so nothing runs after.
    await window.siamepos.resetConfig();
    return;
  }

  // Web (or an older Electron shell without resetConfig): just log out.
  window.location.reload();
}
