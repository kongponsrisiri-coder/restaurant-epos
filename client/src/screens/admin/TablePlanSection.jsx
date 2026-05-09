import { useState, useEffect, useRef, useCallback } from 'react';
import { SERVER_URL, getTables, updateTablePlan, addTable, deleteTable } from '../../api';

// ─────────────────────────────────────────────────────────────────
// Local API helpers — Krit: add these endpoints to server.js
// See ticket at bottom of this file
// ─────────────────────────────────────────────────────────────────
const apiGet  = url       => fetch(SERVER_URL + url).then(r => r.json());
const apiPost = (url, d)  => fetch(SERVER_URL + url, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(r => r.json());
const apiPut  = (url, d)  => fetch(SERVER_URL + url, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(r => r.json());
const apiDel  = url       => fetch(SERVER_URL + url, { method: 'DELETE' }).then(r => r.json());

// ─────────────────────────────────────────────────────────────────
// Graph traversal — walk the combination links to find all
// tables in the same group (handles chains: T5-T6-T7 = 16p)
// ─────────────────────────────────────────────────────────────────
function getGroup(startId, combos) {
  const visited = [startId];
  const queue   = [startId];
  while (queue.length) {
    const curr = queue.shift();
    combos.forEach(c => {
      const neighbor = c.table_id_a === curr ? c.table_id_b
                     : c.table_id_b === curr ? c.table_id_a
                     : null;
      if (neighbor && !visited.includes(neighbor)) {
        visited.push(neighbor);
        queue.push(neighbor);
      }
    });
  }
  return visited.sort((a, b) => a - b);
}

function getAllGroups(combos, tableIds) {
  const seen   = new Set();
  const groups = [];
  tableIds.forEach(id => {
    if (!seen.has(id) && combos.some(c => c.table_id_a === id || c.table_id_b === id)) {
      const group = getGroup(id, combos);
      if (group.length > 1) {
        groups.push(group);
        group.forEach(x => seen.add(x));
      }
    }
  });
  return groups;
}

// ─────────────────────────────────────────────────────────────────
// Default tiers (used if backend not ready yet)
// ─────────────────────────────────────────────────────────────────
const DEFAULT_TIERS = [
  { id: 1, covers_min: 1, covers_max: 4,    duration_mins: 90  },
  { id: 2, covers_min: 5, covers_max: 8,    duration_mins: 120 },
  { id: 3, covers_min: 9, covers_max: null, duration_mins: 150 },
];

// ─────────────────────────────────────────────────────────────────
// Shared styles
// ─────────────────────────────────────────────────────────────────
const lbl = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', fontFamily: 'inherit' };

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
export default function TablePlanSection() {
  const [tables,  setTables]  = useState([]);
  const [combos,  setCombos]  = useState([]);  // { id, table_id_a, table_id_b }
  const [walls,   setWalls]   = useState([]);  // { id, pos_x, pos_y, width, height }
  const [tiers,   setTiers]   = useState(DEFAULT_TIERS);

  const [dragging, setDragging] = useState(null);  // { type: 'table'|'wall', id }
  const [selected, setSelected] = useState(null);  // { type: 'table'|'wall', id }
  const [offset,   setOffset]   = useState({ x: 0, y: 0 });

  const [mode,     setMode]     = useState('select'); // 'select' | 'link'
  const [linkFrom, setLinkFrom] = useState(null);     // table id — first table in link pair

  const [toast, setToast] = useState(null);
  const canvasRef = useRef(null);

  // ── Data loading ───────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [tablesData, combosData, wallsData, tiersData] = await Promise.all([
        getTables(),
        apiGet('/api/table-combinations').catch(() => []),
        apiGet('/api/table-walls').catch(() => []),
        apiGet('/api/dining-duration-tiers').catch(() => DEFAULT_TIERS),
      ]);
      setTables(tablesData.map((t, i) => ({
        ...t,
        pos_x:  t.pos_x  || (i % 5) * 120 + 40,
        pos_y:  t.pos_y  || Math.floor(i / 5) * 120 + 40,
        width:  t.width  || 80,
        height: t.height || 80,
        shape:  t.shape  || 'square',
      })));
      setCombos(Array.isArray(combosData) ? combosData : []);
      setWalls(Array.isArray(wallsData)   ? wallsData  : []);
      setTiers(Array.isArray(tiersData) && tiersData.length ? tiersData : DEFAULT_TIERS);
    } catch (err) {
      showToast('Error loading data', 'error');
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── Mouse: canvas background click (deselect) ──────────────────
  const handleCanvasMouseDown = (e) => {
    if (e.target !== canvasRef.current) return;
    setSelected(null);
    if (mode !== 'link') setLinkFrom(null);
  };

  // ── Mouse: table and wall drag ─────────────────────────────────
  const handleMouseDown = (e, type, id) => {
    e.preventDefault();
    e.stopPropagation();

    // Link mode — handle table pair selection
    if (mode === 'link' && type === 'table') {
      if (!linkFrom) {
        setLinkFrom(id);
        return;
      }
      if (linkFrom === id) {
        setLinkFrom(null);
        return;
      }
      handleAddCombo(linkFrom, id);
      setLinkFrom(null);
      setMode('select');
      return;
    }

    // Select + drag
    setDragging({ type, id });
    setSelected({ type, id });
    const rect = canvasRef.current.getBoundingClientRect();
    const item = type === 'table'
      ? tables.find(t => t.id === id)
      : walls.find(w => w.id === id);
    if (item) {
      setOffset({
        x: e.clientX - rect.left - (item.pos_x || 0),
        y: e.clientY - rect.top  - (item.pos_y || 0),
      });
    }
  };

  const handleMouseMove = (e) => {
    if (!dragging) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left - offset.x);
    const y = Math.max(0, e.clientY - rect.top  - offset.y);
    if (dragging.type === 'table') {
      setTables(prev => prev.map(t => t.id === dragging.id ? { ...t, pos_x: x, pos_y: y } : t));
    } else {
      setWalls(prev => prev.map(w => w.id === dragging.id ? { ...w, pos_x: x, pos_y: y } : w));
    }
  };

  const handleMouseUp = async () => {
    if (!dragging) return;
    if (dragging.type === 'table') {
      const t = tables.find(t => t.id === dragging.id);
      if (t) await updateTablePlan(t.id, { pos_x: t.pos_x, pos_y: t.pos_y, shape: t.shape, width: t.width, height: t.height, name: t.name, capacity: t.capacity });
    } else {
      const w = walls.find(w => w.id === dragging.id);
      if (w) await apiPut(`/api/table-walls/${w.id}`, { pos_x: w.pos_x, pos_y: w.pos_y, width: w.width, height: w.height });
    }
    setDragging(null);
  };

  // ── Table operations ───────────────────────────────────────────
  const handleAddTable = async () => {
    const maxNum = Math.max(...tables.map(t => Number(t.table_number) || 0), 0);
    await addTable({ table_number: maxNum + 1, capacity: 4, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80 });
    fetchAll();
  };

  const handleDeleteTable = async (id) => {
    if (!window.confirm('Delete this table?')) return;
    // Remove any combination links involving this table first
    const related = combos.filter(c => c.table_id_a === id || c.table_id_b === id);
    await Promise.all(related.map(c => apiDel(`/api/table-combinations/${c.id}`)));
    await deleteTable(id);
    setSelected(null);
    fetchAll();
  };

  const updateSelectedTable = async (changes) => {
    if (selected?.type !== 'table') return;
    const t = tables.find(t => t.id === selected.id);
    if (!t) return;
    const u = { ...t, ...changes };
    await updateTablePlan(u.id, { pos_x: u.pos_x, pos_y: u.pos_y, shape: u.shape, width: u.width, height: u.height, name: u.name, capacity: u.capacity });
    fetchAll();
  };

  // ── Wall operations ────────────────────────────────────────────
  const handleAddWall = async () => {
    await apiPost('/api/table-walls', { pos_x: 120, pos_y: 80, width: 12, height: 100 });
    fetchAll();
    showToast('Wall added — drag to position');
  };

  const handleUpdateWall = async (id, changes) => {
    const w = walls.find(w => w.id === id);
    if (!w) return;
    const u = { ...w, ...changes };
    setWalls(prev => prev.map(wl => wl.id === id ? u : wl));
    await apiPut(`/api/table-walls/${id}`, { pos_x: u.pos_x, pos_y: u.pos_y, width: u.width, height: u.height });
  };

  const handleDeleteWall = async (id) => {
    await apiDel(`/api/table-walls/${id}`);
    setSelected(null);
    fetchAll();
  };

  // ── Combination operations ─────────────────────────────────────
  const handleAddCombo = async (idA, idB) => {
    const already = combos.some(c =>
      (c.table_id_a === idA && c.table_id_b === idB) ||
      (c.table_id_a === idB && c.table_id_b === idA)
    );
    if (already) { showToast('Already linked', 'error'); return; }
    await apiPost('/api/table-combinations', { table_id_a: idA, table_id_b: idB });
    showToast('Tables linked ✓');
    fetchAll();
  };

  const handleRemoveCombo = async (comboId) => {
    await apiDel(`/api/table-combinations/${comboId}`);
    showToast('Link removed');
    fetchAll();
  };

  const handleRemoveGroup = async (group) => {
    const groupCombos = combos.filter(c =>
      group.includes(c.table_id_a) && group.includes(c.table_id_b)
    );
    await Promise.all(groupCombos.map(c => apiDel(`/api/table-combinations/${c.id}`)));
    showToast('Group removed');
    fetchAll();
  };

  // ── Duration tier operations ───────────────────────────────────
  const handleUpdateTier = async (tier, newDur) => {
    setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, duration_mins: newDur } : t));
    if (tier.id) await apiPut(`/api/dining-duration-tiers/${tier.id}`, { duration_mins: newDur });
  };

  // ── Derived / helpers ──────────────────────────────────────────
  const selectedTable = selected?.type === 'table' ? tables.find(t => t.id === selected.id) : null;
  const selectedWall  = selected?.type === 'wall'  ? walls.find(w => w.id === selected.id)  : null;
  const groups        = getAllGroups(combos, tables.map(t => t.id));

  function groupCap(ids) {
    return ids.reduce((s, id) => s + (tables.find(t => t.id === id)?.capacity || 0), 0);
  }

  function tableCenter(id) {
    const t = tables.find(t => t.id === id);
    return t ? { x: t.pos_x + (t.width || 80) / 2, y: t.pos_y + (t.height || 80) / 2 } : null;
  }

  function comboPartnersFor(tableId) {
    return combos
      .filter(c => c.table_id_a === tableId || c.table_id_b === tableId)
      .map(c => ({
        comboId:   c.id,
        partnerId: c.table_id_a === tableId ? c.table_id_b : c.table_id_a,
      }));
  }

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24 }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.type === 'error' ? '#ef4444' : '#22c55e',
          color: 'white', padding: '12px 20px', borderRadius: 10,
          fontWeight: 700, fontSize: 14, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e', margin: 0 }}>Table Plan</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>

          {/* Mode: Select */}
          <button
            onClick={() => { setMode('select'); setLinkFrom(null); }}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
              background: mode === 'select' ? '#1a1a2e' : '#f0f0f0',
              color:      mode === 'select' ? 'white'   : '#555' }}
          >✥ Select</button>

          {/* Mode: Link */}
          <button
            onClick={() => { setMode(m => m === 'link' ? 'select' : 'link'); setLinkFrom(null); setSelected(null); }}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
              background: mode === 'link' ? '#C9A84C' : '#f0f0f0',
              color:      mode === 'link' ? 'white'   : '#555' }}
          >⊕ {mode === 'link' && linkFrom ? 'Click 2nd table…' : 'Link Tables'}</button>

          <div style={{ width: 1, height: 24, background: '#e0e0e0' }} />

          <button onClick={handleAddTable}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Table</button>

          <button onClick={handleAddWall}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#555', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Wall</button>

          <button onClick={fetchAll}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#f0f0f0', color: '#555', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            ↻</button>
        </div>
      </div>

      {/* Link mode hint bar */}
      {mode === 'link' && (
        <div style={{ background: '#fef9c3', border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>
            {linkFrom
              ? `Table ${tables.find(t => t.id === linkFrom)?.table_number} selected → now click the adjacent table to link`
              : 'Click the first table, then click the adjacent table — only link tables with NO partition between them'}
          </span>
          <button onClick={() => { setMode('select'); setLinkFrom(null); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#92400e', fontWeight: 700, fontSize: 16, padding: 0 }}>×</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16 }}>

        {/* ── Canvas ────────────────────────────────────────────── */}
        <div
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            flex: 1, height: 600,
            background: '#f0ede8', borderRadius: 16, position: 'relative',
            border: `2px solid ${mode === 'link' ? '#C9A84C' : '#ddd'}`,
            cursor: mode === 'link' ? 'crosshair' : dragging ? 'grabbing' : 'default',
            backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)',
            backgroundSize: '30px 30px', overflow: 'hidden',
          }}
        >
          {/* SVG overlay — combination connectors + group labels */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}>
            {/* Connector lines between each linked pair */}
            {combos.map(c => {
              const a = tableCenter(c.table_id_a);
              const b = tableCenter(c.table_id_b);
              if (!a || !b) return null;
              return (
                <g key={c.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke="#C9A84C" strokeWidth="2.5" strokeDasharray="6 4" />
                  <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r="6" fill="#C9A84C" />
                </g>
              );
            })}

            {/* Group capacity badge — shown below each connected group */}
            {groups.map((group, gi) => {
              const cap   = groupCap(group);
              const names = group.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : ''; }).join('+');
              const label = `${names} = ${cap}p max`;
              const tw    = label.length * 7.2 + 20;
              const maxY  = Math.max(...group.map(id => { const t = tables.find(t => t.id === id); return t ? t.pos_y + (t.height || 80) : 0; }));
              const minX  = Math.min(...group.map(id => { const t = tables.find(t => t.id === id); return t ? t.pos_x : 0; }));
              const maxX  = Math.max(...group.map(id => { const t = tables.find(t => t.id === id); return t ? t.pos_x + (t.width || 80) : 0; }));
              const mx    = (minX + maxX) / 2;
              const my    = maxY + 10;
              return (
                <g key={gi}>
                  <rect x={mx - tw/2} y={my} width={tw} height={22} rx="11" fill="#FAEEDA" stroke="#C9A84C" strokeWidth="1" />
                  <text x={mx} y={my + 14.5} textAnchor="middle" fontSize="11" fill="#854F0B"
                    fontWeight="500" fontFamily="system-ui, -apple-system, sans-serif">
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Partition walls */}
          {walls.map(wall => (
            <div
              key={wall.id}
              onMouseDown={e => handleMouseDown(e, 'wall', wall.id)}
              style={{
                position: 'absolute', left: wall.pos_x, top: wall.pos_y,
                width: wall.width || 12, height: wall.height || 100,
                background: selected?.id === wall.id ? '#e94560' : '#4a4a4a',
                borderRadius: 3, cursor: 'grab', zIndex: 2,
                outline: selected?.id === wall.id ? '2px solid #e94560' : 'none',
                outlineOffset: 2,
              }}
              title="Partition wall — drag to reposition"
            />
          ))}

          {/* Tables */}
          {tables.map(table => {
            const isSelected  = selected?.type === 'table' && selected?.id === table.id;
            const isLinked    = combos.some(c => c.table_id_a === table.id || c.table_id_b === table.id);
            const isLinkFirst = linkFrom === table.id;
            return (
              <div
                key={table.id}
                onMouseDown={e => handleMouseDown(e, 'table', table.id)}
                style={{
                  position: 'absolute',
                  left: table.pos_x, top: table.pos_y,
                  width: table.width || 80, height: table.height || 80,
                  borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                  background: isLinkFirst ? '#C9A84C'
                            : isSelected  ? '#1a1a2e'
                            : isLinked    ? '#fef9c3'
                            : '#fff',
                  border: `3px solid ${isLinkFirst ? '#C9A84C' : isSelected ? '#e94560' : isLinked ? '#C9A84C' : '#1a1a2e'}`,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  cursor: mode === 'link' ? 'crosshair' : 'grab',
                  userSelect: 'none', zIndex: isSelected ? 10 : 3,
                  boxShadow: isSelected ? '0 4px 20px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.1)',
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: isLinkFirst || isSelected ? 'white' : '#1a1a2e', textAlign: 'center' }}>
                  {table.table_number}
                </div>
                <div style={{ fontSize: 10, color: isLinkFirst || isSelected ? 'rgba(255,255,255,0.7)' : '#888' }}>
                  {table.capacity}p
                </div>
              </div>
            );
          })}

          {tables.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 15 }}>
              Click "+ Table" to start building your floor plan
            </div>
          )}
        </div>

        {/* ── Properties panel ──────────────────────────────────── */}
        <div style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>

          {/* TABLE PROPERTIES */}
          {selectedTable && (
            <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>
                Table {selectedTable.table_number}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Table Number / Name</label>
                  <input
                    defaultValue={selectedTable.table_number}
                    key={selectedTable.id + '_n'}
                    onBlur={e => updateSelectedTable({ table_number: e.target.value })}
                    style={inp}
                  />
                </div>
                <div>
                  <label style={lbl}>Capacity (seats)</label>
                  <input
                    type="number"
                    defaultValue={selectedTable.capacity}
                    key={selectedTable.id + '_c'}
                    onBlur={e => updateSelectedTable({ capacity: parseInt(e.target.value) || 1 })}
                    style={inp}
                  />
                </div>
                <div>
                  <label style={lbl}>Shape</label>
                  <select value={selectedTable.shape || 'square'} onChange={e => updateSelectedTable({ shape: e.target.value })} style={inp}>
                    <option value="square">Square</option>
                    <option value="round">Round</option>
                    <option value="rectangle">Rectangle</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Size</label>
                  <select onChange={e => { const [w, h] = e.target.value.split('x').map(Number); updateSelectedTable({ width: w, height: h }); }} style={inp}>
                    <option value="">— select size —</option>
                    <option value="70x70">Small square (2p)</option>
                    <option value="80x80">Medium square (4p)</option>
                    <option value="100x100">Large square (6p)</option>
                    <option value="120x120">Extra large (8p+)</option>
                    <option value="120x70">Rectangle small (4p)</option>
                    <option value="160x70">Rectangle medium (6p)</option>
                    <option value="200x70">Rectangle large (8p)</option>
                    <option value="240x70">Rectangle XL (10p)</option>
                  </select>
                </div>

                {/* Combination links */}
                <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 8 }}>Can combine with</div>

                  {comboPartnersFor(selectedTable.id).length === 0 && (
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>
                      No links set for this table
                    </div>
                  )}

                  {comboPartnersFor(selectedTable.id).map(({ comboId, partnerId }) => {
                    const pt = tables.find(t => t.id === partnerId);
                    return pt ? (
                      <div key={comboId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, background: '#fef9c3', borderRadius: 8, padding: '6px 10px' }}>
                        <span style={{ fontSize: 12, flex: 1, color: '#854F0B', fontWeight: 600 }}>
                          T{pt.table_number} ({pt.capacity}p) → {selectedTable.capacity + pt.capacity}p
                        </span>
                        <button onClick={() => handleRemoveCombo(comboId)}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 16, padding: 0 }}>×</button>
                      </div>
                    ) : null;
                  })}

                  {/* Full group if in a chain of 3+ */}
                  {(() => {
                    const group = getGroup(selectedTable.id, combos);
                    if (group.length > 2) {
                      const cap   = groupCap(group);
                      const names = group.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : ''; }).join('+');
                      return (
                        <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '7px 10px', marginTop: 4, fontSize: 12, color: '#854F0B', fontWeight: 700 }}>
                          Full group: {names} = {cap}p max
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <button
                    onClick={() => { setMode('link'); setLinkFrom(selectedTable.id); setSelected(null); }}
                    style={{ width: '100%', marginTop: 8, padding: '8px', border: '1.5px dashed #C9A84C', borderRadius: 8, background: 'none', cursor: 'pointer', fontSize: 12, color: '#854F0B', fontWeight: 600 }}>
                    ⊕ Link with adjacent table
                  </button>
                </div>

                <button onClick={() => handleDeleteTable(selectedTable.id)}
                  style={{ padding: '8px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                  Delete Table
                </button>
              </div>
            </div>
          )}

          {/* WALL PROPERTIES */}
          {selectedWall && (
            <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>Partition Wall</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Orientation</label>
                  <select
                    onChange={e => {
                      const isH = e.target.value === 'h';
                      const w   = isH ? Math.max(selectedWall.width || 12, selectedWall.height || 100) : Math.min(selectedWall.width || 12, selectedWall.height || 100);
                      const h   = isH ? Math.min(selectedWall.width || 12, selectedWall.height || 100) : Math.max(selectedWall.width || 12, selectedWall.height || 100);
                      handleUpdateWall(selectedWall.id, { width: w, height: h });
                    }}
                    style={inp}
                  >
                    <option value="v">Vertical</option>
                    <option value="h">Horizontal</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Thickness</label>
                  <select onChange={e => handleUpdateWall(selectedWall.id, { width: parseInt(e.target.value) })} style={inp}>
                    <option value="8">Thin (8px)</option>
                    <option value="12">Standard (12px)</option>
                    <option value="20">Thick (20px)</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Length</label>
                  <select onChange={e => handleUpdateWall(selectedWall.id, { height: parseInt(e.target.value) })} style={inp}>
                    <option value="60">Short (60px)</option>
                    <option value="100">Medium (100px)</option>
                    <option value="150">Long (150px)</option>
                    <option value="200">Extra long (200px)</option>
                    <option value="300">Full span (300px)</option>
                  </select>
                </div>
                <div style={{ fontSize: 12, color: '#888', background: '#f8f8f8', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
                  Tables on opposite sides of a wall cannot be combined in the booking system.
                </div>
                <button onClick={() => handleDeleteWall(selectedWall.id)}
                  style={{ padding: '8px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  Delete Wall
                </button>
              </div>
            </div>
          )}

          {/* NO SELECTION: groups summary + duration tiers */}
          {!selectedTable && !selectedWall && (
            <>
              {/* Linked groups */}
              <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', marginBottom: 12 }}>Linked Groups</div>
                {groups.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>
                    No combinations set yet.<br />Use ⊕ Link Tables to connect adjacent tables.
                  </div>
                ) : groups.map((group, gi) => {
                  const cap   = groupCap(group);
                  const names = group.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : ''; }).join(' + ');
                  return (
                    <div key={gi} style={{ background: '#FAEEDA', borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#854F0B' }}>{names}</div>
                        <div style={{ fontSize: 11, color: '#BA7517', marginTop: 2 }}>max combined capacity</div>
                      </div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#C9A84C' }}>{cap}p</div>
                      <button onClick={() => handleRemoveGroup(group)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 16, padding: 0 }}>×</button>
                    </div>
                  );
                })}
              </div>

              {/* Dining duration tiers */}
              <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', marginBottom: 4 }}>Dining Duration</div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
                  Applied automatically by party size when checking availability
                </div>
                {tiers.map((tier, i) => (
                  <div key={tier.id || i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: '#555', flex: 1, fontWeight: 500 }}>
                      {tier.covers_min}{tier.covers_max ? `–${tier.covers_max}` : '+'} covers
                    </span>
                    <input
                      type="number"
                      value={tier.duration_mins}
                      min="30" max="360" step="15"
                      onChange={e => setTiers(prev => prev.map((t, idx) => idx === i ? { ...t, duration_mins: parseInt(e.target.value) || 90 } : t))}
                      onBlur={e => handleUpdateTier(tier, parseInt(e.target.value) || 90)}
                      style={{ width: 60, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, textAlign: 'center', fontFamily: 'inherit' }}
                    />
                    <span style={{ fontSize: 12, color: '#888' }}>min</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Tip */}
          <div style={{ background: '#f8f8f8', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#888', lineHeight: 1.6 }}>
            💡 Drag tables and walls to position<br />
            🟡 Amber tables are linked to a group<br />
            ⊕ Only link tables with no wall between them
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TICKET FOR KRIT — add these routes to server.js
// Run DB migrations first (see separate ticket)
// ─────────────────────────────────────────────────────────────────
/*

// GET /api/table-combinations
app.get('/api/table-combinations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM table_combinations WHERE is_active = true');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/table-combinations
app.post('/api/table-combinations', async (req, res) => {
  try {
    const { table_id_a, table_id_b } = req.body;
    const result = await pool.query(
      'INSERT INTO table_combinations (table_id_a, table_id_b) VALUES ($1,$2) RETURNING id',
      [table_id_a, table_id_b]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/table-combinations/:id
app.delete('/api/table-combinations/:id', async (req, res) => {
  try {
    await pool.query('UPDATE table_combinations SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/table-walls
app.get('/api/table-walls', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM table_walls ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/table-walls
app.post('/api/table-walls', async (req, res) => {
  try {
    const { pos_x, pos_y, width, height } = req.body;
    const result = await pool.query(
      'INSERT INTO table_walls (pos_x, pos_y, width, height) VALUES ($1,$2,$3,$4) RETURNING id',
      [pos_x || 0, pos_y || 0, width || 12, height || 100]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/table-walls/:id
app.put('/api/table-walls/:id', async (req, res) => {
  try {
    const { pos_x, pos_y, width, height } = req.body;
    await pool.query(
      'UPDATE table_walls SET pos_x=$1, pos_y=$2, width=$3, height=$4 WHERE id=$5',
      [pos_x, pos_y, width, height, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/table-walls/:id
app.delete('/api/table-walls/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM table_walls WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/dining-duration-tiers
app.get('/api/dining-duration-tiers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM dining_duration_tiers WHERE restaurant_id = $1 ORDER BY covers_min',
      ['siamepos']
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/dining-duration-tiers/:id
app.put('/api/dining-duration-tiers/:id', async (req, res) => {
  try {
    const { duration_mins } = req.body;
    await pool.query(
      'UPDATE dining_duration_tiers SET duration_mins = $1 WHERE id = $2',
      [duration_mins, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

*/
