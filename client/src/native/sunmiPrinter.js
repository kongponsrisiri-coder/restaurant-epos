// SEPOS-ANDROID-002 — Sunmi built-in (inner) printer bridge.
//
// Wraps the native SunmiPrinter plugin (AIDL InnerPrinterService). isAvailable()
// is true only on a Sunmi device whose printer service binds; everywhere else
// the kitchen/bill print falls back to a network printer. Bytes are raw ESC/POS
// built on-device (escpos.js), so printing works with no internet.
import { Capacitor, registerPlugin } from '@capacitor/core';

const Sunmi = registerPlugin('SunmiPrinter');

let _avail = null;
export async function sunmiAvailable() {
  try { if (!Capacitor.isNativePlatform()) return false; } catch { return false; }
  if (_avail !== null) return _avail;
  try { const r = await Sunmi.isAvailable(); _avail = !!(r && r.available); }
  catch { _avail = false; }
  return _avail;
}

export async function sunmiPrintRaw(dataBase64) {
  return Sunmi.sendRaw({ data: dataBase64 });
}

// Print via the Sunmi native text API (UTF-8 → £ + Thai render correctly).
// ops come from escpos.opsForSunmi(...).
export async function sunmiPrintOps(ops) {
  return Sunmi.printOps({ ops });
}

// Per-route destination chosen in Admin → Printers. route: 'receipt'|'kitchen'|'bar'.
// Returns 'off' | 'builtin' | 'network' | 'auto' (unset = auto: built-in first,
// then a network printer — preserves the previous behaviour).
export function printTarget(settings, route) {
  const t = settings && settings[`print_target_${route}`];
  return (t === 'off' || t === 'builtin' || t === 'network') ? t : 'auto';
}
