// SEPOS-044 — horizontal strip of active takeaway orders shown on top
// of the table-map screen. Auto-hides when empty.
// Each card: customer name, items count, total, countdown to pickup.
// Tap → opens a BillPeek for that order.

import { useEffect, useState } from 'react';
import { getActiveTakeaway, SERVER_URL } from '../api';
import { io } from 'socket.io-client';

export default function TakeawayStrip({ onPeek }) {
  const [orders, setOrders] = useState([]);
  const [tick, setTick] = useState(0);

  const load = async () => {
    try {
      const list = await getActiveTakeaway();
      setOrders(Array.isArray(list) ? list : []);
    } catch (e) {
      // Endpoint may not be reachable in dev — fail quiet.
      console.warn('[takeaway-strip] load failed', e?.message || e);
    }
  };

  useEffect(() => {
    load();
    const poll = setInterval(load, 20000);
    const minTick = setInterval(() => setTick(t => t + 1), 30000);
    // Socket — pulls active list on any takeaway-related event.
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    const refresh = () => load();
    socket.on('new_takeaway_order', refresh);
    socket.on('takeaway_status',    refresh);
    socket.on('order_closed',       refresh);
    return () => {
      clearInterval(poll); clearInterval(minTick);
      socket.off('new_takeaway_order', refresh);
      socket.off('takeaway_status',    refresh);
      socket.off('order_closed',       refresh);
      socket.disconnect();
    };
  }, []);

  if (orders.length === 0) return null;

  return (
    <div style={wrap}>
      <div style={label}>🥡 Takeaway · {orders.length}</div>
      <div style={track}>
        {orders.map(o => <Card key={o.id} order={o} onPeek={onPeek} />)}
      </div>
    </div>
  );
}

function Card({ order, onPeek }) {
  const pickup = order.pickup_time ? new Date(order.pickup_time) : null;
  const mins = pickup ? Math.round((pickup.getTime() - Date.now()) / 60000) : null;

  let pickupLabel = 'ASAP';
  let urgency = '#94a3b8'; // grey
  if (mins != null) {
    if (mins <= -5)       { pickupLabel = `${-mins}m late`; urgency = '#dc2626'; }
    else if (mins <= 0)   { pickupLabel = 'Pickup now';     urgency = '#dc2626'; }
    else if (mins <= 10)  { pickupLabel = `in ${mins}m`;    urgency = '#ea580c'; }
    else if (mins <= 30)  { pickupLabel = `in ${mins}m`;    urgency = '#f59e0b'; }
    else                  { pickupLabel = pickup.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }); urgency = '#475569'; }
  }

  const statusBadge = order.takeaway_status && order.takeaway_status !== 'pending' && (
    <span style={{ ...statusChip, background: statusColours[order.takeaway_status] || '#cbd5e1' }}>
      {order.takeaway_status}
    </span>
  );

  return (
    <button onClick={() => onPeek?.(order.id)} style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#0d1b3e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
          {order.customer_name || 'Takeaway'}
        </span>
        {statusBadge}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: urgency }}>{pickupLabel}</span>
        <span style={{ fontSize: 12, color: '#64748b', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          £{Number(order.total || 0).toFixed(2)}
        </span>
      </div>
    </button>
  );
}

const statusColours = {
  accepted:  '#3b82f6',
  preparing: '#f59e0b',
  ready:     '#22c55e',
};

const wrap = {
  background: 'white', borderBottom: '1px solid #eee',
  padding: '10px 14px 12px', flexShrink: 0,
};
const label = {
  fontSize: 11, fontWeight: 800, color: '#475569',
  textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6,
};
const track = {
  display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2,
};
const card = {
  flex: '0 0 auto', minWidth: 180, maxWidth: 220,
  background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
  padding: '10px 12px', textAlign: 'left', cursor: 'pointer', font: 'inherit',
};
const statusChip = {
  color: 'white', fontSize: 10, fontWeight: 800,
  padding: '1px 7px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.5,
};
