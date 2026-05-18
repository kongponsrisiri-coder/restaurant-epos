import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn } from '../theme.js';

const PERIODS = [
  { label: '7 days',  days: 7  },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

export default function RevenuePage() {
  const [days, setDays]       = useState(30);
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    setLoading(true);
    api.getRevenue(days)
      .then(setRows)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const totalOrders  = rows.reduce((s, r) => s + Number(r.orders),  0);
  const maxRevenue   = Math.max(...rows.map(r => Number(r.revenue)), 1);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Revenue</h1>
          <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>Online orders and takeaway revenue history.</p>
        </div>
        {/* Period picker */}
        <div style={{ display: 'flex', gap: 8 }}>
          {PERIODS.map(p => (
            <button key={p.days} onClick={() => setDays(p.days)}
              style={{
                ...btn.ghost,
                background: days === p.days ? C.navy : 'transparent',
                color:      days === p.days ? '#fff'  : C.textMuted,
                border:     `1px solid ${days === p.days ? C.navy : C.border}`,
                padding: '6px 14px', fontSize: 13,
              }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={{ ...card, padding: '18px 22px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Total revenue ({PERIODS.find(p => p.days === days)?.label})
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text }}>
            £{totalRevenue.toFixed(2)}
          </div>
        </div>
        <div style={{ ...card, padding: '18px 22px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Total orders ({PERIODS.find(p => p.days === days)?.label})
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text }}>{totalOrders}</div>
        </div>
      </div>

      {/* Bar chart */}
      <div style={{ ...card, padding: '22px 24px', marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 20px', fontSize: 14, fontWeight: 800, color: C.text }}>Daily revenue</h3>
        {loading ? (
          <div style={{ color: C.textFaint, fontSize: 13, padding: '20px 0' }}>Loading…</div>
        ) : error ? (
          <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ color: C.textFaint, fontSize: 13, padding: '20px 0' }}>No revenue data for this period.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 160, minWidth: rows.length * 28 }}>
              {rows.map(r => {
                const h = Math.max((Number(r.revenue) / maxRevenue) * 140, Number(r.revenue) > 0 ? 4 : 0);
                const date = new Date(r.date);
                const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                return (
                  <div key={r.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 24, gap: 4 }}
                    title={`${label}: £${Number(r.revenue).toFixed(2)} (${r.orders} orders)`}>
                    <div style={{
                      width: '100%', height: h, background: C.gold, borderRadius: '3px 3px 0 0',
                      transition: 'height 0.3s', minHeight: Number(r.revenue) > 0 ? 4 : 0,
                    }} />
                    {rows.length <= 30 && (
                      <span style={{ fontSize: 9, color: C.textFaint, transform: 'rotate(-45deg)', transformOrigin: 'top left', whiteSpace: 'nowrap', marginTop: 6 }}>
                        {label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Daily table */}
      {!loading && rows.length > 0 && (
        <div style={{ ...card, padding: '22px 24px' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 800, color: C.text }}>Daily breakdown</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ textAlign: 'left',  padding: '8px 0', color: C.textMuted, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>Date</th>
                <th style={{ textAlign: 'right', padding: '8px 0', color: C.textMuted, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>Orders</th>
                <th style={{ textAlign: 'right', padding: '8px 0', color: C.textMuted, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map(r => (
                <tr key={r.date} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '10px 0', color: C.text, fontWeight: 600 }}>
                    {new Date(r.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '10px 0', textAlign: 'right', color: C.textMuted }}>{r.orders}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 700, color: C.text }}>£{Number(r.revenue).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.border}` }}>
                <td style={{ padding: '10px 0', fontWeight: 800, color: C.text }}>Total</td>
                <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 800, color: C.text }}>{totalOrders}</td>
                <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 800, color: C.text }}>£{totalRevenue.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
