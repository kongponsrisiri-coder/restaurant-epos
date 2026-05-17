import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn, input, label } from '../theme.js';

const TAB_STATUSES = {
  open:   ['open', 'pending', 'confirmed', 'preparing', 'ready'],
  closed: ['completed', 'cancelled', 'delivered', 'collected'],
};

const TYPE_LABELS = {
  takeaway: { icon: '🥡', label: 'Collection' },
  delivery: { icon: '🚗', label: 'Delivery' },
  dine_in:  { icon: '🍽️', label: 'Dine-in' },
};

const STATUS_COLOURS = {
  open:       { bg: '#e0f2fe', color: '#0369a1' },
  pending:    { bg: '#fef9c3', color: '#a16207' },
  confirmed:  { bg: '#dcfce7', color: '#15803d' },
  preparing:  { bg: '#fef3c7', color: '#92400e' },
  ready:      { bg: '#d1fae5', color: '#065f46' },
  completed:  { bg: '#e0f2fe', color: '#0369a1' },
  delivered:  { bg: '#dcfce7', color: '#15803d' },
  collected:  { bg: '#dcfce7', color: '#15803d' },
  cancelled:  { bg: '#fee2e2', color: '#dc2626' },
};

export default function OrdersPage() {
  const [tab, setTab]         = useState('open');
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [expanded, setExpanded] = useState(null);

  useEffect(() => { load(); }, [tab]);

  const load = () => {
    setLoading(true); setError('');
    const params = { limit: 100, status: TAB_STATUSES[tab].join(',') };
    api.getOrders(params)
      .then(setOrders)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  const filtered = orders.filter(o => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (o.customer_name  || '').toLowerCase().includes(q)
        || (o.customer_email || '').toLowerCase().includes(q)
        || (o.customer_phone || '').toLowerCase().includes(q)
        || String(o.id).includes(q);
  });

  const revenue = filtered.reduce((a, o) => a + Number(o.total_amount || 0), 0);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Orders</h1>
        <p style={{ margin: '5px 0 0', color: C.textMuted, fontSize: 14 }}>Takeaway and delivery orders from your website widget.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {[['open','Open'], ['closed','Completed / Cancelled']].map(([k, lbl]) => (
          <button key={k} onClick={() => { setTab(k); setSearch(''); }} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: tab === k ? C.navy : C.surface,
            color:      tab === k ? '#fff'  : C.textMuted,
            boxShadow:  tab === k ? 'none'  : `0 1px 3px rgba(0,0,0,0.06)`,
          }}>{lbl}</button>
        ))}
      </div>

      {/* Search + summary bar */}
      <div style={{ ...card, padding: '14px 18px', marginBottom: 18, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: '2 1 200px' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, email, phone, order #…" style={input} />
        </div>
        <button onClick={load} style={{ ...btn.ghost, flexShrink: 0 }}>Refresh</button>
        {!loading && (
          <div style={{ marginLeft: 'auto', fontSize: 13, color: C.textMuted, fontWeight: 600, flexShrink: 0 }}>
            {filtered.length} order{filtered.length !== 1 ? 's' : ''} · £{revenue.toFixed(2)}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Orders list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {loading ? (
          <div style={{ ...card, padding: 48, textAlign: 'center', color: C.textFaint, fontSize: 14 }}>Loading orders…</div>
        ) : filtered.length === 0 ? (
          <div style={{ ...card, padding: 48, textAlign: 'center', color: C.textFaint }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🥡</div>
            <div style={{ fontSize: 14 }}>No {tab} orders found.</div>
          </div>
        ) : filtered.map(o => {
          const typeInfo = TYPE_LABELS[o.order_type] || { icon: '📦', label: o.order_type };
          const col = STATUS_COLOURS[o.status] || { bg: C.surfaceAlt, color: C.textMuted };
          const isOpen = expanded === o.id;
          const items = o.items || [];

          return (
            <div key={o.id} style={{ ...card, overflow: 'hidden' }}>
              {/* Order header row */}
              <div
                onClick={() => setExpanded(isOpen ? null : o.id)}
                style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer', flexWrap: 'wrap' }}
              >
                {/* Order # + type */}
                <div style={{ minWidth: 90 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.navy }}>#{o.id}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    {typeInfo.icon} {typeInfo.label}
                  </div>
                </div>

                {/* Customer */}
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{o.customer_name || 'Online order'}</div>
                  {o.customer_phone && <div style={{ fontSize: 11, color: C.textMuted }}>{o.customer_phone}</div>}
                </div>

                {/* Pickup time */}
                {o.pickup_time && (
                  <div style={{ fontSize: 12, color: C.text, fontWeight: 600, minWidth: 80 }}>
                    ⏱ {formatTime(o.pickup_time)}
                  </div>
                )}

                {/* Total */}
                <div style={{ fontSize: 15, fontWeight: 800, color: C.text, minWidth: 70, textAlign: 'right' }}>
                  £{Number(o.total_amount || 0).toFixed(2)}
                </div>

                {/* Status badge */}
                <span style={{ padding: '4px 12px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: col.bg, color: col.color, textTransform: 'capitalize', flexShrink: 0 }}>
                  {(o.status || '').replace('_',' ')}
                </span>

                {/* Time */}
                <div style={{ fontSize: 11, color: C.textFaint, flexShrink: 0, minWidth: 80, textAlign: 'right' }}>
                  {formatDateTime(o.created_at)}
                </div>

                {/* Expand chevron */}
                <span style={{ fontSize: 12, color: C.textFaint, flexShrink: 0 }}>{isOpen ? '▲' : '▼'}</span>
              </div>

              {/* Expanded: items */}
              {isOpen && (
                <div style={{ borderTop: `1px solid ${C.border}`, padding: '14px 18px', background: C.bg }}>
                  {items.length === 0 ? (
                    <div style={{ fontSize: 13, color: C.textFaint, fontStyle: 'italic' }}>No item details available.</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          {['Item', 'Qty', 'Price'].map(h => (
                            <th key={h} style={{ textAlign: h === 'Price' ? 'right' : 'left', fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', padding: '0 0 8px', letterSpacing: '0.4px' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, i) => (
                          <tr key={i}>
                            <td style={{ fontSize: 13, color: C.text, paddingBottom: 6 }}>{it.name || it.item_name || '—'}</td>
                            <td style={{ fontSize: 13, color: C.textMuted, paddingBottom: 6, paddingLeft: 16 }}>×{it.quantity}</td>
                            <td style={{ fontSize: 13, color: C.text, paddingBottom: 6, textAlign: 'right' }}>£{Number((it.price || it.unit_price || 0) * (it.quantity || 1)).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: `1px solid ${C.border}` }}>
                          <td colSpan={2} style={{ fontSize: 13, fontWeight: 700, color: C.text, paddingTop: 8 }}>Total</td>
                          <td style={{ fontSize: 14, fontWeight: 800, color: C.text, paddingTop: 8, textAlign: 'right' }}>£{Number(o.total_amount || 0).toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  )}

                  {/* Delivery address if applicable */}
                  {o.delivery_address && (
                    <div style={{ marginTop: 12, fontSize: 12, color: C.textMuted }}>
                      🏠 {o.delivery_address}
                    </div>
                  )}

                  {/* Notes */}
                  {o.notes && (
                    <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted, fontStyle: 'italic' }}>
                      📝 {o.notes}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    + ' ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
