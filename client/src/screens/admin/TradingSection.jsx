import { useState, useEffect } from 'react';
import { getSummaryReport } from '../../api';
import { todayStr, getDateRange } from './shared';
import { dineTableLabel } from '../../utils/orderLabel';

export default function TradingSection() {
  const [period, setPeriod] = useState('today');
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { from, to } = getDateRange(period, customFrom, customTo);
    setLoading(true);
    getSummaryReport(from, to).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [period, customFrom, customTo]);

  // SEPOS-REPREC-001 — the headline + averages track MONEY TAKEN (total_paid) so
  // Trading reconciles exactly with the Bills page and its own Payment Methods
  // breakdown below. total_sales is the order-value figure (kept for the Reports
  // breakdown); it can differ from money taken by tips / overpayments.
  const takings     = Number(data?.total_paid ?? data?.total_sales ?? 0);
  const avgPerHead  = data?.total_covers > 0 ? takings / data.total_covers : 0;
  const avgPerCover = data?.order_count  > 0 ? takings / data.order_count  : 0;

  return (
    <div style={{ padding: 'clamp(14px, 4vw, 24px)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 16 }}>Trading Summary</h1>
      {/* Period chips — horizontal-scroll strip on narrow screens so
          Today / Weekly / Monthly / Custom always sit on one line and
          the user can swipe instead of stacking vertically. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {['today', 'weekly', 'monthly', 'custom'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '8px 18px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, textTransform: 'capitalize', whiteSpace: 'nowrap', flexShrink: 0, background: period === p ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0', color: period === p ? 'white' : '#555' }}>{p}</button>
        ))}
        {/* Date-range picker — always visible so any specific day is one tap away.
            Picking a date jumps straight to the custom range (no need to hit
            "Custom" first). A single day = set both boxes to the same date. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 6, flexShrink: 0 }}>
          <input type="date" value={customFrom} max={customTo || todayStr()}
            onChange={e => { setCustomFrom(e.target.value); setPeriod('custom'); }}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #bbb', fontSize: 13 }} />
          <span style={{ color: '#666', fontSize: 13 }}>→</span>
          <input type="date" value={customTo} min={customFrom} max={todayStr()}
            onChange={e => { setCustomTo(e.target.value); setPeriod('custom'); }}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #bbb', fontSize: 13 }} />
        </div>
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          {/* Stat grid — minmax(140px) so 2 columns fit on phones
              (≥320px viewport) and grows to 3+ on desktop. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Total Sales',   value: `£${takings.toFixed(2)}`, color: '#e94560' },
              { label: 'Orders',        value: data?.order_count || 0,                    color: '#3b82f6' },
              { label: 'Covers',        value: data?.total_covers || 0,                   color: '#22c55e' },
              { label: 'Avg per Cover', value: `£${avgPerHead.toFixed(2)}`,               color: '#eab308' },
              { label: 'Avg Order',     value: `£${avgPerCover.toFixed(2)}`,              color: '#8b5cf6' },
            ].map(stat => (
              <div key={stat.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 'clamp(20px, 5.5vw, 26px)', fontWeight: 800, color: stat.color, lineHeight: 1.15 }}>{stat.value}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{stat.label}</div>
              </div>
            ))}
          </div>
          {/* SEPOS-MONEY-STORY-001 — the one card a restaurant owner reads first
              (Korakot at Fern, 17 Aug: "add the sale or something that make the
              restaurant easy to understand"). Adds bills + till voucher sales
              into ONE "money into the till" figure, and explains voucher-paid
              bills with the same day-basis sentence that ended the spa deposit
              confusion. Methods that aren't real money in (voucher/deposit/
              external/comp) are excluded from the money figure. */}
          {(() => {
            if (!data) return null;
            const NON_MONEY = new Set(['voucher', 'deposit', 'external', 'complimentary', 'zero', 'mock']);
            const entries = Object.entries(data.by_method || {});
            const billMoney = entries.filter(([m]) => !NON_MONEY.has(String(m).toLowerCase()))
              .reduce((s, [, a]) => s + Number(a || 0), 0);
            const vs = data.vouchers_sold || {};
            const vTill  = Number(vs.till_total || 0);
            const vCard  = Number(vs.by_method?.card?.total || 0);
            const vCash  = Number(vs.by_method?.cash?.total || 0);
            const cardBills = Number(data.by_method?.Card ?? data.by_method?.card ?? 0);
            const cashBills = Number(data.by_method?.Cash ?? data.by_method?.cash ?? 0);
            const moneyIn = billMoney + vTill;
            const vRedeemed = Number(data.vouchers_redeemed?.total || 0);
            if (moneyIn <= 0 && vRedeemed <= 0) return null;
            const row = (label, val, opts = {}) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: opts.big ? 20 : 14, fontWeight: opts.big ? 800 : (opts.bold ? 700 : 500), color: opts.color || (opts.big ? 'var(--brand-primary,#0D1B3E)' : '#444'), borderTop: opts.rule ? '2px solid var(--brand-primary,#0D1B3E)' : 'none', marginTop: opts.rule ? 6 : 0 }}>
                <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{val}</span>
              </div>
            );
            return (
              <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', border: '1.5px solid var(--brand-accent,#C9A84C)' }}>
                <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--brand-primary, #1a1a2e)', fontSize: 16 }}>💷 Money into the till</div>
                {row('Food & drink taken', `£${billMoney.toFixed(2)}`)}
                {vTill > 0 && row('Gift vouchers sold at the till', `+£${vTill.toFixed(2)}`)}
                {row('Total money in', `£${moneyIn.toFixed(2)}`, { big: true, rule: true })}
                <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                  💳 Card £{(cardBills + vCard).toFixed(2)} &nbsp;·&nbsp; 💵 Cash £{(cashBills + vCash).toFixed(2)}
                </div>
                {vRedeemed > 0 && (
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: '#1e3a8a', marginTop: 10 }}>
                    💡 £{vRedeemed.toFixed(2)} of the bills were paid with gift vouchers — that money was counted on the day each voucher was <strong>sold</strong>, so it isn't added again today.
                  </div>
                )}
              </div>
            );
          })()}
          {data?.by_method && Object.keys(data.by_method).length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: 'var(--brand-primary, #1a1a2e)' }}>Payment Methods</div>
              {Object.entries(data.by_method)
                .filter(([, amount]) => Math.abs(Number(amount) || 0) >= 0.005)  /* SEPOS-MONEY-STORY-001 — hide £0.00 noise rows (e.g. 'zero') */
                .map(([method, amount]) => (
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
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>£{Number(data.vouchers_sold.till_total).toFixed(2)}</div>
                  </div>
                )}
                {Number(data.vouchers_sold?.stripe_total || 0) > 0 && (
                  <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: '#888' }}>↳ Online (Stripe)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>£{Number(data.vouchers_sold.stripe_total).toFixed(2)}</div>
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
              <div style={{ fontWeight: 700, marginBottom: 12, color: 'var(--brand-primary, #1a1a2e)' }}>Recent Orders</div>
              {data.orders.slice(0, 10).map(order => (
                // Korakot 2026-06-02: dropped the · #{order.id} segment so
                // the Trading summary's Recent Orders list matches Bills /
                // Reports — operators reference by Table + time, not bill #.
                <div key={order.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ color: '#555' }}>{order.order_type === 'takeaway' ? `🥡 ${order.customer_name || 'Takeaway'}` : dineTableLabel(order)} · {order.method}</span>
                  <span style={{ fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>£{Number(order.paid_amount ?? order.total ?? 0).toFixed(2)}</span>
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
