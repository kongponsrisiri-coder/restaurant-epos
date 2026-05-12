import { useState, useEffect } from 'react';
import { getOrders, getOrder, updateItemStatus, setTakeawayStatus } from '../api';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../api';
import { orderShortLabel, orderSubLabel, orderShortLabelPlain, isTakeaway } from '../utils/orderLabel';

// Order title helper. MUST live at module scope so every tab (Kitchen,
// Pass, Completed) can reference it. The earlier version was declared
// inside the Kitchen tab's .map() callback, which Chromium block-scoped
// (per strict-mode spec) while Safari/WebKit hoisted it under legacy
// Web Compat rules — that's why the Pass tab rendered fine on iPad
// but blew up to a blank/white surface on Mac (Electron) and Chrome.
function OrderHeading({ order }) {
  const sub = orderSubLabel(order);
  return (
    <span>
      {orderShortLabel(order)}
      {sub && <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 8, opacity: 0.9 }}>· {sub}</span>}
    </span>
  );
}

const playSound = (type) => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    if (type === 'starters') {
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      oscillator.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.4);
    } else if (type === 'mains') {
      oscillator.frequency.setValueAtTime(660, ctx.currentTime);
      oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
      oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.3);
      gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.5);
    } else if (type === 'desserts') {
      oscillator.frequency.setValueAtTime(550, ctx.currentTime);
      oscillator.frequency.setValueAtTime(770, ctx.currentTime + 0.15);
      oscillator.frequency.setValueAtTime(990, ctx.currentTime + 0.3);
      gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.6);
    } else {
      oscillator.frequency.setValueAtTime(750, ctx.currentTime);
      gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.3);
    }
  } catch (err) {
    console.log('Audio not supported');
  }
};

const COURSE_LABELS = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };
const COURSE_COLORS = { 1: '#3b82f6', 2: '#e94560', 3: '#8b5cf6', 4: '#22c55e' };

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
    <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'monospace', minWidth: 64, textAlign: 'right' }}>
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </div>
  );
}

// Item name display — shows English + alt language if enabled
function ItemName({ item, showAlt, altLang }) {
  return (
    <div>
      <div style={{ color: 'white', fontWeight: 800, fontSize: 20 }}>
        {item.quantity}× {item.name}
      </div>
      {showAlt && item.name_alt && (
        <div style={{ color: '#fbbf24', fontWeight: 700, fontSize: 16, marginTop: 2 }}>
          {item.quantity}× {item.name_alt}
        </div>
      )}
    </div>
  );
}

export default function KitchenScreen() {
  const [orders, setOrders] = useState([]);
  const [completedItems, setCompletedItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('kitchen');
  const [filter, setFilter] = useState('all');
  const [notification, setNotification] = useState(null);
  const [showAlt, setShowAlt] = useState(false);
  const [altLang, setAltLang] = useState('ภาษาไทย');
  // SEPOS — Direct Mode: cooked items stay on the Kitchen tab with a tick
  // instead of jumping to a separate Pass tab. Aimed at smaller restaurants
  // where the chef hands food straight to the floor.
  const [directMode, setDirectMode] = useState(false);

  // Load language + mode preferences from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('kitchen_show_alt');
    const savedLang = localStorage.getItem('kitchen_alt_lang');
    const savedDirect = localStorage.getItem('kitchen_direct_mode');
    if (saved === 'true') setShowAlt(true);
    if (savedLang) setAltLang(savedLang);
    if (savedDirect === '1') setDirectMode(true);
  }, []);
  useEffect(() => {
    localStorage.setItem('kitchen_direct_mode', directMode ? '1' : '0');
    // If user enables Direct Mode while looking at Pass, hop back to Kitchen
    if (directMode && tab === 'pass') setTab('kitchen');
  }, [directMode, tab]);

  const toggleAlt = () => {
    const next = !showAlt;
    setShowAlt(next);
    localStorage.setItem('kitchen_show_alt', String(next));
  };

  const fetchOrders = async () => {
    try {
      const openOrders = await getOrders();
      const detailed = await Promise.all(openOrders.map(o => getOrder(o.id)));
      const sorted = detailed
        .filter(o => o.items && o.items.some(i => !i.voided && i.status !== 'served' && !i.is_bar))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      setOrders(sorted);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCompleted = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/kitchen/completed`);
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
    socket.on('course_fired', (data) => {
      fetchOrders();
      if (data.order) {
        const courseNum = data.course;
        const courseLabel = COURSE_LABELS[courseNum] || `Course ${courseNum}`;
        if (courseNum === 1) playSound('starters');
        else if (courseNum === 2) playSound('mains');
        else if (courseNum === 3) playSound('desserts');
        else playSound('default');
        setNotification(`🔥 ${orderShortLabelPlain(data.order)} — ${courseLabel} fired!`);
        setTimeout(() => setNotification(null), 6000);
      }
    });
    const interval = setInterval(() => { fetchOrders(); fetchCompleted(); }, 15000);
    return () => { socket.disconnect(); clearInterval(interval); };
  }, []);

  const markCooked = async (itemId) => {
    await updateItemStatus(itemId, 'cooked');
    fetchOrders();
  };

  const markServed = async (itemId) => {
    await updateItemStatus(itemId, 'served');
    fetchOrders();
    fetchCompleted();
  };

  const getTimeAgo = (createdAt) => {
    const diff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    if (diff < 1) return 'Just now';
    if (diff === 1) return '1 min';
    return `${diff} mins`;
  };

  const getCookTime = (firedAt, servedAt) => {
    if (!firedAt || !servedAt) return '—';
    const diff = Math.floor((new Date(servedAt).getTime() - new Date(firedAt).getTime()) / 60000);
    if (diff < 1) return '< 1 min';
    return `${diff} min${diff > 1 ? 's' : ''}`;
  };

  const cookingCount = orders.reduce((s, o) =>
    s + o.items.filter(i => !i.voided && i.is_fired && i.status === 'cooking' && !i.is_bar).length, 0);

  const passOrders = orders
    .map(o => ({ ...o, items: o.items.filter(i => !i.voided && i.status !== 'served' && !i.is_bar) }))
    .filter(o => o.items.length > 0);

  const completedByOrder = {};
  completedItems.forEach(item => {
    const key = item.order_id;
    if (!completedByOrder[key]) {
      completedByOrder[key] = { order_id: item.order_id, table_number: item.table_number, covers: item.covers, items: [], order_type: item.order_type, customer_name: item.customer_name, pickup_time: item.pickup_time };
    }
    completedByOrder[key].items.push(item);
  });

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#111' }}>
      <div style={{ color: 'white', fontSize: 18 }}>Loading kitchen...</div>
    </div>
  );

  return (
    <div style={{ background: '#111', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      <style>{`
        @keyframes pendingGlow {
          0%, 100% { border-color: #f59e0b; box-shadow: 0 0 0 0 rgba(245,158,11,0); }
          50% { border-color: #fbbf24; box-shadow: 0 0 12px rgba(245,158,11,0.5); }
        }
        @keyframes notificationPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }
      `}</style>

      {/* Notification */}
      {notification && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: '#e94560', color: 'white', padding: '16px 24px',
          borderRadius: 12, fontSize: 18, fontWeight: 800,
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
          animation: 'notificationPulse 0.5s ease'
        }}>
          {notification}
        </div>
      )}

      {/* Header */}
      <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setTab('kitchen')} style={{
            padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 15,
            background: tab === 'kitchen' ? '#e94560' : '#333', color: 'white'
          }}>
            🍳 Kitchen
            {cookingCount > 0 && (
              <span style={{ background: 'white', color: '#e94560', borderRadius: 20, padding: '2px 8px', marginLeft: 8, fontSize: 13 }}>
                {cookingCount}
              </span>
            )}
          </button>
          {!directMode && (
            <button onClick={() => setTab('pass')} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: 15,
              background: tab === 'pass' ? '#8b5cf6' : '#333', color: 'white'
            }}>
              🍽️ Pass
            </button>
          )}
          <button onClick={() => { setTab('completed'); fetchCompleted(); }} style={{
            padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 15,
            background: tab === 'completed' ? '#22c55e' : '#333', color: 'white'
          }}>
            ✅ Done
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Language toggle */}
          <button onClick={toggleAlt} style={{
            padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 800, fontSize: 14,
            background: showAlt ? '#C9A84C' : '#333',
            color: showAlt ? '#0D1B3E' : '#aaa',
            transition: 'all 0.2s'
          }}>
            {showAlt ? `🌐 EN + ภาษา` : `🌐 EN only`}
          </button>

          {/* Direct Mode toggle — cooked items stay on Kitchen tab when enabled */}
          <button onClick={() => setDirectMode(d => !d)} title={directMode ? 'Cooked items stay on Kitchen until you tap "Off Kitchen"' : 'Cooked items move to the Pass tab'} style={{
            padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontWeight: 800, fontSize: 14,
            background: directMode ? '#22c55e' : '#333',
            color: directMode ? 'white' : '#aaa',
            transition: 'all 0.2s'
          }}>
            {directMode ? '✓ Direct mode' : '🍽️ Pass mode'}
          </button>

          {tab === 'kitchen' && (
            <div style={{ display: 'flex', gap: 6 }}>
              {['all', '1', '2', '3', '4'].map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{
                  padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: 12,
                  background: filter === f ? '#e94560' : '#333', color: 'white'
                }}>
                  {f === 'all' ? 'All' : COURSE_LABELS[f]}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => { fetchOrders(); fetchCompleted(); }} style={{ background: '#333', color: 'white', border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}>
            ↻
          </button>
        </div>
      </div>

      {/* Legend */}
      <div style={{ padding: '6px 20px', display: 'flex', gap: 20, borderBottom: '1px solid #222', flexWrap: 'wrap', flexShrink: 0, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#f59e0b' }} />
          <span style={{ color: '#aaa', fontSize: 12 }}>⏳ Pending</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#1e3a5f' }} />
          <span style={{ color: '#aaa', fontSize: 12 }}>🔥 Cooking</span>
        </div>
        {[
          { color: '#22c55e', label: '< 5 mins' },
          { color: '#eab308', label: '5-10 mins' },
          { color: '#ef4444', label: '> 10 mins' },
        ].map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: s.color }} />
            <span style={{ color: '#aaa', fontSize: 12 }}>{s.label}</span>
          </div>
        ))}
        {showAlt && (
          <div style={{ marginLeft: 'auto', background: '#C9A84C', color: '#0D1B3E', padding: '3px 12px', borderRadius: 20, fontSize: 12, fontWeight: 800 }}>
            🌐 Bilingual Mode ON
          </div>
        )}
      </div>

      {/* ─── KITCHEN TAB ─── */}
      {tab === 'kitchen' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 16, background: '#111' }}>
          {orders.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>✅ Kitchen is clear!</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              {orders.map(order => {
                // In Direct Mode, cooked items also live on the Kitchen tab
                // (they stay ticked until the chef marks the whole order off).
                const kitchenFiltered = order.items.filter(i => !i.voided && i.status !== 'served' && !i.is_bar && (directMode || i.status !== 'cooked'));

// Apply course filter to all three lists
const upcoming = kitchenFiltered.filter(i => !i.is_fired && (filter === 'all' || String(i.course || 1) === filter));
const cooking  = kitchenFiltered.filter(i => i.is_fired && i.status !== 'cooked' && (filter === 'all' || String(i.course || 1) === filter));
const ready    = directMode ? kitchenFiltered.filter(i => i.status === 'cooked' && (filter === 'all' || String(i.course || 1) === filter)) : [];

if (upcoming.length === 0 && cooking.length === 0 && ready.length === 0) return null;

// Direct Mode: when everything in scope is "ready" (cooked) and nothing is
// still cooking or pending, surface a big "Off Kitchen" button so the chef
// can send the whole order out in one tap.
const allReadyForOff = directMode && ready.length > 0 && cooking.length === 0 && upcoming.length === 0;

                return (
                  <div key={order.id} style={{ background: '#1a1a1a', borderRadius: 16, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
                    <div style={{ background: allReadyForOff ? '#22c55e' : '#e94560', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ color: 'white', fontWeight: 800, fontSize: 24, flex: 1, minWidth: 0 }}>
                        <OrderHeading order={order} />
                      </div>
                      {allReadyForOff && (
                        <button
                          onClick={async () => {
                            // Mark every ready item as served — one shot.
                            for (const it of ready) {
                              try { await updateItemStatus(it.id, 'served'); } catch {}
                            }
                            // For takeaway orders, also collapse the lifecycle to
                            // 'collected' so the order closes and lands in reports
                            // even if the auto-collect path missed any items.
                            if (isTakeaway(order)) {
                              try { await setTakeawayStatus(order.id, 'collected'); } catch {}
                            }
                            fetchOrders();
                          }}
                          style={{
                            background: 'white', color: '#22c55e', border: 'none', borderRadius: 8,
                            padding: '8px 14px', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                            whiteSpace: 'nowrap', flexShrink: 0,
                          }}
                        >✓ Off Kitchen ({ready.length})</button>
                      )}
                      {isTakeaway(order) && !allReadyForOff && (
                        // Explicit Collected button for takeaway orders on the
                        // Kitchen tab — always reachable in Pass mode AND Direct
                        // mode, even before every item is served. Closes the
                        // order, stamps closed_at, marks any unserved items
                        // served, and the order drops off the kitchen.
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Mark Online Order #${order.id} as collected? This closes the order and counts it as a sale.`)) return;
                            try {
                              await setTakeawayStatus(order.id, 'collected');
                              await fetchOrders();
                            } catch (err) {
                              window.alert('Could not mark collected: ' + (err?.message || 'unknown error'));
                            }
                          }}
                          style={{
                            background: '#22c55e', color: 'white', border: 'none', borderRadius: 8,
                            padding: '8px 14px', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                            whiteSpace: 'nowrap', flexShrink: 0,
                          }}
                        >🥡 Collected</button>
                      )}
                      <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                        #{order.id} · {getTimeAgo(order.created_at)}
                      </span>
                    </div>

                    <div style={{ padding: 12 }}>

                      <div style={{ padding: 12 }}>

  {/* ── READY (Direct Mode only — cooked items waiting to go out) ── */}
  {ready.length > 0 && (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: '#22c55e', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>
        ✓ Ready to go ({ready.length})
      </div>
      {ready.map(item => (
        <div key={item.id} style={{
          background: '#0f2922', borderRadius: 10, padding: '10px 12px', marginBottom: 8,
          border: '2px solid #22c55e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ItemName item={item} showAlt={showAlt} altLang={altLang} />
            {item.notes && <div style={{ color: '#86efac', fontSize: 12, marginTop: 2 }}>{item.notes}</div>}
          </div>
          <button
            onClick={() => markServed(item.id)}
            title="Mark this single item as out"
            style={{
              background: '#22c55e', color: 'white', border: 'none', borderRadius: 8,
              padding: '6px 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer', flexShrink: 0
            }}
          >Out ✓</button>
        </div>
      ))}
    </div>
  )}

  {/* ── COOKING FIRST ── */}
  {cooking.length > 0 && (
    <div>
      <div style={{ color: '#e94560', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>
        🔥 Now Cooking
      </div>
      {(() => {
        const byCourse = {};
        cooking.forEach(item => {
          const c = item.course || 1;
          if (!byCourse[c]) byCourse[c] = [];
          byCourse[c].push(item);
        });
        return Object.keys(byCourse).sort().map(course => (
          <div key={course} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: COURSE_COLORS[course] }} />
              <span style={{ color: COURSE_COLORS[course], fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                {COURSE_LABELS[course]}
              </span>
            </div>
            {byCourse[course].map(item => (
              <div key={item.id} style={{ background: '#1e3a5f', borderRadius: 10, padding: '12px', marginBottom: 8, border: '2px solid #3b82f6' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <ItemName item={item} showAlt={showAlt} altLang={altLang} />
                    {item.notes && <div style={{ color: '#93c5fd', fontSize: 13, marginTop: 3 }}>{item.notes}</div>}
                    {item.item_note && <div style={{ color: '#e94560', fontSize: 13, fontWeight: 700, marginTop: 3 }}>📝 {item.item_note}</div>}
                    {item.resend_reason && (
                      <div style={{
                        display:'inline-block', marginTop:6, padding:'3px 10px',
                        background:'#fbbf24', color:'#1a1a2e', borderRadius:6,
                        fontSize:11, fontWeight:800, letterSpacing:0.5
                      }}>🔄 RESEND · {item.resend_reason}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                    <Timer startedAt={item.fired_at || item.cooking_started_at} />
                    <button onClick={() => markCooked(item.id)} style={{
                      background: '#22c55e', color: 'white', border: 'none',
                      borderRadius: 8, padding: '10px 18px', cursor: 'pointer',
                      fontWeight: 800, fontSize: 15
                    }}>
                      ✓ Cooked
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ));
      })()}
    </div>
  )}

  {cooking.length > 0 && upcoming.length > 0 && (
    <div style={{ borderTop: '1px solid #333', marginBottom: 12, marginTop: 4 }} />
  )}

  {/* ── PENDING AT BOTTOM ── */}
  {upcoming.length > 0 && (
    <div style={{
      marginTop: 4,
      background: '#2d1f00',
      borderRadius: 10, padding: '10px 12px',
      border: '2px solid #f59e0b',
      animation: 'pendingGlow 2s infinite'
    }}>
      <div style={{
        color: '#fbbf24', fontSize: 11, fontWeight: 800,
        textTransform: 'uppercase', marginBottom: 10,
        letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 8
      }}>
        <span style={{ background: '#f59e0b', color: '#111', padding: '3px 10px', borderRadius: 20, fontSize: 11 }}>
          ⏳ PENDING — WAITING TO FIRE
        </span>
        <span style={{ color: '#6b7280', fontSize: 11 }}>{upcoming.length} item{upcoming.length > 1 ? 's' : ''}</span>
      </div>
      {(() => {
        const byCourse = {};
        upcoming.forEach(item => {
          const c = item.course || 1;
          if (!byCourse[c]) byCourse[c] = [];
          byCourse[c].push(item);
        });
        return Object.keys(byCourse).sort().map(course => (
          <div key={course} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: COURSE_COLORS[course] }} />
              <span style={{ color: COURSE_COLORS[course], fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
                {COURSE_LABELS[course]}
              </span>
            </div>
            {byCourse[course].map(item => (
              <div key={item.id} style={{ background: '#3d2800', borderRadius: 8, padding: '10px 12px', marginBottom: 6, border: '1px solid #78350f' }}>
                <ItemName item={item} showAlt={showAlt} altLang={altLang} />
                {item.notes && <div style={{ color: '#d97706', fontSize: 13, marginTop: 4, fontWeight: 600 }}>— {item.notes}</div>}
                {item.item_note && <div style={{ color: '#f87171', fontSize: 13, fontWeight: 700, marginTop: 4 }}>📝 {item.item_note}</div>}
              </div>
            ))}
          </div>
        ));
      })()}
    </div>
  )}
</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── PASS TAB ─── */}
      {tab === 'pass' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 16, background: '#111' }}>
          {passOrders.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>✅ Pass is clear!</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {passOrders.map(order => (
                <div key={order.id} style={{ background: '#1a1a1a', borderRadius: 16, overflow: 'hidden' }}>
                  <div style={{ background: '#8b5cf6', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ color: 'white', fontWeight: 800, fontSize: 22, flex: 1, minWidth: 0 }}>
                      <OrderHeading order={order} />
                    </div>
                    {isTakeaway(order) ? (
                      <button
                        onClick={async () => {
                          if (!window.confirm(`Mark Online Order #${order.id} as collected? This closes the order and counts it as a sale.`)) return;
                          try {
                            await setTakeawayStatus(order.id, 'collected');
                            await fetchOrders();
                          } catch (err) {
                            window.alert('Could not mark collected: ' + (err?.message || 'unknown error'));
                          }
                        }}
                        style={{
                          background: '#22c55e', color: 'white', border: 'none', borderRadius: 8,
                          padding: '8px 14px', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                          whiteSpace: 'nowrap', flexShrink: 0,
                        }}
                      >🥡 Collected</button>
                    ) : (
                      <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>#{order.id}</div>
                    )}
                  </div>
                  <div style={{ padding: 12 }}>
                    {(() => {
                      const byCourse = {};
                      order.items.forEach(item => {
                        const c = item.course || 1;
                        if (!byCourse[c]) byCourse[c] = [];
                        byCourse[c].push(item);
                      });
                      return Object.keys(byCourse).sort().map(course => (
                        <div key={course} style={{ marginBottom: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: COURSE_COLORS[course] }} />
                            <span style={{ color: COURSE_COLORS[course], fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                              {COURSE_LABELS[course]}
                            </span>
                          </div>
                          {byCourse[course].map(item => {
                            const isCooked = item.status === 'cooked';
                            const isCooking = item.is_fired && item.status === 'cooking';
                            const isUpcoming = !item.is_fired;
                            return (
                              <div key={item.id} style={{
                                background: isCooked ? '#2d1f4e' : isUpcoming ? '#2d1f00' : '#2a2a2a',
                                borderRadius: 10, padding: '12px', marginBottom: 8,
                                border: `2px solid ${isCooked ? '#8b5cf6' : isUpcoming ? '#f59e0b' : '#1e3a5f'}`,
                              }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ color: isCooked ? 'white' : isUpcoming ? '#fde68a' : '#9ca3af', fontWeight: 700, fontSize: 16 }}>
                                      {item.quantity}× {item.name}
                                    </div>
                                    {showAlt && item.name_alt && (
                                      <div style={{ color: '#C9A84C', fontWeight: 600, fontSize: 14, marginTop: 2 }}>
                                        {item.quantity}× {item.name_alt}
                                      </div>
                                    )}
                                    {item.notes && <div style={{ color: '#aaa', fontSize: 12, marginTop: 2 }}>{item.notes}</div>}
                                    {item.item_note && <div style={{ color: '#e94560', fontSize: 12, fontWeight: 600, marginTop: 2 }}>📝 {item.item_note}</div>}
                                  </div>
                                  <div style={{ marginLeft: 12, flexShrink: 0 }}>
                                    {isCooked && (
                                      <button onClick={() => markServed(item.id)} style={{
                                        background: '#8b5cf6', color: 'white', border: 'none',
                                        borderRadius: 10, padding: '10px 18px',
                                        fontWeight: 800, fontSize: 15, cursor: 'pointer'
                                      }}>✓ Done</button>
                                    )}
                                    {isCooking && <div style={{ color: '#3b82f6', fontSize: 12, fontWeight: 700, textAlign: 'center' }}>🔥<br />Cooking</div>}
                                    {isUpcoming && <div style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, textAlign: 'center' }}>⏳<br />Pending</div>}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── COMPLETED TAB ─── */}
      {tab === 'completed' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 16, background: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ color: 'white', fontSize: 16, fontWeight: 700 }}>
              Today's completed — {completedItems.length} items
            </div>
            <button onClick={fetchCompleted} style={{ background: '#333', color: 'white', border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>↻</button>
          </div>
          {Object.keys(completedByOrder).length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', marginTop: 100, fontSize: 20 }}>No completed orders yet today</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {Object.values(completedByOrder).map(group => (
                <div key={group.order_id} style={{ background: '#1a1a1a', borderRadius: 16, overflow: 'hidden' }}>
                  <div style={{ background: '#1f2937', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>
                      <OrderHeading order={group} />
                    </div>
                    <div style={{ color: '#aaa', fontSize: 13 }}>#{group.order_id}</div>
                  </div>
                  <div style={{ padding: 12 }}>
                    {group.items.map(item => (
                      <div key={item.id} style={{ background: '#111827', borderRadius: 10, padding: '10px 12px', marginBottom: 8, border: '1px solid #374151' }}>
                        <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>
                          ✅ {item.quantity}× {item.name}
                        </div>
                        {showAlt && item.name_alt && (
                          <div style={{ color: '#C9A84C', fontSize: 13, marginTop: 2 }}>
                            {item.quantity}× {item.name_alt}
                          </div>
                        )}
                        {item.notes && <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{item.notes}</div>}
                        {item.fired_at && <div style={{ color: '#eab308', fontSize: 11, marginTop: 2 }}>⏱ {getCookTime(item.fired_at, item.served_at)}</div>}
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