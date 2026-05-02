import { useState, useEffect } from 'react';
import { getTables, createOrder, getOrders, getTableStatus, moveTable, mergeTables } from '../api';

const COLOUR_MAP = {
  available:      { bg: '#22c55e', border: '#16a34a', text: 'white', label: 'Available' },
  occupied:       { bg: '#ef4444', border: '#dc2626', text: 'white', label: 'Occupied' },
  starters_fired: { bg: '#eab308', border: '#ca8a04', text: 'white', label: 'Starters Called' },
  starters_done:  { bg: '#f97316', border: '#ea580c', text: 'white', label: 'Starters Done' },
  mains_fired:    { bg: '#38bdf8', border: '#0284c7', text: 'white', label: 'Mains Called' },
  mains_done:     { bg: '#1e3a8a', border: '#1e40af', text: 'white', label: 'Mains Done' },
  desserts_fired: { bg: '#f9a8d4', border: '#ec4899', text: '#1a1a2e', label: 'Desserts Called' },
  desserts_done:  { bg: '#6b7280', border: '#4b5563', text: 'white', label: 'Desserts Done' },
  bill_printed:   { bg: '#f8fafc', border: '#cbd5e1', text: '#1a1a2e', label: 'Bill Printed' },
};

export default function TableMapScreen({ staff, onOpenOrder }) {
  const [tables, setTables] = useState([]);
  const [tableStatuses, setTableStatuses] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCoversPopup, setShowCoversPopup] = useState(null);
  const [coversInput, setCoversInput] = useState('');
  const [viewMode, setViewMode] = useState('plan');
  const [tick, setTick] = useState(0);

  // Move/Merge state
  const [tableActionPopup, setTableActionPopup] = useState(null); // selected occupied table
  const [moveMode, setMoveMode] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);

  const fetchData = async () => {
    try {
      const [tablesData, ordersData, statusData] = await Promise.all([
        getTables(),
        getOrders(),
        getTableStatus()
      ]);
      setTables(tablesData);
      setOpenOrders(ordersData);
      setTableStatuses(statusData);
    } catch (err) {
      console.error('Failed to load tables', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    const timerTick = setInterval(() => setTick(t => t + 1), 60000);
    return () => { clearInterval(interval); clearInterval(timerTick); };
  }, []);

  const getTableColour = (table) => {
    const status = tableStatuses.find(s => s.table_id === table.id);
    if (!status) return COLOUR_MAP.available;
    return COLOUR_MAP[status.colour_status] || COLOUR_MAP.occupied;
  };

  const getTableTime = (tableId) => {
    const order = openOrders.find(o => o.table_id === tableId);
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
    const order = openOrders.find(o => o.table_id === tableId);
    if (!order) return 'white';
    const rawDate = order.opened_at || order.created_at;
    const opened = new Date(rawDate);
    if (isNaN(opened.getTime())) return 'white';
    const diff = Math.floor((Date.now() - opened.getTime()) / 60000);
    if (diff > 90) return '#fca5a5';
    if (diff > 60) return '#fde68a';
    return 'rgba(255,255,255,0.9)';
  };
  
  const handleTableClick = async (table) => {
    const existingOrder = openOrders.find(o => o.table_id === table.id);

    // If in move mode — move to this empty table
    if (moveMode && tableActionPopup) {
      if (existingOrder) {
        alert('Please select an empty table to move to!');
        return;
      }
      try {
        await moveTable(tableActionPopup.order.id, table.id);
        alert(`✅ Moved to Table ${table.table_number}!`);
        setMoveMode(false);
        setTableActionPopup(null);
        fetchData();
      } catch (err) {
        alert('Failed to move table!');
      }
      return;
    }

    // If in merge mode — merge this table into the selected table
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
        await mergeTables(tableActionPopup.order.id, existingOrder.id);
        alert(`✅ Tables merged! Table ${table.table_number} combined into Table ${tableActionPopup.table.table_number}`);
        setMergeMode(false);
        setTableActionPopup(null);
        fetchData();
      } catch (err) {
        alert('Failed to merge tables!');
      }
      return;
    }

    // Normal click
    if (existingOrder) {
      setTableActionPopup({ table, order: existingOrder });
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

      {/* Header */}
      <div style={{ padding: '14px 24px', background: 'white', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Table Map</h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(COLOUR_MAP).map(([key, val]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 10, height: 10, borderRadius: 3, background: val.bg, border: `1px solid ${val.border}` }} />
                <span style={{ fontSize: 10, color: '#555' }}>{val.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button onClick={() => setViewMode(viewMode === 'plan' ? 'grid' : 'plan')} style={{ background: '#f0f0f0', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            {viewMode === 'plan' ? '⊞ Grid view' : '🗺️ Plan view'}
          </button>
          <button onClick={fetchData} style={{ background: '#1a1a2e', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Move/Merge mode banner */}
      {(moveMode || mergeMode) && (
        <div style={{ background: moveMode ? '#1e40af' : '#8b5cf6', padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>
            {moveMode
              ? `🔄 Moving Table ${tableActionPopup?.table.table_number} — tap an empty table to move to`
              : `🔗 Merging Table ${tableActionPopup?.table.table_number} — tap another occupied table to merge with`
            }
          </div>
          <button onClick={cancelMode} style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
        </div>
      )}

      {/* Plan view */}
      {viewMode === 'plan' && (
        <div style={{ flex: 1, overflow: 'auto', background: '#f0ede8', position: 'relative', backgroundImage: 'radial-gradient(circle, #ccc 1px, transparent 1px)', backgroundSize: '30px 30px' }}>
          {tables.map(table => {
            const colours = getTableColour(table);
            const w = table.width || 80;
            const h = table.height || 80;
            const x = table.pos_x || 40;
            const y = table.pos_y || 40;
            const time = getTableTime(table.id);
            const timeColor = getTimeColor(table.id);
            const isSelected = tableActionPopup?.table.id === table.id;

            return (
              <div key={table.id} onClick={() => handleTableClick(table)} style={{
                position: 'absolute', left: x, top: y, width: w, height: h,
                borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
                background: colours.bg,
                border: `3px solid ${isSelected ? '#ffffff' : colours.border}`,
                outline: isSelected ? '3px solid #1a1a2e' : 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', userSelect: 'none',
                boxShadow: isSelected ? '0 0 20px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                transition: 'transform 0.1s',
              }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <div style={{ fontSize: w > 90 ? 16 : 13, fontWeight: 800, color: colours.text, textAlign: 'center', padding: '0 4px' }}>
                  {table.table_number}
                </div>
                {time && (
  <div style={{
    fontSize: 13, fontWeight: 800,
    color: '#000000',
    marginTop: 3,
    background: 'rgba(255,255,255,0.85)',
    padding: '2px 6px',
    borderRadius: 6
  }}>
    ⏱ {time}
  </div>
)}
              </div>
            );
          })}
        </div>
      )}

      {/* Grid view */}
      {viewMode === 'grid' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            {tables
              .sort((a, b) => String(a.table_number).localeCompare(String(b.table_number), undefined, { numeric: true }))
              .map(table => {
                const colours = getTableColour(table);
                const order = openOrders.find(o => o.table_id === table.id);
                const time = getTableTime(table.id);
                const isSelected = tableActionPopup?.table.id === table.id;

                return (
                  <div key={table.id} onClick={() => handleTableClick(table)} style={{
                    background: colours.bg,
                    border: `3px solid ${isSelected ? '#1a1a2e' : colours.border}`,
                    borderRadius: 14, padding: 16, cursor: 'pointer', textAlign: 'center',
                    transition: 'transform 0.15s',
                    boxShadow: isSelected ? '0 0 20px rgba(0,0,0,0.3)' : 'none'
                  }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.04)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                  >
                    <div style={{ fontSize: 28, fontWeight: 800, color: colours.text }}>{table.table_number}</div>
                    <div style={{ fontSize: 11, color: colours.text, opacity: 0.8, marginBottom: 2 }}>{table.capacity} seats</div>
                    <div style={{ fontSize: 11, color: colours.text, opacity: 0.7, marginBottom: 4, fontWeight: 600 }}>{colours.label}</div>
                    {time && <div style={{ fontSize: 12, fontWeight: 700, color: colours.text, opacity: 0.9 }}>⏱ {time}</div>}
                    {order && <div style={{ fontSize: 11, color: colours.text, opacity: 0.8, marginTop: 4 }}>{order.covers} cvr · £{(order.total || 0).toFixed(2)}</div>}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Table action popup */}
      {tableActionPopup && !moveMode && !mergeMode && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1a1a2e' }}>Table {tableActionPopup.table.table_number}</div>
              <div style={{ color: '#888', fontSize: 14 }}>
                {tableActionPopup.order.covers} covers · £{(tableActionPopup.order.total || 0).toFixed(2)}
              </div>
            </div>

            {/* Open order */}
            <button onClick={() => {
              setTableActionPopup(null);
              onOpenOrder(tableActionPopup.order.id, tableActionPopup.table.id);
            }} style={{
              padding: '16px', borderRadius: 12, border: 'none',
              background: '#1a1a2e', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              📋 Open Order
            </button>

            {/* Move table */}
            <button onClick={() => {
              setMoveMode(true);
              setMergeMode(false);
            }} style={{
              padding: '16px', borderRadius: 12, border: 'none',
              background: '#1e40af', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              🔄 Move Table
            </button>

            {/* Merge table */}
            <button onClick={() => {
              setMergeMode(true);
              setMoveMode(false);
            }} style={{
              padding: '16px', borderRadius: 12, border: 'none',
              background: '#8b5cf6', color: 'white',
              fontSize: 16, fontWeight: 700, cursor: 'pointer'
            }}>
              🔗 Merge Table
            </button>

            <button onClick={() => setTableActionPopup(null)} style={{
              padding: '12px', borderRadius: 10, border: 'none',
              background: '#f0f0f0', color: '#555',
              fontSize: 14, cursor: 'pointer', fontWeight: 600
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Covers numpad popup */}
      {showCoversPopup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: '32px 28px', width: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Table {showCoversPopup.table_number}</div>
              <div style={{ color: '#888', fontSize: 14 }}>How many covers?</div>
            </div>
            <div style={{ fontSize: 48, fontWeight: 800, color: '#1a1a2e', minHeight: 60 }}>
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
                    try {
                      const data = await createOrder(showCoversPopup.id, num);
                      setShowCoversPopup(null);
                      setCoversInput('');
                      onOpenOrder(data.id, showCoversPopup.id);
                    } catch (err) {
                      alert('Failed to create order!');
                    }
                  } else {
                    setCoversInput(prev => prev.length < 2 ? prev + btn : prev);
                  }
                }} style={{
                  height: 64, borderRadius: 12, border: 'none', fontSize: 22,
                  fontWeight: 700, cursor: 'pointer',
                  background: btn === '✓' ? '#e94560' : btn === 'C' ? '#f0f0f0' : '#f8f8f8',
                  color: btn === '✓' ? 'white' : '#1a1a2e',
                }}>{btn}</button>
              ))}
            </div>
            <button onClick={() => setShowCoversPopup(null)} style={{ color: '#888', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}