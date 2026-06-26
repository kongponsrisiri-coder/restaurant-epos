// SEPOS-ANDROID-001 — native network printing bridge (Android app only).
//
// On the Sunmi / any Android tablet, the app pushes ESC/POS bytes straight to a
// LAN printer's TCP port — no desktop server needed on the network. The bytes
// come from the server's existing builders (printService.js), so formatting is
// byte-identical to the desktop/web path. On web/desktop this is a no-op
// (isNativeApp() === false) and the existing print paths are used.

import { Capacitor, registerPlugin } from '@capacitor/core';

const Printer = registerPlugin('Printer');

export function isNativeApp() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/**
 * Send raw ESC/POS bytes (base64) to a network printer.
 * @returns {Promise<{ok:boolean, bytes:number}>}
 */
export async function sendRawToPrinter(host, port, dataBase64) {
  if (!host) throw new Error('printer host (IP) is required');
  return Printer.sendRaw({ host, port: Number(port) || 9100, data: dataBase64 });
}
