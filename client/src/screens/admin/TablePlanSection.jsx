import { useState, useEffect, useRef, useCallback } from 'react';
import { SERVER_URL, getTables, updateTablePlan, addTable, deleteTable } from '../../api';
import { roomSize } from '../../utils/floorRoom';   // SEPOS-FLOOR-FIT shared room
import { tableLabel } from '../../utils/orderLabel'; // SEPOS-TABLE-NAME
import { confirm } from '../../utils/confirm';

// SEPOS-TABLE-SIZE — sizes are per-shape now (the Shape dropdown picks the
// shape; the Size dropdown only offers that shape's sizes — no repeating both).
const SIZE_OPTIONS = {
  square:    [['70x70', 'Small (2p)'], ['80x80', 'Medium (4p)'], ['100x100', 'Large (6p)'], ['120x120', 'Extra large (8p+)']],
  round:     [['70x70', 'Small (2p)'], ['80x80', 'Medium (4p)'], ['100x100', 'Large (6p)'], ['120x120', 'Extra large (8p+)']],
  rectangle: [['120x70', 'Small (4p)'], ['160x70', 'Medium (6p)'], ['200x70', 'Large (8p)'], ['240x70', 'XL (10p)']],
};

const apiGet  = url       => fetch(SERVER_URL + url).then(r => r.json());
const apiPost = (url, d)  => fetch(SERVER_URL + url, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(r => r.json());
const apiPut  = (url, d)  => fetch(SERVER_URL + url, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(r => r.json());
const apiDel  = url       => fetch(SERVER_URL + url, { method: 'DELETE' }).then(r => r.json());

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

const DEFAULT_TIERS = [
  { id: 1, covers_min: 1, covers_max: 4,    duration_mins: 90  },
  { id: 2, covers_min: 5, covers_max: 8,    duration_mins: 120 },
  { id: 3, covers_min: 9, covers_max: null, duration_mins: 150 },
];

const lbl = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', fontFamily: 'inherit' };

export default function TablePlanSection() {
  const [tables,  setTables]  = useState([]);
  const [combos,  setCombos]  = useState([]);
  const [walls,   setWalls]   = useState([]);
  const [tiers,   setTiers]   = useState(DEFAULT_TIERS);

  const [dragging, setDragging] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null);
  const [offset,   setOffset]   = useState({ x: 0, y: 0 });

  const [mode,     setMode]     = useState('select');
  const [linkFrom, setLinkFrom] = useState(null);

  const [toast, setToast] = useState(null);
  const canvasRef = useRef(null);

  // SEPOS-FLOOR-FIT — editor zoom. The room can outgrow the visible canvas
  // (bigger restaurants); −/Fit/+ scales the view, drag math divides by it.
  // Per-device, remembered.
  const [editorZoom, setEditorZoom] = useState(() => {
    const v = parseFloat(localStorage.getItem('siamepos_editor_zoom'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const changeEditorZoom = (factor) => {
    setEditorZoom((z) => {
      let next;
      if (factor === 0) {
        // Fit: shrink (or grow, capped 1×) so the whole room is visible.
        const el = canvasRef.current;
        const room = roomSize(tablesRef.current, wallsRef.current);
        next = el ? Math.min(1, +(Math.min(el.clientWidth / room.w, el.clientHeight / room.h)).toFixed(3)) : 1;
      } else {
        next = Math.min(2, Math.max(0.4, +(z * factor).toFixed(3)));
      }
      try { localStorage.setItem('siamepos_editor_zoom', String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // ── Refs so handleMouseUp always reads the LATEST positions ───
  // (avoids stale closure — React state in event handlers can be stale)
  const tablesRef  = useRef([]);
  const wallsRef   = useRef([]);
  const draggingRef = useRef(null);
  useEffect(() => { tablesRef.current  = tables;  }, [tables]);
  useEffect(() => { wallsRef.current   = walls;   }, [walls]);
  useEffect(() => { draggingRef.current = dragging; }, [dragging]);

  // ── Initial load only ─────────────────────────────────────────
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
        pos_x:  t.pos_x  != null ? t.pos_x  : (i % 5) * 120 + 40,
        pos_y:  t.pos_y  != null ? t.pos_y  : Math.floor(i / 5) * 120 + 40,
        width:  t.width  != null ? t.width  : 80,
        height: t.height != null ? t.height : 80,
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

  const lastToastRef = useRef({ msg: '', at: 0 });
  function showToast(msg, type = 'success') {
    // Collapse repeats — per-keystroke/per-drag saves can fail in bursts and a
    // toast per failure reads as spam. One identical message per 4s is enough.
    const now = Date.now();
    if (msg === lastToastRef.current.msg && now - lastToastRef.current.at < 4000) return;
    lastToastRef.current = { msg, at: now };
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  const handleCanvasMouseDown = (e) => {
    // Background = the scroll container itself OR the scaled room layers.
    if (e.target !== canvasRef.current && !e.target.getAttribute?.('data-canvas-bg')) return;
    setSelected(null);
    if (mode !== 'link') setLinkFrom(null);
  };

  const handleMouseDown = (e, type, id) => {
    e.preventDefault();
    e.stopPropagation();

    if (mode === 'link' && type === 'table') {
      if (!linkFrom) { setLinkFrom(id); return; }
      if (linkFrom === id) { setLinkFrom(null); return; }
      handleAddCombo(linkFrom, id);
      setLinkFrom(null);
      setMode('select');
      return;
    }

    setDragging({ type, id });
    setSelected({ type, id });
    const rect = canvasRef.current.getBoundingClientRect();
    const item = type === 'table'
      ? tablesRef.current.find(t => t.id === id)
      : wallsRef.current.find(w => w.id === id);
    if (item) {
      // +scrollLeft/Top → screen-space within the scroll content; ÷zoom →
      // the room's logical coordinate space (positions are stored logical).
      setOffset({
        x: (e.clientX - rect.left + canvasRef.current.scrollLeft) / editorZoom - (item.pos_x || 0),
        y: (e.clientY - rect.top  + canvasRef.current.scrollTop)  / editorZoom - (item.pos_y || 0),
      });
    }
  };

  const handleMouseMove = (e) => {
    if (!draggingRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    // Math.round — getBoundingClientRect()/pointer coords are sub-pixel floats
    // (trackpad, browser zoom); pos_x/pos_y are INTEGER columns, so a float
    // position 500'd EVERY save of that table ("invalid input syntax for type
    // integer: 42.121…") — including later name/capacity edits, which send the
    // whole row. One drag poisoned the table until reload.
    const x = Math.max(0, Math.round((e.clientX - rect.left + canvasRef.current.scrollLeft) / editorZoom - offset.x));
    const y = Math.max(0, Math.round((e.clientY - rect.top  + canvasRef.current.scrollTop)  / editorZoom - offset.y));
    if (draggingRef.current.type === 'table') {
      setTables(prev => prev.map(t => t.id === draggingRef.current.id ? { ...t, pos_x: x, pos_y: y } : t));
    } else {
      setWalls(prev => prev.map(w => w.id === draggingRef.current.id ? { ...w, pos_x: x, pos_y: y } : w));
    }
  };

  // ── KEY FIX: read from refs (latest state) not stale closure ──
  const handleMouseUp = async () => {
    const d = draggingRef.current;
    if (!d) return;
    setDragging(null);

    if (d.type === 'table') {
      const t = tablesRef.current.find(t => t.id === d.id);
      if (t) {
        const r = await updateTablePlan(t.id, {
          pos_x: t.pos_x, pos_y: t.pos_y,
          shape: t.shape, width: t.width, height: t.height,
          name: t.name, capacity: t.capacity,
          table_number: t.table_number,   // ← was missing before
        });
        // Loud failure or the position silently reverts on the next pull
        // (desktop till mid cloud-redeploy = every drag lost, "pop back").
        if (r && r.error) showToast(`⚠ Not saved — ${r.error}`, 'error');
      }
    } else {
      const w = wallsRef.current.find(w => w.id === d.id);
      if (w) {
        const r = await apiPut(`/api/table-walls/${w.id}`, {
          pos_x: w.pos_x, pos_y: w.pos_y, width: w.width, height: w.height,
        });
        if (r && r.error) showToast(`⚠ Wall not saved — ${r.error}`, 'error');
      }
    }
  };

  // Explicit "Save layout" — commits EVERY table + wall position in one batch so
  // the whole plan is guaranteed persisted (and forwarded to the cloud, which
  // the Floor map reads), not just the last item dragged. Then re-reads the
  // committed truth so the editor and the Floor screen always agree.
  const handleSaveLayout = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // api.js resolves {error} instead of throwing, so the old try/catch never
      // fired on a failed save — the toast said "✓ saved" while half the plan
      // was doomed to revert. Count failures per row and be honest.
      let failed = 0;
      let firstError = '';
      for (const t of tablesRef.current) {
        const r = await updateTablePlan(t.id, {
          pos_x: t.pos_x, pos_y: t.pos_y,
          shape: t.shape, width: t.width, height: t.height,
          name: t.name, capacity: t.capacity, table_number: t.table_number,
        });
        if (r && r.error) { failed++; firstError = firstError || r.error; }
      }
      for (const w of wallsRef.current) {
        const r = await apiPut(`/api/table-walls/${w.id}`, {
          pos_x: w.pos_x, pos_y: w.pos_y, width: w.width, height: w.height,
        });
        if (r && r.error) { failed++; firstError = firstError || r.error; }
      }
      await fetchAll();
      if (failed > 0) showToast(`⚠ ${failed} item${failed > 1 ? 's' : ''} NOT saved — ${firstError}`, 'error');
      else showToast('✓ Layout saved — floor updated');
    } catch (e) {
      showToast('Save failed — please try again', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Table operations — optimistic, no fetchAll ─────────────────
  const handleAddTable = async () => {
    const maxNum = Math.max(...tablesRef.current.map(t => Number(t.table_number) || 0), 0);
    const newNum = maxNum + 1;
    const newTable = { table_number: newNum, capacity: 4, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80 };
    const result = await addTable(newTable);
    if (result?.id) {
      setTables(prev => [...prev, { ...newTable, id: result.id, status: 'available' }]);
    } else if (result?.error) {
      showToast(`⚠ Table not added — ${result.error}`, 'error');
    }
  };

  // SEPOS-TAKEAWAY-TABLE — a takeaway "table": sits on the floor like a table
  // but orders rung up on it are takeaway (no service charge, kitchen ticket
  // says "Takeaway {number}").
  const handleAddTakeaway = async () => {
    const maxNum = Math.max(...tablesRef.current.map(t => Number(t.table_number) || 0), 0);
    const newNum = maxNum + 1;
    const newTable = { table_number: newNum, capacity: 1, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80, is_takeaway: 1 };
    const result = await addTable(newTable);
    if (result?.id) {
      setTables(prev => [...prev, { ...newTable, id: result.id, status: 'available' }]);
      showToast('🥡 Takeaway table added');
    } else {
      showToast(`⚠ Not added — ${result?.error || 'no response'}`, 'error');
    }
  };

  const handleDeleteTable = async (id) => {
    if (!await confirm('Delete this table?')) return;
    const related = combos.filter(c => c.table_id_a === id || c.table_id_b === id);
    await Promise.all(related.map(c => apiDel(`/api/table-combinations/${c.id}`)));
    const r = await deleteTable(id);
    if (r && r.error) { showToast(`⚠ Not deleted — ${r.error}`, 'error'); return; }
    setTables(prev => prev.filter(t => t.id !== id));
    setCombos(prev => prev.filter(c => c.table_id_a !== id && c.table_id_b !== id));
    setSelected(null);
  };

  const updateSelectedTable = async (changes) => {
    if (selected?.type !== 'table') return;
    const t = tablesRef.current.find(t => t.id === selected.id);
    if (!t) return;
    const u = { ...t, ...changes };
    // Sync the ref IMMEDIATELY (not just via the post-render effect): the
    // rename input commits on BLUR, which fires in the same instant as a
    // "Save Layout" click — Save reads tablesRef and would otherwise snapshot
    // the PRE-rename list and push the old name straight back over the new
    // one (Korakot, Baan Siam 2026-08-03: renamed 13→2, Save reverted it).
    tablesRef.current = tablesRef.current.map(tbl => tbl.id === u.id ? u : tbl);
    setTables(prev => prev.map(tbl => tbl.id === u.id ? u : tbl));
    const r = await updateTablePlan(u.id, {
      pos_x: u.pos_x, pos_y: u.pos_y,
      shape: u.shape, width: u.width, height: u.height,
      name: u.name, capacity: u.capacity,
      table_number: u.table_number,
      is_takeaway: u.is_takeaway ? 1 : 0,
    });
    // Never fail silently — the "Bar 1" 500 looked like the app ignoring the
    // operator. api.js resolves {error} instead of throwing, so check it.
    if (r && r.error) showToast(`⚠ Not saved — ${r.error}`, 'error');
  };

  const handleRotateTable = () => {
    if (!selectedTable) return;
    updateSelectedTable({ width: selectedTable.height, height: selectedTable.width });
  };

  // ── Wall operations — optimistic, no fetchAll ──────────────────
  const handleAddWall = async (direction = 'vertical') => {
    const dims = direction === 'horizontal' ? { width: 100, height: 12 } : { width: 12, height: 100 };
    const result = await apiPost('/api/table-walls', { pos_x: 120, pos_y: 80, ...dims });
    if (result?.id) {
      setWalls(prev => [...prev, { id: result.id, pos_x: 120, pos_y: 80, ...dims }]);
      showToast(direction === 'horizontal' ? '— Horizontal wall added' : '| Vertical wall added');
    } else {
      showToast(`⚠ Wall not added — ${result?.error || 'no response'}`, 'error');
    }
  };

  const handleUpdateWall = async (id, changes) => {
    const w = wallsRef.current.find(w => w.id === id);
    if (!w) return;
    const u = { ...w, ...changes };
    // Same blur-vs-Save race guard as updateSelectedTable — keep the ref fresh.
    wallsRef.current = wallsRef.current.map(wl => wl.id === id ? u : wl);
    setWalls(prev => prev.map(wl => wl.id === id ? u : wl));
    const r = await apiPut(`/api/table-walls/${id}`, { pos_x: u.pos_x, pos_y: u.pos_y, width: u.width, height: u.height });
    if (r && r.error) showToast(`⚠ Wall not saved — ${r.error}`, 'error');
  };

  const handleDeleteWall = async (id) => {
    const r = await apiDel(`/api/table-walls/${id}`);
    if (r && r.error) { showToast(`⚠ Not deleted — ${r.error}`, 'error'); return; }
    setWalls(prev => prev.filter(w => w.id !== id));
    setSelected(null);
  };

  // ── Combination operations — optimistic, no fetchAll ──────────
  const handleAddCombo = async (idA, idB) => {
    const already = combos.some(c =>
      (c.table_id_a === idA && c.table_id_b === idB) ||
      (c.table_id_a === idB && c.table_id_b === idA)
    );
    if (already) { showToast('Already linked', 'error'); return; }
    const result = await apiPost('/api/table-combinations', { table_id_a: idA, table_id_b: idB });
    if (result?.id) {
      setCombos(prev => [...prev, { id: result.id, table_id_a: idA, table_id_b: idB, is_active: true }]);
      showToast('Tables linked ✓');
    } else {
      showToast(`⚠ Not linked — ${result?.error || 'no response'}`, 'error');
    }
  };

  const handleRemoveCombo = async (comboId) => {
    await apiDel(`/api/table-combinations/${comboId}`);
    setCombos(prev => prev.filter(c => c.id !== comboId));
    showToast('Link removed');
  };

  const handleRemoveGroup = async (group) => {
    const groupCombos = combos.filter(c =>
      group.includes(c.table_id_a) && group.includes(c.table_id_b)
    );
    await Promise.all(groupCombos.map(c => apiDel(`/api/table-combinations/${c.id}`)));
    const removedIds = new Set(groupCombos.map(c => c.id));
    setCombos(prev => prev.filter(c => !removedIds.has(c.id)));
    showToast('Group removed');
  };

  const handleUpdateTier = async (tier, newDur) => {
    setTiers(prev => prev.map(t => t.id === tier.id ? { ...t, duration_mins: newDur } : t));
    if (tier.id) await apiPut(`/api/dining-duration-tiers/${tier.id}`, { duration_mins: newDur });
  };

  const selectedTable = selected?.type === 'table' ? tables.find(t => t.id === selected.id) : null;
  const selectedWall  = selected?.type === 'wall'  ? walls.find(w => w.id === selected.id)  : null;
  const groups        = getAllGroups(combos, tables.map(t => t.id));

  // Canvas content size — the floor can be wider/taller than the visible box,
  // so size an inner area to the furthest table/wall and let the canvas scroll
  // (otherwise tables on the right/bottom get cut off).
  // SEPOS-FLOOR-FIT — the canvas draws the shared ROOM rectangle (same one
  // the Floor map scales to fit), so both screens show the same picture.
  const room = roomSize(tables, walls);
  const contentW = room.w;
  const contentH = room.h;

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

  const wallOrientation = selectedWall
    ? ((selectedWall.width || 12) >= (selectedWall.height || 100) ? 'h' : 'v')
    : 'v';

  return (
    <div style={{ padding: 24 }}>

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
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', margin: 0 }}>Table Plan</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>

          <button
            onClick={() => { setMode('select'); setLinkFrom(null); }}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
              background: mode === 'select' ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0',
              color:      mode === 'select' ? 'white'   : '#555' }}
          >✥ Select</button>

          <button
            onClick={() => { setMode(m => m === 'link' ? 'select' : 'link'); setLinkFrom(null); setSelected(null); }}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
              background: mode === 'link' ? 'var(--brand-accent,#C9A84C)' : '#f0f0f0',
              color:      mode === 'link' ? 'white'   : '#555' }}
          >⊕ {mode === 'link' && linkFrom ? 'Click 2nd table…' : 'Link Tables'}</button>

          <div style={{ width: 1, height: 24, background: '#e0e0e0' }} />

          <button onClick={handleAddTable}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Table</button>

          <button onClick={handleAddTakeaway}
            style={{ padding: '8px 12px', borderRadius: 8, border: '2px solid #f59e0b', background: '#fff', color: '#b45309', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            🥡 Takeaway</button>

          <button onClick={() => handleAddWall('vertical')}
            style={{ padding: '8px 10px', borderRadius: 8, border: 'none', background: '#555', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            | Wall</button>
          <button onClick={() => handleAddWall('horizontal')}
            style={{ padding: '8px 10px', borderRadius: 8, border: 'none', background: '#555', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            — Wall</button>

          <button onClick={fetchAll}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#f0f0f0', color: '#555', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
            title="Reload from server">
            ↻</button>

          <div style={{ width: 1, height: 24, background: '#e0e0e0' }} />

          <button onClick={handleSaveLayout} disabled={saving}
            style={{ padding: '8px 20px', borderRadius: 8, border: 'none',
              background: saving ? '#86efac' : '#16a34a', color: 'white',
              cursor: saving ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13 }}
            title="Save the whole layout and apply it to the floor">
            {saving ? 'Saving…' : '💾 Save Layout'}</button>
        </div>
      </div>

      {/* Floating overlay (position:fixed) so showing/hiding it never reflows the
          floor plan — otherwise the table you're about to click would jump. */}
      {mode === 'link' && (
        <div style={{ position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 2000, maxWidth: '92vw', background: '#fef9c3', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 16px', fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.22)' }}>
          <span>
            {linkFrom
              ? `Table ${tables.find(t => t.id === linkFrom)?.table_number} selected → now click the adjacent table to link`
              : 'Click the first table, then click the adjacent table — only link tables with NO partition between them'}
          </span>
          <button onClick={() => { setMode('select'); setLinkFrom(null); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#92400e', fontWeight: 700, fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, position: 'relative' }}>

        {/* Canvas */}
        <div
          ref={canvasRef}
          onPointerDown={handleCanvasMouseDown}
          onPointerMove={handleMouseMove}
          onPointerUp={handleMouseUp}
          onPointerLeave={handleMouseUp}
          style={{
            flex: 1, height: 640, minWidth: 0,
            background: '#f0ede8', borderRadius: 16, position: 'relative',
            border: `2px solid ${mode === 'link' ? 'var(--brand-accent,#C9A84C)' : '#ddd'}`,
            cursor: mode === 'link' ? 'crosshair' : dragging ? 'grabbing' : 'default',
            overflow: 'auto',
            // Pointer events + touch-action:none so tables drag by FINGER on a
            // touch till, not just by mouse (editor was mouse-only before).
            touchAction: 'none',
          }}
        >
          {/* Spacer defines the scroll extent at the CURRENT zoom; the inner
              layer is the room at logical size, CSS-scaled. Grid dots live on
              the scaled layer so they track the room's logical grid. */}
          <div data-canvas-bg="1" style={{ width: contentW * editorZoom, height: contentH * editorZoom, position: 'relative' }}>
          <div data-canvas-bg="1" style={{
            position: 'absolute', top: 0, left: 0, width: contentW, height: contentH,
            transform: `scale(${editorZoom})`, transformOrigin: '0 0',
            backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)',
            backgroundSize: '30px 30px',
          }}>
          {/* SVG sized to the full floor so link lines + the scroll area cover
              every table (a sized absolute child extends the scrollable width). */}
          <svg style={{ position: 'absolute', top: 0, left: 0, width: contentW, height: contentH, pointerEvents: 'none', zIndex: 1 }}>
            {combos.map(c => {
              const a = tableCenter(c.table_id_a);
              const b = tableCenter(c.table_id_b);
              if (!a || !b) return null;
              return (
                <g key={c.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--brand-accent,#C9A84C)" strokeWidth="2.5" strokeDasharray="6 4" />
                  <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r="6" fill="var(--brand-accent,#C9A84C)" />
                </g>
              );
            })}
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
                  <rect x={mx - tw/2} y={my} width={tw} height={22} rx="11" fill="#FAEEDA" stroke="var(--brand-accent,#C9A84C)" strokeWidth="1" />
                  <text x={mx} y={my + 14.5} textAnchor="middle" fontSize="11" fill="#854F0B" fontWeight="500" fontFamily="system-ui, -apple-system, sans-serif">{label}</text>
                </g>
              );
            })}
          </svg>

          {walls.map(wall => (
            <div
              key={wall.id}
              onPointerDown={e => handleMouseDown(e, 'wall', wall.id)}
              style={{
                position: 'absolute', left: wall.pos_x, top: wall.pos_y,
                width: wall.width || 12, height: wall.height || 100,
                background: selected?.id === wall.id ? '#e94560' : '#4a4a4a',
                borderRadius: 3, cursor: 'grab', zIndex: 2, touchAction: 'none',
                outline: selected?.id === wall.id ? '2px solid #e94560' : 'none',
                outlineOffset: 2,
              }}
              title="Partition wall — drag to reposition"
            />
          ))}

          {tables.map(table => {
            const isSelected  = selected?.type === 'table' && selected?.id === table.id;
            const isLinked    = combos.some(c => c.table_id_a === table.id || c.table_id_b === table.id);
            const isLinkFirst = linkFrom === table.id;
            return (
              <div
                key={table.id}
                onPointerDown={e => handleMouseDown(e, 'table', table.id)}
                style={{
                  position: 'absolute', touchAction: 'none',
                  left: table.pos_x, top: table.pos_y,
                  width: table.width || 80, height: table.height || 80,
                  borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                  background: isLinkFirst ? 'var(--brand-accent,#C9A84C)' : isSelected ? 'var(--brand-primary, #1a1a2e)' : isLinked ? '#fef9c3' : (table.is_takeaway ? '#fffbeb' : '#fff'),
                  border: `3px solid ${isLinkFirst ? 'var(--brand-accent,#C9A84C)' : isSelected ? '#e94560' : isLinked ? 'var(--brand-accent,#C9A84C)' : (table.is_takeaway ? '#f59e0b' : 'var(--brand-primary, #1a1a2e)')}`,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  cursor: mode === 'link' ? 'crosshair' : 'grab',
                  userSelect: 'none', zIndex: isSelected ? 10 : 3,
                  boxShadow: isSelected ? '0 4px 20px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.1)',
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: isLinkFirst || isSelected ? 'white' : (table.is_takeaway ? '#b45309' : 'var(--brand-primary, #1a1a2e)'), textAlign: 'center' }}>
                  {table.is_takeaway ? '🥡' : ''}{tableLabel(table)}
                </div>
                <div style={{ fontSize: 10, color: isLinkFirst || isSelected ? 'rgba(255,255,255,0.7)' : '#888' }}>
                  {table.is_takeaway ? 'Takeaway' : `${table.capacity}p`}
                </div>
              </div>
            );
          })}

          {tables.length === 0 && (
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 15 }}>
              Click "+ Table" to start building your floor plan
            </div>
          )}
          </div>{/* /scaled room layer */}
          </div>{/* /zoom spacer */}
        </div>

        {/* Editor zoom — same −/Fit/+ control as the Floor map so a big room
            can be designed without running off the visible canvas. */}
        <div style={{
          position: 'absolute', right: 274, bottom: 12,
          display: 'flex', flexDirection: 'column', gap: 6, zIndex: 5,
        }}>
          {[
            { label: '+', title: 'Zoom in',       act: () => changeEditorZoom(1.15) },
            { label: '⊡', title: 'Fit whole room', act: () => changeEditorZoom(0) },
            { label: '−', title: 'Zoom out',      act: () => changeEditorZoom(1 / 1.15) },
          ].map(b => (
            <button key={b.label} title={b.title} onClick={b.act} style={{
              width: 40, height: 40, borderRadius: 10,
              border: '1px solid #d6d3cb', background: 'rgba(255,255,255,0.95)',
              color: 'var(--brand-primary, #1a1a2e)', fontSize: b.label === '⊡' ? 18 : 22,
              fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{b.label}</button>
          ))}
          {editorZoom !== 1 && (
            <div style={{
              textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#7C766A',
              background: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '2px 4px',
            }}>{Math.round(editorZoom * 100)}%</div>
          )}
        </div>

        {/* Properties panel */}
        <div style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>

          {selectedTable && (
            <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 14 }}>{selectedTable.is_takeaway ? `🥡 Takeaway ${tableLabel(selectedTable)}` : `Table ${tableLabel(selectedTable)}`}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Table Number / Name</label>
                  {/* Save on CHANGE (like Capacity), not blur — blur fires in the same
                      instant as deselect/Save-Layout clicks and the typed name was
                      silently dropped (deselect nulls `selected` → the blur save
                      no-ops; or the input unmounts and blur never fires at all).
                      SEPOS-TABLE-NAME — digits go to table_number (an INTEGER
                      column; text used to 500 "invalid input syntax" SILENTLY);
                      anything else is a display label saved to `name` ("Bar 1"). */}
                  <input defaultValue={String(tableLabel(selectedTable) ?? '')} key={selectedTable.id + '_n'}
                    onChange={e => {
                      const v = e.target.value.trim();
                      if (v === '') return;
                      if (/^\d+$/.test(v)) updateSelectedTable({ table_number: Number(v), name: null });
                      else updateSelectedTable({ name: v });
                    }}
                    style={inp} />
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 3 }}>A number, or a label like “Bar 1”</div>
                </div>
                <div>
                  <label style={lbl}>Capacity (seats)</label>
                  <input type="number" defaultValue={selectedTable.capacity} key={selectedTable.id + '_c'} onChange={e => { if (e.target.value !== '') updateSelectedTable({ capacity: parseInt(e.target.value) || 1 }); }} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Shape</label>
                  <select value={selectedTable.shape || 'square'} onChange={e => {
                    const shape = e.target.value;
                    const opts = SIZE_OPTIONS[shape] || [];
                    const cur = `${selectedTable.width}x${selectedTable.height}`;
                    if (opts.some(([v]) => v === cur)) { updateSelectedTable({ shape }); return; }
                    // Current dims don't fit the new shape → snap to that shape's default (Medium).
                    const [w, h] = (opts[1] || opts[0] || ['80x80', ''])[0].split('x').map(Number);
                    updateSelectedTable({ shape, width: w, height: h });
                  }} style={inp}>
                    <option value="square">Square</option>
                    <option value="round">Round</option>
                    <option value="rectangle">Rectangle</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Size</label>
                  <select value={`${selectedTable.width}x${selectedTable.height}`} onChange={e => { const [w, h] = e.target.value.split('x').map(Number); updateSelectedTable({ width: w, height: h }); }} style={inp}>
                    {(SIZE_OPTIONS[selectedTable.shape || 'square'] || []).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </div>

                <button onClick={handleRotateTable}
                  style={{ padding: '8px', borderRadius: 8, border: '1.5px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  ↻ Rotate Table
                </button>

                {/* SEPOS-TAKEAWAY-TABLE — flag this table as a takeaway table */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8, background: selectedTable.is_takeaway ? '#fffbeb' : '#f8f8f8', border: `1px solid ${selectedTable.is_takeaway ? '#f59e0b' : '#eee'}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!selectedTable.is_takeaway} onChange={e => updateSelectedTable({ is_takeaway: e.target.checked ? 1 : 0 })} style={{ width: 16, height: 16 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#b45309' }}>🥡 Takeaway table</span>
                </label>
                <div style={{ fontSize: 11, color: '#999', marginTop: -4 }}>Orders here skip service charge and print as “Takeaway {selectedTable.table_number}”.</div>

                <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 8 }}>Can combine with</div>
                  {comboPartnersFor(selectedTable.id).length === 0 && (
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>No links set for this table</div>
                  )}
                  {comboPartnersFor(selectedTable.id).map(({ comboId, partnerId }) => {
                    const pt = tables.find(t => t.id === partnerId);
                    return pt ? (
                      <div key={comboId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, background: '#fef9c3', borderRadius: 8, padding: '6px 10px' }}>
                        <span style={{ fontSize: 12, flex: 1, color: '#854F0B', fontWeight: 600 }}>T{pt.table_number} ({pt.capacity}p) → {selectedTable.capacity + pt.capacity}p</span>
                        <button onClick={() => handleRemoveCombo(comboId)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 16, padding: 0 }}>×</button>
                      </div>
                    ) : null;
                  })}
                  {(() => {
                    const group = getGroup(selectedTable.id, combos);
                    if (group.length > 2) {
                      const cap   = groupCap(group);
                      const names = group.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : ''; }).join('+');
                      return <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '7px 10px', marginTop: 4, fontSize: 12, color: '#854F0B', fontWeight: 700 }}>Full group: {names} = {cap}p max</div>;
                    }
                    return null;
                  })()}
                  <button onClick={() => { setMode('link'); setLinkFrom(selectedTable.id); setSelected(null); }}
                    style={{ width: '100%', marginTop: 8, padding: '8px', border: '1.5px dashed var(--brand-accent,#C9A84C)', borderRadius: 8, background: 'none', cursor: 'pointer', fontSize: 12, color: '#854F0B', fontWeight: 600 }}>
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

          {selectedWall && (
            <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 14 }}>Partition Wall</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Orientation</label>
                  <select
                    value={wallOrientation}
                    onChange={e => {
                      const isH = e.target.value === 'h';
                      const w = isH ? Math.max(selectedWall.width || 12, selectedWall.height || 100) : Math.min(selectedWall.width || 12, selectedWall.height || 100);
                      const h = isH ? Math.min(selectedWall.width || 12, selectedWall.height || 100) : Math.max(selectedWall.width || 12, selectedWall.height || 100);
                      handleUpdateWall(selectedWall.id, { width: w, height: h });
                    }}
                    style={inp}
                  >
                    <option value="v">Vertical |</option>
                    <option value="h">Horizontal —</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Thickness</label>
                  <select onChange={e => {
                    const thickness = parseInt(e.target.value);
                    handleUpdateWall(selectedWall.id, wallOrientation === 'h' ? { height: thickness } : { width: thickness });
                  }} style={inp}>
                    <option value="8">Thin (8px)</option>
                    <option value="12">Standard (12px)</option>
                    <option value="20">Thick (20px)</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Length</label>
                  <select onChange={e => {
                    const length = parseInt(e.target.value);
                    handleUpdateWall(selectedWall.id, wallOrientation === 'h' ? { width: length } : { height: length });
                  }} style={inp}>
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

          {!selectedTable && !selectedWall && (
            <>
              <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 12 }}>Linked Groups</div>
                {groups.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>No combinations set yet.<br />Use ⊕ Link Tables to connect adjacent tables.</div>
                ) : groups.map((group, gi) => {
                  const cap   = groupCap(group);
                  const names = group.map(id => { const t = tables.find(t => t.id === id); return t ? `T${t.table_number}` : ''; }).join(' + ');
                  return (
                    <div key={gi} style={{ background: '#FAEEDA', borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#854F0B' }}>{names}</div>
                        <div style={{ fontSize: 11, color: '#BA7517', marginTop: 2 }}>max combined capacity</div>
                      </div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--brand-accent,#C9A84C)' }}>{cap}p</div>
                      <button onClick={() => handleRemoveGroup(group)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 16, padding: 0 }}>×</button>
                    </div>
                  );
                })}
              </div>

              <div style={{ background: 'white', borderRadius: 14, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 4 }}>Dining Duration</div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>Applied automatically by party size when checking availability</div>
                {tiers.map((tier, i) => (
                  <div key={tier.id || i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: '#555', flex: 1, fontWeight: 500 }}>{tier.covers_min}{tier.covers_max ? `–${tier.covers_max}` : '+'} covers</span>
                    <input type="number" value={tier.duration_mins} min="30" max="360" step="15"
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
