// SEPOS-ORDER-CHIME-001 — sound alert for new ONLINE orders ("sometimes no
// one at the till" — client request via Korakot, 27 Aug 2026).
//
// Rings when an online order arrives and REPEATS every ~25s until a person
// acknowledges it — a single ring at an empty counter is the old failure with
// extra steps. A banner pairs with the sound so a till whose browser blocks
// autoplay (no interaction since load) still shows the arrival, and the next
// interaction unblocks the sound.
//
// Sources covered (the class, not one path):
//   • widget takeaway/delivery + Deliveroo → 'new_takeaway_order'
//     (the Deliveroo webhook now emits it too — it only sent the generic
//     items event before, so nothing keyed on takeaway arrivals saw it)
//   • QR table orders → 'new_order_items' where order.source === 'qr'
//
// Restaurant setting: online_order_chime ('1' default — patch-note headline;
// venues that hate it turn it off in Settings). Never mounts on the customer
// display (/#display early-returns before the root fragment).
//
// The chime is SYNTHESISED with Web Audio (two-tone ding) — no audio asset,
// nothing to fetch, works offline.

import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL, getSettings } from '../api';

const REPEAT_MS = 25000;

function ding() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!ding._ctx) ding._ctx = new Ctx();
    const ctx = ding._ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    // Two-tone "counter bell": E6 then A6, short decay, gentle second strike.
    [[1318.5, 0, 0.5], [1760, 0.18, 0.6]].forEach(([freq, delay, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.4, t0 + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + dur + 0.05);
    });
    // Autoplay policy: without a prior user gesture the context stays
    // 'suspended' and the tones above are silent — report that honestly so
    // the banner shows its "tap once to enable sound" hint.
    return ctx.state === 'running';
  } catch { return false; }
}

export default function OrderChime({ onOpen }) {
  // Pending = arrived online orders nobody has acknowledged yet.
  const [pending, setPending] = useState([]);   // [{id, label}]
  const [muted, setMuted] = useState(false);    // sound blocked by autoplay policy
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    let alive = true;
    const arrive = async (id, label) => {
      if (!alive || id == null) return;
      try {
        const s = await getSettings();
        if (s && String(s.online_order_chime ?? '1') === '0') return;   // venue opted out
      } catch { /* settings unreachable → still alert; losing an order is worse */ }
      setPending((prev) => prev.some(p => p.id === id) ? prev : [...prev, { id, label }]);
      if (!ding()) setMuted(true);
    };

    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    const onTakeaway = (p) => {
      const label = p?.order_subtype === 'delivery'
        ? (p?.source === 'deliveroo' ? '🛵 Deliveroo' : '🛵 Delivery')
        : '🥡 Takeaway';
      arrive(p?.id, `${label}${p?.customer_name ? ' · ' + p.customer_name : ''}`);
    };
    const onItems = (p) => {
      // QR table orders ride the generic items event; the payload carries the
      // order row. Everything else on this event (till sends) stays silent.
      if (p?.order?.source === 'qr') arrive(p.order.id, `📱 QR · table order`);
    };
    socket.on('new_takeaway_order', onTakeaway);
    socket.on('new_order_items', onItems);

    // Repeat until acknowledged. Also retries sound after an autoplay block —
    // once any tap/keypress has happened, the context resumes and rings.
    const t = setInterval(() => {
      if (pendingRef.current.length > 0) { if (ding()) setMuted(false); }
    }, REPEAT_MS);

    return () => {
      alive = false;
      socket.off('new_takeaway_order', onTakeaway);
      socket.off('new_order_items', onItems);
      socket.disconnect();
      clearInterval(t);
    };
  }, []);

  if (pending.length === 0) return null;

  const ack = () => { setPending([]); if (onOpen) onOpen(); };

  return (
    <div
      onClick={ack}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 2147482000,
        background: '#b45309', color: 'white', cursor: 'pointer',
        padding: '12px 16px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: 10, fontWeight: 800, fontSize: 15,
        boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
      }}
    >
      <span style={{ fontSize: 20 }}>🔔</span>
      {pending.length === 1
        ? <span>New online order — {pending[0].label} — tap to view</span>
        : <span>{pending.length} new online orders — tap to view</span>}
      {muted && <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.85 }}>(tap once to enable sound)</span>}
    </div>
  );
}
