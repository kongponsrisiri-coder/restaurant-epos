// SEPOS-044 — Lightweight read-only bill popover.
// Reused by the takeaway strip (tap a card) and the table-map tap menu
// (tap "📋 Bill"). Same math as BillScreen but no payment/split UI —
// staff hand off to the full BillScreen via "Open full bill" when they
// want to take payment.

import { useEffect, useState } from 'react';
import { getBill } from '../api';
import { orderShortLabelPlain, isTakeaway } from '../utils/orderLabel';

export default function BillPeek({ orderId, onClose, onOpenFull }) {
  const [bill, setBill]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    getBill(orderId)
      .then(data => { if (!cancelled) { setBill(data); setLoading(false); } })
      .catch(e => { if (!cancelled) { setErr(e.message || String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [orderId]);

  // Esc to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div style={panel}>
        <div style={header}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>
            {loading ? 'Loading…' : err ? 'Bill' : labelFor(bill.order)}
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close">×</button>
        </div>

        {err && <div style={errBox}>{err}</div>}

        {!loading && !err && bill?.order && <BillBody bill={bill} />}

        <div style={footer}>
          <button onClick={onClose} style={ghostBtn}>Close</button>
          {onOpenFull && bill?.order && (
            <button onClick={() => onOpenFull(bill.order.id)} style={primaryBtn}>
              Open full bill →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function labelFor(order) {
  if (!order) return 'Bill';
  if (isTakeaway(order)) return `🥡 ${order.customer_name || 'Takeaway'}`;
  return `${orderShortLabelPlain(order) || 'Order'} · Bill`;
}

function BillBody({ bill }) {
  const { order, settings } = bill;
  const billItems = (order.items || []).filter(i => !i.voided);
  const serviceChargePercent = parseFloat(settings.service_charge_rate || settings.service_charge_percent || 12.5) / 100;
  const serviceChargeEnabled = settings.service_charge_enabled !== '0' && settings.service_charge_enabled !== 'false' && !isTakeaway(order);

  const subtotal = billItems.reduce((s, i) => {
    const p = i.unit_price * i.quantity;
    const d = i.discount_value > 0
      ? i.discount_type === 'percent' ? p * (i.discount_value / 100) : Math.min(i.discount_value, p)
      : 0;
    return s + p - d;
  }, 0);

  const discountAmount = order.discount_value > 0
    ? (order.discount_type === 'percent' ? subtotal * (order.discount_value / 100) : parseFloat(order.discount_value))
    : 0;
  const afterDiscount = subtotal - discountAmount;
  const serviceCharge = serviceChargeEnabled ? afterDiscount * serviceChargePercent : 0;
  const total = Math.round(afterDiscount * 100 + serviceCharge * 100) / 100;
  const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;

  return (
    <div style={body}>
      {/* Quick header line */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, fontSize: 12, color: '#555', flexWrap: 'wrap' }}>
        {order.covers != null && <span>{order.covers} {order.covers === 1 ? 'cover' : 'covers'}</span>}
        {order.opened_at && <span>Opened {formatTime(order.opened_at)}</span>}
        {isTakeaway(order) && order.pickup_time && <span>Pickup {formatTime(order.pickup_time)}</span>}
        {order.status && <span style={{ marginLeft: 'auto', fontWeight: 700, color: order.status === 'closed' ? '#16a34a' : '#0d1b3e' }}>{order.status.toUpperCase()}</span>}
      </div>

      {/* Items */}
      {billItems.length === 0 ? (
        <div style={{ color: '#999', padding: 16, textAlign: 'center', fontSize: 13 }}>No items on this bill yet.</div>
      ) : (
        <div style={{ borderTop: '1px solid #eee' }}>
          {billItems.map(i => {
            const lineGross = i.unit_price * i.quantity;
            const dLine = i.discount_value > 0
              ? i.discount_type === 'percent' ? lineGross * (i.discount_value / 100) : Math.min(i.discount_value, lineGross)
              : 0;
            return (
              <div key={i.id} style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f3f3', fontSize: 14 }}>
                <span style={{ minWidth: 28, color: '#666', fontWeight: 700 }}>{i.quantity}×</span>
                <span style={{ flex: 1 }}>
                  {i.name || i.item_name || `Item #${i.menu_item_id}`}
                  {i.notes && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{i.notes}</div>}
                  {dLine > 0 && <div style={{ fontSize: 11, color: '#16a34a', marginTop: 2 }}>− {money(dLine)} discount</div>}
                </span>
                <span style={{ minWidth: 60, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(lineGross - dLine)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Totals */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #ddd', fontSize: 14 }}>
        <Row label="Subtotal"        value={money(subtotal)} />
        {discountAmount > 0 && <Row label={`Discount${order.discount_reason ? ` (${order.discount_reason})` : ''}`} value={`− ${money(discountAmount)}`} />}
        {serviceChargeEnabled && (
          <Row label={`Service charge (${(serviceChargePercent * 100).toFixed(1)}%)`} value={money(serviceCharge)} />
        )}
        <Row label="Total" value={money(total)} strong />
      </div>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', padding: '4px 0', fontWeight: strong ? 800 : 500, fontSize: strong ? 17 : 14, color: strong ? '#0d1b3e' : '#444' }}>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// ── styles ─────────────────────────────────────────────────────────
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16, zIndex: 9000,
};
const panel = {
  background: 'white', borderRadius: 14, width: 'min(440px, 100%)',
  maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 30px 80px rgba(0,0,0,0.35)',
};
const header = {
  padding: '14px 18px', borderBottom: '1px solid #eee',
  display: 'flex', alignItems: 'center', gap: 8,
};
const closeBtn = {
  marginLeft: 'auto', background: 'none', border: 'none',
  fontSize: 24, color: '#888', cursor: 'pointer', padding: 0, lineHeight: 1,
};
const body = { padding: '14px 18px', overflowY: 'auto', flex: 1 };
const footer = {
  padding: 14, borderTop: '1px solid #eee',
  display: 'flex', gap: 10, justifyContent: 'flex-end',
};
const ghostBtn = {
  background: 'transparent', color: '#475569', border: '1px solid #cbd5e1',
  padding: '9px 14px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const primaryBtn = {
  background: '#0d1b3e', color: 'white', border: 'none',
  padding: '9px 16px', borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: 'pointer',
};
const errBox = {
  margin: '14px 18px 0', padding: '10px 12px', background: '#fee2e2',
  color: '#991b1b', borderRadius: 8, fontSize: 13,
};
