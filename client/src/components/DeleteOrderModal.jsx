import { useState } from 'react';
import { deleteOrder } from '../api';

// SEPOS-042 — shared delete-order modal.
// Used from Admin → Bills (closed orders) AND from OrderScreen / KitchenScreen
// (open orders). Requires manager PIN + free-text reason. Surfaces per-step
// backend errors so a failure isn't silent.
//
// Props:
//   order      — { id, total, method?, table_number?, order_type?, customer_name? }
//                Minimum: { id }. Other fields are used for the summary line.
//   onClose()  — close the modal (cancel / × / backdrop click).
//   onDeleted(orderId) — called on successful delete. Parent should refresh.
export default function DeleteOrderModal({ order, onClose, onDeleted }) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  if (!order) return null;

  const summary = (() => {
    if (order.order_type === 'takeaway') {
      return `🥡 Online Order #${order.id}${order.customer_name ? ' · ' + order.customer_name : ''} · £${(order.total || 0).toFixed(2)}`;
    }
    return `Table ${order.table_number ?? '—'} · Order #${order.id} · £${(order.total || 0).toFixed(2)}${order.method ? ' · ' + order.method : ''}`;
  })();

  const submit = async (e) => {
    e?.preventDefault();
    if (!pin.trim() || !reason.trim()) {
      setErr('Manager PIN and reason are both required.');
      return;
    }
    setSubmitting(true); setErr('');
    try {
      const r = await deleteOrder(order.id, pin.trim(), reason.trim());
      if (r?.error) {
        setErr(r.error);
      } else if (r?.steps?.order?.ok === false) {
        setErr(`Delete failed: ${r.steps.order.error}`);
      } else {
        onDeleted?.(order.id);
      }
    } catch (e) {
      setErr(e?.message || 'Delete failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form onSubmit={submit} style={{ background: 'white', borderRadius: 14, padding: 28, width: 460, maxWidth: '100%', boxShadow: '0 30px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
          <div style={{ fontSize: 28 }}>🗑️</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: '#1a1a2e' }}>Delete this order?</h2>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>{summary}</div>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, color: '#94a3b8', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          ⚠ This permanently removes the order, its items, payments and any sale-source stock movements. A record (who/when/why) is kept in <code>order_deletions</code> for the audit trail.
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Manager PIN</label>
        <input
          type="password" autoFocus inputMode="numeric" pattern="[0-9]*"
          value={pin} onChange={(e) => setPin(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 18, marginBottom: 14, letterSpacing: 4, fontFamily: 'monospace', textAlign: 'center' }}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reason</label>
        <input
          type="text" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Test order / wrong table / customer cancelled"
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, marginBottom: 16 }}
        />

        {err && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{err}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', background: '#f1f5f9', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={submitting} style={{ padding: '9px 18px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Deleting…' : 'Delete order'}
          </button>
        </div>
      </form>
    </div>
  );
}
