// SEPOS-ANDROID-AUTOUPDATE-001 — check the releases channel for a newer satellite
// APK and offer a one-tap update. Android sideloaded apps cannot self-install
// silently, so we check here and the native AppUpdate plugin downloads the APK +
// launches the system installer for the user to confirm.
//
// No-op everywhere except the native ANDROID app:
//   • iOS satellite  → TestFlight auto-updates
//   • web / iPad PWA → service worker
//   • desktop        → electron-updater
import { APP_VERSION } from '../version';
import { isNativeApp } from './printer';

const RELEASES = 'https://api.github.com/repos/kongponsrisiri-coder/siamepos-releases/releases?per_page=30';
const APK_TAG_RE = /^tablet-v(\d+\.\d+\.\d+)/i;

function isAndroidApp() {
  try { return isNativeApp() && /android/i.test(navigator.userAgent || ''); }
  catch { return false; }
}

// Numeric semver compare: "1.5.52" vs "1.5.9" → 1.5.52 is newer.
function cmp(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Fetch via the native HTTP bridge so it bypasses WebView CORS and works from an
// http origin (a satellite pointed at a LAN host loads over http).
async function ghGet(url) {
  try {
    const { CapacitorHttp } = await import('@capacitor/core');
    if (CapacitorHttp && CapacitorHttp.get) {
      const r = await CapacitorHttp.get({ url, headers: { Accept: 'application/vnd.github+json' } });
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }
  } catch { /* fall through to fetch */ }
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  return r.json();
}

// Returns { version, url } for the newest tablet-v* release above APP_VERSION,
// or null (no update, not Android, or the check failed — always fails quiet).
export async function checkForUpdate() {
  if (!isAndroidApp()) return null;
  let releases;
  try { releases = await ghGet(RELEASES); } catch { return null; }
  if (!Array.isArray(releases)) return null;
  let best = null;
  for (const rel of releases) {
    const m = APK_TAG_RE.exec((rel && rel.tag_name) || '');
    if (!m) continue;
    const ver = m[1];
    if (cmp(ver, APP_VERSION) <= 0) continue;              // not newer than us
    const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name || ''));
    if (!apk || !apk.browser_download_url) continue;
    if (!best || cmp(ver, best.version) > 0) best = { version: ver, url: apk.browser_download_url };
  }
  return best;
}

// Download + hand the APK to the Android installer. Resolves { started:true }
// once the system installer is launched (the user still taps "Update").
export async function startUpdate(url) {
  const { registerPlugin } = await import('@capacitor/core');
  const AppUpdate = registerPlugin('AppUpdate');
  return AppUpdate.install({ url });
}
