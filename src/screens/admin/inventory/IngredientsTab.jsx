import { useState, useEffect } from 'react';
import { invAPI } from '../shared';

export default function IngredientsTab() {
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);

  const emptyForm = { name_en: '', name_th: '', unit: 'kg', cost_per_unit: '', yield_percentage: '100', category: 'Meat', current_stock: '0', par_level: '', supplier_name: '', allergens: [] };
  const [form, setForm] = useState(emptyForm);

  const CATEGORIES = ['Meat', 'Seafood', 'Vegetables', 'Dry Goods', 'Sauces', 'Dairy', 'Other'];
  const UNITS      = ['kg', 'g', 'L', 'ml', 'unit'];
  const ALLERGENS  = ['Gluten', 'Crustaceans', 'Eggs', 'Fish', 'Peanuts', 'Soybeans', 'Milk', 'Nuts', 'Sesame', 'Molluscs', 'Sulphites', 'Celery', 'Mustard'];

  const load = async () => { setLoading(true); const data = await invAPI.getIngredients(); setIngredients(Array.isArray(data) ? data : []); setLoading(false); };
  useEffect(() => { load(); }, []);

  const getStatus = (ing) => {
    if (!ing.current_stock || Number(ing.current_stock) <= 0) return { label: '🔴 OUT', color: '#ef4444', bg: '#fee2e2' };
    if (ing.par_level && Number(ing.current_stock) < Number(ing.par_level)) return { label: '🟡 LOW', color: '#eab308', bg: '#fef9c3' };
    return { label: '✅ OK', color: '#22c55e', bg: '#dcfce7' };
  };
  const getAllergens = (ing) => { try { return typeof ing.allergens === 'string' ? JSON.parse(ing.allergens || '[]') : (ing.allergens || []); } catch { return []; } };
  const filtered = ingredients.filter(ing => {
    const matchSearch = (ing.name_en || '').toLowerCase().includes(search.toLowerCase()) || (ing.name_th || '').toLowerCase().includes(search.toLowerCase());
    return matchSearch && (filterCat === 'all' || ing.category === filterCat);
  });
  const lowStockCount = ingredients.filter(i => i.par_level && Number(i.current_stock) < Number(i.par_level) && Number(i.current_stock) > 0).length;
  const outCount      = ingredients.filter(i => !i.current_stock || Number(i.current_stock) <= 0).length;

  const openAdd  = () => { setEditItem(null); setForm(emptyForm); setShowForm(true); };
  const openEdit = (ing) => { setEditItem(ing); setForm({ ...ing, allergens: getAllergens(ing) }); setShowForm(true); };
  const handleSave = async () => {
    if (!form.name_en || !form.cost_per_unit) return alert('Name and cost per unit are required!');
    const payload = { ...form, allergens: JSON.stringify(form.allergens || []) };
    try { if (editItem) await invAPI.updateIngredient(editItem.id, payload); else await invAPI.addIngredient(payload); setShowForm(false); load(); }
    catch { alert('Save failed — has Krit built the inventory backend yet?'); }
  };
  const handleDelete = async (id) => { if (!confirm('Delete this ingredient? This will affect any recipes that use it.')) return; await invAPI.deleteIngredient(id); load(); };
  const toggleAllergen = (a) => setForm(prev => ({ ...prev, allergens: prev.allergens.includes(a) ? prev.allergens.filter(x => x !== a) : [...prev.allergens, a] }));

  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[{ label: 'Total Ingredients', value: ingredients.length, color: '#3b82f6' }, { label: 'Low Stock', value: lowStockCount, color: '#eab308' }, { label: 'Out of Stock', value: outCount, color: '#ef4444' }].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}><div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div></div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search ingredients..." style={{ flex: 1, minWidth: 180, padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="all">All Categories</option>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <button onClick={openAdd} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add Ingredient</button>
      </div>
      {loading ? <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading ingredients...</div> : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 80px 70px 80px 100px 90px', padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
            <span>Name</span><span>Category</span><span>Unit</span><span style={{ textAlign: 'right' }}>Cost/Unit</span><span style={{ textAlign: 'right' }}>Yield</span><span style={{ textAlign: 'right' }}>Stock</span><span style={{ textAlign: 'center' }}>Status</span><span style={{ textAlign: 'right' }}>Actions</span>
          </div>
          {filtered.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>{ingredients.length === 0 ? 'No ingredients yet — add your first ingredient.' : 'No ingredients match your search.'}</div>}
          {filtered.map(ing => {
            const status = getStatus(ing); const allergens = getAllergens(ing);
            return (
              <div key={ing.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 80px 70px 80px 100px 90px', padding: '12px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#1a1a2e' }}>{ing.name_en}</div>
                  {ing.name_th && <div style={{ fontSize: 11, color: '#C9A84C', marginTop: 1 }}>{ing.name_th}</div>}
                  {allergens.length > 0 && <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>{allergens.map(a => <span key={a} style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4 }}>{a}</span>)}</div>}
                  {ing.supplier_name && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>📦 {ing.supplier_name}</div>}
                </div>
                <span style={{ fontSize: 12, color: '#555' }}>{ing.category}</span>
                <span style={{ fontSize: 12, color: '#555' }}>{ing.unit}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{Number(ing.cost_per_unit || 0).toFixed(2)}</span>
                <span style={{ textAlign: 'right', color: '#555' }}>{ing.yield_percentage}%</span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: Number(ing.current_stock) <= 0 ? '#ef4444' : '#1a1a2e' }}>{Number(ing.current_stock || 0).toFixed(1)}{ing.unit}</span>
                <div style={{ textAlign: 'center' }}><span style={{ background: status.bg, color: status.color, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>{status.label}</span></div>
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <button onClick={() => openEdit(ing)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Edit</button>
                  <button onClick={() => handleDelete(ing.id)} style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 28, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>{editItem ? '✏️ Edit Ingredient' : '+ New Ingredient'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelStyle}>Name (English) *</label><input value={form.name_en} onChange={e => setForm({ ...form, name_en: e.target.value })} placeholder="e.g. Chicken Breast" style={inputStyle} /></div>
                <div><label style={labelStyle}>Name (Thai)</label><input value={form.name_th} onChange={e => setForm({ ...form, name_th: e.target.value })} placeholder="e.g. อกไก่" style={inputStyle} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelStyle}>Category</label><select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={inputStyle}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label style={labelStyle}>Purchase Unit</label><select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} style={inputStyle}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelStyle}>Cost per Unit (£) *</label><input type="number" step="0.01" value={form.cost_per_unit} onChange={e => setForm({ ...form, cost_per_unit: e.target.value })} placeholder="e.g. 6.00" style={inputStyle} /></div>
                <div><label style={labelStyle}>Yield % (post-prep)</label><input type="number" step="1" min="1" max="100" value={form.yield_percentage} onChange={e => setForm({ ...form, yield_percentage: e.target.value })} placeholder="e.g. 78" style={inputStyle} /></div>
              </div>
              <div style={{ background: '#f0f7ff', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#1e40af' }}>💡 Yield = usable amount after prep. Chicken breast = 78%. Fish sauce = 100%.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelStyle}>Current Stock ({form.unit})</label><input type="number" step="0.1" value={form.current_stock} onChange={e => setForm({ ...form, current_stock: e.target.value })} style={inputStyle} /></div>
                <div><label style={labelStyle}>PAR Level ({form.unit})</label><input type="number" step="0.1" value={form.par_level} onChange={e => setForm({ ...form, par_level: e.target.value })} placeholder="Min before reorder" style={inputStyle} /></div>
              </div>
              <div><label style={labelStyle}>Supplier</label><input value={form.supplier_name} onChange={e => setForm({ ...form, supplier_name: e.target.value })} placeholder="e.g. Wing Yip, Brakes" style={inputStyle} /></div>
              <div>
                <label style={labelStyle}>Allergens (tick all that apply)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ALLERGENS.map(a => { const active = (form.allergens || []).includes(a); return (<button key={a} onClick={() => toggleAllergen(a)} style={{ padding: '4px 10px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: active ? '#fee2e2' : '#f0f0f0', color: active ? '#991b1b' : '#555' }}>{active ? '✓ ' : ''}{a}</button>); })}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{editItem ? 'Save Changes' : 'Add Ingredient'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
