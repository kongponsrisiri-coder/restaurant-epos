import { useState, useEffect } from 'react';
import SeatActionSheet from '../components/SeatActionSheet';

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
  // SEPOS-044 — seated needs to be IMMEDIATELY obvious on the floor plan
  // so reception (separate from servers) can see at a glance which tables
  // are taken. Punchier green + stronger border + dark text on light bg.
  seated:    { bg: '#22c55e', border: '#15803d', text: 'white',   dot: '#22c55e' },
  completed: { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3', dot: '#6366f1' },
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
  if (!tiers || !tiers.length) return 90;
  const tier = tiers.find(t => covers >= t.covers_min && (t.covers_max == null || covers <= t.covers_max));
  return tier ? tier.duration_mins : 90;
}

// Multi-table join — the full set of tables a reservation occupies.
// `table_ids` is a CSV; older bookings only have the single `table_id`.
function resTableIds(r) {
  if (!r) return [];
  if (r.table_ids) return String(r.table_ids).split(',').map(s => Number(s.trim())).filter(Boolean);
  return r.table_id ? [Number(r.table_id)] : [];
}

function buildTableGroups(combinations, tables) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });
  const adj = {};
  combinations.forEach(c => {
    if (!adj[c.table_id_a]) adj[c.table_id_a] = [];
    if (!adj[c.table_id_b]) adj[c.table_id_b] = [];
    adj[c.table_id_a].push(c.table_id_b);
    adj[c.table_id_b].push(c.table_id_a);
  });
  const parent = {};
  function find(x) { if (parent[x] == null) parent[x] = x; if (parent[x] !== x) parent[x] = find(parent[x]); return parent[x]; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  combinations.forEach(c => union(c.table_id_a, c.table_id_b));
  const components = {};
  const allIds = new Set();
  combinations.forEach(c => { allIds.add(c.table_id_a); allIds.add(c.table_id_b); });
  allIds.forEach(id => {
    if (!tableMap[id]) return;
    const root = find(id);
    if (!components[root]) components[root] = [];
    components[root].push(id);
  });
  return Object.values(components).filter(ids => ids.length >= 2).map(ids => {
    const localAdj = {};
    ids.forEach(id => { localAdj[id] = (adj[id] || []).filter(n => ids.includes(n)); });
    const endpoints = ids.filter(id => localAdj[id].length === 1);
    const start = endpoints[0] || ids[0];
    const chain = [start]; const visited = new Set([start]); let cur = start;
    while (true) { const next = (localAdj[cur] || []).find(n => !visited.has(n)); if (!next) break; chain.push(next); visited.add(next); cur = next; }
    const chainTables = chain.map(id => tableMap[id]).filter(Boolean);
    const capacity = chainTables.reduce((s, t) => s + (t.capacity || 0), 0);
    return { chain, ids: chain, tables: chainTables, capacity, label: chainTables.map(t => `T${t.table_number}`).join('+') };
  });
}

function getSubCombos(tableGroups, tables, minCapacity) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });
  const result = []; const seen = new Set();
  tableGroups.forEach(group => {
    const chain = group.chain || group.ids;
    for (let start = 0; start < chain.length; start++) {
      let capacity = 0;
      for (let end = start; end < chain.length; end++) {
        const t = tableMap[chain[end]]; if (!t) continue;
        capacity += t.capacity || 0;
        if (end <= start) continue;
        const subIds = chain.slice(start, end + 1); const key = subIds.join('-');
        if (seen.has(key)) continue; seen.add(key);
        if (capacity >= minCapacity) {
          const subTables = subIds.map(id => tableMap[id]).filter(Boolean);
          result.push({ ids: subIds, tables: subTables, capacity, label: subTables.map(t => `T${t.table_number}`).join('+') });
        }
      }
    }
  });
  return result.sort((a, b) => a.capacity - b.capacity || a.ids.length - b.ids.length);
}

// Also return under-capacity combos for "squeeze" options
function getAllCombos(tableGroups, tables) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });
  const result = []; const seen = new Set();
  tableGroups.forEach(group => {
    const chain = group.chain || group.ids;
    for (let start = 0; start < chain.length; start++) {
      let capacity = 0;
      for (let end = start; end < chain.length; end++) {
        const t = tableMap[chain[end]]; if (!t) continue;
        capacity += t.capacity || 0;
        if (end <= start) continue;
        const subIds = chain.slice(start, end + 1); const key = subIds.join('-');
        if (seen.has(key)) continue; seen.add(key);
        const subTables = subIds.map(id => tableMap[id]).filter(Boolean);
        result.push({ ids: subIds, tables: subTables, capacity, label: subTables.map(t => `T${t.table_number}`).join('+') });
      }
    }
  });
  return result.sort((a, b) => a.capacity - b.capacity || a.ids.length - b.ids.length);
}

function getTakenTableIds(allReservations, currentRes, tiers) {
  const curStart = toMins(currentRes.reservation_time);
  const curEnd   = curStart + getDuration(currentRes.covers, tiers);
  const taken    = new Set();
  allReservations.forEach(r => {
    if (r.id === currentRes.id) return;
    if (r.status === 'cancelled' || r.status === 'no-show') return;
    const rIds = resTableIds(r);
    if (!rIds.length) return;
    const rStart = toMins(r.reservation_time), rEnd = rStart + getDuration(r.covers, tiers);
    if (curStart < rEnd && curEnd > rStart) rIds.forEach(id => taken.add(id));
  });
  return taken;
}

// Get the conflicting booking for a table
function getConflictingBooking(tableId, allReservations, currentRes, tiers) {
  const curStart = toMins(currentRes.reservation_time);
  const curEnd   = curStart + getDuration(currentRes.covers, tiers);
  return allReservations.find(r => {
    if (r.id === currentRes.id || !resTableIds(r).includes(tableId)) return false;
    if (r.status === 'cancelled' || r.status === 'no-show') return false;
    const rStart = toMins(r.reservation_time), rEnd = rStart + getDuration(r.covers, tiers);
    return curStart < rEnd && curEnd > rStart;
  });
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
export default function ReservationPlanView({ reservations = [], selectedDate, onRefresh, view }) {
  // SEPOS-044 — `view` prop ('timeline' | 'floorplan') makes the sub-view
  // externally controlled. ReservationsScreen now drives it from its top
  // nav, so the internal toggle is hidden in that case.
  const [planView,     setPlanView]     = useState(view || 'timeline');
  useEffect(() => { if (view) setPlanView(view); }, [view]);
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

  const tableGroups    = buildTableGroups(combinations, tables);
  // SEPOS-044 — completed bookings shouldn't keep claiming a table on the
  // floor plan; once the bill closes the table should go free (unless
  // another upcoming reservation is assigned to it).
  const active         = reservations.filter(r =>
    r.status !== 'cancelled' && r.status !== 'no-show' && r.status !== 'completed'
  );
  const maxCoversPerSlot = settings?.max_covers_per_slot || 20;

  // Multi-table assign — `ids` is the full set of tables for this booking.
  const assignTables = async (ids) => {
    if (!selectedRes) return;
    const idsArr = (Array.isArray(ids) ? ids : (ids != null ? [ids] : [])).filter(Boolean);
    setAssigning(true);
    await put(`/api/reservations/${selectedRes.id}`, {
      customer_name: selectedRes.customer_name, customer_phone: selectedRes.customer_phone,
      customer_email: selectedRes.customer_email || null, covers: selectedRes.covers,
      reservation_date: selectedRes.reservation_date, reservation_time: selectedRes.reservation_time,
      table_ids: idsArr, notes: selectedRes.notes || null, status: selectedRes.status,
    });
    if (onRefresh) onRefresh();
    setSelectedRes(r => ({ ...r, table_id: idsArr[0] || null, table_ids: idsArr.join(',') || null }));
    setAssigning(false);
  };

  const updateStatus = async (status) => {
    if (!selectedRes) return;
    await put(`/api/reservations/${selectedRes.id}`, {
      customer_name: selectedRes.customer_name, customer_phone: selectedRes.customer_phone,
      customer_email: selectedRes.customer_email || null, covers: selectedRes.covers,
      reservation_date: selectedRes.reservation_date, reservation_time: selectedRes.reservation_time,
      table_ids: resTableIds(selectedRes), notes: selectedRes.notes || null, status,
    });
    if (onRefresh) onRefresh();
    setSelectedRes(r => ({ ...r, status }));
  };

  const timeStart = toMins(settings?.opening_time || '11:00');
  const timeEnd   = toMins(settings?.last_booking_time || '22:00') + 90;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 185px)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#f8f9fa', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        {!view && (
          <div style={{ display: 'flex', gap: 4 }}>
            {[['timeline','⏱ Timeline'],['floorplan','🗺 Floor Plan']].map(([v, l]) => (
              <button key={v} onClick={() => setPlanView(v)}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: planView === v ? '#1a1a2e' : '#e5e7eb', color: planView === v ? 'white' : '#555' }}>
                {l}
              </button>
            ))}
          </div>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#555' }}>
          <strong style={{ color: '#1a1a2e' }}>{active.length}</strong> bookings ·{' '}
          <strong style={{ color: '#e94560' }}>{active.reduce((s, r) => s + r.covers, 0)}</strong> covers ·{' '}
          <span style={{ color: '#888' }}>max {maxCoversPerSlot}/slot</span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {planView === 'timeline' ? (
          <TimelineView tables={tables} reservations={active} tiers={tiers}
            tableGroups={tableGroups} settings={settings}
            timeStart={timeStart} timeEnd={timeEnd}
            selectedRes={selectedRes} onSelect={setSelectedRes} />
        ) : (
          <FloorPlanView tables={tables} reservations={active} tiers={tiers}
            tableGroups={tableGroups} selectedRes={selectedRes} onSelect={setSelectedRes}
            onRefresh={onRefresh} selectedDate={selectedDate} />
        )}
        {selectedRes && (
          <BookingPanel res={selectedRes} allReservations={active}
            tables={tables} tableGroups={tableGroups} tiers={tiers}
            onAssign={assignTables} onStatusChange={updateStatus}
            onClose={() => setSelectedRes(null)} assigning={assigning} />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// TIMELINE VIEW — stacks overlapping bookings on same row
// ═══════════════════════════════════════════════════════
function TimelineView({ tables, reservations, tiers, tableGroups, settings, timeStart, timeEnd, selectedRes, onSelect }) {
  const SLOT = 30, COL_W = 72, LBL_W = 120;
  const totalMins  = timeEnd - timeStart;
  const maxPerSlot = settings?.max_covers_per_slot || 20;
  const slots = [];
  for (let m = timeStart; m <= timeEnd; m += SLOT) slots.push(m);

  // SEPOS-049 — Build rows: one per PHYSICAL table. Linked tables used to
  // collapse into a single combined row, so a small party dropped on one
  // linked table visually consumed the whole linked group, and a second
  // small party on a sibling table looked like an overlap conflict.
  // Each table now gets its own row. A booking only spills onto its
  // sibling rows when it genuinely needs the linked group — i.e. its
  // covers exceed the assigned table's own capacity — the same rule the
  // floor plan and /api/tables/status already use (SEPOS-044).
  const tableById = {};
  tables.forEach(t => { tableById[t.id] = t; });

  const rowMap = {};
  const ensureRow = (t) => {
    if (!rowMap[t.id]) {
      rowMap[t.id] = {
        key: `t-${t.id}`, tableNumber: t.table_number,
        label: `T${t.table_number}`, capacity: t.capacity || 0,
        linked: tableGroups.some(g => g.ids.includes(t.id)),
        entries: [],
      };
    }
    return rowMap[t.id];
  };
  tables.forEach(t => ensureRow(t));

  // A booking occupies every table in its table_ids set. The first table
  // is the primary; the rest render as dashed "ghost" entries so staff
  // see those tables are part of the joined group.
  reservations.forEach(r => {
    const ids = resTableIds(r).filter(id => tableById[id]);
    ids.forEach((id, idx) => {
      ensureRow(tableById[id]).entries.push({ res: r, isPrimary: idx === 0 });
    });
  });

  // No tables, or table ids pointing at since-deleted tables → surface
  // it in the Unassigned row so staff can re-seat it.
  const unassigned = reservations.filter(r => resTableIds(r).filter(id => tableById[id]).length === 0);
  const rows = Object.values(rowMap).sort((a, b) => (a.tableNumber || 0) - (b.tableNumber || 0));

  function pxLeft(ts) { return ((toMins(ts) - timeStart) / totalMins) * (slots.length * COL_W); }
  function pxWidth(ts, cov) { return (getDuration(cov, tiers) / totalMins) * (slots.length * COL_W) - 4; }

  // Detect overlaps within a row and assign vertical lanes
  function assignLanes(rowEntries) {
    const sorted = [...rowEntries].sort((a, b) => toMins(a.res.reservation_time) - toMins(b.res.reservation_time));
    const lanes = []; // each lane is array of entries
    sorted.forEach(e => {
      const rStart = toMins(e.res.reservation_time);
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        const last = lanes[i][lanes[i].length - 1].res;
        const lastEnd = toMins(last.reservation_time) + getDuration(last.covers, tiers);
        if (rStart >= lastEnd) { lanes[i].push(e); placed = true; break; }
      }
      if (!placed) lanes.push([e]);
    });
    // Build map: res.id → laneIndex
    const laneMap = {};
    lanes.forEach((lane, i) => lane.forEach(e => { laneMap[e.res.id] = i; }));
    return { laneMap, laneCount: lanes.length };
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa' }}>
      <div style={{ minWidth: LBL_W + slots.length * COL_W + 20 }}>
        {/* Time header */}
        <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 10, background: '#1a1a2e' }}>
          <div style={{ width: LBL_W, flexShrink: 0, padding: '10px 12px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Table</div>
          {slots.map(m => (
            <div key={m} style={{ width: COL_W, flexShrink: 0, padding: '10px 0', fontSize: 11, fontWeight: m % 60 === 0 ? 700 : 400, textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.07)', color: m % 60 === 0 ? 'white' : 'rgba(255,255,255,0.3)' }}>
              {m % 60 === 0 ? minsToTime(m) : '·'}
            </div>
          ))}
        </div>

        {rows.map((row, ri) => {
          const { laneMap, laneCount } = assignLanes(row.entries);
          const LANE_H = 44;
          const rowH = Math.max(54, laneCount * LANE_H + 10);

          return (
            <div key={row.key} style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: ri % 2 === 0 ? 'white' : '#fafafa', height: rowH }}>
              <div style={{ width: LBL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '2px solid #e5e7eb', position: 'sticky', left: 0, background: 'inherit', zIndex: 2 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#1a1a2e' }}>
                  {row.label}
                  {row.linked && <span title="Can be linked with adjacent tables" style={{ marginLeft: 4, fontSize: 11 }}>🔗</span>}
                </div>
                <div style={{ fontSize: 11, color: laneCount > 1 ? '#ef4444' : '#9ca3af' }}>
                  {row.capacity}p {laneCount > 1 && <span style={{ fontWeight: 700 }}>⚠ {laneCount} overlap</span>}
                </div>
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                {slots.map(m => <div key={m} style={{ position: 'absolute', left: ((m - timeStart) / totalMins) * (slots.length * COL_W), top: 0, bottom: 0, width: 1, background: m % 60 === 0 ? '#e5e7eb' : '#f3f4f6' }} />)}
                {/* Overlap warning band */}
                {laneCount > 1 && <div style={{ position: 'absolute', inset: 0, background: 'rgba(239,68,68,0.04)', pointerEvents: 'none' }} />}
                {row.entries.map(({ res: r, isPrimary }) => {
                  const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
                  const isSel = selectedRes?.id === r.id;
                  const lane = laneMap[r.id] || 0;
                  const top = 5 + lane * LANE_H;
                  const h = LANE_H - 6;
                  // isPrimary === false → this booking is too large for its own
                  // table and spills across the linked group; show it as a
                  // dashed "ghost" so staff see the table is consumed.
                  return (
                    <div key={`${r.id}-${isPrimary ? 'p' : 'g'}`} onClick={() => onSelect(r)}
                      title={isPrimary ? undefined : `${r.customer_name} (${r.covers}p) — uses this table as part of a linked group`}
                      style={{ position: 'absolute', left: pxLeft(r.reservation_time) + 2, top, height: h,
                        width: Math.max(pxWidth(r.reservation_time, r.covers), 70),
                        background: isSel ? '#1a1a2e' : isPrimary ? c.bg : 'repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 6px, #e8eaed 6px, #e8eaed 12px)',
                        border: `2px ${isPrimary ? 'solid' : 'dashed'} ${isSel ? '#e94560' : laneCount > 1 ? '#ef4444' : isPrimary ? c.border : '#cbd5e1'}`,
                        borderRadius: 8, padding: '3px 8px', cursor: 'pointer', overflow: 'hidden', zIndex: isSel ? 5 : 3,
                        boxShadow: isSel ? '0 4px 16px rgba(0,0,0,0.25)' : '0 1px 3px rgba(0,0,0,0.08)', transition: 'all 0.15s' }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: isSel ? 'white' : isPrimary ? c.text : '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {isPrimary ? r.customer_name : `🔗 ${r.customer_name}`}
                      </div>
                      <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.7)' : isPrimary ? c.text : '#6b7280', opacity: 0.85 }}>
                        {isPrimary ? `${r.reservation_time} · ${r.covers}p` : `linked · ${r.covers}p`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {unassigned.length > 0 && (
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#fffbeb', height: 54 }}>
            <div style={{ width: LBL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '2px solid #e5e7eb', position: 'sticky', left: 0, background: '#fffbeb', zIndex: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>⚠ Unassigned</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{unassigned.length} booking{unassigned.length !== 1 ? 's' : ''}</div>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              {unassigned.map(r => {
                const isSel = selectedRes?.id === r.id;
                const left = ((toMins(r.reservation_time) - timeStart) / totalMins) * (slots.length * COL_W);
                const width = (getDuration(r.covers, tiers) / totalMins) * (slots.length * COL_W) - 4;
                return (
                  <div key={r.id} onClick={() => onSelect(r)}
                    style={{ position: 'absolute', left: left + 2, top: 6, height: 42, width: Math.max(width, 70),
                      background: isSel ? '#1a1a2e' : '#fff7ed', border: `2px dashed ${isSel ? '#e94560' : '#f59e0b'}`,
                      borderRadius: 8, padding: '3px 8px', cursor: 'pointer', overflow: 'hidden', zIndex: isSel ? 5 : 3, transition: 'all 0.15s' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: isSel ? 'white' : '#92400e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.customer_name}</div>
                    <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.7)' : '#92400e', opacity: 0.85 }}>{r.reservation_time} · {r.covers}p</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Capacity footer */}
        <div style={{ display: 'flex', background: '#1a1a2e', position: 'sticky', bottom: 0 }}>
          <div style={{ width: LBL_W, flexShrink: 0, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>
            <div>Covers</div><div style={{ fontSize: 9, opacity: 0.6 }}>max {maxPerSlot}</div>
          </div>
          {slots.map(m => {
            const covers = reservations.reduce((sum, r) => { const s = toMins(r.reservation_time), e = s + getDuration(r.covers, tiers); return s <= m && e > m ? sum + r.covers : sum; }, 0);
            const pct = Math.min(covers / maxPerSlot, 1);
            const barColor = pct >= 1 ? '#ef4444' : pct >= 0.75 ? '#f59e0b' : '#22c55e';
            return (
              <div key={m} style={{ width: COL_W, flexShrink: 0, padding: '4px 2px', textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: covers > 0 ? '#C9A84C' : 'rgba(255,255,255,0.15)' }}>{covers > 0 ? covers : '·'}</div>
                {covers > 0 && <div style={{ width: COL_W - 8, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}><div style={{ width: `${pct * 100}%`, height: '100%', background: barColor, borderRadius: 2 }} /></div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// FLOOR PLAN VIEW
// ═══════════════════════════════════════════════════════
function FloorPlanView({ tables, reservations, tiers, tableGroups, selectedRes, onSelect, onRefresh, selectedDate }) {
  const [seatTable, setSeatTable] = useState(null);  // SEPOS-044 — tap-to-seat target
  const canvasW = tables.length ? Math.max(900, ...tables.map(t => (t.pos_x||0) + (t.width||80) + 80)) : 900;
  const canvasH = tables.length ? Math.max(600, ...tables.map(t => (t.pos_y||0) + (t.height||80) + 80)) : 600;

  function getBookingForTable(tableId) {
    // A booking sits on a table when that table is in its table_ids set.
    return reservations.find(r => resTableIds(r).includes(tableId)) || null;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #e5e7eb', background: 'white', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 1, flexShrink: 0 }}>
          Bookings · {reservations.length}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 20 }}>
          {reservations.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#888', fontSize: 13 }}>No bookings today</div>}
          {reservations.map(r => {
            const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
            const isSel = selectedRes?.id === r.id;
            const rIds = resTableIds(r);
            const tLabel = rIds.length
              ? rIds.map(id => { const tt = tables.find(x => x.id === id); return tt ? `T${tt.table_number}` : '?'; }).join('+')
              : '⚠ No table';
            return (
              <div key={r.id} onClick={() => onSelect(r)}
                style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', borderLeft: `4px solid ${c.border}`, background: isSel ? '#1a1a2e' : 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isSel ? 'white' : '#1a1a2e' }}>{r.customer_name}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: isSel ? 'rgba(255,255,255,0.15)' : c.bg, color: isSel ? 'white' : c.text, textTransform: 'capitalize' }}>{r.status}</div>
                </div>
                <div style={{ fontSize: 11, color: isSel ? 'rgba(255,255,255,0.6)' : '#9ca3af' }}>
                  {r.reservation_time} · {r.covers}p · {tLabel}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#f0ede8', backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)', backgroundSize: '30px 30px' }}>
        <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
          <div style={{ position: 'absolute', top: 12, right: 12, background: 'white', borderRadius: 10, padding: '10px 14px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 10 }}>
            {['pending','confirmed','seated'].map(s => <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s].dot }} /><span style={{ color: '#555', textTransform: 'capitalize' }}>{s}</span></div>)}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, paddingTop: 4, borderTop: '1px solid #f0f0f0' }}><div style={{ width: 8, height: 8, borderRadius: '50%', border: '1px solid #9ca3af', background: 'white' }} /><span style={{ color: '#555' }}>Available</span></div>
          </div>
          {tables.map(table => {
            const booking = getBookingForTable(table.id);
            const c = booking ? (STATUS_COLORS[booking.status] || STATUS_COLORS.pending) : null;
            const isSel = selectedRes?.id === booking?.id;
            const isPrimary     = booking && resTableIds(booking)[0] === table.id;
            const isGroupMember = booking && !isPrimary;
            return (
              <div key={table.id} onClick={() => setSeatTable(table)}
                style={{ position: 'absolute', left: table.pos_x||0, top: table.pos_y||0, width: table.width||80, height: table.height||80,
                  borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                  background: isSel ? '#1a1a2e' : booking ? c.bg : 'white',
                  border: `3px ${isGroupMember ? 'dashed' : 'solid'} ${isSel ? '#e94560' : booking ? c.border : '#cbd5e1'}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  cursor: booking ? 'pointer' : 'default', userSelect: 'none', zIndex: isSel ? 10 : 3,
                  boxShadow: isSel ? '0 4px 20px rgba(0,0,0,0.25)' : '0 2px 6px rgba(0,0,0,0.08)', transition: 'all 0.15s' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: isSel ? 'white' : booking ? c.text : '#1a1a2e', lineHeight: 1 }}>{table.table_number}</div>
                {isPrimary ? (
                  <>
                    <div style={{
                      fontSize: 11, fontWeight: 800, color: isSel ? 'white' : c.text,
                      marginTop: 4, textAlign: 'center',
                      maxWidth: '92%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {booking.customer_name.split(' ')[0]} · {booking.covers}p
                    </div>
                    {booking.status === 'seated' && (
                      <div style={{
                        fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                        background: 'rgba(255,255,255,0.25)', color: 'white',
                        padding: '1px 6px', borderRadius: 4, marginTop: 3,
                      }}>🪑 SEATED</div>
                    )}
                  </>
                ) : !booking ? (
                  <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>Tap to seat · {table.capacity}p</div>
                ) : null}
              </div>
            );
          })}
          {tables.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#888' }}><div style={{ fontSize: 36 }}>🗺</div><div>Set up your floor plan in Admin → Table Plan first</div></div>}
        </div>
      </div>

      {/* SEPOS-044 — tap any table → action sheet.
          Empty: seat upcoming booking / walk-in / pre-assign future booking.
          Occupied: view current booking + pre-assign a future booking. */}
      {seatTable && (
        <SeatActionSheet
          table={seatTable}
          bookings={reservations}
          tableGroups={tableGroups}
          selectedDate={selectedDate}
          currentBooking={getBookingForTable(seatTable.id) || null}
          onClose={() => setSeatTable(null)}
          onSeated={() => { setSeatTable(null); onRefresh?.(); }}
          onViewBooking={(b) => { setSeatTable(null); onSelect(b); }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// BOOKING DETAIL PANEL — with confirm dialog for overrides
// ═══════════════════════════════════════════════════════
function BookingPanel({ res, allReservations, tables, tableGroups, tiers, onAssign, onStatusChange, onClose, assigning }) {
  const duration = getDuration(res.covers, tiers);
  const endTime  = minsToTime(toMins(res.reservation_time) + duration);
  const takenIds = getTakenTableIds(allReservations, res, tiers);

  // Multi-table join — the set of tables currently on this booking.
  const selectedIds = resTableIds(res);
  const selectedCapacity = selectedIds.reduce((s, id) => {
    const t = tables.find(t => t.id === id); return s + (t ? (t.capacity || 0) : 0);
  }, 0);
  const enough = selectedCapacity >= res.covers;

  const allTables = [...tables].sort((a, b) => a.table_number - b.table_number);
  const allCombos = getAllCombos(tableGroups, tables);

  // A table only warns when ANOTHER booking overlaps this slot. Capacity
  // is no longer a per-table warning — the selected-set summary shows
  // whether the joined tables seat the whole party.
  function getTableWarning(table) {
    if (takenIds.has(table.id)) {
      const conflict = getConflictingBooking(table.id, allReservations, res, tiers);
      return { type: 'conflict', msg: `⚠ T${table.table_number} is booked by ${conflict?.customer_name || 'another party'} at ${conflict?.reservation_time || 'this time'}. Add it anyway?` };
    }
    return null;
  }
  function getComboWarning(combo) {
    if (combo.ids.some(id => takenIds.has(id))) {
      return { type: 'conflict', msg: `⚠ ${combo.label} includes a table that's booked at this time. Assign anyway?` };
    }
    return null;
  }

  // Tapping a table toggles it in/out of the join; a combo sets the
  // whole group at once. Each change persists immediately.
  function toggleTable(tableId, warning) {
    if (selectedIds.includes(tableId)) {
      onAssign(selectedIds.filter(id => id !== tableId));
    } else {
      if (warning && !window.confirm(warning.msg)) return;
      onAssign([...selectedIds, tableId]);
    }
  }
  function assignCombo(combo, warning) {
    if (warning && !window.confirm(warning.msg)) return;
    onAssign(combo.ids);
  }

  function btnStyle(isSel, warning) {
    if (isSel)    return { border: '2px solid #22c55e', background: '#dcfce7', color: '#166534' };
    if (!warning) return { border: '2px solid #e5e7eb', background: 'white', color: '#1a1a2e' };
    return { border: '2px solid #fca5a5', background: '#fef2f2', color: '#ef4444' };
  }

  return (
    <div style={{ width: 290, flexShrink: 0, minHeight: 0, background: 'white', borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#1a1a2e' }}>{res.customer_name}</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{res.reservation_time} – {endTime} · {res.covers}p · {duration}min</div>
        </div>
        <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: '#f3f4f6', cursor: 'pointer', fontSize: 16, color: '#555' }}>×</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Status */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 8 }}>Status</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {['pending','confirmed','seated','completed','no-show','cancelled'].map(s => (
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

        {/* Table assignment — tap multiple tables to join them */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 8 }}>
            Assign Table{selectedIds.length > 1 ? 's' : ''}
          </div>

          {/* Selected-set summary */}
          <div style={{
            background: enough ? '#dcfce7' : selectedIds.length ? '#fffbeb' : '#f3f4f6',
            border: `1px solid ${enough ? '#86efac' : selectedIds.length ? '#fde68a' : '#e5e7eb'}`,
            borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12,
          }}>
            {selectedIds.length === 0 ? (
              <span style={{ color: '#888' }}>No table yet — tap one or more tables below to seat (and join) this party.</span>
            ) : (
              <>
                <div style={{ fontWeight: 800, color: '#1a1a2e' }}>
                  {selectedIds.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : '?'; }).join(' + ')}
                </div>
                <div style={{ color: enough ? '#166534' : '#92400e', fontWeight: 700, marginTop: 2 }}>
                  seats {selectedCapacity} of {res.covers} {enough ? '✓' : '— still short'}
                </div>
              </>
            )}
          </div>

          {/* Single tables — tap to add/remove from the join */}
          <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Tables · tap to join</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 10 }}>
            {allTables.map(t => {
              const isSel = selectedIds.includes(t.id);
              const warning = isSel ? null : getTableWarning(t);
              const bs = btnStyle(isSel, warning);
              return (
                <button key={t.id} onClick={() => toggleTable(t.id, warning)} disabled={assigning}
                  title={warning?.msg || `T${t.table_number} · ${t.capacity}p`}
                  style={{ padding: '7px 4px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'center', ...bs }}>
                  <div>{isSel ? '✓ ' : ''}T{t.table_number}</div>
                  <div style={{ fontSize: 10, fontWeight: 400 }}>{warning ? '⚠ taken' : `${t.capacity}p`}</div>
                </button>
              );
            })}
          </div>

          {/* Linked-table shortcuts (pre-configured combinations) */}
          {allCombos.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>🔗 Linked shortcuts</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
                {allCombos.map(combo => {
                  const isSel = combo.ids.length === selectedIds.length && combo.ids.every(id => selectedIds.includes(id));
                  const warning = isSel ? null : getComboWarning(combo);
                  const bs = btnStyle(isSel, warning);
                  return (
                    <button key={combo.label} onClick={() => assignCombo(combo, warning)} disabled={assigning}
                      title={warning?.msg || `Assign ${combo.label}`}
                      style={{ padding: '9px 12px', borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontWeight: 700, ...bs }}>
                      <span>{isSel ? '✓ ' : ''}{combo.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 600 }}>{combo.capacity}p</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {selectedIds.length > 0 && (
            <button onClick={() => onAssign([])} disabled={assigning}
              style={{ width: '100%', marginTop: 4, padding: '7px', borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', color: '#888', cursor: 'pointer', fontSize: 12 }}>
              Clear all tables
            </button>
          )}
        </div>

        <div style={{ fontSize: 11, color: '#ccc', textAlign: 'center' }}>via {res.source || 'epos'} · {res.reservation_date}</div>
      </div>
    </div>
  );
}
