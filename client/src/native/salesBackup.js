// SEPOS-ANDROID-003 — "Keep all sales on this device".
//
// The on-device read cache (native/localdb.js) only ever holds GET responses
// the operator actually opened. This module proactively warms the cache with a
// COMPLETE, offline-viewable copy of sales + reports so the Sunmi till always
// has them — both as a local backup and so Bills / Reports work with no internet.
//
// Native-only + additive: on web POS / Electron desktop this is never started,
// and every fetch is best-effort (a failure is swallowed, never thrown). The
// fetches go through api.js `get()` which does cachePut on success, so once
// warmed the existing offline cacheGet fallback serves them.
import { getBills, getSummaryReport, getZReportHistory, getDailyReport } from '../api';

const LAST_BACKUP_KEY = 'siamepos_sales_backup_at';
// Rolling window the till keeps offline. 365 days of bills is the heaviest
// payload here; the daily report + summary + Z history are small by comparison.
const WINDOW_DAYS = 365;

function isNative() {
  try {
    return !!(typeof window !== 'undefined' && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch { return false; }
}

// YYYY-MM-DD in local time (matches how the Bills / Reports screens build dates).
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getLastBackupAt() {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY);
    return v ? Number(v) : 0;
  } catch { return 0; }
}

let _running = false;

// Warm the cache with the whole sales window. Best-effort throughout: each call
// is wrapped so one failing endpoint doesn't abort the rest. Returns the count
// of successful fetches; records a "last backup" timestamp if anything succeeded.
export async function backupSalesToDevice() {
  if (!isNative()) return { ok: false };
  if (_running) return { ok: false };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false };
  _running = true;
  let ok = 0;
  try {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - (WINDOW_DAYS - 1));
    const fromStr = ymd(from);
    const toStr = ymd(today);

    // Each through api.js get() → cachePut. `method='all'` so every payment
    // method's bills are cached under the exact URL the Bills screen requests.
    const tasks = [
      () => getBills(fromStr, toStr, 'all'),
      () => getSummaryReport(fromStr, toStr),
      () => getZReportHistory(),
      () => getDailyReport(),
    ];
    for (const task of tasks) {
      try {
        const res = await task();
        if (res && !res.error) ok++;
      } catch { /* best-effort — keep going */ }
    }

    if (ok > 0) {
      try { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch {}
    }
  } finally {
    _running = false;
  }
  return { ok };
}
