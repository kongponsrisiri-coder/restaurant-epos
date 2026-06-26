// SEPOS-ANDROID-001 — auto-print incoming online (takeaway) orders.
//
// On the native Android app, the designated device listens for new online orders
// and prints the kitchen ticket itself (the cloud can't reach a LAN printer).
// Headless (renders nothing). No-op unless: running natively AND this device is
// flagged as the online-order printer AND a printer is configured. Deduped so an
// order prints once (even across reconnects / multiple devices).

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL, getSettings, getKitchenBuffer } from '../api';
import { isNativeApp, sendRawToPrinter } from './printer';

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
        const target = s.printer_kitchen_ip || s.printer_receipt_ip;  // single-printer Sunmi → built-in
        if (!target) return;
        const port = s.printer_kitchen_port || s.printer_receipt_port || 9100;

        const buf = await getKitchenBuffer(id);
        if (buf && buf.data) await sendRawToPrinter(target, port, buf.data);

        localStorage.setItem(PRINTED, JSON.stringify([...printed, id].slice(-200)));
      } catch (e) {
        console.warn('[online-order-print]', e && e.message);
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  return null;
}
