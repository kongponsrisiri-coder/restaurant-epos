import { useState, useEffect } from 'react';
import { getBarOrders, updateItemStatus } from '../api';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../api';

function Timer({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const color = mins >= 10 ? '#ef4444' : mins >= 5 ? '#eab308' : '#22c55e';

  return (
    <span style={{ fontSize: 13, fontWeight: 800, color, fontFamily: 'monospace' }}>
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}

export default function BarScreen() {
  const [orders, setOrders] = useState([]);
  const [completedItems, setCompletedItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('bar');

  const fetchOrders = async () => {
    try {
      const data = await getBarOrders();
      setOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCompleted = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/bar/completed`);
      const data = await res.json();
      setCompletedItems(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchOrders();
    fetchCompleted();
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socket.on('new_order_items', () => fetchOrders());
    socket.on('item_status_changed', () => { fetchOrders(); fetchCompleted(); });
    socket.on('order_closed', () => { fetchOrders(); fetchCompleted(); });
    const interval = setInterval(() => { fetchOrders(); fetchCompleted(); }, 15000);
    return () => { socket.disconnect(); clearInterval(interval); };
  }, []);

  const markDone = async (itemId) => {
    await updateItemStatus(itemId, 'served');
    fetchOrders();
    fetchCompleted();
  };

  const getCookTime = (firedAt, servedAt) => {
    if (!firedAt || !servedAt) return '—';
    const diff = Math.floor((new Date(servedAt).getTime() - new Date(firedAt).getTime()) / 60000);
    if (diff < 1) return '< 1 min';
    return `${diff} min${diff > 1 ? 's' : ''}`;
  };

  // Group completed by order
  const completedByOrder = {};
  completedItems.forEach(item => {
    const key = item.order_id;
    if (!completedByOrder[key]) {
      completedByOrder[key] = {
        order_id: item.order_id,
        table_number: item.table_number,
        covers: item.covers,
        items: []
      };
    }
    completedByOrder[key].items.push(item);
  });

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a1a' }}>
      <div style={{ color: 'white', fontSize: 18 }}>Loading bar orders...</div>
    </div>
  );

  return (
    <div style={{ background: '#0a0a1a', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setTab('bar')} style={{
            padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 15,
            background: tab === 'bar' ? '#1e40af' : '#1e293b', color: 'white'
          }}>
            🍹 Bar
            {orders.reduce((s, o) => s + o.items.length, 0) > 0 && (
              <span style={{ background: 'white', color: '#1e40af', borderRadius: 20, padding: '2px 8px', marginLeft: 8, fontSize: 13 }}>
                {orders.reduce((s, o) => s + o.items.length, 0)}
              </span>
            )}
          </button>
          <button onClick={() => { setTab('completed'); fetchCompleted(); }} style={{
            padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 15,
            background: tab === 'completed' ? '#22c55e' : '#1e293b', color: 'white'
          }}>
            ✅ Completed
            {completedItems.length > 0 && (
              <span style={{ background: 'white', color: '#22c55e', borderRadius: 20, padding: '2px 8px', marginLeft: 8, fontSize: 13 }}>
                {completedItems.length}
              </span>
            )}
          </button>
        </div>
        <button onClick={() => { fetchOrders(); fetchCompleted(); }} style={{ background: '#1e293b', color: 'white', border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}>
          Refresh
        </button>
      </div>

      {/* Timer legend */}
      {tab === 'bar' && (
        <div style={{ padding: '8px 20px', display: 'flex', gap: 20, borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
          {[
            { color: '#22c55e', label: '< 5 mins' },
            { color: '#eab308', label: '5-10 mins' },
            { color: '#ef4444', label: '> 10 mins' }
          ].map(s => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: s.color }} />
              <span style={{ color: '#aaa', fontSize: 12 }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ─── BAR TAB ─── */}
      {tab === 'bar' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 16 }}>
          {orders.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>
              🍹 Bar is clear — no drinks to prepare!
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {orders.map(order => (
                <div key={order.id} style={{ background: '#1a1a2e', borderRadius: 16, overflow: 'hidden', border: '1px solid #1e293b' }}>
                  <div style={{ background: '#1e40af', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ color: 'white', fontWeight: 800, fontSize: 20 }}>Table {order.table_number}</div>
                    <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>Order #{order.id}</span>
                  </div>
                  <div style={{ padding: 12 }}>
                    {order.items.map(item => (
                      <div key={item.id} style={{ background: '#0f172a', borderRadius: 10, padding: '12px', marginBottom: 8, border: '1px solid #1e40af' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ color: 'white', fontWeight: 700, fontSize: 16 }}>
                              {item.quantity}× {item.name}
                            </div>
                            {item.notes && <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>{item.notes}</div>}
                            {item.item_note && <div style={{ color: '#60a5fa', fontSize: 12, fontWeight: 600, marginTop: 2 }}>📝 {item.item_note}</div>}
                            <div style={{ marginTop: 6 }}>
                              <Timer startedAt={item.cooking_started_at} />
                            </div>
                          </div>
                          <button onClick={() => markDone(item.id)} style={{
                            background: '#1e40af', color: 'white', border: 'none',
                            borderRadius: 8, padding: '10px 16px', cursor: 'pointer',
                            fontWeight: 700, fontSize: 14
                          }}>
                            ✓ Ready
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── COMPLETED TAB ─── */}
      {tab === 'completed' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ color: 'white', fontSize: 16, fontWeight: 700 }}>
              Today's drinks served — {completedItems.length} items
            </div>
            <button onClick={fetchCompleted} style={{ background: '#1e293b', color: 'white', border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
              Refresh
            </button>
          </div>

          {Object.keys(completedByOrder).length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>
              No completed drinks yet today
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {Object.values(completedByOrder).map(group => (
                <div key={group.order_id} style={{ background: '#1a1a2e', borderRadius: 16, overflow: 'hidden' }}>
                  <div style={{ background: '#1e293b', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>
                      Table {group.table_number}
                      {group.covers && <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 8, opacity: 0.7 }}>{group.covers} cvr</span>}
                    </div>
                    <div style={{ color: '#aaa', fontSize: 13 }}>Order #{group.order_id}</div>
                  </div>
                  <div style={{ padding: 12 }}>
                    {group.items.map(item => (
                      <div key={item.id} style={{ background: '#0f172a', borderRadius: 10, padding: '10px 12px', marginBottom: 8, border: '1px solid #1e293b' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>
                              ✅ {item.quantity}× {item.name}
                            </div>
                            {item.notes && <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>{item.notes}</div>}
                            {item.item_note && <div style={{ color: '#60a5fa', fontSize: 11, marginTop: 2 }}>📝 {item.item_note}</div>}
                          </div>
                          <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                            {item.fired_at && (
                              <div style={{ color: '#eab308', fontSize: 11 }}>
                                ⏱ {getCookTime(item.fired_at, item.served_at)}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}