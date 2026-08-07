// SEPOS-ANDROID-001 — auto-print incoming online (takeaway) orders.
//
// On the native Android app, the designated device listens for new online orders
// and prints the kitchen ticket itself (the cloud can't reach a LAN printer).
// Headless (renders nothing). No-op unless: running natively AND this device is
// flagged as the online-order printer. Deduped so an order prints once (even
// across reconnects / multiple devices).
//
// SEPOS-ANDROID-005 (2026-07-19) — print through printFullOrderTicket, the same
// path as manual kitchen printing, so the Admin → Printers destination is
// honoured: built-in Sunmi, network, or station routing. The old code demanded
// printer_kitchen_ip and sent a server-rendered buffer over the LAN — on a
// built-in-only Sunmi (Chart Thai) it silently never printed.

import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL, getOrder } from '../api';
import { isNativeApp } from './printer';
import { printFullOrderTicket, printBarOrderTicket } from '../screens/KitchenTicket';

const FLAG    = 'print_online_orders';     // '1' on the one device that should print
const PRINTED = 'printed_online_orders';   // recent ids, for dedup

export default function OnlineOrderPrinter() {
  useEffect(() => {
    if (!isNativeApp()) return;            // web/desktop print online orders the existing way

    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socket.on('new_takeaway_order', async (payload) => {
      try {
        if (localStorage.getItem(FLAG) !== '1') return;     // not the designated printer device
        const id = payload && payload.id;
        if (!id) return;
        let printed = [];
        try { printed = JSON.parse(localStorage.getItem(PRINTED) || '[]'); } catch {}
        if (printed.includes(id)) return;                   // already printed
        // Claim the id BEFORE printing — a socket reconnect can redeliver the
        // event mid-print and a double ticket is worse than a rare missed one
        // (the order is always visible on the Kitchen tab regardless).
        localStorage.setItem(PRINTED, JSON.stringify([...printed, id].slice(-200)));

        const order = await getOrder(id);
        if (!order || order.error) return;
        const allItems = order.items || [];
        await printFullOrderTicket({ order, items: allItems });
        // SEPOS-AUDIT-002 F24 — printFullOrderTicket drops is_bar lines (they
        // belong on the bar ticket) and since SEPOS-ANDROID-005 nothing else
        // printed them on the native path: drinks in an online order never
        // reached the bar.
        if (allItems.some(i => i && !i.voided && i.is_bar)) {
          try { await printBarOrderTicket({ order, items: allItems }); }
          catch (e) { console.warn('[online-order-print] bar ticket', e && e.message); }
        }
      } catch (e) {
        console.warn('[online-order-print]', e && e.message);
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  return null;
}
