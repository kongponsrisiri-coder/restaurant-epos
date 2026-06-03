import { useState, useEffect } from 'react';
import { getSummaryReport } from '../../api';
import { today, getDateRange } from './shared';

export default function TradingSection() {
  const [period, setPeriod] = useState('today');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { from, to } = getDateRange(period, customFrom, customTo);
    setLoading(true);
    getSummaryReport(from, to).then(d => { setData(d); setLoading(false); });
  }, [period, customFrom, customTo]);

  const avgPerHead  = data?.total_covers > 0 ? data.total_sales / data.total_covers : 0;
  const avgPerCover = data?.order_count  > 0 ? data.total_sales / data.order_count  : 0;

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Trading Summary</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        {['today', 'weekly', 'monthly', 'custom'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '8px 20px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, textTransform: 'capitalize', background: period === p ? '#1a1a2e' : '#e0e0e0', color: period === p ? 'white' : '#555' }}>{p}</button>
        ))}
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 6 }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #bbb', fontSize: 13 }} />
            <span style={{ color: '#666', fontSize: 13 }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #bbb', fontSize: 13 }} />
          </div>
        )}
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Sales',   value: `£${Number(data?.total_sales || 0).toFixed(2)}`, color: '#e94560' },
              { label: 'Orders',        value: data?.order_count || 0,                    color: '#3b82f6' },
              { label: 'Covers',        value: data?.total_covers || 0,                   color: '#22c55e' },
              { label: 'Avg per Cover', value: `£${avgPerHead.toFixed(2)}`,               color: '#eab308' },
              { label: 'Avg Order',     value: `£${avgPerCover.toFixed(2)}`,              color: '#8b5cf6' },
            ].map(stat => (
              <div key={stat.label} style={{ background: 'white', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{stat.label}</div>
              </div>
            ))}
          </div>
          {data?.by_method && Object.keys(data.by_method).length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#1a1a2e' }}>Payment Methods</div>
              {Object.entries(data.by_method).map(([method, amount]) => (
                <div key={method} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ color: '#555' }}>{method}</span>
                  <span style={{ fontWeight: 700 }}>£{Number(amount).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          {/* SEPOS-VOUCHER-001 — gift voucher activity (off the food/drink total — sold separately) */}
          {(data?.vouchers_sold?.count > 0 || data?.vouchers_redeemed?.count > 0) && (
            <div style={{ background: '#fdf6ec', border: '1px solid #f3e1bb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: '#5b4a2a' }}>🎁 Gift Vouchers</div>
              <div style={{ fontSize: 12, color: '#8a7a4f', marginBottom: 12 }}>Tracked separately from food/drink sales — recognised as revenue when sold, not when redeemed.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
                <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>Sold ({data.vouchers_sold?.count || 0})</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#5b4a2a' }}>£{Number(data.vouchers_sold?.total || 0).toFixed(2)}</div>
                </div>
                {Number(data.vouchers_sold?.till_total || 0) > 0 && (
                  <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: '#888' }}>↳ Via till (cash/card)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e' }}>£{Number(data.vouchers_sold.till_total).toFixed(2)}</div>
                  </div>
                )}
                {Number(data.vouchers_sold?.stripe_total || 0) > 0 && (
                  <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: '#888' }}>↳ Online (Stripe)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e' }}>£{Number(data.vouchers_sold.stripe_total).toFixed(2)}</div>
                  </div>
                )}
                <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>Redeemed ({data.vouchers_redeemed?.count || 0})</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#8b5cf6' }}>£{Number(data.vouchers_redeemed?.total || 0).toFixed(2)}</div>
                </div>
              </div>
            </div>
          )}
          {data?.orders?.length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#1a1a2e' }}>Recent Orders</div>
              {data.orders.slice(0, 10).map(order => (
                // Korakot 2026-06-02: dropped the · #{order.id} segment so
                // the Trading summary's Recent Orders list matches Bills /
                // Reports — operators reference by Table + time, not bill #.
                <div key={order.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ color: '#555' }}>Table {order.table_number} · {order.method}</span>
                  <span style={{ fontWeight: 700, color: '#1a1a2e' }}>£{Number(order.paid_amount ?? order.total ?? 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          {data?.orders?.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60, fontSize: 16 }}>No orders found for this period</div>}
        </>
      )}
    </div>
  );
}
