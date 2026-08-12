import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getTables, createOrder, getOrders, getTableStatus, moveTable, mergeTables, getReservations, assertOk } from '../api';
import { tableLabel } from '../utils/orderLabel';
// Round 6 — a table can hold a waiter bill AND a customer's prepaid QR bill.
// The QR order is read-only (staff can't touch it) and auto-closes when served,
// so on the floor we prefer the STAFF order: the waiter's bill must never be
// hidden behind the customer's. Falls back to the QR order when it's the only
// one (shown read-only via the existing PAID banner on the order screen).
const orderForTable = (orders, tid) =>
  orders.find(o => o.table_id === tid && o.source !== 'qr') || orders.find(o => o.table_id === tid);
 // SEPOS-TABLE-NAME
import { roomSize } from '../utils/floorRoom';    // SEPOS-FLOOR-FIT shared room
import TakeawayStrip    from '../components/TakeawayStrip';
import BillPeek         from '../components/BillPeek';
import SyncHealthBanner from '../components/SyncHealthBanner';

// Previous colour code (restored per operator request) — kept with the new
// white-card + coloured-accent grid design. bg = status colour (plan-view fill +
// grid accent/pill).
const COLOUR_MAP = {
  available:      { bg: '#22c55e', border: '#16a34a', text: 'white',   label: 'Available' },
  occupied:       { bg: '#ef4444', border: '#dc2626', text: 'white',   label: 'Occupied' },
  starters_fired: { bg: '#eab308', border: '#ca8a04', text: 'white',   label: 'Starters Called' },
  starters_done:  { bg: '#f97316', border: '#ea580c', text: 'white',   label: 'Starters Done' },
  mains_fired:    { bg: '#38bdf8', border: '#0284c7', text: 'white',   label: 'Mains Called' },
  mains_done:     { bg: '#1e3a8a', border: '#1e40af', text: 'white',   label: 'Mains Done' },
  desserts_fired: { bg: '#f9a8d4', border: '#ec4899', text: 'var(--brand-primary, #1a1a2e)', label: 'Desserts Called' },
  desserts_done:  { bg: '#6b7280', border: '#4b5563', text: 'white',   label: 'Desserts Done' },
  bill_printed:   { bg: '#f8fafc', border: '#cbd5e1', text: 'var(--brand-primary, #1a1a2e)', label: 'Bill Printed' },
};

export default function TableMapScreen({ staff, onOpenOrder }) {
  const [tables, setTables] = useState([]);
  const [tableStatuses, setTableStatuses] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [billPeekOrderId, setBillPeekOrderId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCoversPopup, setShowCoversPopup] = useState(null);
  const [coversInput, setCoversInput] = useState('');
  const [tick, setTick] = useState(0);
  // SEPOS-GHOST-001 — in-flight guard so a fast double-tap on ✓ / a takeaway
  // table can't fire two createOrder calls (the client half of the ghost-table
  // fix; the server de-dupes too). Ref = synchronous gate; state = button UI.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

  // Sandy: Mobile state — defaults to grid on mobile (more touch-friendly)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [viewMode, setViewMode] = useState(window.innerWidth < 768 ? 'grid' : 'plan');

  // SEPOS-FLOOR-FIT — the plan view auto-zooms the floor plan to fill the
  // screen. Editor coordinates are absolute pixels laid out on a small canvas,
  // so on a big monitor the plan huddled in the top-left corner with most of
  // the screen empty (Korakot, 2026-08-05). Measure the viewport, measure the
  // plan's bounding box, scale + centre. Clamped so tiny plans don't balloon
  // (max 2.2×) and huge plans stay tappable (min 0.5× — beyond that the
  // container still scrolls).
  const planViewRef = useRef(null);
  const [planViewSize, setPlanViewSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (viewMode !== 'plan') return;
    const el = planViewRef.current;
    if (!el) return;
    const measure = () => setPlanViewSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode, loading]);

  // Manual zoom on top of the auto-fit — a per-device multiplier the operator
  // controls with −/Fit/+ buttons (Korakot: "where's the zoom button, and it's
  // too big"). 1 = auto-fit; persisted so each till remembers its preference.
  const [userZoom, setUserZoom] = useState(() => {
    const v = parseFloat(localStorage.getItem('siamepos_floor_zoom'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const changeZoom = (factor) => {
    setUserZoom((z) => {
      const next = factor === 0 ? 1 : Math.min(2, Math.max(0.5, +(z * factor).toFixed(3)));
      try { localStorage.setItem('siamepos_floor_zoom', String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // Move/Merge state — unchanged
  const [tableActionPopup, setTableActionPopup] = useState(null);
  const [moveMode, setMoveMode] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);

  // ── Fetch data ────────────────────────────────────────
  const fetchData = async () => {
    try {
      const [tablesData, ordersData, statusData, reservationsData] = await Promise.all([
        getTables(),
        getOrders(),
        getTableStatus(),
        getReservations().catch(() => []),       // pre-claim badges (SEPOS-044)
      ]);
      setTables(tablesData);
      setOpenOrders(ordersData);
      setTableStatuses(statusData);
      setReservations(Array.isArray(reservationsData) ? reservationsData : []);
    } catch (err) {
      console.error('Failed to load tables', err);
    } finally {
      setLoading(false);
    }
  };

  // SEPOS-044 — find a reservation that "claims" this table right now.
  // Shows on empty tables when a booking is due within ±30 min and the
  // status hasn't moved past pending/confirmed yet.
  const getUpcomingReservation = (tableId) => {
    if (openOrders.some(o => o.table_id === tableId)) return null;
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    let best = null;
    let bestDelta = Infinity;
    for (const r of reservations) {
      if (r.table_id !== tableId) continue;
      if (r.status !== 'pending' && r.status !== 'confirmed') continue;
      const dateStr = String(r.reservation_date || '').slice(0, 10);
      if (dateStr !== todayIso) continue;
      const timeStr = String(r.reservation_time || '').slice(0, 5);
      if (!/^\d\d:\d\d$/.test(timeStr)) continue;
      const [h, m] = timeStr.split(':').map(Number);
      const t = new Date(now); t.setHours(h, m, 0, 0);
      const deltaMin = (t.getTime() - now.getTime()) / 60000;
      if (deltaMin < -30 || deltaMin > 30) continue;
      if (Math.abs(deltaMin) < Math.abs(bestDelta)) {
        best = { ...r, _delta: deltaMin, _time: timeStr };
        bestDelta = deltaMin;
      }
    }
    return best;
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    const timerTick = setInterval(() => setTick(t => t + 1), 60000);
    return () => { clearInterval(interval); clearInterval(timerTick); };
  }, []);

  // Sandy: Resize listener
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── Helpers — unchanged ───────────────────────────────
  const getTableColour = (table) => {
    const status = tableStatuses.find(s => s.table_id === table.id);
    if (!status) return COLOUR_MAP.available;
    return COLOUR_MAP[status.colour_status] || COLOUR_MAP.occupied;
  };

  const getTableTime = (tableId) => {
    const order = orderForTable(openOrders, tableId);
    if (!order) return null;
    const rawDate = order.opened_at || order.created_at;
    const opened = new Date(rawDate);
    if (isNaN(opened.getTime())) return null;
    const diff = Math.floor((Date.now() - opened.getTime()) / 60000);
    if (diff < 1) return '0m';
    if (diff < 60) return `${diff}m`;
    const hrs = Math.floor(diff / 60);
    const mins = diff % 60;
    return `${hrs}h ${mins}m`;
  };

  const getTimeColor = (tableId) => {
    const order = orderForTable(openOrders, tableId);
    if (!order) return 'white';
    const rawDate = order.opened_at || order.created_at;
    const opened = new Date(rawDate);
    if (isNaN(opened.getTime())) return 'white';
    const diff = Math.floor((Date.now() - opened.getTime()) / 60000);
    if (diff > 90) return '#fca5a5';
    if (diff > 60) return '#fde68a';
    return 'rgba(255,255,255,0.9)';
  };

  // ── Table click handler — unchanged ───────────────────
  const handleTableClick = async (table) => {
    const existingOrder = orderForTable(openOrders, table.id);

    if (moveMode && tableActionPopup) {
      if (existingOrder) {
        alert('Please select an empty table to move to!');
        return;
      }
      try {
        // SEPOS-047h — assertOk: api.js resolves {error} on HTTP 4xx/5xx
        // instead of throwing, so without this the catch was dead code and
        // "✅ Moved!" showed even when the move 404'd (order closed/deleted
        // on another terminal) or 500'd — leaving both tables wrong.
        assertOk(await moveTable(tableActionPopup.order.id, table.id));
        alert(`✅ Moved to Table ${table.table_number}!`);
        setMoveMode(false);
        setTableActionPopup(null);
        fetchData();
      } catch (err) {
        alert(`Failed to move table: ${err.message || 'please try again'}`);
        fetchData();
      }
      return;
    }

    if (mergeMode && tableActionPopup) {
      if (!existingOrder) {
        alert('Please select an occupied table to merge with!');
        return;
      }
      if (existingOrder.id === tableActionPopup.order.id) {
        alert('Cannot merge a table with itself!');
        return;
      }
      if (!confirm(`Merge Table ${table.table_number} into Table ${tableActionPopup.table.table_number}? All items will combine.`)) return;
      try {
        assertOk(await mergeTables(tableActionPopup.order.id, existingOrder.id)); // SEPOS-047h — see move note above
        alert(`✅ Tables merged! Table ${table.table_number} combined into Table ${tableActionPopup.table.table_number}`);
        setMergeMode(false);
        setTableActionPopup(null);
        fetchData();
      } catch (err) {
        alert(`Failed to merge tables: ${err.message || 'please try again'}`);
        fetchData();
      }
      return;
    }

    if (existingOrder) {
      setTableActionPopup({ table, order: existingOrder });
    } else if (table.is_takeaway) {
      // SEPOS-TAKEAWAY-TABLE — no covers prompt; ring straight into a takeaway
      // order (order_type='takeaway' → skips service charge, kitchen labels it).
      if (creatingRef.current) return;         // SEPOS-GHOST-001 — ignore double-tap
      creatingRef.current = true; setCreating(true);
      try {
        const data = await createOrder(table.id, 1, staff?.id, 'takeaway');
        if (!data?.id) throw new Error(data?.error || 'No order id returned');
        onOpenOrder(data.id, table.id);
      } catch (err) {
        alert(`Failed to start takeaway: ${err.message || 'please try again'}`);
      } finally {
        creatingRef.current = false; setCreating(false);
      }
    } else {
      setShowCoversPopup(table);
      setCoversInput('');
    }
  };

  const cancelMode = () => {
    setMoveMode(false);
    setMergeMode(false);
    setTableActionPopup(null);
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ fontSize: 18, color: '#888' }}>Loading tables...</div>
    </div>
  );

  return (
    <div style={{ height: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' }}>

      {/* ════════════════════════════════════════
          HEADER

          Desktop: title + legend + buttons in one row
          Mobile:  compact — title + buttons only
                   legend moves to a strip below
          ════════════════════════════════════════ */}
      <div style={{
        padding: isMobile ? '12px 16px' : '14px 24px',
        background: 'white',
        borderBottom: '1px solid #eee',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
        gap: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
          <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: isMobile ? 22 : 30, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', flexShrink: 0 }}>
            Floor map
          </h1>

          {/* Legend — desktop only. Moves to strip below on mobile. */}
          {!isMobile && (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {Object.values(COLOUR_MAP).map(val => (
                <div key={val.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 999, background: val.bg, border: `1px solid ${val.border}` }} />
                  <span style={{ fontSize: 12, color: '#7C766A', fontWeight: 600 }}>{val.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => setViewMode(viewMode === 'plan' ? 'grid' : 'plan')}
            style={{
              background: '#f0f0f0', border: 'none',
              padding: isMobile ? '10px 14px' : '8px 16px',
              borderRadius: 8, cursor: 'pointer',
              fontWeight: 600, fontSize: 13
            }}>
            {viewMode === 'plan' ? '⊞ Grid' : '🗺️ Plan'}
          </button>
          <button
            onClick={fetchData}
            style={{
              background: 'var(--brand-primary, #1a1a2e)', color: 'white', border: 'none',
              padding: isMobile ? '10px 14px' : '8px 16px',
              borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600
            }}>
            ↻
          </button>
        </div>
      </div>

      {/* Sandy: Mobile legend — scrollable horizontal strip below header */}
      {isMobile && (
        <div style={{
          overflowX: 'auto',
          display: 'flex',
          gap: 14,
          padding: '8px 16px',
          background: 'white',
          borderBottom: '1px solid #eee',
          flexShrink: 0
        }}>
          {Object.values(COLOUR_MAP).map(val => (
            <div key={val.label} style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <div style={{ width: 12, height: 12, borderRadius: 999, background: val.bg, border: `1px solid ${val.border}`, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#7C766A', whiteSpace: 'nowrap', fontWeight: 600 }}>{val.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* SEPOS-044 follow-up — surfaces SYNC_SECRET-missing or stuck-queue state. */}
      <SyncHealthBanner />

      {/* SEPOS-044 — Active takeaway strip (auto-hides if none).
          Tapping a card opens the full bill screen so staff close the
          order via the same Close & Pay flow as dine-in (no BillPeek). */}
      <TakeawayStrip onPeek={(orderId) => {
        const order = openOrders.find(o => o.id === orderId);
        if (order) onOpenOrder(order.id, order.table_id);
        else setBillPeekOrderId(orderId); // fallback if not in cached list yet
      }} />

      {/* ════════════════════════════════════════
          MOVE / MERGE MODE BANNER

          Desktop: full text
          Mobile:  shorter text, stacked layout
          ════════════════════════════════════════ */}
      {(moveMode || mergeMode) && (
        <div style={{
          background: moveMode ? '#1e40af' : '#8b5cf6',
          padding: isMobile ? '12px 16px' : '12px 24px',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: isMobile ? 10 : 0,
          flexShrink: 0
        }}>
          <div style={{ color: 'white', fontWeight: 700, fontSize: isMobile ? 14 : 15 }}>
            {moveMode
              ? `🔄 Moving Table ${tableActionPopup?.table.table_number} — tap an empty table`
              : `🔗 Merging Table ${tableActionPopup?.table.table_number} — tap another occupied table`
            }
          </div>
          <button onClick={cancelMode} style={{
            background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none',
            padding: isMobile ? '12px' : '8px 16px',
            borderRadius: 8, cursor: 'pointer', fontWeight: 700,
            fontSize: 14, textAlign: 'center'
          }}>
            Cancel
          </button>
        </div>
      )}

      {/* ════════════════════════════════════════
          PLAN VIEW

          Unchanged — the container already scrolls
          via overflow: auto. On mobile, a subtle
          hint nudges users toward grid view.
          ════════════════════════════════════════ */}
      {viewMode === 'plan' && (
        <>
          {isMobile && (
            <div style={{
              background: '#fffbeb',
              borderBottom: '1px solid #fde68a',
              padding: '8px 16px',
              fontSize: 12,
              color: '#92400e',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}>
              💡 Scroll to see all tables · Tap ⊞ Grid for an easier view on this screen
            </div>
          )}
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div ref={planViewRef} style={{
            position: 'absolute', inset: 0, overflow: 'auto',
            background: '#f0ede8',
            backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)',
            backgroundSize: '30px 30px'
          }}>
            {(() => {
              // SEPOS-FLOOR-FIT v2 — render the ROOM, not the table cluster.
              // The editor's canvas rectangle IS the room; scaling that whole
              // rectangle to the viewport keeps every table at the same
              // relative spot on both screens (a bar at the left wall stays
              // left — centring just the cluster made it jump to the middle).
              const PAD = 16;
              const room = roomSize(tables);
              const availW = Math.max(0, planViewSize.w - PAD * 2);
              const availH = Math.max(0, planViewSize.h - PAD * 2);
              const fitScale = (availW > 0 && availH > 0)
                ? Math.min(1.5, availW / room.w, availH / room.h)
                : 1;
              const scale = Math.min(3, Math.max(0.35, fitScale * userZoom));
              // Letterbox-centre the room itself (like a blueprint on a desk);
              // geometry inside the room is untouched.
              const offX = PAD + Math.max(0, (availW - room.w * scale) / 2);
              const offY = PAD + Math.max(0, (availH - room.h * scale) / 2);

              return tables.map(table => {
              const colours = getTableColour(table);
              const w = Math.round((table.width || 80) * scale);
              const h = Math.round((table.height || 80) * scale);
              // ?? not || — a table dragged flush to the top/left edge is saved
              // at pos 0, and `0 || 40` silently bumped it 40px on the FLOOR
              // while the editor drew it at 0 → "I saved but the layout still
              // differs" (Korakot, 2026-08-03: only T1/T2 at y=0 were off).
              const x = Math.round((table.pos_x ?? 40) * scale + offX);
              const y = Math.round((table.pos_y ?? 40) * scale + offY);
              const time = getTableTime(table.id);
              const timeColor = getTimeColor(table.id);
              const isSelected = tableActionPopup?.table.id === table.id;
              const upcoming = getUpcomingReservation(table.id);

              return (
                <div key={table.id} onClick={() => handleTableClick(table)} style={{
                  position: 'absolute', left: x, top: y, width: w, height: h,
                  borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                  background: colours.bg,
                  border: `3px solid ${isSelected ? '#ffffff' : colours.border}`,
                  outline: isSelected ? '3px solid var(--brand-primary, #1a1a2e)' : 'none',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', userSelect: 'none',
                  boxShadow: isSelected ? '0 0 20px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                  transition: 'transform 0.1s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)'; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                >
                  <div style={{ fontSize: Math.max(12, Math.min(22, Math.round(w * 0.17))), fontWeight: 800, color: colours.text, textAlign: 'center', padding: '0 4px' }}>
                    {table.is_takeaway ? '🥡 ' : ''}{tableLabel(table)}
                  </div>
                  {time && (
                    <div style={{
                      fontSize: Math.max(11, Math.min(17, Math.round(w * 0.13))), fontWeight: 800,
                      color: '#000000',
                      marginTop: 3,
                      background: 'rgba(255,255,255,0.85)',
                      padding: '2px 6px',
                      borderRadius: 6
                    }}>
                      ⏱ {time}
                    </div>
                  )}
                  {/* SEPOS-044 — reservation pre-claim badge */}
                  {upcoming && (
                    <div title={`${upcoming.customer_name} · ${upcoming.covers} covers · ${upcoming._time}`} style={{
                      position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                      background: upcoming._delta < 0 ? '#dc2626' : 'var(--brand-primary,#0d1b3e)', color: 'white',
                      fontSize: 10, fontWeight: 800,
                      padding: '2px 8px', borderRadius: 999,
                      whiteSpace: 'nowrap', boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                      pointerEvents: 'none', maxWidth: w + 40, overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      📅 {upcoming._time} {upcoming.customer_name?.split(' ')[0]}·{upcoming.covers}
                    </div>
                  )}
                </div>
              );
              });
            })()}
          </div>
          {/* SEPOS-FLOOR-FIT — manual zoom on top of auto-fit. Per-device,
              remembered. Fit (⊡) returns to automatic. */}
          <div style={{
            position: 'absolute', right: 14, bottom: 14,
            display: 'flex', flexDirection: 'column', gap: 6, zIndex: 5,
          }}>
            {[
              { label: '+', title: 'Zoom in',            act: () => changeZoom(1.15) },
              { label: '⊡', title: 'Fit to screen',      act: () => changeZoom(0) },
              { label: '−', title: 'Zoom out',           act: () => changeZoom(1 / 1.15) },
            ].map(b => (
              <button key={b.label} title={b.title} onClick={b.act} style={{
                width: 44, height: 44, borderRadius: 10,
                border: '1px solid #d6d3cb', background: 'rgba(255,255,255,0.95)',
                color: 'var(--brand-primary, #1a1a2e)', fontSize: b.label === '⊡' ? 20 : 24,
                fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{b.label}</button>
            ))}
            {userZoom !== 1 && (
              <div style={{
                textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#7C766A',
                background: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '2px 4px',
              }}>{Math.round(userZoom * 100)}%</div>
            )}
          </div>
          </div>
        </>
      )}

      {/* ════════════════════════════════════════
          GRID VIEW

          Desktop: auto-fill minmax(140px)
          Mobile:  fixed 2 columns — predictable
                   on all phone sizes. Larger cards,
                   larger text, bigger touch targets.
          ════════════════════════════════════════ */}
      {viewMode === 'grid' && (
        <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? 14 : 24, background: '#F4F1EA' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile
              ? 'repeat(2, 1fr)'
              : 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 16
          }}>
            {tables
              .sort((a, b) => String(a.table_number).localeCompare(String(b.table_number), undefined, { numeric: true }))
              .map(table => {
                const colours = getTableColour(table);
                const order = orderForTable(openOrders, table.id);
                const time = getTableTime(table.id);
                const isSelected = tableActionPopup?.table.id === table.id;
                const upcoming = getUpcomingReservation(table.id);

                const fromTime = order ? new Date(order.opened_at || order.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
                return (
                  <div key={table.id} onClick={() => handleTableClick(table)} style={{
                    background: '#fff',
                    border: `1.5px solid ${isSelected ? 'var(--brand-primary, #1a1a2e)' : '#E7E2D6'}`,
                    borderLeft: `5px solid ${colours.bg}`,
                    borderRadius: 16,
                    padding: '14px 16px',
                    minHeight: 148,
                    cursor: 'pointer',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: isSelected ? '0 8px 20px rgba(13,27,62,.12)' : '0 1px 2px rgba(13,27,62,.05)',
                    transition: 'transform .15s, box-shadow .15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
                  >
                    {/* Status pill (top-right) */}
                    <div style={{
                      position: 'absolute', top: 12, right: 12,
                      background: colours.bg, color: colours.text,
                      fontSize: 10.5, fontWeight: 800, letterSpacing: '.4px',
                      textTransform: 'uppercase', borderRadius: 999, padding: '3px 9px',
                    }}>
                      {colours.label}
                    </div>

                    {/* Table number */}
                    <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                      {table.is_takeaway ? '🥡 ' : ''}{tableLabel(table)}
                    </div>
                    <div style={{ fontSize: 12.5, color: '#9A9488', marginTop: 6, fontWeight: 600 }}>
                      {table.is_takeaway ? 'Takeaway' : `${table.capacity} seats`}
                    </div>

                    <div style={{ flex: 1 }} />

                    {/* Bottom — status specific */}
                    {order ? (
                      <div>
                        <div style={{ fontSize: 12.5, color: '#7C766A', fontWeight: 600 }}>
                          {order.covers} covers · from {fromTime}{time ? ` · ${time}` : ''}
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#9A7B1F', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                          £{Number(order.total || 0).toFixed(2)}
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#2E9E6E' }}>Open</div>
                    )}
                    {/* SEPOS-044 — pre-claim badge on grid tile */}
                    {upcoming && (
                      <div style={{
                        position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                        background: upcoming._delta < 0 ? '#dc2626' : 'var(--brand-primary,#0d1b3e)', color: 'white',
                        fontSize: 11, fontWeight: 800,
                        padding: '3px 10px', borderRadius: 999,
                        whiteSpace: 'nowrap', boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                      }}>
                        📅 {upcoming._time} {upcoming.customer_name?.split(' ')[0]}·{upcoming.covers}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          TABLE ACTION POPUP
          Added maxWidth: 90vw for small phones
          ════════════════════════════════════════ */}
      {tableActionPopup && !moveMode && !mergeMode && createPortal((
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: 16
        }}>
          <div style={{
            background: 'white', borderRadius: 20, padding: '32px 28px',
            width: 360, maxWidth: '92vw',
            display: 'flex', flexDirection: 'column', gap: 22
          }}>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>
                {(() => { const l = tableLabel(tableActionPopup.table); return typeof l === 'string' ? l : `Table ${l}`; })()}
              </div>
              <div style={{ color: '#888', fontSize: 14 }}>
                {tableActionPopup.order.covers} covers · £{Number(tableActionPopup.order.total || 0).toFixed(2)}
              </div>
            </div>

            <button onClick={() => {
              setTableActionPopup(null);
              onOpenOrder(tableActionPopup.order.id, tableActionPopup.table.id);
            }} style={{
              padding: isMobile ? '18px' : '16px',
              borderRadius: 12, border: 'none',
              background: 'var(--brand-primary, #1a1a2e)', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              📋 Open Order
            </button>

            {/* SEPOS-044 — peek at the running bill without leaving the floor plan. */}
            <button onClick={() => {
              const oid = tableActionPopup.order.id;
              setTableActionPopup(null);
              setBillPeekOrderId(oid);
            }} style={{
              padding: isMobile ? '18px' : '16px',
              borderRadius: 12, border: 'none',
              background: '#0f766e', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              👁 View Bill
            </button>

            <button onClick={() => {
              setMoveMode(true);
              setMergeMode(false);
            }} style={{
              padding: isMobile ? '18px' : '16px',
              borderRadius: 12, border: 'none',
              background: '#1e40af', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              🔄 Move Table
            </button>

            <button onClick={() => {
              setMergeMode(true);
              setMoveMode(false);
            }} style={{
              padding: isMobile ? '18px' : '16px',
              borderRadius: 12, border: 'none',
              background: '#8b5cf6', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              🔗 Merge Table
            </button>

            <button onClick={() => setTableActionPopup(null)} style={{
              padding: isMobile ? '16px' : '12px',
              borderRadius: 10, border: 'none',
              background: '#f0f0f0', color: '#555',
              fontSize: 14, cursor: 'pointer', fontWeight: 600
            }}>
              Cancel
            </button>
          </div>
        </div>
      ), document.body)}

      {/* ════════════════════════════════════════
          COVERS NUMPAD POPUP
          Added maxWidth: 90vw, bigger buttons on mobile
          ════════════════════════════════════════ */}
      {showCoversPopup && createPortal((
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: 16
        }}>
          <div style={{
            background: 'white', borderRadius: 20,
            padding: isMobile ? '28px 20px' : '32px 28px',
            width: 300, maxWidth: '90vw',
            // Keep the popup fully on-screen and centred even when the device
            // scales the UI up (Sunmi): cap the height and let it scroll rather
            // than overflow off the top so it always sits in the middle.
            maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>
                {(() => { const l = tableLabel(showCoversPopup); return typeof l === 'string' ? l : `Table ${l}`; })()}
              </div>
              <div style={{ color: '#888', fontSize: 14 }}>How many covers?</div>
            </div>

            <div style={{ fontSize: 48, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)', minHeight: 60 }}>
              {coversInput || '0'}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%' }}>
              {['1','2','3','4','5','6','7','8','9','C','0','✓'].map(btn => (
                <button key={btn} onClick={async () => {
                  if (btn === 'C') {
                    setCoversInput('');
                  } else if (btn === '✓') {
                    const num = parseInt(coversInput);
                    if (isNaN(num) || num < 1) return alert('Please enter number of covers!');
                    // SEPOS-GHOST-001 — swallow a double-tap so we never fire two
                    // createOrder calls for the same table (empty-twin ghost).
                    if (creatingRef.current) return;
                    creatingRef.current = true; setCreating(true);
                    try {
                      // SEPOS-047h — createOrder resolves {error} (no throw)
                      // on failure; without this guard data.id was undefined
                      // and onOpenOrder(undefined) opened a broken OrderScreen
                      // for a nonexistent order. Verify the id before nav.
                      const data = await createOrder(showCoversPopup.id, num, staff?.id);
                      if (!data?.id) throw new Error(data?.error || 'No order id returned');
                      setShowCoversPopup(null);
                      setCoversInput('');
                      onOpenOrder(data.id, showCoversPopup.id);
                    } catch (err) {
                      alert(`Failed to create order: ${err.message || 'please try again'}`);
                    } finally {
                      creatingRef.current = false; setCreating(false);
                    }
                  } else {
                    setCoversInput(prev => prev.length < 2 ? prev + btn : prev);
                  }
                }} disabled={creating && btn === '✓'} style={{
                  height: isMobile ? 72 : 64,
                  borderRadius: 12, border: 'none',
                  fontSize: isMobile ? 26 : 22,
                  fontWeight: 700, cursor: (creating && btn === '✓') ? 'wait' : 'pointer',
                  opacity: (creating && btn === '✓') ? 0.6 : 1,
                  background: btn === '✓' ? '#e94560' : btn === 'C' ? '#f0f0f0' : '#f8f8f8',
                  color: btn === '✓' ? 'white' : 'var(--brand-primary, #1a1a2e)',
                }}>{btn}</button>
              ))}
            </div>

            <button onClick={() => setShowCoversPopup(null)} style={{
              color: '#888', background: 'none', border: 'none',
              cursor: 'pointer', fontSize: 14, padding: '8px 20px'
            }}>
              Cancel
            </button>
          </div>
        </div>
      ), document.body)}

      {/* SEPOS-044 — BillPeek modal (shared by takeaway strip + tap menu). */}
      {billPeekOrderId && (
        <BillPeek
          orderId={billPeekOrderId}
          onClose={() => setBillPeekOrderId(null)}
          onOpenFull={(oid) => {
            const order = openOrders.find(o => o.id === oid);
            setBillPeekOrderId(null);
            if (order) onOpenOrder(order.id, order.table_id);
          }}
        />
      )}
    </div>
  );
}