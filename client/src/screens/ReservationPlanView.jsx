import { useState, useEffect } from 'react';

const SERVER_URL = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host.startsWith('192.168.') || host.startsWith('10.'))
    return window.location.origin;
  return 'https://restaurant-epos-production.up.railway.app';
})();

const api = url => fetch(`${SERVER_URL}${url}`).then(r => r.json());
const put = (url, d) => fetch(`${SERVER_URL}${url}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d),
}).then(r => r.json());

const STATUS_COLORS = {
  pending:   { bg: '#fef9c3', border: '#f59e0b', text: '#92400e', dot: '#f59e0b' },
  confirmed: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af', dot: '#3b82f6' },
  seated:    { bg: '#dcfce7', border: '#22c55e', text: '#166534', dot: '#22c55e' },
  completed: { bg: '#f3f4f6', border: '#9ca3af', text: '#4b5563', dot: '#9ca3af' },
  cancelled: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b', dot: '#ef4444' },
  'no-show': { bg: '#fee2e2', border: '#ef4444', text: '#991b1b', dot: '#ef4444' },
};

function toMins(t) {
  if (!t) return 0;
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}
function minsToTime(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function getDuration(covers, tiers) {
  const tier = tiers.find(t => covers >= t.covers_min && (t.covers_max == null || covers <= t.covers_max));
  return tier ? tier.duration_mins : 90;
}

// ── Build connected groups from pairs using union-find ────────────
function buildTableGroups(combinations, tables) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });

  const parent = {};
  function find(x) {
    if (parent[x] == null) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  combinations.forEach(c => { union(c.table_id_a, c.table_id_b); });

  const groups = {};
  const allIds = new Set();
  combinations.forEach(c => { allIds.add(c.table_id_a); allIds.add(c.table_id_b); });
  allIds.forEach(id => {
    const root = find(id);
    if (!groups[root]) groups[root] = [];
    if (tableMap[id]) groups[root].push(tableMap[id]);
  });

  return Object.values(groups)
    .filter(g => g.length >= 2)
    .map(g => {
      const sorted = g.sort((a, b) => a.table_number - b.table_number);
      const capacity = sorted.reduce((s, t) => s + (t.capacity || 0), 0);
      const label = sorted.map(t => `T${t.table_number}`).join('+');
      return { tables: sorted, capacity, label, ids: sorted.map(t => t.id) };
    });
}

function getGroupForTable(tableId, tableGroups) {
  return tableGroups.find(g => g.ids.includes(tableId)) || null;
}

function getAssignedLabel(res, tables, tableGroups) {
  if (!res.table_id) return null;
  const table = tables.find(t => t.id === res.table_id);
  if (!table) return null;
  const group = getGroupForTable(res.table_id, tableGroups);
  return group ? group.label : `T${table.table_number}`;
}

// ── Main export ───────────────────────────────────────────────────
export default function ReservationPlanView({ reservations = [], selectedDate, onRefresh }) {
  const [planView,     setPlanView]     = useState('timeline');
  const [tables,       setTables]       = useState([]);
  const [combinations, setCombinations] = useState([]);
  const [tiers,        setTiers]        = useState([]);
  const [settings,     setSettings]     = useState(null);
  const [selectedRes,  setSelectedRes]  = useState(null);
  const [assigning,    setAssigning]    = useState(false);

  useEffect(() => {
    Promise.all([
      api('/api/tables'),
      api('/api/table-combinations').catch(() => []),
      api('/api/dining-duration-tiers').catch(() => []),
      api('/api/reservations/settings/siamepos').catch(() => null),
    ]).then(([tabs, combs, trs, sett]) => {
      setTables(Array.isArray(tabs) ? tabs : []);
      setCombinations(Array.isArray(combs) ? combs : []);
      setTiers(Array.isArray(trs) ? trs : []);
      setSettings(sett);
    });
  }, []);

  const tableGroups = buildTableGroups(combinations, tables);
  const active = reservations.filter(r => r.status !== 'cancelled' && r.status !== 'no-show');

  const assignTable = async (tableId) => {
    if (!selectedRes) return;
    setAssigning(true);
    await put(`/api/reservations/${selectedRes.id}`, {
      customer_name:    selectedRes.customer_name,
      customer_phone:   selectedRes.customer_phone,
      customer_email:   selectedRes.customer_email || null,
      covers:           selectedRes.covers,
      reservation_date: selectedRes.reservation_date,
      reservation_time: selectedRes.reservation_time,
      table_id:         tableId,
      notes:            selectedRes.notes || null,
      status:           selectedRes.status,
    });
    if (onRefresh) onRefresh();
    setSelectedRes(r => ({ ...r, table_id: tableId }));
    setAssigning(false);
  };

  const updateStatus = async (status) => {
    if (!selectedRes) return;
    await put(`/api/reservations/${selectedRes.id}`, {
      customer_name:    selectedRes.customer_name,
      customer_phone:   selectedRes.customer_phone,
      customer_email:   selectedRes.customer_email || null,
      covers:           selectedRes.covers,
      reservation_date: selectedRes.reservation_date,
      reservation_time: selectedRes.reservation_time,
      table_id:         selectedRes.table_id || null,
      notes:            selectedRes.notes || null,
      status,
    });
    if (onRefresh) onRefresh();
    setSelectedRes(r => ({ ...r, status }));
  };

  const timeStart = toMins(settings?.opening_time || '11:00');
  const timeEnd   = toMins(settings?.last_booking_time || '22:00') + 90;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 170px)', overflow: 'hidden', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#f8f9fa', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[['timeline','⏱ Timeline'],['floorplan','🗺 Floor Plan']].map(([v, l]) => (
            <button key={v} onClick={() => setPlanView(v)}
              style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                background: planView === v ? '#1a1a2e' : '#e5e7eb', color: planView === v ? 'white' : '#555' }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <span style={{ fontSize: 13, color: '#555' }}>
            <strong style={{ color: '#1a1a2e' }}>{active.length}</strong> bookings ·{' '}
            <strong style={{ color: '#e94560' }}>{active.reduce((s, r) => s + r.covers, 0)}</strong> covers
          </span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {planView === 'timeline' ? (
          <TimelineView tables={tables} reservations={active} tiers={tiers} tableGroups={tableGroups}
            timeStart={timeStart} timeEnd={timeEnd} selectedRes={selectedRes} onSelect={setSelectedRes} />
        ) : (
          <FloorPlanView tables={tables} reservations={active} tiers={tiers} tableGroups={tableGroups}
            selectedRes={selectedRes} onSelect={setSelectedRes} />
        )}
        {selectedRes && (
          <BookingPanel res={selectedRes} tables={tables} tableGroups={tableGroups} tiers={tiers}
            onAssign={assignTable} onStatusChange={updateStatus}
            onClose={() => setSelectedRes(null)} assigning={assigning} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TIMELINE VIEW
// ─────────────────────────────────────────────────────────────────
function TimelineView({ tables, reservations, tiers, tableGroups, timeStart, timeEnd, selectedRes, onSelect }) {
  const SLOT = 30, COL_W = 72, ROW_H = 54, LBL_W = 110;
  const totalMins = timeEnd - timeStart;
  const slots = [];
  for (let m = timeStart; m <= timeEnd; m += SLOT) slots.push(m);

  const assignedIds = new Set(reservations.filter(r => r.table_id).map(r => r.table_id));
  const usedTables  = tables.filter(t => assignedIds.has(t.id)).sort((a, b) => a.table_number - b.table_number);
  const unassigned  = reservations.filter(r => !r.table_id);
  const rows = [...usedTables.map(t => ({ type: 'table', table: t })), ...(unassigned.length ? [{ type: 'unassigned' }] : [])];

  function pxLeft(ts) { return ((toMins(ts) - timeStart) / totalMins) * (slots.length * COL_W); }
  function pxWidth(ts, cov) { return (getDuration(cov, tiers) / totalMins) * (slots.length * COL_W) - 4; }
  function rowRes(row) { return row.type === 'table' ? reservations.filter(r => r.table_id === row.table.id) : unassigned; }

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fafafa' }}>
      <div style={{ minWidth: LBL_W + slots.length * COL_W + 20 }}>
        <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 10, background: '#1a1a2e' }}>
          <div style={{ width: LBL_W, flexShrink: 0, padding: '10px 12px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Table</div>
          {slots.map(m => (
            <div key={m} style={{ width: COL_W, flexShrink: 0, padding: '10px 0', fontSize: 11, fontWeight: m % 60 === 0 ? 700 : 400, textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.07)', color: m % 60 === 0 ? 'white' : 'rgba(255,255,255,0.3)' }}>
              {m % 60 === 0 ? minsToTime(m) : '·'}
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: '60px 0', textAlign: 'center', color: '#888' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📅</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Assign tables to bookings to see them here</div>
          </div>
        ) : rows.map((row, ri) => {
          const group = row.type === 'table' ? getGroupForTable(row.table.id, tableGroups) : null;
          const label = group ? group.label : (row.type === 'table' ? `T${row.table.table_number}` : null);
          const capacity = group ? group.capacity : (row.type === 'table' ? row.table.capacity : null);
          return (
            <div key={row.type === 'table' ? row.table.id : 'unassigned'}
              style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: ri % 2 === 0 ? 'white' : '#fafafa', height: ROW_H, position: 'relative' }}>
              <div style={{ width: LBL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '2px solid #e5e7eb', position: 'sticky', left: 0, background: 'inherit', zIndex: 2 }}>
                {row.type === 'table' ? (
                  <><div style={{ fontSize: 13, fontWeight: 800, color: '#1a1a2e' }}>{label}</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{capacity}p</div></>
                ) : (
                  <><div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>⚠ Unassigned</div><div style={{ fontSize: 11, color: '#9ca3af' }}>{unassigned.length} booking{unassigned.length !== 1 ? 's' : ''}</div></>
                )}
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                {slots.map(m => <div key={m} style={{ position: 'absolute', left: ((m - timeStart) / totalMins) * (slots.length * COL_W), top: 0, bottom: 0, width: 1, background: m % 60 === 0 ? '#e5e7eb' : '#f3f4f6' }} />)}
                {rowRes(row).map(r => {
                  const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
                  const isSel = selectedRes?.id === r.id;
                  return (
                    <div key={r.id} onClick={() => onSelect(r)}
                      style={{ position: 'absolute', left: pxLeft(r.reservation_time) + 2, top: 6, height: ROW_H - 12, width: Math.max(pxWidth(r.reservation_time, r.covers), 70),
                        background: isSel ? '#1a1a2e' : c.bg, border: `2px solid ${isSel ? '#e94560' : c.border}`,
                        borderRadius: 8, padding: '4px 8px', cursor: 'pointer', overflow: 'hidden', zIndex: isSel ? 5 : 3,
                        boxShadow: isSel ? '0 4px 16px rgba(0,0,0,0.25)' : '0 1px 3px rgba(0,0,0,0.08)', transition: 'all 0.15s' }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: isSel ? 'white' : c.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.customer_name}</div>
                      <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.7)' : c.text, opacity: 0.85 }}>{r.reservation_time} · {r.covers}p</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div style={{ display: 'flex', background: '#1a1a2e', position: 'sticky', bottom: 0 }}>
          <div style={{ width: LBL_W, flexShrink: 0, padding: '8px 12px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Covers</div>
          {slots.map(m => {
            const covers = reservations.reduce((sum, r) => { const s = toMins(r.reservation_time), e = s + getDuration(r.covers, tiers); return s <= m && e > m ? sum + r.covers : sum; }, 0);
            return <div key={m} style={{ width: COL_W, flexShrink: 0, padding: '8px 0', textAlign: 'center', fontSize: 11, fontWeight: 700, borderLeft: '1px solid rgba(255,255,255,0.07)', color: covers > 0 ? '#C9A84C' : 'rgba(255,255,255,0.15)' }}>{covers > 0 ? covers : '·'}</div>;
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// FLOOR PLAN VIEW
// ─────────────────────────────────────────────────────────────────
function FloorPlanView({ tables, reservations, tiers, tableGroups, selectedRes, onSelect }) {
  function getBookingForTable(tableId) {
    const direct = reservations.find(r => r.table_id === tableId);
    if (direct) return direct;
    const group = getGroupForTable(tableId, tableGroups);
    if (group) { for (const id of group.ids) { const found = reservations.find(r => r.table_id === id); if (found) return found; } }
    return null;
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 256, borderRight: '1px solid #e5e7eb', background: 'white', overflow: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>Bookings · {reservations.length}</div>
        {reservations.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#888', fontSize: 13 }}>No bookings today</div>}
        {reservations.map(r => {
          const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
          const isSel = selectedRes?.id === r.id;
          const label = getAssignedLabel(r, tables, tableGroups);
          return (
            <div key={r.id} onClick={() => onSelect(r)}
              style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', borderLeft: `4px solid ${c.border}`, background: isSel ? '#1a1a2e' : 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isSel ? 'white' : '#1a1a2e' }}>{r.customer_name}</div>
                <div style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: isSel ? 'rgba(255,255,255,0.15)' : c.bg, color: isSel ? 'white' : c.text, textTransform: 'capitalize' }}>{r.status}</div>
              </div>
              <div style={{ fontSize: 11, color: isSel ? 'rgba(255,255,255,0.6)' : '#9ca3af' }}>{r.reservation_time} · {r.covers}p · {label || '⚠ No table'}</div>
              {r.notes && <div style={{ fontSize: 11, color: isSel ? 'rgba(255,255,255,0.5)' : '#aaa', marginTop: 2, fontStyle: 'italic', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.notes}</div>}
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'auto', background: '#f0ede8', backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)', backgroundSize: '30px 30px', minHeight: 500 }}>
        <div style={{ position: 'absolute', top: 12, right: 12, background: 'white', borderRadius: 10, padding: '10px 14px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 10 }}>
          {['pending','confirmed','seated'].map(s => <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s].dot }} /><span style={{ color: '#555', textTransform: 'capitalize' }}>{s}</span></div>)}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, paddingTop: 4, borderTop: '1px solid #f0f0f0' }}><div style={{ width: 8, height: 8, borderRadius: '50%', border: '1px solid #9ca3af', background: 'white' }} /><span style={{ color: '#555' }}>Available</span></div>
        </div>

        {tables.map(table => {
          const booking = getBookingForTable(table.id);
          const c = booking ? (STATUS_COLORS[booking.status] || STATUS_COLORS.pending) : null;
          const isSel = selectedRes?.id === booking?.id;
          const isPrimary = booking && booking.table_id === table.id;
          const isGroupMember = booking && booking.table_id !== table.id;
          return (
            <div key={table.id} onClick={() => booking ? onSelect(booking) : null}
              title={booking ? `${booking.customer_name} · ${booking.covers}p · ${booking.reservation_time}` : `T${table.table_number} — Available`}
              style={{ position: 'absolute', left: table.pos_x || 0, top: table.pos_y || 0, width: table.width || 80, height: table.height || 80,
                borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                background: isSel ? '#1a1a2e' : booking ? c.bg : 'white',
                border: `3px ${isGroupMember ? 'dashed' : 'solid'} ${isSel ? '#e94560' : booking ? c.border : '#cbd5e1'}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                cursor: booking ? 'pointer' : 'default', userSelect: 'none', zIndex: isSel ? 10 : 3,
                boxShadow: isSel ? '0 4px 20px rgba(0,0,0,0.25)' : '0 2px 6px rgba(0,0,0,0.08)', transition: 'all 0.15s' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: isSel ? 'white' : booking ? c.text : '#1a1a2e', textAlign: 'center' }}>{table.table_number}</div>
              {isPrimary ? (
                <div style={{ fontSize: 9, fontWeight: 600, color: isSel ? 'rgba(255,255,255,0.8)' : c.text, textAlign: 'center', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{booking.customer_name.split(' ')[0]}</div>
              ) : !booking ? (
                <div style={{ fontSize: 9, color: '#9ca3af' }}>{table.capacity}p</div>
              ) : null}
            </div>
          );
        })}
        {tables.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#888' }}><div style={{ fontSize: 36 }}>🗺</div><div style={{ fontSize: 14, fontWeight: 600 }}>Set up your floor plan in Admin → Table Plan first</div></div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// BOOKING DETAIL PANEL
// ─────────────────────────────────────────────────────────────────
function BookingPanel({ res, tables, tableGroups, tiers, onAssign, onStatusChange, onClose, assigning }) {
  const duration = getDuration(res.covers, tiers);
  const endTime  = minsToTime(toMins(res.reservation_time) + duration);
  const assignedLabel = getAssignedLabel(res, tables, tableGroups);

  const singleTables   = tables.filter(t => t.capacity >= res.covers).sort((a, b) => a.table_number - b.table_number);
  const suitableGroups = tableGroups.filter(g => g.capacity >= res.covers).sort((a, b) => a.capacity - b.capacity);

  function isAssigned(tableId) { return res.table_id === tableId; }
  function isGroupAssigned(group) { return group.ids.includes(res.table_id); }

  return (
    <div style={{ width: 280, background: 'white', borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'auto' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#1a1a2e' }}>{res.customer_name}</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{res.reservation_time} – {endTime} · {res.covers}p</div>
        </div>
        <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: '#f3f4f6', cursor: 'pointer', fontSize: 16, color: '#555' }}>×</button>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {/* Status */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 8 }}>Status</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {['pending','confirmed','seated','no-show','cancelled'].map(s => (
              <button key={s} onClick={() => onStatusChange(s)}
                style={{ padding: '5px 9px', borderRadius: 6, border: `1.5px solid ${STATUS_COLORS[s].border}`,
                  background: res.status === s ? STATUS_COLORS[s].bg : 'white', color: STATUS_COLORS[s].text,
                  cursor: 'pointer', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>{s}</button>
            ))}
          </div>
        </div>

        {/* Contact */}
        <div style={{ background: '#f8f9fa', borderRadius: 10, padding: '10px 12px', fontSize: 12, lineHeight: 1.8 }}>
          <div>📞 {res.customer_phone}</div>
          {res.customer_email && <div>✉️ {res.customer_email}</div>}
          {res.notes && <div style={{ color: '#888', fontStyle: 'italic' }}>💬 {res.notes}</div>}
        </div>

        {/* Table assignment */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 8 }}>
            Assign Table
            {assignedLabel && <span style={{ color: '#22c55e', marginLeft: 6 }}>{assignedLabel} ✓</span>}
          </div>

          {/* Single tables */}
          {singleTables.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Single Tables</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 12 }}>
                {singleTables.map(t => (
                  <button key={t.id} onClick={() => onAssign(t.id)} disabled={assigning}
                    style={{ padding: '7px 4px', borderRadius: 8, border: `2px solid ${isAssigned(t.id) ? '#22c55e' : '#e5e7eb'}`,
                      background: isAssigned(t.id) ? '#dcfce7' : 'white', color: isAssigned(t.id) ? '#166534' : '#1a1a2e',
                      cursor: assigning ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'center' }}>
                    <div>T{t.table_number}</div>
                    <div style={{ fontSize: 10, color: '#888', fontWeight: 400 }}>{t.capacity}p</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Linked combinations */}
          {suitableGroups.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>🔗 Linked Tables</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
                {suitableGroups.map(group => (
                  <button key={group.label} onClick={() => onAssign(group.ids[0])} disabled={assigning}
                    style={{ padding: '9px 12px', borderRadius: 8, border: `2px solid ${isGroupAssigned(group) ? '#22c55e' : '#e5e7eb'}`,
                      background: isGroupAssigned(group) ? '#dcfce7' : 'white', color: isGroupAssigned(group) ? '#166534' : '#1a1a2e',
                      cursor: assigning ? 'not-allowed' : 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 13, fontWeight: 700, textAlign: 'left' }}>
                    <span>{group.label}</span>
                    <span style={{ fontSize: 11, color: isGroupAssigned(group) ? '#166534' : '#888', fontWeight: 600 }}>{group.capacity}p max</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {singleTables.length === 0 && suitableGroups.length === 0 && (
            <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>No tables or combinations with {res.covers}+ capacity</div>
          )}

          {res.table_id && (
            <button onClick={() => onAssign(null)} disabled={assigning}
              style={{ width: '100%', marginTop: 4, padding: '7px', borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', color: '#888', cursor: 'pointer', fontSize: 12 }}>
              Remove assignment
            </button>
          )}
        </div>

        <div style={{ fontSize: 11, color: '#ccc', textAlign: 'center' }}>via {res.source || 'epos'} · {res.reservation_date}</div>
      </div>
    </div>
  );
}
