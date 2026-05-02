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
  // Track which items are marked ready (cooked) per order
  const [readyItems, setReadyItems] = useState({});

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

  const markReady = (orderId, itemId) => {
    setReadyItems(prev => ({
      ...prev,
      [orderId]: [...(prev[orderId] || []), itemId]
    }));
  };

  const unmarkReady = (orderId, itemId) => {
    setReadyItems(prev => ({
      ...prev,
      [orderId]: (prev[orderId] || []).filter(id => id !== itemId)
    }));
  };

  const serveTable = async (order) => {
    const allItemIds = order.items.map(i => i.id);
    try {
      await Promise.all(allItemIds.map(id => updateItemStatus(id, 'served')));
      setReadyItems(prev => {
        const updated = { ...prev };
        delete updated[order.id];
        return updated;
      });
      fetchOrders();
      fetchCompleted();
    } catch (err) {
      alert('Failed to serve table!');
    }
  };

  const getCookTime = (firedAt, servedAt) => {
    if (!firedAt || !servedAt) return '—';
    const diff = Math.floor((new Date(servedAt).getTime() - new Date(firedAt).getTime()) / 60000);
    if (diff < 1) return '< 1 min';
    return `${diff} min${diff > 1 ? 's' : ''}`;
  };

  const completedByOrder = {};
  completedItems.forEach(item => {
    const key = item.order_id;
    if (!completedByOrder[key]) {
      completedByOrder[key] = { order_id: item.order_id, table_number: item.table_number, covers: item.covers, items: [] };
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
          <div style={{ marginLeft: 'auto', color: '#555', fontSize: 12 }}>
            Tap ✓ Ready when drink is made · Tap 🍹 Serve Table to deliver all
          </div>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {orders.map(order => {
                const orderReadyIds = readyItems[order.id] || [];
                const allReady = order.items.length > 0 && order.items.every(i => orderReadyIds.includes(i.id));
                const someReady = orderReadyIds.length > 0;

                return (
                  <div key={order.id} style={{
                    background: '#1a1a2e', borderRadius: 16, overflow: 'hidden',
                    border: `2px solid ${allReady ? '#22c55e' : someReady ? '#eab308' : '#1e293b'}`,
                    boxShadow: allReady ? '0 0 20px rgba(34,197,94,0.3)' : 'none',
                    transition: 'all 0.3s'
                  }}>
                    {/* Table header */}
                    <div style={{
                      background: allReady ? '#166534' : '#1e40af',
                      padding: '12px 16px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <div style={{ color: 'white', fontWeight: 800, fontSize: 20 }}>
                        Table {order.table_number}
                        {order.covers && <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 8, opacity: 0.8 }}>{order.covers} cvr</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
                          {orderReadyIds.length}/{order.items.length} ready
                        </span>
                      </div>
                    </div>

                    {/* Items */}
                    <div style={{ padding: 12 }}>
                      {order.items.map(item => {
                        const isReady = orderReadyIds.includes(item.id);
                        return (
                          <div key={item.id} style={{
                            background: isReady ? '#052e16' : '#0f172a',
                            borderRadius: 10, padding: '12px', marginBottom: 8,
                            border: `2px solid ${isReady ? '#22c55e' : '#1e40af'}`,
                            transition: 'all 0.2s'
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ color: isReady ? '#4ade80' : 'white', fontWeight: 700, fontSize: 16 }}>
                                  {isReady ? '✅' : '🍹'} {item.quantity}× {item.name}
                                </div>
                                {item.notes && <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>{item.notes}</div>}
                                {item.item_note && <div style={{ color: '#60a5fa', fontSize: 12, fontWeight: 600, marginTop: 2 }}>📝 {item.item_note}</div>}
                                {!isReady && (
                                  <div style={{ marginTop: 6 }}>
                                    <Timer startedAt={item.cooking_started_at} />
                                  </div>
                                )}
                              </div>
                              {!isReady ? (
                                <button onClick={() => markReady(order.id, item.id)} style={{
                                  background: '#1e40af', color: 'white', border: 'none',
                                  borderRadius: 8, padding: '10px 16px', cursor: 'pointer',
                                  fontWeight: 700, fontSize: 14, marginLeft: 8
                                }}>
                                  ✓ Ready
                                </button>
                              ) : (
                                <button onClick={() => unmarkReady(order.id, item.id)} style={{
                                  background: '#166534', color: '#4ade80', border: '1px solid #22c55e',
                                  borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
                                  fontWeight: 600, fontSize: 12, marginLeft: 8
                                }}>
                                  Undo
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Serve Table button — shows when ALL items ready */}
                    {allReady && (
                      <div style={{ padding: '0 12px 12px' }}>
                        <button onClick={() => serveTable(order)} style={{
                          width: '100%', padding: '16px', borderRadius: 12, border: 'none',
                          background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                          color: 'white', fontSize: 18, fontWeight: 800,
                          cursor: 'pointer',
                          boxShadow: '0 4px 16px rgba(34,197,94,0.4)',
                          animation: 'pulse 1.5s infinite'
                        }}>
                          🍹 Serve Table {order.table_number}!
                        </button>
                      </div>
                    )}

                    {/* Partial ready indicator */}
                    {someReady && !allReady && (
                      <div style={{ padding: '0 12px 12px' }}>
                        <div style={{ background: '#1e293b', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: '#334155', borderRadius: 3 }}>
                            <div style={{ width: `${(orderReadyIds.length / order.items.length) * 100}%`, height: '100%', background: '#eab308', borderRadius: 3, transition: 'width 0.3s' }} />
                          </div>
                          <span style={{ color: '#eab308', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {orderReadyIds.length}/{order.items.length} ready
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>No completed drinks yet today</div>
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
                            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>✅ {item.quantity}× {item.name}</div>
                            {item.notes && <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>{item.notes}</div>}
                          </div>
                          <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                            {item.fired_at && <div style={{ color: '#eab308', fontSize: 11 }}>⏱ {getCookTime(item.fired_at, item.served_at)}</div>}
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

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
      `}</style>
    </div>
  );
}