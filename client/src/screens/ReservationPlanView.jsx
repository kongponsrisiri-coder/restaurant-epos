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
  if (!tiers || !tiers.length) return 90;
  const tier = tiers.find(t => covers >= t.covers_min && (t.covers_max == null || covers <= t.covers_max));
  return tier ? tier.duration_mins : 90;
}

// ── Build ordered chains from combination pairs ───────────────────
// Each chain is a linear sequence of table IDs in order
function buildTableGroups(combinations, tables) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });

  // Adjacency list
  const adj = {};
  combinations.forEach(c => {
    if (!adj[c.table_id_a]) adj[c.table_id_a] = [];
    if (!adj[c.table_id_b]) adj[c.table_id_b] = [];
    adj[c.table_id_a].push(c.table_id_b);
    adj[c.table_id_b].push(c.table_id_a);
  });

  // Union-Find for connected components
  const parent = {};
  function find(x) {
    if (parent[x] == null) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  combinations.forEach(c => union(c.table_id_a, c.table_id_b));

  // Group by component
  const components = {};
  const allIds = new Set();
  combinations.forEach(c => { allIds.add(c.table_id_a); allIds.add(c.table_id_b); });
  allIds.forEach(id => {
    if (!tableMap[id]) return;
    const root = find(id);
    if (!components[root]) components[root] = [];
    components[root].push(id);
  });

  // Build ordered chain for each component
  return Object.values(components)
    .filter(ids => ids.length >= 2)
    .map(ids => {
      // Local adjacency (within this component only)
      const localAdj = {};
      ids.forEach(id => { localAdj[id] = (adj[id] || []).filter(n => ids.includes(n)); });

      // Find an endpoint (degree 1) to start the chain
      const endpoints = ids.filter(id => localAdj[id].length === 1);
      const start = endpoints[0] || ids[0];

      // Walk the chain
      const chain = [start];
      const visited = new Set([start]);
      let cur = start;
      while (true) {
        const next = (localAdj[cur] || []).find(n => !visited.has(n));
        if (!next) break;
        chain.push(next); visited.add(next); cur = next;
      }

      const chainTables = chain.map(id => tableMap[id]).filter(Boolean);
      const capacity = chainTables.reduce((s, t) => s + (t.capacity || 0), 0);
      return {
        chain,              // ordered list of table IDs
        ids: chain,
        tables: chainTables,
        capacity,
        label: chainTables.map(t => `T${t.table_number}`).join('+'),
      };
    });
}

// ── Enumerate all valid contiguous sub-combinations ───────────────
// For a chain [A,B,C,D], sub-combos of length>=2: AB, BC, CD, ABC, BCD, ABCD
// Returns only those with combined capacity >= minCapacity, sorted by capacity asc
function getSubCombos(tableGroups, tables, minCapacity) {
  const tableMap = {};
  tables.forEach(t => { tableMap[t.id] = t; });

  const result = [];
  const seen = new Set();

  tableGroups.forEach(group => {
    const chain = group.chain || group.ids;

    for (let start = 0; start < chain.length; start++) {
      let capacity = 0;
      for (let end = start; end < chain.length; end++) {
        const t = tableMap[chain[end]];
        if (!t) continue;
        capacity += t.capacity || 0;
        if (end <= start) continue; // need at least 2 tables

        const subIds = chain.slice(start, end + 1);
        const key = subIds.join('-');
        if (seen.has(key)) continue;
        seen.add(key);

        if (capacity >= minCapacity) {
          const subTables = subIds.map(id => tableMap[id]).filter(Boolean);
          result.push({
            ids: subIds,
            tables: subTables,
            capacity,
            label: subTables.map(t => `T${t.table_number}`).join('+'),
          });
        }
      }
    }
  });

  return result.sort((a, b) => a.capacity - b.capacity || a.ids.length - b.ids.length);
}

// ── Find which table IDs are taken during a booking's time window ─
function getTakenTableIds(allReservations, currentRes, tiers) {
  const curStart = toMins(currentRes.reservation_time);
  const curEnd   = curStart + getDuration(currentRes.covers, tiers);
  const taken    = new Set();

  allReservations.forEach(r => {
    if (r.id === currentRes.id) return;
    if (!r.table_id) return;
    if (r.status === 'cancelled' || r.status === 'no-show') return;
    const rStart = toMins(r.reservation_time);
    const rEnd   = rStart + getDuration(r.covers, tiers);
    if (curStart < rEnd && curEnd > rStart) taken.add(r.table_id);
  });
  return taken;
}

// ── Group label helper ────────────────────────────────────────────
function getGroupForTable(tableId, tableGroups) {
  return tableGroups.find(g => g.ids.includes(tableId)) || null;
}

function getAssignedLabel(res, tables, tableGroups) {
  if (!res.table_id) return null;
  const table = tables.find(t => t.id === res.table_id);
  if (!table) return null;
  // Find which sub-combo was assigned (may not be full group)
  const group = getGroupForTable(res.table_id, tableGroups);
  if (!group) return `T${table.table_number}`;
  // We only store the first table of the combo — reconstruct the label
  // by checking which group member is assigned
  return `T${table.table_number}`; // Simple for now
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
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
  const active      = reservations.filter(r => r.status !== 'cancelled' && r.status !== 'no-show');

  const assignTable = async (tableId) => {
    if (!selectedRes) return;
    setAssigning(true);
    const data = await put(`/api/reservations/${selectedRes.id}`, {
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

  // Capacity bar data for timeline
  const maxCoversPerSlot = settings?.max_covers_per_slot || 20;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 170px)', overflow: 'hidden', flexDirection: 'column' }}>

      {/* Sub-header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: '#f8f9fa', borderBottom: '1px solid #e5e7eb', flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[['timeline','⏱ Timeline'],['floorplan','🗺 Floor Plan']].map(([v, l]) => (
            <button key={v} onClick={() => setPlanView(v)}
              style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                background: planView === v ? '#1a1a2e' : '#e5e7eb', color: planView === v ? 'white' : '#555' }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, marginLeft: 'auto', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#555' }}>
            <strong style={{ color: '#1a1a2e' }}>{active.length}</strong> bookings ·{' '}
            <strong style={{ color: '#e94560' }}>{active.reduce((s, r) => s + r.covers, 0)}</strong> covers ·{' '}
            <span style={{ color: '#888' }}>max {maxCoversPerSlot}/slot</span>
          </span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {planView === 'timeline' ? (
          <TimelineView
            tables={tables} reservations={active} tiers={tiers}
            tableGroups={tableGroups} settings={settings}
            timeStart={timeStart} timeEnd={timeEnd}
            selectedRes={selectedRes} onSelect={setSelectedRes}
          />
        ) : (
          <FloorPlanView
            tables={tables} reservations={active} tiers={tiers}
            tableGroups={tableGroups}
            selectedRes={selectedRes} onSelect={setSelectedRes}
          />
        )}

        {selectedRes && (
          <BookingPanel
            res={selectedRes}
            allReservations={active}
            tables={tables}
            tableGroups={tableGroups}
            tiers={tiers}
            onAssign={assignTable}
            onStatusChange={updateStatus}
            onClose={() => setSelectedRes(null)}
            assigning={assigning}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TIMELINE VIEW
// ═══════════════════════════════════════════════════════════════════
function TimelineView({ tables, reservations, tiers, tableGroups, settings, timeStart, timeEnd, selectedRes, onSelect }) {
  const SLOT = 30, COL_W = 72, ROW_H = 54, LBL_W = 120;
  const totalMins = timeEnd - timeStart;
  const slots = [];
  for (let m = timeStart; m <= timeEnd; m += SLOT) slots.push(m);
  const maxPerSlot = settings?.max_covers_per_slot || 20;

  const assignedIds = new Set(reservations.filter(r => r.table_id).map(r => r.table_id));

  // Build rows — one per unique assigned table/group, plus unassigned
  const rowMap = {}; // groupKey → { label, capacity, tableIds, reservations[] }
  reservations.filter(r => r.table_id).forEach(r => {
    // Find if this table is part of a combination that was assigned
    const group = tableGroups.find(g => g.ids.includes(r.table_id));
    const key = group ? group.ids[0] : r.table_id;
    if (!rowMap[key]) {
      const t = tables.find(t => t.id === r.table_id);
      rowMap[key] = {
        key,
        label: group ? group.label : (t ? `T${t.table_number}` : `T?`),
        capacity: group ? group.capacity : (t?.capacity || 0),
        reservations: [],
      };
    }
    rowMap[key].reservations.push(r);
  });

  // Add individual unassigned tables too (for empty rows)
  tables.sort((a,b) => a.table_number - b.table_number).forEach(t => {
    if (!assignedIds.has(t.id)) {
      const group = tableGroups.find(g => g.ids.includes(t.id));
      const key = group ? `grp-${group.ids[0]}` : `t-${t.id}`;
      // Skip if group already shown
      if (group && rowMap[group.ids[0]]) return;
      if (!rowMap[key]) {
        rowMap[key] = {
          key,
          label: group ? group.label : `T${t.table_number}`,
          capacity: group ? group.capacity : t.capacity,
          reservations: [],
        };
      }
    }
  });

  const unassigned = reservations.filter(r => !r.table_id);
  const rows = Object.values(rowMap).sort((a, b) => {
    const numA = parseInt(a.label.match(/\d+/)?.[0] || 999);
    const numB = parseInt(b.label.match(/\d+/)?.[0] || 999);
    return numA - numB;
  });

  function pxLeft(ts) { return ((toMins(ts) - timeStart) / totalMins) * (slots.length * COL_W); }
  function pxWidth(ts, cov) { return (getDuration(cov, tiers) / totalMins) * (slots.length * COL_W) - 4; }

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#fafafa' }}>
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

        {/* Table rows */}
        {rows.map((row, ri) => (
          <div key={row.key} style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: ri % 2 === 0 ? 'white' : '#fafafa', height: ROW_H, position: 'relative' }}>
            <div style={{ width: LBL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '2px solid #e5e7eb', position: 'sticky', left: 0, background: 'inherit', zIndex: 2 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#1a1a2e' }}>{row.label}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.capacity}p</div>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              {slots.map(m => <div key={m} style={{ position: 'absolute', left: ((m - timeStart) / totalMins) * (slots.length * COL_W), top: 0, bottom: 0, width: 1, background: m % 60 === 0 ? '#e5e7eb' : '#f3f4f6' }} />)}
              {row.reservations.map(r => {
                const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
                const isSel = selectedRes?.id === r.id;
                return (
                  <div key={r.id} onClick={() => onSelect(r)}
                    style={{ position: 'absolute', left: pxLeft(r.reservation_time) + 2, top: 6, height: ROW_H - 12,
                      width: Math.max(pxWidth(r.reservation_time, r.covers), 70),
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
        ))}

        {/* Unassigned row */}
        {unassigned.length > 0 && (
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#fffbeb', height: ROW_H, position: 'relative' }}>
            <div style={{ width: LBL_W, flexShrink: 0, padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '2px solid #e5e7eb', position: 'sticky', left: 0, background: '#fffbeb', zIndex: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>⚠ Unassigned</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{unassigned.length} booking{unassigned.length !== 1 ? 's' : ''}</div>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              {slots.map(m => <div key={m} style={{ position: 'absolute', left: ((m - timeStart) / totalMins) * (slots.length * COL_W), top: 0, bottom: 0, width: 1, background: '#f3f4f6' }} />)}
              {unassigned.map(r => {
                const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
                const isSel = selectedRes?.id === r.id;
                return (
                  <div key={r.id} onClick={() => onSelect(r)}
                    style={{ position: 'absolute', left: pxLeft(r.reservation_time) + 2, top: 6, height: ROW_H - 12,
                      width: Math.max(pxWidth(r.reservation_time, r.covers), 70),
                      background: isSel ? '#1a1a2e' : '#fff7ed', border: `2px dashed ${isSel ? '#e94560' : '#f59e0b'}`,
                      borderRadius: 8, padding: '4px 8px', cursor: 'pointer', overflow: 'hidden', zIndex: isSel ? 5 : 3,
                      transition: 'all 0.15s' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: isSel ? 'white' : '#92400e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.customer_name}</div>
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
            <div>Covers</div>
            <div style={{ fontSize: 9, opacity: 0.6 }}>max {maxPerSlot}</div>
          </div>
          {slots.map(m => {
            const covers = reservations.reduce((sum, r) => {
              const s = toMins(r.reservation_time), e = s + getDuration(r.covers, tiers);
              return s <= m && e > m ? sum + r.covers : sum;
            }, 0);
            const pct = Math.min(covers / maxPerSlot, 1);
            const barColor = pct >= 1 ? '#ef4444' : pct >= 0.75 ? '#f59e0b' : '#22c55e';
            return (
              <div key={m} style={{ width: COL_W, flexShrink: 0, padding: '4px 2px', textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: covers > 0 ? '#C9A84C' : 'rgba(255,255,255,0.15)' }}>{covers > 0 ? covers : '·'}</div>
                {covers > 0 && (
                  <div style={{ width: COL_W - 8, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                    <div style={{ width: `${pct * 100}%`, height: '100%', background: barColor, borderRadius: 2 }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FLOOR PLAN VIEW
// ═══════════════════════════════════════════════════════════════════
function FloorPlanView({ tables, reservations, tiers, tableGroups, selectedRes, onSelect }) {
  function getBookingForTable(tableId) {
    const direct = reservations.find(r => r.table_id === tableId);
    if (direct) return direct;
    const group = tableGroups.find(g => g.ids.includes(tableId));
    if (group) { for (const id of group.ids) { const f = reservations.find(r => r.table_id === id); if (f) return f; } }
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
          const t = tables.find(t => t.id === r.table_id);
          const label = t ? `T${t.table_number}` : '⚠ No table';
          return (
            <div key={r.id} onClick={() => onSelect(r)}
              style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', borderLeft: `4px solid ${c.border}`, background: isSel ? '#1a1a2e' : 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isSel ? 'white' : '#1a1a2e' }}>{r.customer_name}</div>
                <div style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: isSel ? 'rgba(255,255,255,0.15)' : c.bg, color: isSel ? 'white' : c.text, textTransform: 'capitalize' }}>{r.status}</div>
              </div>
              <div style={{ fontSize: 11, color: isSel ? 'rgba(255,255,255,0.6)' : '#9ca3af' }}>{r.reservation_time} · {r.covers}p · {label}</div>
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
              style={{ position: 'absolute', left: table.pos_x || 0, top: table.pos_y || 0, width: table.width || 80, height: table.height || 80,
                borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                background: isSel ? '#1a1a2e' : booking ? c.bg : 'white',
                border: `3px ${isGroupMember ? 'dashed' : 'solid'} ${isSel ? '#e94560' : booking ? c.border : '#cbd5e1'}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                cursor: booking ? 'pointer' : 'default', userSelect: 'none', zIndex: isSel ? 10 : 3,
                boxShadow: isSel ? '0 4px 20px rgba(0,0,0,0.25)' : '0 2px 6px rgba(0,0,0,0.08)', transition: 'all 0.15s' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: isSel ? 'white' : booking ? c.text : '#1a1a2e' }}>{table.table_number}</div>
              {isPrimary ? <div style={{ fontSize: 9, color: isSel ? 'rgba(255,255,255,0.8)' : c.text, maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{booking.customer_name.split(' ')[0]}</div>
              : !booking ? <div style={{ fontSize: 9, color: '#9ca3af' }}>{table.capacity}p</div> : null}
            </div>
          );
        })}
        {tables.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#888' }}><div style={{ fontSize: 36 }}>🗺</div><div>Set up your floor plan in Admin → Table Plan first</div></div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BOOKING DETAIL PANEL
// ═══════════════════════════════════════════════════════════════════
function BookingPanel({ res, allReservations, tables, tableGroups, tiers, onAssign, onStatusChange, onClose, assigning }) {
  const duration = getDuration(res.covers, tiers);
  const endTime  = minsToTime(toMins(res.reservation_time) + duration);

  // Assigned label
  const assignedTable = tables.find(t => t.id === res.table_id);
  const assignedGroup = tableGroups.find(g => g.ids.includes(res.table_id));

  // Which tables are taken at this booking's time (conflict detection)
  const takenIds = getTakenTableIds(allReservations, res, tiers);

  // Single tables: capacity >= covers AND not taken
  const singleTables = tables
    .filter(t => t.capacity >= res.covers)
    .sort((a, b) => a.capacity - b.capacity || a.table_number - b.table_number);

  // Smart sub-combinations: all valid contiguous sub-combos with capacity >= covers
  const subCombos = getSubCombos(tableGroups, tables, res.covers);

  // Check if a single table is taken
  function isSingleTaken(tableId) { return takenIds.has(tableId) && tableId !== res.table_id; }

  // Check if a combo is taken (any of its tables is taken by another booking)
  function isComboTaken(combo) {
    return combo.ids.some(id => takenIds.has(id) && id !== res.table_id);
  }

  // Check if currently assigned
  function isAssigned(tableId) { return res.table_id === tableId; }
  function isComboAssigned(combo) { return combo.ids.includes(res.table_id); }

  return (
    <div style={{ width: 290, background: 'white', borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'auto' }}>

      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#1a1a2e' }}>{res.customer_name}</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{res.reservation_time} – {endTime} · {res.covers}p · {duration}min</div>
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
          <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 6 }}>
            Assign Table
            {res.table_id && assignedTable && (
              <span style={{ color: '#22c55e', marginLeft: 6 }}>
                {assignedGroup ? assignedGroup.label.split('+').slice(0, assignedGroup.ids.indexOf(res.table_id) + 1).join('+') : `T${assignedTable.table_number}`} ✓
              </span>
            )}
          </div>

          {/* Single tables */}
          {singleTables.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>Single Tables</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 12 }}>
                {singleTables.map(t => {
                  const taken = isSingleTaken(t.id);
                  const assigned = isAssigned(t.id);
                  return (
                    <button key={t.id}
                      onClick={() => !taken && onAssign(t.id)}
                      disabled={assigning || taken}
                      title={taken ? `T${t.table_number} is already booked at this time` : `Assign T${t.table_number} (${t.capacity}p)`}
                      style={{ padding: '7px 4px', borderRadius: 8,
                        border: `2px solid ${assigned ? '#22c55e' : taken ? '#fee2e2' : '#e5e7eb'}`,
                        background: assigned ? '#dcfce7' : taken ? '#fef2f2' : 'white',
                        color: assigned ? '#166534' : taken ? '#ef4444' : '#1a1a2e',
                        cursor: taken ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'center',
                        opacity: taken && !assigned ? 0.6 : 1 }}>
                      <div>T{t.table_number}</div>
                      <div style={{ fontSize: 10, fontWeight: 400, color: taken ? '#ef4444' : '#888' }}>
                        {taken ? '✕ taken' : `${t.capacity}p`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Smart sub-combinations */}
          {subCombos.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>🔗 Linked Tables</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
                {subCombos.map(combo => {
                  const taken   = isComboTaken(combo);
                  const assigned = isComboAssigned(combo);
                  return (
                    <button key={combo.label}
                      onClick={() => !taken && onAssign(combo.ids[0])}
                      disabled={assigning || taken}
                      title={taken ? `${combo.label} has a conflict at this time` : `Assign ${combo.label} (${combo.capacity}p max)`}
                      style={{ padding: '9px 12px', borderRadius: 8,
                        border: `2px solid ${assigned ? '#22c55e' : taken ? '#fee2e2' : '#e5e7eb'}`,
                        background: assigned ? '#dcfce7' : taken ? '#fef2f2' : 'white',
                        color: assigned ? '#166534' : taken ? '#ef4444' : '#1a1a2e',
                        cursor: taken ? 'not-allowed' : 'pointer',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        fontSize: 13, fontWeight: 700, opacity: taken && !assigned ? 0.6 : 1 }}>
                      <span>{combo.label}</span>
                      <span style={{ fontSize: 11, color: taken ? '#ef4444' : assigned ? '#166534' : '#888', fontWeight: 600 }}>
                        {taken ? '✕ conflict' : `${combo.capacity}p`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {singleTables.length === 0 && subCombos.length === 0 && (
            <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>No tables with {res.covers}+ capacity</div>
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
