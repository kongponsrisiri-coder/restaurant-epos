import { useState, useEffect, useRef } from 'react';
import { getTables, updateTablePlan, addTable, deleteTable } from '../api';

export default function TablePlanScreen() {
  const [tables, setTables] = useState([]);
  const [dragging, setDragging] = useState(null);
  const [selected, setSelected] = useState(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const canvasRef = useRef(null);

  const fetchTables = async () => {
    const data = await getTables();
    setTables(data.map((t, i) => ({
      ...t,
      pos_x: t.pos_x || (i % 5) * 120 + 40,
      pos_y: t.pos_y || Math.floor(i / 5) * 120 + 40,
      width: t.width || 80,
      height: t.height || 80,
      shape: t.shape || 'square'
    })));
  };

  useEffect(() => { fetchTables(); }, []);

  const handleMouseDown = (e, table) => {
    e.preventDefault();
    setDragging(table.id);
    setSelected(table.id);
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
      const table = tables.find(t => t.id === dragging);
      if (table) {
        await updateTablePlan(table.id, {
          pos_x: table.pos_x, pos_y: table.pos_y,
          shape: table.shape, width: table.width,
          height: table.height, name: table.name,
          capacity: table.capacity
        });
      }
    }
    setDragging(null);
  };

  const handleAddTable = async () => {
    const maxNum = Math.max(...tables.map(t => Number(t.table_number) || 0), 0);
    await addTable({ table_number: maxNum + 1, capacity: 4, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80 });
    fetchTables();
  };

  // SEPOS-TAKEAWAY-TABLE — a takeaway "table". Sits on the floor like a table
  // but orders rung up on it are takeaway (no service charge, kitchen ticket
  // says "Takeaway {number}").
  const handleAddTakeaway = async () => {
    const maxNum = Math.max(...tables.map(t => Number(t.table_number) || 0), 0);
    await addTable({ table_number: maxNum + 1, capacity: 1, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80, is_takeaway: 1 });
    fetchTables();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this table?')) return;
    await deleteTable(id);
    setSelected(null);
    fetchTables();
  };

  const selectedTable = tables.find(t => t.id === selected);

  const updateSelected = async (changes) => {
    if (!selectedTable) return;
    const updated = { ...selectedTable, ...changes };
    await updateTablePlan(updated.id, {
      pos_x: updated.pos_x, pos_y: updated.pos_y,
      shape: updated.shape, width: updated.width,
      height: updated.height, name: updated.name,
      capacity: updated.capacity,
      is_takeaway: updated.is_takeaway ? 1 : 0
    });
    fetchTables();
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>Table Plan Editor</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleAddTakeaway} style={{ background: '#fff', color: '#b45309', border: '2px solid #f59e0b', padding: '9px 16px', borderRadius: 10, cursor: 'pointer', fontWeight: 700 }}>
            🥡 Add Takeaway
          </button>
          <button onClick={handleAddTable} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>
            + Add Table
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        {/* Canvas */}
        <div
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            flex: 1, height: 600, background: '#f0ede8',
            borderRadius: 16, position: 'relative',
            border: '2px solid #ddd', cursor: dragging ? 'grabbing' : 'default',
            backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)',
            backgroundSize: '30px 30px', overflow: 'hidden'
          }}
        >
          {tables.map(table => (
            <div
              key={table.id}
              onMouseDown={e => handleMouseDown(e, table)}
              style={{
                position: 'absolute',
                left: table.pos_x, top: table.pos_y,
                width: table.width || 80,
                height: table.height || 80,
                borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                background: selected === table.id ? 'var(--brand-primary, #1a1a2e)' : (table.is_takeaway ? '#fffbeb' : '#fff'),
                border: `3px solid ${selected === table.id ? '#e94560' : (table.is_takeaway ? '#f59e0b' : 'var(--brand-primary, #1a1a2e)')}`,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', userSelect: 'none',
                boxShadow: selected === table.id ? '0 4px 20px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.1)',
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 800, color: selected === table.id ? 'white' : (table.is_takeaway ? '#b45309' : 'var(--brand-primary, #1a1a2e)'), textAlign: 'center', padding: '0 4px' }}>
                {table.is_takeaway ? '🥡' : ''}{table.table_number}
              </div>
              <div style={{ fontSize: 10, color: selected === table.id ? 'rgba(255,255,255,0.7)' : '#888' }}>
                {table.is_takeaway ? 'Takeaway' : `${table.capacity} seats`}
              </div>
            </div>
          ))}

          {tables.length === 0 && (
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 16 }}>
              Click "+ Add Table" to start building your floor plan
            </div>
          )}
        </div>

        {/* Properties panel */}
        <div style={{ width: 240, background: 'white', borderRadius: 16, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', alignSelf: 'flex-start' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 16 }}>
            {selectedTable ? (selectedTable.is_takeaway ? `🥡 Takeaway ${selectedTable.table_number}` : `Table ${selectedTable.table_number}`) : 'Select a table'}
          </div>

          {selectedTable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Table number */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Table Name / Number</label>
                <input
                  defaultValue={selectedTable.table_number}
                  key={selectedTable.id + '_num'}
                  onBlur={e => updateSelected({ table_number: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              {/* Capacity */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Capacity (seats)</label>
                <input
                  type="number"
                  defaultValue={selectedTable.capacity}
                  key={selectedTable.id + '_cap'}
                  onBlur={e => updateSelected({ capacity: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              {/* Shape */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Shape</label>
                <select
                  value={selectedTable.shape || 'square'}
                  onChange={e => updateSelected({ shape: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}
                >
                  <option value="square">Square</option>
                  <option value="round">Round</option>
                  <option value="rectangle">Rectangle</option>
                </select>
              </div>

              {/* Size */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Size</label>
                <select
                  onChange={e => {
                    const [w, h] = e.target.value.split('x').map(Number);
                    updateSelected({ width: w, height: h });
                  }}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}
                >
                  <option value="70x70">Small square (2 seats)</option>
                  <option value="80x80">Medium square (4 seats)</option>
                  <option value="100x100">Large square (6 seats)</option>
                  <option value="120x120">Extra large (8+ seats)</option>
                  <option value="120x70">Rectangle small (4 seats)</option>
                  <option value="160x70">Rectangle medium (6 seats)</option>
                  <option value="200x70">Rectangle large (8 seats)</option>
                  <option value="240x70">Rectangle extra large (10 seats)</option>
                </select>
              </div>

              {/* SEPOS-TAKEAWAY-TABLE — flag this table as a takeaway table */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px', borderRadius: 8, background: selectedTable.is_takeaway ? '#fffbeb' : '#f8f8f8', border: `1px solid ${selectedTable.is_takeaway ? '#f59e0b' : '#eee'}`, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!selectedTable.is_takeaway}
                  onChange={e => updateSelected({ is_takeaway: e.target.checked ? 1 : 0 })}
                  style={{ width: 16, height: 16 }}
                />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#b45309' }}>🥡 Takeaway table</span>
              </label>
              <div style={{ fontSize: 11, color: '#999', marginTop: -6 }}>
                Orders here skip service charge and print as “Takeaway {selectedTable.table_number}” to the kitchen.
              </div>

              {/* Delete button */}
              <button
                onClick={() => handleDelete(selectedTable.id)}
                style={{ padding: '8px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13, marginTop: 8 }}
              >
                Delete Table
              </button>
            </div>
          ) : (
            <div style={{ color: '#bbb', fontSize: 13 }}>Click a table to edit its properties</div>
          )}

          <div style={{ marginTop: 20, padding: '12px', background: '#f8f8f8', borderRadius: 8, fontSize: 12, color: '#888' }}>
            💡 Drag tables to move them around the floor plan
          </div>
        </div>
      </div>
    </div>
  );
}