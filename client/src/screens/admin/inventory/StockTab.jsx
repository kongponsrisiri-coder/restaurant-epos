import { useState, useEffect } from 'react';
import { invAPI } from '../shared';

export default function StockTab() {
  const [movements, setMovements]   = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [filterType, setFilterType] = useState('all');
  const [adjForm, setAdjForm]       = useState({ ingredient_id: '', quantity: '', movement_type: 'adjustment', note: '' });
  const [saving, setSaving]         = useState(false);

  const MOVEMENT_TYPES = [{ id: 'all', label: 'All' }, { id: 'delivery', label: '📦 Delivery' }, { id: 'used', label: '🍳 Used' }, { id: 'waste', label: '🗑️ Waste' }, { id: 'adjustment', label: '✏️ Adjustment' }];

  const loadAll = async () => { setLoading(true); const [movs, ings] = await Promise.all([invAPI.getMovements(), invAPI.getIngredients()]); setMovements(Array.isArray(movs) ? movs : []); setIngredients(Array.isArray(ings) ? ings : []); setLoading(false); };
  useEffect(() => { loadAll(); }, []);

  const filtered = movements.filter(m => filterType === 'all' || m.movement_type === filterType);
  const typeStyle = (type) => {
    const map = { delivery: { color: '#22c55e', bg: '#dcfce7', label: '📦 Delivery' }, used: { color: '#3b82f6', bg: '#dbeafe', label: '🍳 Used' }, waste: { color: '#ef4444', bg: '#fee2e2', label: '🗑️ Waste' }, adjustment: { color: '#8b5cf6', bg: '#ede9fe', label: '✏️ Adjustment' } };
    return map[type] || { color: '#888', bg: '#f0f0f0', label: type };
  };

  const handleAdjust = async () => {
    if (!adjForm.ingredient_id || !adjForm.quantity) return alert('Select an ingredient and enter a quantity');
    setSaving(true);
    try { await invAPI.addAdjustment(adjForm); setAdjForm({ ingredient_id: '', quantity: '', movement_type: 'adjustment', note: '' }); loadAll(); }
    catch { alert('Save failed — check backend is running'); }
    finally { setSaving(false); }
  };

  const formatDateTime = (dt) => dt ? new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div>
      <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📝 Record Stock Movement</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 160 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Ingredient</label><select value={adjForm.ingredient_id} onChange={e => setAdjForm({ ...adjForm, ingredient_id: e.target.value })} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="">— Select —</option>{ingredients.map(i => <option key={i.id} value={i.id}>{i.name_en}</option>)}</select></div>
          <div style={{ flex: 1, minWidth: 90 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Quantity</label><input type="number" step="0.01" value={adjForm.quantity} onChange={e => setAdjForm({ ...adjForm, quantity: e.target.value })} placeholder="+ or –" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
          <div style={{ flex: 1, minWidth: 130 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Type</label><select value={adjForm.movement_type} onChange={e => setAdjForm({ ...adjForm, movement_type: e.target.value })} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="delivery">📦 Delivery</option><option value="waste">🗑️ Waste</option><option value="adjustment">✏️ Adjustment</option></select></div>
          <div style={{ flex: 2, minWidth: 140 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Note (optional)</label><input value={adjForm.note} onChange={e => setAdjForm({ ...adjForm, note: e.target.value })} placeholder="e.g. Wing Yip delivery" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
          <button onClick={handleAdjust} disabled={saving} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{saving ? 'Saving...' : 'Record'}</button>
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>💡 Use positive numbers for stock in (deliveries), negative numbers for stock out (waste, adjustments)</div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {MOVEMENT_TYPES.map(t => (<button key={t.id} onClick={() => setFilterType(t.id)} style={{ padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: filterType === t.id ? '#1a1a2e' : '#e0e0e0', color: filterType === t.id ? 'white' : '#555' }}>{t.label}</button>))}
      </div>
      {loading ? <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading stock movements...</div> : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 90px 80px 1fr', padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
            <span>Date</span><span>Ingredient</span><span style={{ textAlign: 'center' }}>Type</span><span style={{ textAlign: 'right' }}>Quantity</span><span style={{ paddingLeft: 12 }}>Note</span>
          </div>
          {filtered.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>{movements.length === 0 ? 'No stock movements recorded yet.' : 'No movements match this filter.'}</div>}
          {filtered.map((m, i) => {
            const ts = typeStyle(m.movement_type);
            const ing = ingredients.find(x => x.id === m.ingredient_id);
            // Show ingredient name from DB, fallback to stored name, fallback to muted "Deleted ingredient" for orphaned records
            const displayName = ing?.name_en || m.ingredient_name;
            const isOrphaned  = !ing && !m.ingredient_name;
            return (
              <div key={m.id || i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 90px 80px 1fr', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                <span style={{ color: '#888', fontSize: 12 }}>{formatDateTime(m.created_at)}</span>
                <div>
                  {isOrphaned
                    ? <div style={{ fontWeight: 500, color: '#ef4444', opacity: 0.6, fontStyle: 'italic' }}>Deleted ingredient</div>
                    : <div style={{ fontWeight: 600, color: '#1a1a2e' }}>{displayName}</div>
                  }
                  {ing?.name_th && <div style={{ fontSize: 11, color: '#C9A84C' }}>{ing.name_th}</div>}
                </div>
                <div style={{ textAlign: 'center' }}><span style={{ background: ts.bg, color: ts.color, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20 }}>{ts.label}</span></div>
                <span style={{ textAlign: 'right', fontWeight: 700, color: Number(m.quantity) >= 0 ? '#22c55e' : '#ef4444' }}>{Number(m.quantity) >= 0 ? '+' : ''}{Number(m.quantity).toFixed(2)}</span>
                <span style={{ paddingLeft: 12, color: '#888', fontSize: 12 }}>{m.note || '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
