import { useState, useEffect, useRef } from 'react';

export default function TablePlanSection() {
  const [tables, setTables]     = useState([]);
  const [selected, setSelected] = useState(null);
  const canvasRef               = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [offset, setOffset]     = useState({ x: 0, y: 0 });

  const fetchTables = async () => {
    const { getTables } = await import('../../api');
    const data = await getTables();
    setTables(data.map((t, i) => ({
      ...t,
      pos_x: t.pos_x || (i % 5) * 120 + 40,
      pos_y: t.pos_y || Math.floor(i / 5) * 120 + 40,
      width: t.width || 80, height: t.height || 80, shape: t.shape || 'square',
    })));
  };

  useEffect(() => { fetchTables(); }, []);

  const handleMouseDown = (e, table) => {
    e.preventDefault();
    setDragging(table.id); setSelected(table.id);
    const rect = canvasRef.current.getBoundingClientRect();
    setOffset({ x: e.clientX - rect.left - table.pos_x, y: e.clientY - rect.top - table.pos_y });
  };

  const handleMouseMove = (e) => {
    if (!dragging) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left - offset.x, rect.width - 80));
    const y = Math.max(0, Math.min(e.clientY - rect.top - offset.y, rect.height - 80));
    setTables(prev => prev.map(t => t.id === dragging ? { ...t, pos_x: x, pos_y: y } : t));
  };

  const handleMouseUp = async () => {
    if (dragging) {
      const { updateTablePlan } = await import('../../api');
      const table = tables.find(t => t.id === dragging);
      if (table) await updateTablePlan(table.id, table);
    }
    setDragging(null);
  };

  const handleAddTable = async () => {
    const { addTable } = await import('../../api');
    const maxNum = Math.max(...tables.map(t => Number(t.table_number) || 0), 0);
    await addTable({ table_number: maxNum + 1, capacity: 4, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80 });
    fetchTables();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this table?')) return;
    const { deleteTable } = await import('../../api');
    await deleteTable(id);
    setSelected(null); fetchTables();
  };

  const updateSelected = async (changes) => {
    const { updateTablePlan } = await import('../../api');
    const table = tables.find(t => t.id === selected);
    if (!table) return;
    const updated = { ...table, ...changes };
    setTables(prev => prev.map(t => t.id === selected ? updated : t));
    await updateTablePlan(updated.id, updated);
    fetchTables();
  };

  const selectedTable = tables.find(t => t.id === selected);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>Table Plan Editor</h1>
        <button onClick={handleAddTable} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Table</button>
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div ref={canvasRef} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
          style={{ flex: 1, height: 600, background: '#f0ede8', borderRadius: 16, position: 'relative', border: '2px solid #ddd', cursor: dragging ? 'grabbing' : 'default', backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)', backgroundSize: '30px 30px', overflow: 'hidden' }}>
          {tables.map(table => (
            <div key={table.id} onMouseDown={e => handleMouseDown(e, table)} style={{ position: 'absolute', left: table.pos_x, top: table.pos_y, width: table.width || 80, height: table.height || 80, borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12, background: selected === table.id ? '#1a1a2e' : 'white', border: `3px solid ${selected === table.id ? '#e94560' : '#1a1a2e'}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'grab', userSelect: 'none', boxShadow: selected === table.id ? '0 4px 20px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: selected === table.id ? 'white' : '#1a1a2e', textAlign: 'center', padding: '0 4px' }}>{table.table_number}</div>
              <div style={{ fontSize: 10, color: selected === table.id ? 'rgba(255,255,255,0.7)' : '#888' }}>{table.capacity} seats</div>
            </div>
          ))}
          {tables.length === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 16 }}>Click "+ Add Table" to start</div>}
        </div>
        <div style={{ width: 260, background: 'white', borderRadius: 16, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', alignSelf: 'flex-start' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 16 }}>{selectedTable ? `Table ${selectedTable.table_number}` : 'Select a table'}</div>
          {selectedTable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Table Number / Name</label>
                <input key={selectedTable.id + '_num'} defaultValue={selectedTable.table_number} onBlur={e => updateSelected({ table_number: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Click away to save</div>
              </div>
              <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Capacity (seats)</label><input type="number" key={selectedTable.id + '_cap'} defaultValue={selectedTable.capacity} onBlur={e => updateSelected({ capacity: Number(e.target.value) })} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Shape</label><select value={selectedTable.shape || 'square'} onChange={e => updateSelected({ shape: e.target.value })} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="square">Square</option><option value="round">Round</option><option value="rectangle">Rectangle</option></select></div>
              <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Size</label><select onChange={e => { const [w, h] = e.target.value.split('x').map(Number); updateSelected({ width: w, height: h }); }} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="">— Pick a size —</option><option value="70x70">Small (2 seats)</option><option value="80x80">Medium (4 seats)</option><option value="100x100">Large (6 seats)</option><option value="120x120">Extra large (8+ seats)</option><option value="120x70">Rectangle small</option><option value="160x70">Rectangle medium</option><option value="200x70">Rectangle large</option></select></div>
              <button onClick={() => handleDelete(selectedTable.id)} style={{ padding: '8px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>🗑️ Delete Table</button>
            </div>
          ) : <div style={{ color: '#bbb', fontSize: 13 }}>Click a table to edit</div>}
          <div style={{ marginTop: 20, padding: '12px', background: '#f8f8f8', borderRadius: 8, fontSize: 12, color: '#888' }}>💡 Drag tables to move them</div>
        </div>
      </div>
    </div>
  );
}
