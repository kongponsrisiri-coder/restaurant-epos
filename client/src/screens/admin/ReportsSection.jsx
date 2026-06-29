import { useState, useEffect } from 'react';
import { getSummaryReport, getItemSalesReport, getSettings } from '../../api';
import { today, getDateRange } from './shared';
import { downloadCsv } from '../../utils/csv';
import {
  thermalPrint, fullPagePrint, escPosPrint, pageHtml,
  fmt, fmtInt, periodLabel, restaurantName, nowStamp,
} from '../../utils/reportPrinter';

export default function ReportsSection() {
  const [tab, setTab] = useState('sales');
  const [period, setPeriod] = useState('today');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [data, setData] = useState(null);
  const [itemData, setItemData] = useState([]);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => { getSettings().then(s => setSettings(s || {})).catch(() => {}); }, []);

  useEffect(() => {
    const { from, to } = getDateRange(period, customFrom, customTo);
    setLoading(true);
    Promise.all([getSummaryReport(from, to), getItemSalesReport(from, to)]).then(([s, i]) => {
      setData(s); setItemData(i); setLoading(false);
    }).catch(() => setLoading(false));
  }, [period, customFrom, customTo]);

  const { from, to } = getDateRange(period, customFrom, customTo);

  const exportCsv = () => {
    const stamp = new Date().toISOString().slice(0,10);
    if (tab === 'sales') {
      if (!data?.orders?.length) return;
      const rows = [['Type', 'Table / Customer', 'Method', 'Covers', 'Subtotal £', 'Total £']];
      data.orders.forEach(o => {
        rows.push([
          o.order_type || 'dine_in',
          o.order_type === 'takeaway' ? (o.customer_name || 'Online') : `Table ${o.table_number || '-'}`,
          o.method || (o.order_type === 'takeaway' ? 'Online' : ''),
          o.covers || '',
          Number(o.total || 0).toFixed(2),
          Number(o.paid_amount ?? o.total ?? 0).toFixed(2),
        ]);
      });
      rows.push([]);
      rows.push(['', '', '', '', 'Food',                 Number(data.total_food     || 0).toFixed(2)]);
      rows.push(['', '', '', '', 'Drink',                Number(data.total_drink    || 0).toFixed(2)]);
      rows.push(['', '', '', '', 'Service charge',       Number(data.total_service  || 0).toFixed(2)]);
      rows.push(['', '', '', '', `TOTAL (${data.order_count || 0} orders · ${data.total_covers || 0} covers)`, Number(data.total_sales || 0).toFixed(2)]);
      if (data?.vouchers_sold?.count > 0 || data?.vouchers_redeemed?.count > 0) {
        rows.push([]);
        rows.push(['🎁 GIFT VOUCHERS', '', '', '', '', '']);
        rows.push(['Sold total', '', '', '', data.vouchers_sold?.count || 0, Number(data.vouchers_sold?.total || 0).toFixed(2)]);
        rows.push(['  via till (cash/card)', '', '', '', '', Number(data.vouchers_sold?.till_total || 0).toFixed(2)]);
        rows.push(['  online (Stripe)',      '', '', '', '', Number(data.vouchers_sold?.stripe_total || 0).toFixed(2)]);
        rows.push(['Redeemed against bills', '', '', '', data.vouchers_redeemed?.count || 0, '-' + Number(data.vouchers_redeemed?.total || 0).toFixed(2)]);
      }
      downloadCsv(`sales-report_${period}_${stamp}.csv`, rows);
    } else {
      if (!itemData.length) return;
      const rows = [['Item', 'Price £', 'Qty sold', 'Revenue £']];
      itemData.forEach(i => {
        rows.push([i.name, Number(i.price).toFixed(2), i.qty_sold, Number(i.total_revenue).toFixed(2)]);
      });
      downloadCsv(`item-sales_${period}_${stamp}.csv`, rows);
    }
  };

  const doPrint = async (mode) => {
    if (loading) return;
    const title = tab === 'sales' ? 'Sales Report' : 'Item Sales';
    const isThermal = (mode === 'thermal');

    // Thermal path: try direct ESC/POS to the configured receipt printer.
    // Falls back to the HTML preview popup if no IP is configured.
    if (isThermal) {
      const lines = (tab === 'sales')
        ? buildSalesLines(data, period, from, to, settings)
        : buildItemsLines(itemData, period, from, to, settings);
      const r = await escPosPrint(lines, settings);
      if (r && r.success) return;
      // Show fallback popup if there's no printer configured.
      const fallbackBody = (tab === 'sales')
        ? buildSalesBody(data, period, from, to, settings, true)
        : buildItemsBody(itemData, period, from, to, settings, true);
      thermalPrint(pageHtml(title + ' — ' + restaurantName(settings), fallbackBody, 'thermal'));
      return;
    }
    // Full-page popup: A4 preview, operator prints / saves PDF themselves.
    const body = (tab === 'sales')
      ? buildSalesBody(data, period, from, to, settings, false)
      : buildItemsBody(itemData, period, from, to, settings, false);
    fullPagePrint(pageHtml(title + ' — ' + restaurantName(settings), body, 'full'));
  };

  const periodBtn = { padding: '6px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, textTransform: 'capitalize' };
  const tabBtn    = { padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600 };
  const actionBtn = { padding: '8px 14px', borderRadius: 8, border: '1px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontWeight: 700, fontSize: 13, cursor: 'pointer' };

  return (
    <div style={{ padding: 'clamp(14px, 4vw, 24px)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>Reports</h1>
      {/* Period strip — horizontal scroll on narrow viewports (same
          pattern as TradingSection). */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {['today', 'weekly', 'monthly', 'custom'].map(p => (
          <button key={p} onClick={() => setPeriod(p)}
            style={{ ...periodBtn, background: period === p ? '#1a1a2e' : '#e0e0e0', color: period === p ? 'white' : '#555' }}>
            {p}
          </button>
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        {['sales', 'items'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...tabBtn, background: tab === t ? '#e94560' : '#f0f0f0', color: tab === t ? 'white' : '#555' }}>
            {t === 'sales' ? 'Sales Report' : 'Item Sales'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => doPrint('thermal')} style={{ ...actionBtn, background: '#1a1a2e', color: 'white', border: '1px solid #1a1a2e' }}>🖨 Print</button>
          <button onClick={() => doPrint('full')}    style={actionBtn}>📄 Export</button>
          <button onClick={exportCsv}                style={actionBtn}>⬇ CSV</button>
        </div>
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          {tab === 'sales' && (
            // Horizontal-scroll wrapper for the 5-column sales table so
            // mobile users can swipe; desktop renders edge-to-edge.
            <div style={{ background: 'white', borderRadius: 12, overflowX: 'auto', overflowY: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', WebkitOverflowScrolling: 'touch' }}>
              <div style={{ minWidth: 580 }}>
              <div style={{ padding: '12px 20px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '1fr 110px 70px 90px 90px', fontWeight: 700, fontSize: 13, color: '#555' }}>
                <span>Table / Customer</span><span>Method</span><span>Covers</span><span style={{ textAlign: 'right' }}>Subtotal</span><span style={{ textAlign: 'right' }}>Total</span>
              </div>
              {data?.orders?.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No orders for this period</div>}
              {data?.orders?.map(order => (
                <div key={order.id} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '1fr 110px 70px 90px 90px', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span>{order.order_type === 'takeaway' ? `🥡 ${order.customer_name || 'Online'}` : `Table ${order.table_number}`}</span>
                  <span>{order.method || (order.order_type === 'takeaway' ? 'Online' : '-')}</span>
                  <span>{order.covers || '-'}</span>
                  <span style={{ textAlign: 'right', color: '#888' }}>£{Number(order.total || 0).toFixed(2)}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>£{Number(order.paid_amount ?? order.total ?? 0).toFixed(2)}</span>
                </div>
              ))}
              {data?.orders?.length > 0 && (
                <>
                  {(data.takeaway_count > 0 || data.dine_in_count > 0) && (
                    <div style={{ background: '#fffbeb', borderTop: '1px solid #fde68a', display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: 13 }}>
                      <div style={{ padding: '10px 20px', borderRight: '1px solid #fde68a' }}>
                        <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Dine-in</div>
                        <div style={{ fontWeight: 800, color: '#1a1a2e' }}>£{Number(data.total_dine_in || 0).toFixed(2)} <span style={{ color: '#888', fontSize: 12, fontWeight: 400 }}>· {data.dine_in_count || 0} orders</span></div>
                      </div>
                      <div style={{ padding: '10px 20px' }}>
                        <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>🥡 Online Takeaway</div>
                        <div style={{ fontWeight: 800, color: '#C9A84C' }}>£{Number(data.total_takeaway || 0).toFixed(2)} <span style={{ color: '#888', fontSize: 12, fontWeight: 400 }}>· {data.takeaway_count || 0} orders</span></div>
                      </div>
                    </div>
                  )}
                  <div style={{ padding: '10px 20px', background: '#fafafa', display:'flex', flexDirection:'column', gap:4, fontSize:13 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', color:'#555' }}><span>🍽️ Food</span><span>£{Number(data.total_food || 0).toFixed(2)}</span></div>
                    <div style={{ display:'flex', justifyContent:'space-between', color:'#555' }}><span>🍺 Drink</span><span>£{Number(data.total_drink || 0).toFixed(2)}</span></div>
                    <div style={{ display:'flex', justifyContent:'space-between', color:'#0D1B3E', fontWeight:600 }}><span>Service charge (12.5%)</span><span>£{Number(data.total_service || 0).toFixed(2)}</span></div>
                  </div>
                  <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', background: '#f8f8f8', fontWeight: 700 }}>
                    <span>Total ({data.order_count} orders · {data.total_covers} covers)</span>
                    <span style={{ color: '#e94560' }}>£{Number(data.total_sales || 0).toFixed(2)}</span>
                  </div>
                </>
              )}
              </div>
            </div>
          )}

          {tab === 'sales' && (data?.vouchers_sold?.count > 0 || data?.vouchers_redeemed?.count > 0) && (
            <div style={{ marginTop: 16, background: '#fdf6ec', border: '1px solid #f3e1bb', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', background: '#fbeed0', fontWeight: 700, color: '#5b4a2a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>🎁 Gift Vouchers</span>
                <span style={{ fontSize: 11, fontWeight: 400, color: '#8a7a4f' }}>tracked separately from food/drink</span>
              </div>
              <div style={{ padding: '12px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, fontSize: 13 }}>
                <div>
                  <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sold total ({data.vouchers_sold?.count || 0})</div>
                  <div style={{ fontWeight: 800, color: '#5b4a2a', fontSize: 18 }}>£{Number(data.vouchers_sold?.total || 0).toFixed(2)}</div>
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Via till (cash/card)</div>
                  <div style={{ fontWeight: 800, color: '#1a1a2e', fontSize: 18 }}>£{Number(data.vouchers_sold?.till_total || 0).toFixed(2)}</div>
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Online (Stripe)</div>
                  <div style={{ fontWeight: 800, color: '#1a1a2e', fontSize: 18 }}>£{Number(data.vouchers_sold?.stripe_total || 0).toFixed(2)}</div>
                </div>
              </div>
              {data?.vouchers_redeemed?.count > 0 && (
                <div style={{ padding: '10px 20px', borderTop: '1px solid #f3e1bb', background: 'white', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#666' }}>Redeemed against bills ({data.vouchers_redeemed.count})</span>
                  <span style={{ fontWeight: 700, color: '#8b5cf6' }}>−£{Number(data.vouchers_redeemed.total).toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          {tab === 'items' && (
            // Horizontal scroll wrapper, same pattern as sales table.
            <div style={{ background: 'white', borderRadius: 12, overflowX: 'auto', overflowY: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', WebkitOverflowScrolling: 'touch' }}>
              <div style={{ minWidth: 480 }}>
              <div style={{ padding: '12px 20px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', fontWeight: 700, fontSize: 13, color: '#555' }}>
                <span>Item</span><span>Price</span><span>Qty Sold</span><span style={{ textAlign: 'right' }}>Revenue</span>
              </div>
              {itemData.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No sales for this period</div>}
              {itemData.map((item, i) => (
                <div key={i} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{item.name}</span><span>£{Number(item.price).toFixed(2)}</span>
                  <span style={{ color: '#3b82f6', fontWeight: 700 }}>{item.qty_sold}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700, color: '#e94560' }}>£{Number(item.total_revenue).toFixed(2)}</span>
                </div>
              ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Print body builders ────────────────────────────────────────────
// Render the same data for either 80mm thermal or A4 full-page.
function buildSalesBody(data, period, from, to, settings, thermal) {
  const orders = data?.orders || [];
  const totalSales = Number(data?.total_sales || 0);
  const orderCount = data?.order_count || 0;
  const covers     = data?.total_covers || 0;
  const headerHtml = thermal
    ? `<div class="center" style="font-size:13px;font-weight:900;letter-spacing:1px;">${restaurantName(settings)}</div>
       <div class="center small">SALES REPORT</div>
       <div class="center small">${periodLabel(period, from, to)}</div>
       <div class="center small muted">${nowStamp()}</div>
       <hr class="divider"/>`
    : `<h1>${restaurantName(settings)} — Sales Report</h1>
       <div class="sub"><span class="pill">PERIOD</span> &nbsp; ${periodLabel(period, from, to)}</div>`;

  if (orders.length === 0) {
    return headerHtml + (thermal
      ? '<div class="center muted">No orders for this period</div>'
      : '<p class="muted" style="margin-top:8px;">No orders for this period.</p>');
  }

  // Headline cards (full page only)
  const cardsHtml = thermal ? '' : `
    <div class="grid-3" style="margin-top:8px;">
      <div class="card"><div class="lbl">Total sales</div><div class="val">${fmt(totalSales)}</div></div>
      <div class="card"><div class="lbl">Orders</div><div class="val">${fmtInt(orderCount)}</div></div>
      <div class="card"><div class="lbl">Covers</div><div class="val">${fmtInt(covers)}</div></div>
    </div>`;

  // Breakdown — dine-in / takeaway, food / drink / service
  const breakdownThermal = `
    <hr class="divider"/>
    <table>
      <tr><td>Dine-in (${data.dine_in_count || 0})</td><td class="right">${fmt(data.total_dine_in)}</td></tr>
      ${data.takeaway_count > 0 ? `<tr><td>🥡 Takeaway (${data.takeaway_count})</td><td class="right">${fmt(data.total_takeaway)}</td></tr>` : ''}
      <tr><td>Food</td><td class="right">${fmt(data.total_food)}</td></tr>
      <tr><td>Drink</td><td class="right">${fmt(data.total_drink)}</td></tr>
      <tr><td>Service charge (12.5%)</td><td class="right">${fmt(data.total_service)}</td></tr>
      <tr class="total-row"><td>TOTAL · ${orderCount} orders</td><td class="right">${fmt(totalSales)}</td></tr>
    </table>`;
  const breakdownFull = `
    <h2>Breakdown</h2>
    <table>
      <tr><td>Dine-in (${data.dine_in_count || 0} orders)</td><td class="right">${fmt(data.total_dine_in)}</td></tr>
      ${data.takeaway_count > 0 ? `<tr><td>🥡 Online Takeaway (${data.takeaway_count} orders)</td><td class="right">${fmt(data.total_takeaway)}</td></tr>` : ''}
      <tr><td>🍽️ Food</td><td class="right">${fmt(data.total_food)}</td></tr>
      <tr><td>🍺 Drink</td><td class="right">${fmt(data.total_drink)}</td></tr>
      <tr><td>Service charge (12.5%)</td><td class="right">${fmt(data.total_service)}</td></tr>
      <tr class="total-row"><td>Total sales (${orderCount} orders · ${covers} covers)</td><td class="right">${fmt(totalSales)}</td></tr>
    </table>`;

  // Orders list — thermal stacks each on its own row pair; full page is a real table
  const ordersThermal = `
    <hr class="divider"/>
    <div class="section-head">Orders</div>
    <table>
      ${orders.map(o => {
        const label = o.order_type === 'takeaway' ? '🥡 ' + (o.customer_name || 'Online') : `T${o.table_number || '-'}`;
        const method = o.method || (o.order_type === 'takeaway' ? 'Online' : '-');
        const amt = Number(o.paid_amount ?? o.total ?? 0);
        return `<tr><td>${label} · ${method}${o.covers ? ' · ' + o.covers + 'p' : ''}</td><td class="right">${fmt(amt)}</td></tr>`;
      }).join('')}
    </table>`;
  const ordersFull = `
    <h2>Orders (${orders.length})</h2>
    <table>
      <thead><tr><th>Table / Customer</th><th>Method</th><th class="right">Covers</th><th class="right">Subtotal</th><th class="right">Total</th></tr></thead>
      <tbody>
      ${orders.map(o => {
        const label = o.order_type === 'takeaway' ? '🥡 ' + (o.customer_name || 'Online') : `Table ${o.table_number || '-'}`;
        const method = o.method || (o.order_type === 'takeaway' ? 'Online' : '-');
        return `<tr>
          <td>${label}</td>
          <td>${method}</td>
          <td class="right">${o.covers || '-'}</td>
          <td class="right muted">${fmt(o.total)}</td>
          <td class="right" style="font-weight:700;">${fmt(o.paid_amount ?? o.total)}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;

  // Vouchers (optional)
  const vouchersThermal = (data?.vouchers_sold?.count || data?.vouchers_redeemed?.count) ? `
    <hr class="divider"/>
    <div class="section-head">🎁 Vouchers</div>
    <table>
      <tr><td>Sold (${data.vouchers_sold?.count || 0})</td><td class="right">${fmt(data.vouchers_sold?.total)}</td></tr>
      ${Number(data.vouchers_sold?.till_total)   > 0 ? `<tr><td>↳ via till</td><td class="right">${fmt(data.vouchers_sold.till_total)}</td></tr>` : ''}
      ${Number(data.vouchers_sold?.stripe_total) > 0 ? `<tr><td>↳ online</td><td class="right">${fmt(data.vouchers_sold.stripe_total)}</td></tr>` : ''}
      ${data.vouchers_redeemed?.count > 0 ? `<tr><td>Redeemed (${data.vouchers_redeemed.count})</td><td class="right">-${fmt(data.vouchers_redeemed.total)}</td></tr>` : ''}
    </table>` : '';
  const vouchersFull = (data?.vouchers_sold?.count || data?.vouchers_redeemed?.count) ? `
    <h2>🎁 Gift Vouchers</h2>
    <table>
      <tr><td>Sold total (${data.vouchers_sold?.count || 0})</td><td class="right">${fmt(data.vouchers_sold?.total)}</td></tr>
      ${Number(data.vouchers_sold?.till_total) > 0   ? `<tr><td>↳ via till (cash / card)</td><td class="right">${fmt(data.vouchers_sold.till_total)}</td></tr>` : ''}
      ${Number(data.vouchers_sold?.stripe_total) > 0 ? `<tr><td>↳ online (Stripe)</td><td class="right">${fmt(data.vouchers_sold.stripe_total)}</td></tr>` : ''}
      ${data.vouchers_redeemed?.count > 0 ? `<tr><td>Redeemed against bills (${data.vouchers_redeemed.count})</td><td class="right">-${fmt(data.vouchers_redeemed.total)}</td></tr>` : ''}
    </table>` : '';

  return thermal
    ? headerHtml + ordersThermal + breakdownThermal + vouchersThermal
    : headerHtml + cardsHtml + breakdownFull + ordersFull + vouchersFull;
}

function buildItemsBody(items, period, from, to, settings, thermal) {
  const total = items.reduce((s, it) => s + Number(it.total_revenue || 0), 0);
  const qty   = items.reduce((s, it) => s + Number(it.qty_sold || 0), 0);
  const header = thermal
    ? `<div class="center" style="font-size:13px;font-weight:900;letter-spacing:1px;">${restaurantName(settings)}</div>
       <div class="center small">ITEM SALES</div>
       <div class="center small">${periodLabel(period, from, to)}</div>
       <div class="center small muted">${nowStamp()}</div>
       <hr class="divider"/>`
    : `<h1>${restaurantName(settings)} — Item Sales</h1>
       <div class="sub"><span class="pill">PERIOD</span> &nbsp; ${periodLabel(period, from, to)}</div>`;

  if (items.length === 0) {
    return header + (thermal
      ? '<div class="center muted">No items sold for this period</div>'
      : '<p class="muted">No items sold for this period.</p>');
  }

  if (thermal) {
    return header + `
      <table>
        <tr><td>Item</td><td class="right">Qty</td><td class="right">£</td></tr>
        <tr><td colspan="3"><hr class="divider"/></td></tr>
        ${items.map(it => `
          <tr>
            <td>${escapeHtml(it.name)}</td>
            <td class="right">${fmtInt(it.qty_sold)}</td>
            <td class="right">${fmt(it.total_revenue)}</td>
          </tr>`).join('')}
        <tr class="total-row"><td colspan="2">TOTAL · ${fmtInt(qty)} items</td><td class="right">${fmt(total)}</td></tr>
      </table>`;
  }
  return header + `
    <div class="grid-2" style="margin-top:8px;">
      <div class="card"><div class="lbl">Items sold</div><div class="val">${fmtInt(qty)}</div></div>
      <div class="card"><div class="lbl">Total revenue</div><div class="val">${fmt(total)}</div></div>
    </div>
    <h2>Items (${items.length})</h2>
    <table>
      <thead><tr><th>Item</th><th class="right">Price</th><th class="right">Qty sold</th><th class="right">Revenue</th></tr></thead>
      <tbody>
        ${items.map(it => `
          <tr>
            <td>${escapeHtml(it.name)}</td>
            <td class="right muted">${fmt(it.price)}</td>
            <td class="right" style="color:#3b82f6;font-weight:700;">${fmtInt(it.qty_sold)}</td>
            <td class="right" style="font-weight:700;">${fmt(it.total_revenue)}</td>
          </tr>`).join('')}
        <tr class="total-row"><td colspan="3">Total</td><td class="right">${fmt(total)}</td></tr>
      </tbody>
    </table>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── ESC/POS line builders ─────────────────────────────────────────
// Emit the line DSL consumed by escPosPrint → server printService.
// 42 chars wide on 80mm. Plain ASCII — emoji + Thai are stripped on
// the server before bytes hit the printer.
function buildSalesLines(data, period, from, to, settings) {
  const lines = [];
  lines.push({ kind: 'h1', text: restaurantName(settings) });
  lines.push({ kind: 'h2', text: 'SALES REPORT' });
  lines.push({ kind: 'small', text: periodLabel(period, from, to) });
  lines.push({ kind: 'small', text: nowStamp() });
  lines.push({ kind: 'div' });
  if (!data?.orders?.length) {
    lines.push({ kind: 'small', text: 'No orders for this period' });
    return lines;
  }
  // Orders list
  for (const o of data.orders) {
    const label = o.order_type === 'takeaway'
      ? 'TA ' + (o.customer_name || 'Online')
      : `T${o.table_number || '-'}`;
    const method = o.method || (o.order_type === 'takeaway' ? 'Online' : '-');
    const amt = Number(o.paid_amount ?? o.total ?? 0);
    const lbl = `${label}  ${method}${o.covers ? '  ' + o.covers + 'p' : ''}`;
    lines.push({ kind: 'row', left: lbl, right: fmt(amt) });
  }
  lines.push({ kind: 'div' });
  lines.push({ kind: 'row', left: `Dine-in (${data.dine_in_count || 0})`, right: fmt(data.total_dine_in) });
  if (data.takeaway_count > 0)
    lines.push({ kind: 'row', left: `Takeaway (${data.takeaway_count})`, right: fmt(data.total_takeaway) });
  lines.push({ kind: 'row', left: 'Food',  right: fmt(data.total_food) });
  lines.push({ kind: 'row', left: 'Drink', right: fmt(data.total_drink) });
  lines.push({ kind: 'row', left: 'Service charge (12.5%)', right: fmt(data.total_service) });
  lines.push({ kind: 'total', left: `TOTAL (${data.order_count || 0} ord)`, right: fmt(data.total_sales) });
  if (data?.vouchers_sold?.count > 0 || data?.vouchers_redeemed?.count > 0) {
    lines.push({ kind: 'div' });
    lines.push({ kind: 'h2', text: 'GIFT VOUCHERS' });
    lines.push({ kind: 'row', left: `Sold (${data.vouchers_sold?.count || 0})`, right: fmt(data.vouchers_sold?.total) });
    if (Number(data.vouchers_sold?.till_total) > 0)
      lines.push({ kind: 'row', left: ' via till', right: fmt(data.vouchers_sold.till_total) });
    if (Number(data.vouchers_sold?.stripe_total) > 0)
      lines.push({ kind: 'row', left: ' online',   right: fmt(data.vouchers_sold.stripe_total) });
    if (data.vouchers_redeemed?.count > 0)
      lines.push({ kind: 'row', left: `Redeemed (${data.vouchers_redeemed.count})`, right: '-' + fmt(data.vouchers_redeemed.total) });
  }
  return lines;
}

function buildItemsLines(items, period, from, to, settings) {
  const lines = [];
  lines.push({ kind: 'h1', text: restaurantName(settings) });
  lines.push({ kind: 'h2', text: 'ITEM SALES' });
  lines.push({ kind: 'small', text: periodLabel(period, from, to) });
  lines.push({ kind: 'small', text: nowStamp() });
  lines.push({ kind: 'div' });
  if (!items?.length) {
    lines.push({ kind: 'small', text: 'No items sold for this period' });
    return lines;
  }
  const totalQty = items.reduce((s, it) => s + Number(it.qty_sold || 0), 0);
  const totalRev = items.reduce((s, it) => s + Number(it.total_revenue || 0), 0);
  for (const it of items) {
    lines.push({ kind: 'row',
      left: `${fmtInt(it.qty_sold)}x ${String(it.name || '').slice(0, 28)}`,
      right: fmt(it.total_revenue) });
  }
  lines.push({ kind: 'total', left: `TOTAL (${fmtInt(totalQty)} items)`, right: fmt(totalRev) });
  return lines;
}
