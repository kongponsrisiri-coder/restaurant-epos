// SEPOS-ANDROID-001 / -004 — auto-print incoming online (takeaway + delivery) orders.
//
// On the native Android app, the designated device listens for new online orders
// and prints the kitchen ticket itself (the cloud can't reach a LAN — or built-in
// — printer). Headless (renders nothing). No-op unless: running natively AND this
// device is flagged as the online-order printer AND a printer is available.
// Deduped so an order prints once (even across reconnects / multiple devices).
//
// SEPOS-ANDROID-004: builds the ticket ON-DEVICE (like the kitchen ticket) so it
// prints on the Sunmi's BUILT-IN printer too — not only a network printer — and
// includes the customer / pickup / DELIVERY-address header a takeaway needs.

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL, getSettings, getOrder } from '../api';
import { isNativeApp, sendRawToPrinter } from './printer';
import { sunmiAvailable, sunmiPrintOps, printTarget } from './sunmiPrinter';
import { buildKitchenOps, opsForSunmi, renderOpsToBytes } from './escpos';

const FLAG    = 'print_online_orders';     // '1' on the one device that should print
const PRINTED = 'printed_online_orders';   // recent ids, for dedup

export default function OnlineOrderPrinter() {
  const settingsRef = useRef(null);

  useEffect(() => {
    if (!isNativeApp()) return;            // web/desktop print online orders the existing way
    getSettings().then((s) => { settingsRef.current = s; }).catch(() => {});

    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socket.on('new_takeaway_order', async (payload) => {
      try {
        if (localStorage.getItem(FLAG) !== '1') return;     // not the designated printer device
        const id = payload && payload.id;
        if (!id) return;
        let printed = [];
        try { printed = JSON.parse(localStorage.getItem(PRINTED) || '[]'); } catch {}
        if (printed.includes(id)) return;                   // already printed

        const s = settingsRef.current || (settingsRef.current = await getSettings());
        const target = printTarget(s, 'kitchen');           // off | builtin | network | auto
        if (target === 'off') return;

        // Fetch the full order (items + takeaway/delivery meta) and build the
        // kitchen ticket on-device, so it can go to the built-in printer.
        const order = await getOrder(id);
        if (!order || order.error) return;
        // Match the desktop's item mapping: fold modifiers into the notes line so
        // options print on the built-in ticket too.
        const items = (order.items || order.order_items || []).map((it) => ({
          ...it,
          notes: it.notes || (Array.isArray(it.modifiers) ? it.modifiers.map((m) => m.name).join(', ') : ''),
        }));
        const ops = buildKitchenOps({
          order, items, kind: 'kitchen',
          fontScale: s.kitchen_font_scale || 'large',
        });
        if (!ops) return;

        // Built-in first (Sunmi printText → UTF-8, so £ + Thai render correctly),
        // else a configured network printer. Same chooser the kitchen ticket uses.
        const sunmiOk = (target === 'builtin' || target === 'auto') ? await sunmiAvailable() : false;
        const ip   = s.printer_kitchen_ip || s.printer_receipt_ip;
        const port = s.printer_kitchen_port || s.printer_receipt_port || 9100;
        if (sunmiOk) {
          await sunmiPrintOps(opsForSunmi(ops));
        } else if ((target === 'network' || target === 'auto') && ip) {
          await sendRawToPrinter(ip, port, renderOpsToBytes(ops, { thaiCp: s.kitchen_thai_codepage }));
        } else {
          console.warn('[online-order-print] no printer for target', target);
          return;                                           // don't mark printed — retry on the next order/reconnect
        }

        localStorage.setItem(PRINTED, JSON.stringify([...printed, id].slice(-200)));
      } catch (e) {
        console.warn('[online-order-print]', e && e.message);
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  return null;
}
