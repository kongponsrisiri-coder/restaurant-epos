import { useState, useEffect } from 'react';
import { getSummaryReport, getItemSalesReport } from '../../api';
import { getDateRange } from './shared';

export default function ReportsSection() {
  const [tab, setTab] = useState('sales');
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState(null);
  const [itemData, setItemData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { from, to } = getDateRange(period);
    setLoading(true);
    Promise.all([getSummaryReport(from, to), getItemSalesReport(from, to)]).then(([s, i]) => {
      setData(s); setItemData(i); setLoading(false);
    });
  }, [period]);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Reports</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['today', 'weekly', 'monthly'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '6px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, textTransform: 'capitalize', background: period === p ? '#1a1a2e' : '#e0e0e0', color: period === p ? 'white' : '#555' }}>{p}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['sales', 'items'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, background: tab === t ? '#e94560' : '#f0f0f0', color: tab === t ? 'white' : '#555' }}>
            {t === 'sales' ? 'Sales Report' : 'Item Sales'}
          </button>
        ))}
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          {tab === 'sales' && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ padding: '12px 20px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 80px', fontWeight: 700, fontSize: 13, color: '#555' }}>
                <span>Order #</span><span>Table</span><span>Method</span><span>Covers</span><span style={{ textAlign: 'right' }}>Total</span>
              </div>
              {data?.orders?.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No orders for this period</div>}
              {data?.orders?.map(order => (
                <div key={order.id} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 80px', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ color: '#888' }}>#{order.id}</span><span>Table {order.table_number}</span><span>{order.method || '-'}</span><span>{order.covers || '-'}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>£{(order.total || 0).toFixed(2)}</span>
                </div>
              ))}
              {data?.orders?.length > 0 && (
                <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', background: '#f8f8f8', fontWeight: 700 }}>
                  <span>Total ({data.order_count} orders · {data.total_covers} covers)</span>
                  <span style={{ color: '#e94560' }}>£{(data.total_sales || 0).toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          {tab === 'items' && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
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
          )}
        </>
      )}
    </div>
  );
}
