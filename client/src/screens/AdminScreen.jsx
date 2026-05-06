import { useState, useEffect, useRef } from 'react';
import { SERVER_URL } from '../api';
import {
  getAllMenu as getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getItemModifiers, addModifierGroup, addModifierOption,
  deleteModifierGroup, deleteModifier,
  getSettings, updateSettings,
  getDiscountReasons, addDiscountReason, deleteDiscountReason,
  getStaff, addStaff, updateStaff,
  getSummaryReport, getItemSalesReport,
  getCategories, updateCategoryBar, updateCategoryDefaultCourse,
  getSubcategories, addSubcategory, deleteSubcategory,
  getZReportPreview, saveZReport, getZReportHistory, getBills, getBillItems
} from '../api';

const today = new Date().toISOString().split('T')[0];
const getDateRange = (type) => {
  const now = new Date();
  if (type === 'today') return { from: today, to: today };
  if (type === 'weekly') {
    const from = new Date(now); from.setDate(now.getDate() - 7);
    return { from: from.toISOString().split('T')[0], to: today };
  }
  if (type === 'monthly') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: from.toISOString().split('T')[0], to: today };
  }
  return { from: today, to: today };
};

// ─────────────────────────────────────────────
// INVENTORY API HELPERS
// TODO: Move these to api.js once Krit has built the backend endpoints
// ─────────────────────────────────────────────
const invAPI = {
  getIngredients:   ()         => fetch(`${SERVER_URL}/api/ingredients`).then(r => r.ok ? r.json() : []).catch(() => []),
  addIngredient:    (data)     => fetch(`${SERVER_URL}/api/ingredients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  updateIngredient: (id, data) => fetch(`${SERVER_URL}/api/ingredients/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  deleteIngredient: (id)       => fetch(`${SERVER_URL}/api/ingredients/${id}`, { method: 'DELETE' }).then(r => r.json()),
  getRecipes:       ()         => fetch(`${SERVER_URL}/api/recipes`).then(r => r.ok ? r.json() : []).catch(() => []),
  getRecipeForItem: (menuId)   => fetch(`${SERVER_URL}/api/recipes/menu-item/${menuId}`).then(r => r.ok ? r.json() : null).catch(() => null),
  saveRecipe:       (data)     => fetch(`${SERVER_URL}/api/recipes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  updateRecipe:     (id, data) => fetch(`${SERVER_URL}/api/recipes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  getMovements:     ()         => fetch(`${SERVER_URL}/api/stock/movements`).then(r => r.ok ? r.json() : []).catch(() => []),
  addAdjustment:    (data)     => fetch(`${SERVER_URL}/api/stock/adjustment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  // Expenses (overheads, labour, other one-off costs)
  getExpenses:      ()         => fetch(`${SERVER_URL}/api/expenses`).then(r => r.ok ? r.json() : []).catch(() => []),
  addExpense:       (data)     => fetch(`${SERVER_URL}/api/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  deleteExpense:    (id)       => fetch(`${SERVER_URL}/api/expenses/${id}`, { method: 'DELETE' }).then(r => r.json()),
  // Supplier invoices
  saveInvoice:      (data)     => fetch(`${SERVER_URL}/api/supplier-invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
};

// ─────────────────────────────────────────────
// BILLS SECTION
// ─────────────────────────────────────────────
function BillsSection() {
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(new Date().toISOString().split('T')[0]);
  const [to, setTo] = useState(new Date().toISOString().split('T')[0]);
  const [method, setMethod] = useState('all');
  const [selectedBill, setSelectedBill] = useState(null);
  const [billItems, setBillItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const COURSE_LABELS = { 0: 'Bar', 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };

  const fetchBills = async () => {
    setLoading(true);
    try {
      const data = await getBills(from, to, method);
      setBills(Array.isArray(data) ? data : []);
    } catch (err) {
      alert('Failed to load bills!');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBills(); }, []);

  const handleSelectBill = async (bill) => {
    if (selectedBill?.id === bill.id) { setSelectedBill(null); setBillItems([]); return; }
    setSelectedBill(bill);
    setLoadingItems(true);
    try {
      const items = await getBillItems(bill.id);
      setBillItems(Array.isArray(items) ? items : []);
    } catch (err) { setBillItems([]); }
    finally { setLoadingItems(false); }
  };

  const totalSales = bills.reduce((s, b) => s + (b.total || 0), 0);
  const totalCash = bills.filter(b => b.method === 'Cash').reduce((s, b) => s + (b.total || 0), 0);
  const totalCard = bills.filter(b => b.method === 'Card').reduce((s, b) => s + (b.total || 0), 0);

  const formatDateTime = (dt) => {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const itemsByCourse = {};
  billItems.forEach(item => {
    const c = item.course ?? 0;
    if (!itemsByCourse[c]) itemsByCourse[c] = [];
    itemsByCourse[c].push(item);
  });

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>🧾 Bill Records</h1>
      <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From Date</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To Date</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Payment Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
              <option value="all">All Methods</option>
              <option value="Cash">Cash</option>
              <option value="Card">Card</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <button onClick={fetchBills} style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>Search</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Bills', value: bills.length, color: '#3b82f6' },
          { label: 'Total Sales', value: `£${totalSales.toFixed(2)}`, color: '#e94560' },
          { label: 'Cash', value: `£${totalCash.toFixed(2)}`, color: '#22c55e' },
          { label: 'Card', value: `£${totalCard.toFixed(2)}`, color: '#8b5cf6' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      {loading ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading...</div>
      ) : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px', padding: '12px 20px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>
            <span>Bill #</span><span>Table</span><span>Cvr</span><span>Date & Time</span><span>Method</span>
            <span style={{ textAlign: 'right' }}>Discount</span><span style={{ textAlign: 'right' }}>Total</span>
          </div>
          {bills.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No bills found for this period</div>}
          {bills.map(bill => (
            <div key={bill.id}>
              <div onClick={() => handleSelectBill(bill)} style={{
                display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px',
                padding: '12px 20px', borderBottom: selectedBill?.id === bill.id ? 'none' : '1px solid #f0f0f0',
                fontSize: 14, cursor: 'pointer', background: selectedBill?.id === bill.id ? '#f0f7ff' : 'white'
              }}>
                <span style={{ color: '#888', fontWeight: 600 }}>#{bill.id}</span>
                <span style={{ fontWeight: 600 }}>T{bill.table_number}</span>
                <span style={{ color: '#555' }}>{bill.covers || '—'}</span>
                <span style={{ color: '#555' }}>{formatDateTime(bill.closed_at)}</span>
                <span>
                  <span style={{
                    background: bill.method === 'Cash' ? '#dcfce7' : bill.method === 'Card' ? '#dbeafe' : '#f3f4f6',
                    color: bill.method === 'Cash' ? '#14532d' : bill.method === 'Card' ? '#1e40af' : '#374151',
                    padding: '2px 8px', borderRadius: 20, fontSize: 12, fontWeight: 600
                  }}>
                    {bill.method === 'Cash' ? '💵' : bill.method === 'Card' ? '💳' : '🔄'} {bill.method}
                  </span>
                </span>
                <span style={{ textAlign: 'right', color: bill.discount_value > 0 ? '#22c55e' : '#bbb', fontSize: 13 }}>
                  {bill.discount_value > 0 ? bill.discount_type === 'percent' ? `-${bill.discount_value}%` : `-£${bill.discount_value}` : '—'}
                </span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{(bill.total || 0).toFixed(2)}</span>
              </div>
              {selectedBill?.id === bill.id && (
                <div style={{ background: '#f8fbff', padding: '16px 20px', borderBottom: '1px solid #dbeafe', borderLeft: '4px solid #3b82f6' }}>
                  {loadingItems ? (
                    <div style={{ color: '#888', fontSize: 13 }}>Loading items...</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                      <div style={{ flex: 2, minWidth: 280 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af', marginBottom: 10 }}>Order Items</div>
                        {Object.keys(itemsByCourse).sort().map(course => (
                          <div key={course} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>
                              {COURSE_LABELS[course] || `Course ${course}`}
                            </div>
                            {itemsByCourse[course].map(item => (
                              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                                <span style={{ color: '#1a1a2e' }}>
                                  {item.quantity}× {item.name}
                                  {item.notes && <span style={{ color: '#aaa', marginLeft: 6 }}>({item.notes})</span>}
                                  {item.item_note && <span style={{ color: '#3b82f6', marginLeft: 6 }}>📝 {item.item_note}</span>}
                                </span>
                                <span style={{ fontWeight: 600, color: '#1a1a2e', marginLeft: 12 }}>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af', marginBottom: 10 }}>Bill Summary</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {[
                            { label: 'Date', value: formatDateTime(bill.closed_at) },
                            { label: 'Method', value: bill.method },
                            { label: 'Covers', value: bill.covers || '—' },
                            { label: 'Discount', value: bill.discount_value > 0 ? `${bill.discount_type === 'percent' ? bill.discount_value + '%' : '£' + bill.discount_value} (${bill.discount_reason})` : 'None' },
                            { label: 'Amount Paid', value: `£${(bill.paid_amount || 0).toFixed(2)}` },
                          ].map(item => (
                            <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                              <span style={{ color: '#888' }}>{item.label}</span>
                              <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{item.value}</span>
                            </div>
                          ))}
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, paddingTop: 8, borderTop: '2px solid #3b82f6', marginTop: 4 }}>
                            <span>Total</span>
                            <span style={{ color: '#e94560' }}>£{(bill.total || 0).toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {bills.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px', padding: '14px 20px', background: '#f8f8f8', fontWeight: 800, fontSize: 15 }}>
              <span style={{ color: '#555', gridColumn: '1 / 7' }}>Total — {bills.length} bills</span>
              <span style={{ textAlign: 'right', color: '#e94560' }}>£{totalSales.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// INVENTORY SECTION — INGREDIENTS TAB
// ─────────────────────────────────────────────
function IngredientsTab() {
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);

  const emptyForm = { name_en: '', name_th: '', unit: 'kg', cost_per_unit: '', yield_percentage: '100', category: 'Meat', current_stock: '0', par_level: '', supplier_name: '', allergens: [] };
  const [form, setForm] = useState(emptyForm);

  const CATEGORIES = ['Meat', 'Seafood', 'Vegetables', 'Dry Goods', 'Sauces', 'Dairy', 'Other'];
  const UNITS = ['kg', 'g', 'L', 'ml', 'unit'];
  const ALLERGENS = ['Gluten', 'Crustaceans', 'Eggs', 'Fish', 'Peanuts', 'Soybeans', 'Milk', 'Nuts', 'Sesame', 'Molluscs', 'Sulphites', 'Celery', 'Mustard'];

  const load = async () => {
    setLoading(true);
    const data = await invAPI.getIngredients();
    setIngredients(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const getStatus = (ing) => {
    if (!ing.current_stock || Number(ing.current_stock) <= 0) return { label: '🔴 OUT', color: '#ef4444', bg: '#fee2e2' };
    if (ing.par_level && Number(ing.current_stock) < Number(ing.par_level)) return { label: '🟡 LOW', color: '#eab308', bg: '#fef9c3' };
    return { label: '✅ OK', color: '#22c55e', bg: '#dcfce7' };
  };

  const getAllergens = (ing) => {
    try {
      return typeof ing.allergens === 'string' ? JSON.parse(ing.allergens || '[]') : (ing.allergens || []);
    } catch { return []; }
  };

  const filtered = ingredients.filter(ing => {
    const matchSearch = (ing.name_en || '').toLowerCase().includes(search.toLowerCase()) || (ing.name_th || '').toLowerCase().includes(search.toLowerCase());
    const matchCat = filterCat === 'all' || ing.category === filterCat;
    return matchSearch && matchCat;
  });

  const lowStockCount = ingredients.filter(i => i.par_level && Number(i.current_stock) < Number(i.par_level) && Number(i.current_stock) > 0).length;
  const outCount = ingredients.filter(i => !i.current_stock || Number(i.current_stock) <= 0).length;

  const openAdd = () => {
    setEditItem(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (ing) => {
    setEditItem(ing);
    setForm({ ...ing, allergens: getAllergens(ing) });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name_en || !form.cost_per_unit) return alert('Name and cost per unit are required!');
    const payload = { ...form, allergens: JSON.stringify(form.allergens || []) };
    try {
      if (editItem) await invAPI.updateIngredient(editItem.id, payload);
      else await invAPI.addIngredient(payload);
      setShowForm(false);
      load();
    } catch (err) {
      alert('Save failed — has Krit built the inventory backend yet?');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this ingredient? This will affect any recipes that use it.')) return;
    await invAPI.deleteIngredient(id);
    load();
  };

  const toggleAllergen = (a) => {
    setForm(prev => ({
      ...prev,
      allergens: prev.allergens.includes(a) ? prev.allergens.filter(x => x !== a) : [...prev.allergens, a]
    }));
  };

  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 };

  return (
    <div>
      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Ingredients', value: ingredients.length, color: '#3b82f6' },
          { label: 'Low Stock', value: lowStockCount, color: '#eab308' },
          { label: 'Out of Stock', value: outCount, color: '#ef4444' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Search + filter + add */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search ingredients..."
          style={{ flex: 1, minWidth: 180, padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}
        />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
          <option value="all">All Categories</option>
          {['Meat', 'Seafood', 'Vegetables', 'Dry Goods', 'Sauces', 'Dairy', 'Other'].map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button onClick={openAdd} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          + Add Ingredient
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading ingredients...</div>
      ) : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 80px 70px 80px 100px 90px', padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
            <span>Name</span>
            <span>Category</span>
            <span>Unit</span>
            <span style={{ textAlign: 'right' }}>Cost/Unit</span>
            <span style={{ textAlign: 'right' }}>Yield</span>
            <span style={{ textAlign: 'right' }}>Stock</span>
            <span style={{ textAlign: 'center' }}>Status</span>
            <span style={{ textAlign: 'right' }}>Actions</span>
          </div>
          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>
              {ingredients.length === 0 ? 'No ingredients yet — add your first ingredient or wait for Krit to seed the database.' : 'No ingredients match your search.'}
            </div>
          )}
          {filtered.map(ing => {
            const status = getStatus(ing);
            const allergens = getAllergens(ing);
            return (
              <div key={ing.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 80px 70px 80px 100px 90px', padding: '12px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#1a1a2e' }}>{ing.name_en}</div>
                  {ing.name_th && <div style={{ fontSize: 11, color: '#C9A84C', marginTop: 1 }}>{ing.name_th}</div>}
                  {allergens.length > 0 && (
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
                      {allergens.map(a => (
                        <span key={a} style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4 }}>{a}</span>
                      ))}
                    </div>
                  )}
                  {ing.supplier_name && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>📦 {ing.supplier_name}</div>}
                </div>
                <span style={{ fontSize: 12, color: '#555' }}>{ing.category}</span>
                <span style={{ fontSize: 12, color: '#555' }}>{ing.unit}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{Number(ing.cost_per_unit || 0).toFixed(2)}</span>
                <span style={{ textAlign: 'right', color: '#555' }}>{ing.yield_percentage}%</span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: Number(ing.current_stock) <= 0 ? '#ef4444' : '#1a1a2e' }}>
                  {Number(ing.current_stock || 0).toFixed(1)}{ing.unit}
                </span>
                <div style={{ textAlign: 'center' }}>
                  <span style={{ background: status.bg, color: status.color, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                    {status.label}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <button onClick={() => openEdit(ing)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Edit</button>
                  <button onClick={() => handleDelete(ing.id)} style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 28, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>{editItem ? '✏️ Edit Ingredient' : '+ New Ingredient'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Name (English) *</label>
                  <input value={form.name_en} onChange={e => setForm({ ...form, name_en: e.target.value })} placeholder="e.g. Chicken Breast" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Name (Thai)</label>
                  <input value={form.name_th} onChange={e => setForm({ ...form, name_th: e.target.value })} placeholder="e.g. อกไก่" style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Category</label>
                  <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={inputStyle}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Purchase Unit</label>
                  <select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} style={inputStyle}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Cost per Unit (£) *</label>
                  <input type="number" step="0.01" value={form.cost_per_unit} onChange={e => setForm({ ...form, cost_per_unit: e.target.value })} placeholder="e.g. 6.00" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Yield % (post-prep)</label>
                  <input type="number" step="1" min="1" max="100" value={form.yield_percentage} onChange={e => setForm({ ...form, yield_percentage: e.target.value })} placeholder="e.g. 78" style={inputStyle} />
                </div>
              </div>
              <div style={{ background: '#f0f7ff', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#1e40af' }}>
                💡 Yield = usable amount after prep. Chicken breast = 78% (trim + skin removal). Fish sauce = 100% (no prep loss).
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Current Stock ({form.unit})</label>
                  <input type="number" step="0.1" value={form.current_stock} onChange={e => setForm({ ...form, current_stock: e.target.value })} placeholder="0" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>PAR Level ({form.unit})</label>
                  <input type="number" step="0.1" value={form.par_level} onChange={e => setForm({ ...form, par_level: e.target.value })} placeholder="Min before reorder" style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Supplier</label>
                <input value={form.supplier_name} onChange={e => setForm({ ...form, supplier_name: e.target.value })} placeholder="e.g. Wing Yip, Brakes" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Allergens (tick all that apply)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ALLERGENS.map(a => {
                    const active = (form.allergens || []).includes(a);
                    return (
                      <button key={a} onClick={() => toggleAllergen(a)} style={{
                        padding: '4px 10px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: active ? '#fee2e2' : '#f0f0f0',
                        color: active ? '#991b1b' : '#555',
                      }}>{active ? '✓ ' : ''}{a}</button>
                    );
                  })}
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

// ─────────────────────────────────────────────
// INVENTORY SECTION — RECIPES TAB
// ─────────────────────────────────────────────

// Food cost calculation helpers
const calcLineCost = (qty, costPerUnit, yieldPct) => {
  const q = parseFloat(qty) || 0;
  const c = parseFloat(costPerUnit) || 0;
  const y = parseFloat(yieldPct) || 100;
  if (!q || !c) return 0;
  return (q * c) / (y / 100);
};

const fcBadge = (pct) => {
  if (!pct || pct <= 0) return { color: '#888', bg: '#f0f0f0', label: '—' };
  if (pct < 35) return { color: '#22c55e', bg: '#dcfce7', label: `${pct.toFixed(1)}% ✅` };
  if (pct < 42) return { color: '#eab308', bg: '#fef9c3', label: `${pct.toFixed(1)}% 🟡` };
  return { color: '#ef4444', bg: '#fee2e2', label: `${pct.toFixed(1)}% 🔴` };
};

function RecipesTab() {
  const [menuItems, setMenuItems] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [recipe, setRecipe] = useState(null);
  const [lines, setLines] = useState([]);
  const [serves, setServes] = useState(1);
  const [saving, setSaving] = useState(false);
  const [allRecipes, setAllRecipes] = useState([]);

  // new line form state
  const [newLine, setNewLine] = useState({ ingredient_id: '', quantity_used: '', unit: 'kg' });

  useEffect(() => {
    Promise.all([getMenu(), invAPI.getIngredients(), invAPI.getRecipes()]).then(([menu, ings, recs]) => {
      const flatItems = (Array.isArray(menu) ? menu : []).flatMap(cat => cat.items || []);
      setMenuItems(flatItems);
      setIngredients(Array.isArray(ings) ? ings : []);
      setAllRecipes(Array.isArray(recs) ? recs : []);
    });
  }, []);

  const loadRecipe = async (item) => {
    setSelectedItem(item);
    setLines([]);
    setRecipe(null);
    setServes(1);
    setNewLine({ ingredient_id: '', quantity_used: '', unit: 'kg' });
    const data = await invAPI.getRecipeForItem(item.id);
    if (data) {
      setRecipe(data);
      setLines(data.lines || []);
      setServes(data.serves || 1);
    }
  };

  const recipeForItem = (itemId) => allRecipes.find(r => r.menu_item_id === itemId);

  const addLine = () => {
    if (!newLine.ingredient_id || !newLine.quantity_used) return alert('Select an ingredient and enter a quantity');
    const ing = ingredients.find(i => i.id === Number(newLine.ingredient_id));
    if (!ing) return;
    const lineCost = calcLineCost(newLine.quantity_used, ing.cost_per_unit, ing.yield_percentage);
    setLines(prev => [...prev, {
      ingredient_id: Number(newLine.ingredient_id),
      ingredient_name: ing.name_en,
      ingredient_name_th: ing.name_th,
      quantity_used: Number(newLine.quantity_used),
      unit: newLine.unit || ing.unit,
      cost_per_unit: ing.cost_per_unit,
      yield_percentage: ing.yield_percentage,
      line_cost: lineCost,
    }]);
    setNewLine({ ingredient_id: '', quantity_used: '', unit: 'kg' });
  };

  const removeLine = (index) => {
    setLines(prev => prev.filter((_, i) => i !== index));
  };

  const totalCost = lines.reduce((sum, l) => sum + (l.line_cost || 0), 0);
  const costPerPortion = serves > 0 ? totalCost / serves : 0;
  const menuPrice = selectedItem ? Number(selectedItem.price) : 0;
  const foodCostPct = menuPrice > 0 ? (costPerPortion / menuPrice) * 100 : 0;
  const grossProfit = menuPrice - costPerPortion;

  const fc = fcBadge(foodCostPct);

  const handleSave = async () => {
    if (!selectedItem) return;
    if (lines.length === 0) return alert('Add at least one ingredient to the recipe');
    setSaving(true);
    try {
      const payload = { menu_item_id: selectedItem.id, name: selectedItem.name, serves, lines };
      if (recipe?.id) await invAPI.updateRecipe(recipe.id, payload);
      else await invAPI.saveRecipe(payload);
      const recs = await invAPI.getRecipes();
      setAllRecipes(Array.isArray(recs) ? recs : []);
      alert('Recipe saved!');
    } catch (err) {
      alert('Save failed — has Krit built the recipes backend yet?');
    } finally {
      setSaving(false);
    }
  };

  const UNITS = ['kg', 'g', 'L', 'ml', 'unit'];

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* Left panel — menu item list */}
      <div style={{ width: 280, flexShrink: 0 }}>
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>
            Menu Items ({menuItems.length})
          </div>
          {menuItems.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#bbb', fontSize: 13 }}>No menu items found</div>
          )}
          {menuItems.map(item => {
            const rec = recipeForItem(item.id);
            const isSelected = selectedItem?.id === item.id;
            return (
              <div key={item.id} onClick={() => loadRecipe(item)} style={{
                padding: '12px 16px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
                background: isSelected ? '#f0f7ff' : 'white',
                borderLeft: isSelected ? '4px solid #3b82f6' : '4px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#1a1a2e' }}>{item.name}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e94560' }}>£{Number(item.price).toFixed(2)}</span>
                  {rec ? (
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                      background: fcBadge(rec.food_cost_pct).bg,
                      color: fcBadge(rec.food_cost_pct).color
                    }}>{rec.food_cost_pct ? `${Number(rec.food_cost_pct).toFixed(1)}%` : 'Has recipe'}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#eab308', fontWeight: 700 }}>⚠️ No recipe</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — recipe builder */}
      <div style={{ flex: 1 }}>
        {!selectedItem ? (
          <div style={{ background: 'white', borderRadius: 12, padding: 40, textAlign: 'center', color: '#bbb', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>Select a dish to build its recipe</div>
            <div style={{ fontSize: 13 }}>Click any item from the left panel to start costing</div>
          </div>
        ) : (
          <div>
            {/* Dish header */}
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>{selectedItem.name}</div>
                  {selectedItem.name_alt && <div style={{ fontSize: 13, color: '#C9A84C', marginTop: 2 }}>{selectedItem.name_alt}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#e94560' }}>£{Number(selectedItem.price).toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: '#888' }}>menu price</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>Recipe makes</label>
                <input type="number" min="1" value={serves} onChange={e => setServes(Number(e.target.value))} style={{ width: 60, padding: '6px 8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, textAlign: 'center' }} />
                <span style={{ fontSize: 13, color: '#888' }}>portion(s)</span>
              </div>
            </div>

            {/* Ingredient lines */}
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 36px', padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
                <span>Ingredient</span>
                <span style={{ textAlign: 'right' }}>Qty</span>
                <span style={{ textAlign: 'center' }}>Unit</span>
                <span style={{ textAlign: 'right' }}>Line Cost</span>
                <span></span>
              </div>
              {lines.length === 0 && (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: '#bbb', fontSize: 13 }}>No ingredients added yet</div>
              )}
              {lines.map((line, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 36px', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: '#1a1a2e' }}>{line.ingredient_name}</div>
                    {line.ingredient_name_th && <div style={{ fontSize: 11, color: '#C9A84C' }}>{line.ingredient_name_th}</div>}
                    <div style={{ fontSize: 10, color: '#aaa' }}>yield {line.yield_percentage}% · £{Number(line.cost_per_unit).toFixed(2)}/{line.unit}</div>
                  </div>
                  <span style={{ textAlign: 'right', color: '#555' }}>{line.quantity_used}</span>
                  <span style={{ textAlign: 'center', color: '#555' }}>{line.unit}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{Number(line.line_cost).toFixed(2)}</span>
                  <button onClick={() => removeLine(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
                </div>
              ))}

              {/* Add new ingredient row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 36px', padding: '10px 16px', borderTop: '2px dashed #e0e0e0', gap: 6, alignItems: 'center' }}>
                <select value={newLine.ingredient_id} onChange={e => {
                  const ing = ingredients.find(i => i.id === Number(e.target.value));
                  setNewLine({ ...newLine, ingredient_id: e.target.value, unit: ing?.unit || 'kg' });
                }} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}>
                  <option value="">— Select ingredient —</option>
                  {ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name_en}</option>)}
                </select>
                <input type="number" step="0.001" value={newLine.quantity_used} onChange={e => setNewLine({ ...newLine, quantity_used: e.target.value })} placeholder="Qty" style={{ padding: '7px 8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, textAlign: 'right' }} />
                <select value={newLine.unit} onChange={e => setNewLine({ ...newLine, unit: e.target.value })} style={{ padding: '7px 6px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}>
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <button onClick={addLine} style={{ padding: '7px 10px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>+ Add</button>
                <div />
              </div>
            </div>

            {/* Totals + food cost */}
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', marginBottom: 14 }}>Recipe Costing Summary</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: `Total recipe cost (${serves} portion${serves > 1 ? 's' : ''})`, value: `£${totalCost.toFixed(2)}`, color: '#555' },
                  { label: 'Cost per portion', value: `£${costPerPortion.toFixed(2)}`, color: '#1a1a2e', bold: true },
                  { label: 'Menu price', value: `£${menuPrice.toFixed(2)}`, color: '#e94560', bold: true },
                  { label: 'Gross profit per dish', value: `£${grossProfit.toFixed(2)}`, color: grossProfit >= 0 ? '#22c55e' : '#ef4444', bold: true },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                    <span style={{ color: '#555' }}>{row.label}</span>
                    <span style={{ fontWeight: row.bold ? 800 : 400, color: row.color }}>{row.value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 0', marginTop: 4, borderTop: '2px solid #eee' }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>Food Cost %</span>
                  <span style={{ background: fc.bg, color: fc.color, fontWeight: 800, fontSize: 18, padding: '6px 16px', borderRadius: 20 }}>
                    {lines.length > 0 ? fc.label : '—'}
                  </span>
                </div>
                {lines.length > 0 && foodCostPct >= 35 && (
                  <div style={{ background: foodCostPct >= 42 ? '#fee2e2' : '#fef9c3', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: foodCostPct >= 42 ? '#991b1b' : '#713f12' }}>
                    {foodCostPct >= 42
                      ? '🔴 Food cost is too high — review portion sizes, pricing, or ingredient sourcing urgently.'
                      : '🟡 Food cost is above target. Consider adjusting portion or increasing menu price slightly.'}
                  </div>
                )}
              </div>
            </div>

            <button onClick={handleSave} disabled={saving} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: saving ? '#bbb' : '#e94560', color: 'white', fontWeight: 800, fontSize: 16, cursor: saving ? 'default' : 'pointer' }}>
              {saving ? 'Saving...' : '💾 Save Recipe'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// INVENTORY SECTION — STOCK LOG TAB
// ─────────────────────────────────────────────
function StockTab() {
  const [movements, setMovements] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('all');
  const [adjForm, setAdjForm] = useState({ ingredient_id: '', quantity: '', movement_type: 'adjustment', note: '' });
  const [saving, setSaving] = useState(false);

  const MOVEMENT_TYPES = [
    { id: 'all', label: 'All' },
    { id: 'delivery', label: '📦 Delivery' },
    { id: 'used', label: '🍳 Used' },
    { id: 'waste', label: '🗑️ Waste' },
    { id: 'adjustment', label: '✏️ Adjustment' },
  ];

  const loadAll = async () => {
    setLoading(true);
    const [movs, ings] = await Promise.all([invAPI.getMovements(), invAPI.getIngredients()]);
    setMovements(Array.isArray(movs) ? movs : []);
    setIngredients(Array.isArray(ings) ? ings : []);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  const filtered = movements.filter(m => filterType === 'all' || m.movement_type === filterType);

  const typeStyle = (type) => {
    const map = {
      delivery:   { color: '#22c55e', bg: '#dcfce7', label: '📦 Delivery' },
      used:       { color: '#3b82f6', bg: '#dbeafe', label: '🍳 Used' },
      waste:      { color: '#ef4444', bg: '#fee2e2', label: '🗑️ Waste' },
      adjustment: { color: '#8b5cf6', bg: '#ede9fe', label: '✏️ Adjustment' },
    };
    return map[type] || { color: '#888', bg: '#f0f0f0', label: type };
  };

  const handleAdjust = async () => {
    if (!adjForm.ingredient_id || !adjForm.quantity) return alert('Select an ingredient and enter a quantity');
    setSaving(true);
    try {
      await invAPI.addAdjustment(adjForm);
      setAdjForm({ ingredient_id: '', quantity: '', movement_type: 'adjustment', note: '' });
      loadAll();
    } catch (err) {
      alert('Save failed — has Krit built the stock backend yet?');
    } finally {
      setSaving(false);
    }
  };

  const formatDateTime = (dt) => {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div>
      {/* Quick adjustment form */}
      <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📝 Record Stock Movement</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 160 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Ingredient</label>
            <select value={adjForm.ingredient_id} onChange={e => setAdjForm({ ...adjForm, ingredient_id: e.target.value })} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
              <option value="">— Select —</option>
              {ingredients.map(i => <option key={i.id} value={i.id}>{i.name_en}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 90 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Quantity</label>
            <input type="number" step="0.01" value={adjForm.quantity} onChange={e => setAdjForm({ ...adjForm, quantity: e.target.value })} placeholder="+ or –" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
          </div>
          <div style={{ flex: 1, minWidth: 130 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Type</label>
            <select value={adjForm.movement_type} onChange={e => setAdjForm({ ...adjForm, movement_type: e.target.value })} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
              <option value="delivery">📦 Delivery</option>
              <option value="waste">🗑️ Waste</option>
              <option value="adjustment">✏️ Adjustment</option>
            </select>
          </div>
          <div style={{ flex: 2, minWidth: 140 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Note (optional)</label>
            <input value={adjForm.note} onChange={e => setAdjForm({ ...adjForm, note: e.target.value })} placeholder="e.g. Wing Yip delivery" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
          </div>
          <button onClick={handleAdjust} disabled={saving} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {saving ? 'Saving...' : 'Record'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
          💡 Use positive numbers for stock in (deliveries), negative numbers for stock out (waste, adjustments)
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {MOVEMENT_TYPES.map(t => (
          <button key={t.id} onClick={() => setFilterType(t.id)} style={{
            padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            background: filterType === t.id ? '#1a1a2e' : '#e0e0e0',
            color: filterType === t.id ? 'white' : '#555'
          }}>{t.label}</button>
        ))}
      </div>

      {/* Movements log */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading stock movements...</div>
      ) : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 90px 80px 1fr', padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
            <span>Date</span>
            <span>Ingredient</span>
            <span style={{ textAlign: 'center' }}>Type</span>
            <span style={{ textAlign: 'right' }}>Quantity</span>
            <span style={{ paddingLeft: 12 }}>Note</span>
          </div>
          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>
              {movements.length === 0 ? 'No stock movements recorded yet. Use the form above to record deliveries and adjustments.' : 'No movements match this filter.'}
            </div>
          )}
          {filtered.map((m, i) => {
            const ts = typeStyle(m.movement_type);
            const ing = ingredients.find(x => x.id === m.ingredient_id);
            return (
              <div key={m.id || i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 90px 80px 1fr', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                <span style={{ color: '#888', fontSize: 12 }}>{formatDateTime(m.created_at)}</span>
                <div>
                  <div style={{ fontWeight: 600, color: '#1a1a2e' }}>{ing?.name_en || m.ingredient_name || `ID ${m.ingredient_id}`}</div>
                  {ing?.name_th && <div style={{ fontSize: 11, color: '#C9A84C' }}>{ing.name_th}</div>}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <span style={{ background: ts.bg, color: ts.color, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20 }}>{ts.label}</span>
                </div>
                <span style={{ textAlign: 'right', fontWeight: 700, color: Number(m.quantity) >= 0 ? '#22c55e' : '#ef4444' }}>
                  {Number(m.quantity) >= 0 ? '+' : ''}{Number(m.quantity).toFixed(2)}
                </span>
                <span style={{ paddingLeft: 12, color: '#888', fontSize: 12 }}>{m.note || '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// INVENTORY SECTION — INVOICE SCANNER TAB
// ─────────────────────────────────────────────
function InvoiceScannerTab() {
  const [mode, setMode]           = useState('invoice'); // 'invoice' | 'expense'
  const [stage, setStage]         = useState('upload');  // upload | scanning | review | done
  const [file, setFile]           = useState(null);
  const [fileData, setFileData]   = useState(null);
  const [invoiceData, setInvoiceData] = useState({ supplier_name: '', invoice_date: '', invoice_number: '', total_amount: '' });
  const [expenseData, setExpenseData] = useState({ vendor: '', date: today, description: '', category: 'overhead', total_amount: '' });
  const [lineItems, setLineItems] = useState([]);
  const [expLines, setExpLines]   = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [error, setError]         = useState('');
  const [confirming, setConfirming] = useState(false);
  const fileInputRef              = useRef(null);

  useEffect(() => { invAPI.getIngredients().then(d => setIngredients(Array.isArray(d) ? d : [])); }, []);

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setFileData(e.target.result);
    reader.readAsDataURL(f);
  };

  const fuzzyMatch = (extractedName) => {
    const lower = (extractedName || '').toLowerCase();
    let best = null, bestScore = 0;
    for (const ing of ingredients) {
      const ingLower = ing.name_en.toLowerCase();
      let score = 0;
      if (lower.includes(ingLower)) score = 10;
      else if (ingLower.includes(lower.split(' ')[0])) score = 7;
      else ingLower.split(' ').forEach(w => { if (w.length > 3 && lower.includes(w)) score += 3; });
      if (score > bestScore) { bestScore = score; best = ing.id; }
    }
    return bestScore >= 3 ? best : null;
  };

  const resetAll = () => {
    setStage('upload'); setFile(null); setFileData(null); setError('');
    setLineItems([]); setExpLines([]);
    setInvoiceData({ supplier_name: '', invoice_date: '', invoice_number: '', total_amount: '' });
    setExpenseData({ vendor: '', date: today, description: '', category: 'overhead', total_amount: '' });
  };

  const runScan = async () => {
    if (!file || !fileData) return;
    setError(''); setStage('scanning');
    try {
      const base64 = fileData.split(',')[1];
      const media_type = file.type || 'image/jpeg';
      const endpoint = mode === 'invoice' ? '/api/ai/scan-invoice' : '/api/ai/scan-expense';

      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, media_type }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');

      if (mode === 'invoice') {
        const inv = data.invoice;
        setInvoiceData({ supplier_name: inv.supplier_name || '', invoice_date: inv.invoice_date || '', invoice_number: inv.invoice_number || '', total_amount: inv.total_amount || 0 });
        setLineItems((inv.line_items || []).map(item => ({
          name_extracted: item.name || '',
          quantity: item.quantity || 0,
          unit: item.unit || 'kg',
          unit_price: item.unit_price || 0,
          line_total: item.line_total || (item.quantity * item.unit_price) || 0,
          matched_ingredient_id: fuzzyMatch(item.name),
        })));
      } else {
        const exp = data.expense;
        setExpenseData({ vendor: exp.vendor || '', date: exp.date || today, description: exp.description || '', category: exp.category || 'overhead', total_amount: exp.total_amount || 0 });
        setExpLines(exp.line_items || []);
      }
      setStage('review');
    } catch (err) {
      setError(err.message || 'Scan failed — check backend is running');
      setStage('upload');
    }
  };

  const setMatch = (index, ingredientId) => {
    setLineItems(prev => prev.map((l, i) => i === index ? { ...l, matched_ingredient_id: ingredientId ? Number(ingredientId) : null } : l));
  };

  const confirmInvoice = async () => {
    const matched = lineItems.filter(l => l.matched_ingredient_id);
    if (matched.length === 0) return alert('Match at least one ingredient to record.');
    setConfirming(true);
    try {
      for (const item of matched) {
        await invAPI.addAdjustment({ ingredient_id: item.matched_ingredient_id, quantity: item.quantity, movement_type: 'delivery', cost_at_time: item.unit_price, note: `Invoice ${invoiceData.invoice_number} — ${invoiceData.supplier_name}`.trim() });
      }
      await invAPI.saveInvoice({ ...invoiceData, status: 'processed' });
      setStage('done');
    } catch (err) { alert('Record failed — is the backend running?'); }
    finally { setConfirming(false); }
  };

  const confirmExpense = async () => {
    if (!expenseData.description || !expenseData.total_amount) return alert('Description and amount are required.');
    setConfirming(true);
    try {
      await invAPI.addExpense({ category: expenseData.category, description: `${expenseData.vendor ? expenseData.vendor + ' — ' : ''}${expenseData.description}`, amount: expenseData.total_amount, date: expenseData.date });
      setStage('done');
    } catch (err) { alert('Record failed — is the backend running?'); }
    finally { setConfirming(false); }
  };

  const unmatchedCount = lineItems.filter(l => !l.matched_ingredient_id).length;
  const matchedCount   = lineItems.filter(l =>  l.matched_ingredient_id).length;

  // ── Shared upload area ──
  const uploadArea = (
    <div style={{ maxWidth: 580 }}>
      <div style={{ background: mode === 'invoice' ? '#f0f7ff' : '#fff8f0', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: mode === 'invoice' ? '#1e40af' : '#92400e', border: `1px solid ${mode === 'invoice' ? '#bfdbfe' : '#fed7aa'}` }}>
        {mode === 'invoice'
          ? '💡 Photo your supplier delivery note or invoice. AI reads every line item and matches to your ingredients.'
          : '💡 Photo any receipt, bill or expense document. AI extracts the cost and auto-categorises it.'}
      </div>
      {error && <div style={{ background: '#fee2e2', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>⚠️ {error}</div>}
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
        style={{ border: `2px dashed ${file ? '#22c55e' : '#1a1a2e'}`, borderRadius: 16, padding: '44px 24px', textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: file ? '#f0fdf4' : 'white' }}
      >
        <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        {file ? (
          <div>
            {file.type.startsWith('image/') && fileData && <img src={fileData} alt="preview" style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 8, marginBottom: 12, objectFit: 'contain' }} />}
            <div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div>
            <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 44, marginBottom: 12 }}>{mode === 'invoice' ? '🧾' : '🧾'}</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop {mode === 'invoice' ? 'invoice' : 'receipt'} photo here or click</div>
            <div style={{ color: '#888', fontSize: 13 }}>JPG, PNG or PDF · Phone photo is fine</div>
          </div>
        )}
      </div>
      <button onClick={runScan} disabled={!file} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: file ? '#1a1a2e' : '#ddd', color: file ? 'white' : '#aaa', fontWeight: 700, fontSize: 16, cursor: file ? 'pointer' : 'not-allowed' }}>
        🤖 Scan with AI
      </button>
    </div>
  );

  return (
    <div>
      {/* Mode switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[
          { id: 'invoice', label: '📦 Supplier Invoice', desc: 'Records stock + delivery' },
          { id: 'expense', label: '🏢 Expense / Receipt', desc: 'Records overhead cost' },
        ].map(m => (
          <button key={m.id} onClick={() => { setMode(m.id); resetAll(); }} style={{
            flex: 1, padding: '12px 16px', borderRadius: 12, border: 'none', cursor: 'pointer', textAlign: 'left',
            background: mode === m.id ? '#1a1a2e' : 'white',
            color: mode === m.id ? 'white' : '#555',
            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{m.label}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{m.desc}</div>
          </button>
        ))}
      </div>

      {/* ── UPLOAD ── */}
      {stage === 'upload' && uploadArea}

      {/* ── SCANNING ── */}
      {stage === 'scanning' && (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{ width: 56, height: 56, border: '5px solid #f0f0f0', borderTop: '5px solid #1a1a2e', borderRadius: '50%', margin: '0 auto 24px', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>
            {mode === 'invoice' ? 'Reading invoice…' : 'Reading receipt…'}
          </div>
          <div style={{ color: '#888', fontSize: 14 }}>AI is extracting {mode === 'invoice' ? 'supplier, items, quantities and prices' : 'vendor, amount and category'}</div>
        </div>
      )}

      {/* ── REVIEW — INVOICE ── */}
      {stage === 'review' && mode === 'invoice' && (
        <div>
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📄 Invoice Details — confirm or correct</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 12 }}>
              {[
                { label: 'Supplier', key: 'supplier_name', placeholder: 'e.g. Wing Yip' },
                { label: 'Date', key: 'invoice_date', type: 'date' },
                { label: 'Invoice #', key: 'invoice_number', placeholder: 'e.g. INV-001' },
                { label: 'Total (£)', key: 'total_amount', type: 'number', placeholder: '0.00' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>{f.label}</label>
                  <input type={f.type || 'text'} value={invoiceData[f.key]} onChange={e => setInvoiceData(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>
          </div>
          {unmatchedCount > 0 && (
            <div style={{ background: '#fef9c3', borderRadius: 10, padding: '10px 16px', marginBottom: 12, border: '1px solid #fde047', fontSize: 13, color: '#713f12' }}>
              ⚠️ <strong>{unmatchedCount} item{unmatchedCount !== 1 ? 's' : ''} not matched</strong> — assign them below or leave blank to skip.
            </div>
          )}
          <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 60px 80px 80px 1fr', padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
              <span>As on Invoice</span><span style={{ textAlign: 'right' }}>Qty</span><span style={{ textAlign: 'center' }}>Unit</span>
              <span style={{ textAlign: 'right' }}>Unit £</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ paddingLeft: 12 }}>Match to Ingredient</span>
            </div>
            {lineItems.map((item, i) => {
              const isUnmatched = !item.matched_ingredient_id;
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 60px 80px 80px 1fr', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center', background: isUnmatched ? '#fffbeb' : 'white' }}>
                  <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{item.name_extracted}</span>
                  <span style={{ textAlign: 'right', color: '#555' }}>{item.quantity}</span>
                  <span style={{ textAlign: 'center', color: '#555' }}>{item.unit}</span>
                  <span style={{ textAlign: 'right', color: '#555' }}>£{Number(item.unit_price).toFixed(2)}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>£{Number(item.line_total).toFixed(2)}</span>
                  <div style={{ paddingLeft: 12 }}>
                    <select value={item.matched_ingredient_id || ''} onChange={e => setMatch(i, e.target.value || null)}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 8, fontSize: 13, border: `2px solid ${isUnmatched ? '#fde047' : '#22c55e'}`, background: isUnmatched ? '#fffbeb' : '#f0fdf4', color: isUnmatched ? '#713f12' : '#14532d' }}>
                      <option value="">⚠️ No match — select manually</option>
                      {ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name_en}</option>)}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, fontSize: 13, color: '#555' }}>
              <span style={{ color: '#22c55e', fontWeight: 700 }}>✅ {matchedCount} matched</span>
              {unmatchedCount > 0 && <span style={{ color: '#eab308', fontWeight: 700, marginLeft: 10 }}>⚠️ {unmatchedCount} will be skipped</span>}
            </div>
            <button onClick={resetAll} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Re-scan</button>
            <button onClick={confirmInvoice} disabled={confirming || matchedCount === 0} style={{ padding: '12px 28px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: confirming || matchedCount === 0 ? 'default' : 'pointer', background: confirming || matchedCount === 0 ? '#ddd' : '#1a1a2e', color: 'white' }}>
              {confirming ? 'Recording...' : `✓ Confirm & Record ${matchedCount} Item${matchedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {/* ── REVIEW — EXPENSE ── */}
      {stage === 'review' && mode === 'expense' && (
        <div>
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>🧾 Expense Details — confirm or correct</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Vendor / Source</label>
                <input value={expenseData.vendor} onChange={e => setExpenseData(p => ({ ...p, vendor: e.target.value }))} placeholder="e.g. BG Gas" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Date</label>
                <input type="date" value={expenseData.date} onChange={e => setExpenseData(p => ({ ...p, date: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Category</label>
                <select value={expenseData.category} onChange={e => setExpenseData(p => ({ ...p, category: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                  <option value="overhead">🏢 Overhead</option>
                  <option value="labour">👥 Labour</option>
                  <option value="other">📌 Other</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Total Amount (£)</label>
                <input type="number" step="0.01" value={expenseData.total_amount} onChange={e => setExpenseData(p => ({ ...p, total_amount: e.target.value }))} placeholder="0.00" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Description</label>
              <input value={expenseData.description} onChange={e => setExpenseData(p => ({ ...p, description: e.target.value }))} placeholder="e.g. Monthly gas bill, Cleaning supplies, Agency staff" style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
            </div>
          </div>
          {expLines.length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <div style={{ padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>Line Items on Receipt</div>
              {expLines.map((l, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
                  <span style={{ color: '#555' }}>{l.description}</span>
                  <span style={{ fontWeight: 700 }}>£{Number(l.amount).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={resetAll} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Re-scan</button>
            <button onClick={confirmExpense} disabled={confirming} style={{ padding: '12px 28px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: confirming ? 'default' : 'pointer', background: confirming ? '#ddd' : '#e94560', color: 'white' }}>
              {confirming ? 'Saving...' : `✓ Save Expense £${Number(expenseData.total_amount).toFixed(2)}`}
            </button>
          </div>
        </div>
      )}

      {/* ── DONE ── */}
      {stage === 'done' && (
        <div style={{ maxWidth: 480, textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginBottom: 8 }}>
            {mode === 'invoice' ? 'Invoice Recorded!' : 'Expense Saved!'}
          </div>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>
            {mode === 'invoice'
              ? `${matchedCount} delivery movement${matchedCount !== 1 ? 's' : ''} recorded in Stock Log`
              : `£${Number(expenseData.total_amount).toFixed(2)} added to Cost vs Sales`}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
            <button onClick={resetAll} style={{ padding: '12px 24px', borderRadius: 10, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
              📷 Scan Another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

  useEffect(() => { invAPI.getIngredients().then(d => setIngredients(Array.isArray(d) ? d : [])); }, []);

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setFileData(e.target.result);
    reader.readAsDataURL(f);
  };

  // Simple fuzzy match: check if extracted name contains ingredient name or vice versa
  const fuzzyMatch = (extractedName) => {
    const lower = (extractedName || '').toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const ing of ingredients) {
      const ingLower = ing.name_en.toLowerCase();
      const words = ingLower.split(' ');
      let score = 0;
      if (lower.includes(ingLower)) score = 10;
      else if (ingLower.includes(lower.split(' ')[0])) score = 7;
      else { words.forEach(w => { if (w.length > 3 && lower.includes(w)) score += 3; }); }
      if (score > bestScore) { bestScore = score; best = ing.id; }
    }
    return bestScore >= 3 ? best : null;
  };

  const runScan = async () => {
    if (!file || !fileData) return;
    setError('');
    setStage('scanning');
    try {
      const base64 = fileData.split(',')[1];
      const media_type = file.type || 'image/jpeg';
      const res = await fetch(`${SERVER_URL}/api/ai/scan-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, media_type }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');
      const inv = data.invoice;
      setInvoiceData({
        supplier_name: inv.supplier_name || '',
        invoice_date:  inv.invoice_date  || '',
        invoice_number: inv.invoice_number || '',
        total_amount:  inv.total_amount  || 0,
      });
      const matched = (inv.line_items || []).map(item => ({
        name_extracted:       item.name       || '',
        quantity:             item.quantity   || 0,
        unit:                 item.unit       || 'kg',
        unit_price:           item.unit_price || 0,
        line_total:           item.line_total || (item.quantity * item.unit_price) || 0,
        matched_ingredient_id: fuzzyMatch(item.name),
      }));
      setLineItems(matched);
      setStage('review');
    } catch (err) {
      setError(err.message || 'Scan failed — try again');
      setStage('upload');
    }
  };

  const setMatch = (index, ingredientId) => {
    setLineItems(prev => prev.map((l, i) => i === index ? { ...l, matched_ingredient_id: ingredientId ? Number(ingredientId) : null } : l));
  };

  const confirmAndRecord = async () => {
    const matched = lineItems.filter(l => l.matched_ingredient_id);
    if (matched.length === 0) return alert('No matched items to record — please match at least one ingredient.');
    setConfirming(true);
    try {
      for (const item of matched) {
        await invAPI.addAdjustment({
          ingredient_id:  item.matched_ingredient_id,
          quantity:       item.quantity,
          movement_type:  'delivery',
          cost_at_time:   item.unit_price,
          note: `Invoice ${invoiceData.invoice_number} — ${invoiceData.supplier_name}`.trim(),
        });
      }
      await invAPI.saveInvoice({ ...invoiceData, status: 'processed' });
      setStage('done');
    } catch (err) {
      alert('Record failed — has Krit built the invoice backend yet?');
    } finally {
      setConfirming(false);
    }
  };

  const unmatchedCount = lineItems.filter(l => !l.matched_ingredient_id).length;
  const matchedCount   = lineItems.filter(l =>  l.matched_ingredient_id).length;

  return (
    <div>
      {/* ── UPLOAD ── */}
      {stage === 'upload' && (
        <div style={{ maxWidth: 600 }}>
          <div style={{ background: '#f0f7ff', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#1e40af' }}>
            💡 Take a photo of any supplier invoice or delivery note. AI will read every line item and match it to your ingredients automatically.
          </div>
          {error && (
            <div style={{ background: '#fee2e2', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>⚠️ {error}</div>
          )}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
            style={{ border: `2px dashed ${file ? '#22c55e' : '#1a1a2e'}`, borderRadius: 16, padding: '48px 24px', textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: file ? '#f0fdf4' : 'white' }}
          >
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            {file ? (
              <div>
                {file.type.startsWith('image/') && fileData && (
                  <img src={fileData} alt="preview" style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 8, marginBottom: 12, objectFit: 'contain' }} />
                )}
                <div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div>
                <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🧾</div>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop invoice photo here or click to upload</div>
                <div style={{ color: '#888', fontSize: 13 }}>JPG, PNG or PDF · Phone photo is fine</div>
              </div>
            )}
          </div>
          <button onClick={runScan} disabled={!file} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: file ? '#1a1a2e' : '#ddd', color: file ? 'white' : '#aaa', fontWeight: 700, fontSize: 16, cursor: file ? 'pointer' : 'not-allowed' }}>
            🤖 Scan Invoice with AI
          </button>
        </div>
      )}

      {/* ── SCANNING ── */}
      {stage === 'scanning' && (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{ width: 56, height: 56, border: '5px solid #f0f0f0', borderTop: '5px solid #1a1a2e', borderRadius: '50%', margin: '0 auto 24px', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>Reading your invoice…</div>
          <div style={{ color: '#888', fontSize: 14 }}>AI is extracting supplier, items, quantities and prices</div>
        </div>
      )}

      {/* ── REVIEW ── */}
      {stage === 'review' && (
        <div>
          {/* Invoice header — editable */}
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📄 Invoice Details — confirm or correct</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              {[
                { label: 'Supplier Name', key: 'supplier_name', placeholder: 'e.g. Wing Yip' },
                { label: 'Invoice Date',  key: 'invoice_date',  placeholder: 'YYYY-MM-DD', type: 'date' },
                { label: 'Invoice #',     key: 'invoice_number', placeholder: 'e.g. INV-001' },
                { label: 'Total (£)',     key: 'total_amount',  placeholder: '0.00', type: 'number' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>{f.label}</label>
                  <input
                    type={f.type || 'text'}
                    value={invoiceData[f.key]}
                    onChange={e => setInvoiceData(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Match status banner */}
          {unmatchedCount > 0 && (
            <div style={{ background: '#fef9c3', borderRadius: 10, padding: '10px 16px', marginBottom: 12, border: '1px solid #fde047', fontSize: 13, color: '#713f12' }}>
              ⚠️ <strong>{unmatchedCount} item{unmatchedCount > 1 ? 's' : ''} not matched</strong> — use the dropdown to assign them manually, or leave blank to skip.
            </div>
          )}

          {/* Line items table */}
          <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 60px 80px 80px 1fr', padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>
              <span>As on Invoice</span>
              <span style={{ textAlign: 'right' }}>Qty</span>
              <span style={{ textAlign: 'center' }}>Unit</span>
              <span style={{ textAlign: 'right' }}>Unit £</span>
              <span style={{ textAlign: 'right' }}>Total</span>
              <span style={{ paddingLeft: 12 }}>Match to Ingredient</span>
            </div>
            {lineItems.map((item, i) => {
              const isUnmatched = !item.matched_ingredient_id;
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr 70px 60px 80px 80px 1fr',
                  padding: '10px 16px', borderBottom: '1px solid #f0f0f0',
                  fontSize: 13, alignItems: 'center',
                  background: isUnmatched ? '#fffbeb' : 'white',
                }}>
                  <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{item.name_extracted}</span>
                  <span style={{ textAlign: 'right', color: '#555' }}>{item.quantity}</span>
                  <span style={{ textAlign: 'center', color: '#555' }}>{item.unit}</span>
                  <span style={{ textAlign: 'right', color: '#555' }}>£{Number(item.unit_price).toFixed(2)}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>£{Number(item.line_total).toFixed(2)}</span>
                  <div style={{ paddingLeft: 12 }}>
                    <select
                      value={item.matched_ingredient_id || ''}
                      onChange={e => setMatch(i, e.target.value || null)}
                      style={{
                        width: '100%', padding: '6px 8px', borderRadius: 8, fontSize: 13,
                        border: `2px solid ${isUnmatched ? '#fde047' : '#22c55e'}`,
                        background: isUnmatched ? '#fffbeb' : '#f0fdf4',
                        color: isUnmatched ? '#713f12' : '#14532d',
                      }}
                    >
                      <option value="">⚠️ No match — select manually</option>
                      {ingredients.map(ing => (
                        <option key={ing.id} value={ing.id}>{ing.name_en}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Confirm row */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, fontSize: 13, color: '#555' }}>
              <span style={{ color: '#22c55e', fontWeight: 700 }}>✅ {matchedCount} matched</span>
              {unmatchedCount > 0 && <span style={{ color: '#eab308', fontWeight: 700, marginLeft: 10 }}>⚠️ {unmatchedCount} unmatched (will be skipped)</span>}
            </div>
            <button onClick={() => { setStage('upload'); setFile(null); setFileData(null); }} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>
              ↩ Re-scan
            </button>
            <button onClick={confirmAndRecord} disabled={confirming || matchedCount === 0} style={{
              padding: '12px 28px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: confirming ? 'default' : 'pointer',
              background: confirming || matchedCount === 0 ? '#ddd' : '#1a1a2e', color: 'white'
            }}>
              {confirming ? 'Recording...' : `✓ Confirm & Record ${matchedCount} Item${matchedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {/* ── DONE ── */}
      {stage === 'done' && (
        <div style={{ maxWidth: 500, textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginBottom: 8 }}>Invoice Recorded!</div>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>
            Supplier: <strong>{invoiceData.supplier_name || '—'}</strong> · Invoice: <strong>{invoiceData.invoice_number || '—'}</strong>
          </div>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 28 }}>
            {matchedCount} stock movement{matchedCount !== 1 ? 's' : ''} recorded as deliveries
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => { setStage('upload'); setFile(null); setFileData(null); setLineItems([]); setInvoiceData({ supplier_name: '', invoice_date: '', invoice_number: '', total_amount: '' }); }}
              style={{ padding: '12px 24px', borderRadius: 10, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
              📷 Scan Another Invoice
            </button>
          </div>
        </div>
      )}
    </div>
  );

  

// ─────────────────────────────────────────────
// INVENTORY SECTION — COST VS SALES TAB
// ─────────────────────────────────────────────
function CostSalesTab() {
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [revenue, setRevenue] = useState(null);
  const [movements, setMovements] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expForm, setExpForm] = useState({ category: 'overhead', description: '', amount: '', date: today });
  const [savingExp, setSavingExp] = useState(false);
  const [activeExpSection, setActiveExpSection] = useState(true);

  const loadData = async () => {
    setLoading(true);
    const [rev, movs, exps] = await Promise.all([
      getSummaryReport(from, to),
      invAPI.getMovements(),
      invAPI.getExpenses(),
    ]);
    setRevenue(rev);
    setMovements(Array.isArray(movs) ? movs : []);
    setExpenses(Array.isArray(exps) ? exps : []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  // COGS: sum delivery movements within date range
  const cogsMovements = movements.filter(m => {
    if (m.movement_type !== 'delivery') return false;
    if (!m.created_at) return false;
    const d = m.created_at.split('T')[0];
    return d >= from && d <= to;
  });
  const cogs = cogsMovements.reduce((sum, m) => {
    const cost = Number(m.cost_at_time || 0) * Number(m.quantity || 0);
    return sum + cost;
  }, 0);

  // Expenses filtered by date range
  const filteredExp = expenses.filter(e => {
    const d = (e.date || '').split('T')[0];
    return d >= from && d <= to;
  });
  const overheads = filteredExp.filter(e => e.category === 'overhead').reduce((s, e) => s + Number(e.amount || 0), 0);
  const labour    = filteredExp.filter(e => e.category === 'labour').reduce((s, e) => s + Number(e.amount || 0), 0);
  const other     = filteredExp.filter(e => e.category === 'other').reduce((s, e) => s + Number(e.amount || 0), 0);

  const totalRevenue  = revenue?.total_sales || 0;
  const grossProfit   = totalRevenue - cogs;
  const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const totalCosts    = cogs + overheads + labour + other;
  const netProfit     = totalRevenue - totalCosts;
  const netMarginPct  = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  const marginColor = (pct) => pct >= 25 ? '#22c55e' : pct >= 10 ? '#eab308' : '#ef4444';

  const addExpense = async () => {
    if (!expForm.description || !expForm.amount) return alert('Description and amount are required');
    setSavingExp(true);
    try {
      await invAPI.addExpense(expForm);
      setExpForm({ category: 'overhead', description: '', amount: '', date: today });
      loadData();
    } catch (err) {
      alert('Save failed — has Krit built the expenses backend yet?');
    } finally {
      setSavingExp(false);
    }
  };

  const deleteExpense = async (id) => {
    if (!confirm('Delete this expense?')) return;
    await invAPI.deleteExpense(id);
    loadData();
  };

  const catLabel = { overhead: '🏢 Overhead', labour: '👥 Labour', other: '📌 Other' };
  const catColor = { overhead: { color: '#8b5cf6', bg: '#ede9fe' }, labour: { color: '#3b82f6', bg: '#dbeafe' }, other: { color: '#f97316', bg: '#ffedd5' } };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

  return (
    <div>
      {/* Date range */}
      <div style={{ background: 'white', borderRadius: 12, padding: 16, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
        </div>
        <button onClick={loadData} style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>Calculate</button>
        {/* Quick period buttons */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { label: 'This Month', from: firstOfMonth, to: today },
            { label: 'Last 7 Days', from: new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0], to: today },
            { label: 'Today', from: today, to: today },
          ].map(p => (
            <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); }} style={{ padding: '6px 12px', borderRadius: 20, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600, fontSize: 12, color: '#555' }}>{p.label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 60 }}>Loading...</div>
      ) : (
        <>
          {/* Main KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Revenue',       value: `£${totalRevenue.toFixed(2)}`,  color: '#1a1a2e', bold: true },
              { label: 'Ingredient COGS', value: `£${cogs.toFixed(2)}`,        color: '#ef4444' },
              { label: 'Overheads',     value: `£${overheads.toFixed(2)}`,     color: '#8b5cf6' },
              { label: 'Labour',        value: `£${labour.toFixed(2)}`,        color: '#3b82f6' },
              { label: 'Other Costs',   value: `£${other.toFixed(2)}`,         color: '#f97316' },
              { label: 'Total Costs',   value: `£${totalCosts.toFixed(2)}`,    color: '#ef4444', bold: true },
            ].map(s => (
              <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 20, fontWeight: s.bold ? 900 : 800, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Margin summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 13, color: '#888', marginBottom: 6, fontWeight: 600 }}>GROSS PROFIT (after COGS)</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: marginColor(grossMarginPct) }}>£{grossProfit.toFixed(2)}</div>
              <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>
                Gross margin: <span style={{ fontWeight: 800, color: marginColor(grossMarginPct) }}>{grossMarginPct.toFixed(1)}%</span>
              </div>
              <div style={{ marginTop: 10, background: '#f5f5f5', borderRadius: 8, overflow: 'hidden', height: 8 }}>
                <div style={{ height: '100%', width: `${Math.min(grossMarginPct, 100)}%`, background: marginColor(grossMarginPct), borderRadius: 8, transition: 'width 0.4s' }} />
              </div>
            </div>
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 13, color: '#888', marginBottom: 6, fontWeight: 600 }}>NET PROFIT (after all costs)</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: marginColor(netMarginPct) }}>£{netProfit.toFixed(2)}</div>
              <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>
                Net margin: <span style={{ fontWeight: 800, color: marginColor(netMarginPct) }}>{netMarginPct.toFixed(1)}%</span>
              </div>
              <div style={{ marginTop: 10, background: '#f5f5f5', borderRadius: 8, overflow: 'hidden', height: 8 }}>
                <div style={{ height: '100%', width: `${Math.max(0, Math.min(netMarginPct, 100))}%`, background: marginColor(netMarginPct), borderRadius: 8, transition: 'width 0.4s' }} />
              </div>
            </div>
          </div>

          {/* Waterfall breakdown */}
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📊 Profit Breakdown</div>
            {[
              { label: 'Revenue',              value: totalRevenue, color: '#22c55e', sign: '' },
              { label: '– Ingredient COGS',    value: cogs,         color: '#ef4444', sign: '–' },
              { label: '= Gross Profit',        value: grossProfit,  color: grossProfit >= 0 ? '#22c55e' : '#ef4444', sign: '', bold: true },
              { label: '– Overheads',          value: overheads,    color: '#8b5cf6', sign: '–' },
              { label: '– Labour',             value: labour,       color: '#3b82f6', sign: '–' },
              { label: '– Other',              value: other,        color: '#f97316', sign: '–' },
              { label: '= Net Profit',          value: netProfit,    color: netProfit >= 0 ? '#22c55e' : '#ef4444', sign: '', bold: true },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: row.bold ? '10px 0' : '7px 0', borderTop: row.bold ? '2px solid #eee' : '1px solid #f5f5f5', marginTop: row.bold ? 4 : 0 }}>
                <span style={{ fontSize: 14, color: '#555', fontWeight: row.bold ? 700 : 400, paddingLeft: row.sign === '–' ? 16 : 0 }}>{row.label}</span>
                <span style={{ fontSize: row.bold ? 18 : 14, fontWeight: row.bold ? 800 : 600, color: row.color }}>
                  {row.sign === '–' ? '–' : ''}£{Math.abs(row.value).toFixed(2)}
                </span>
              </div>
            ))}
          </div>

          {/* Add expense form */}
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <button onClick={() => setActiveExpSection(!activeExpSection)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0, marginBottom: activeExpSection ? 16 : 0 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>+ Log an Expense</span>
              <span style={{ color: '#888', fontSize: 14 }}>{activeExpSection ? '▲' : '▼'}</span>
            </button>
            {activeExpSection && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Category</label>
                  <select value={expForm.category} onChange={e => setExpForm({ ...expForm, category: e.target.value })} style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                    <option value="overhead">🏢 Overhead</option>
                    <option value="labour">👥 Labour</option>
                    <option value="other">📌 Other</option>
                  </select>
                </div>
                <div style={{ flex: 3, minWidth: 160 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Description</label>
                  <input value={expForm.description} onChange={e => setExpForm({ ...expForm, description: e.target.value })} placeholder="e.g. Monthly rent, Gas bill, Chef wages..." style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: 1, minWidth: 100 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Amount (£)</label>
                  <input type="number" step="0.01" value={expForm.amount} onChange={e => setExpForm({ ...expForm, amount: e.target.value })} placeholder="0.00" style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Date</label>
                  <input type="date" value={expForm.date} onChange={e => setExpForm({ ...expForm, date: e.target.value })} style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <button onClick={addExpense} disabled={savingExp} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {savingExp ? 'Saving...' : 'Add'}
                </button>
              </div>
            )}
          </div>

          {/* Expenses list */}
          {filteredExp.length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>
                Logged Expenses — {from} to {to}
              </div>
              {filteredExp.map((e, i) => {
                const cc = catColor[e.category] || catColor.other;
                return (
                  <div key={e.id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
                    <span style={{ background: cc.bg, color: cc.color, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>{catLabel[e.category]}</span>
                    <span style={{ flex: 1, color: '#1a1a2e' }}>{e.description}</span>
                    <span style={{ color: '#888', fontSize: 12 }}>{formatDate(e.date)}</span>
                    <span style={{ fontWeight: 700, color: '#ef4444' }}>£{Number(e.amount).toFixed(2)}</span>
                    <button onClick={() => deleteExpense(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16, padding: 0 }}>×</button>
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', fontWeight: 800, fontSize: 15, background: '#f8f8f8', color: '#ef4444' }}>
                Total: £{(overheads + labour + other).toFixed(2)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// INVENTORY SECTION — MAIN WRAPPER
// ─────────────────────────────────────────────
function InventorySection() {
  const [tab, setTab] = useState('ingredients');

  const tabs = [
    { id: 'ingredients', label: '🧅 Ingredients' },
    { id: 'recipes',     label: '📋 Recipes & Costs' },
    { id: 'stock',       label: '📦 Stock Log' },
    { id: 'invoices',    label: '🧾 Invoice Scanner' },
    { id: 'costsales',   label: '💰 Cost vs Sales' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>🥬 Inventory & Food Costs</h1>
      <p style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>Manage ingredients, recipe costing, and stock movements — Growth tier feature</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 20px', borderRadius: 20, border: 'none', cursor: 'pointer',
            fontWeight: 600, fontSize: 14,
            background: tab === t.id ? '#1a1a2e' : '#e0e0e0',
            color: tab === t.id ? 'white' : '#555',
          }}>{t.label}</button>
        ))}
      </div>
      {tab === 'ingredients' && <IngredientsTab />}
      {tab === 'recipes'     && <RecipesTab />}
      {tab === 'stock'       && <StockTab />}
      {tab === 'invoices'    && <InvoiceScannerTab />}
      {tab === 'costsales'   && <CostSalesTab />}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN ADMIN SCREEN
// ─────────────────────────────────────────────
export default function AdminScreen() {
  const [section, setSection] = useState('trading');

  const navItems = [
    { id: 'trading',   label: '📊 Trading' },
    { id: 'menu',      label: '🍽️ Menu' },
    { id: 'tableplan', label: '🗺️ Table Plan' },
    { id: 'reports',   label: '📈 Reports' },
    { id: 'bills',     label: '🧾 Bills' },
    { id: 'zreport',   label: '🔐 Z Report' },
    { id: 'staff',     label: '👥 Staff' },
    { id: 'inventory', label: '🥬 Inventory' },
    { id: 'settings',  label: '⚙️ Settings' },
  ];

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>
      <div style={{ width: 200, background: '#1a1a2e', display: 'flex', flexDirection: 'column', padding: '20px 0' }}>
        <div style={{ color: 'white', fontWeight: 700, fontSize: 14, padding: '0 20px 16px', opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 }}>Admin Panel</div>
        {navItems.map(item => (
          <button key={item.id} onClick={() => setSection(item.id)} style={{
            background: section === item.id ? '#e94560' : 'none',
            border: 'none', color: 'white', padding: '12px 20px',
            textAlign: 'left', cursor: 'pointer', fontSize: 14,
            fontWeight: section === item.id ? 700 : 400,
          }}>{item.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', background: '#f5f5f5' }}>
        {section === 'trading'   && <TradingSection />}
        {section === 'menu'      && <MenuSection />}
        {section === 'tableplan' && <TablePlanSection />}
        {section === 'reports'   && <ReportsSection />}
        {section === 'bills'     && <BillsSection />}
        {section === 'zreport'   && <ZReportSection />}
        {section === 'staff'     && <StaffSection />}
        {section === 'inventory' && <InventorySection />}
        {section === 'settings'  && <SettingsSection />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// TRADING SECTION
// ─────────────────────────────────────────────
function TradingSection() {
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { from, to } = getDateRange(period);
    setLoading(true);
    getSummaryReport(from, to).then(d => { setData(d); setLoading(false); });
  }, [period]);

  const avgPerHead  = data?.total_covers > 0 ? data.total_sales / data.total_covers : 0;
  const avgPerCover = data?.order_count  > 0 ? data.total_sales / data.order_count  : 0;

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Trading Summary</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {['today', 'weekly', 'monthly'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            padding: '8px 20px', borderRadius: 20, border: 'none', cursor: 'pointer',
            fontWeight: 600, textTransform: 'capitalize',
            background: period === p ? '#1a1a2e' : '#e0e0e0',
            color: period === p ? 'white' : '#555'
          }}>{p}</button>
        ))}
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Sales',    value: `£${(data?.total_sales || 0).toFixed(2)}`, color: '#e94560' },
              { label: 'Orders',         value: data?.order_count || 0,                    color: '#3b82f6' },
              { label: 'Covers',         value: data?.total_covers || 0,                   color: '#22c55e' },
              { label: 'Avg per Cover',  value: `£${avgPerHead.toFixed(2)}`,               color: '#eab308' },
              { label: 'Avg Order',      value: `£${avgPerCover.toFixed(2)}`,              color: '#8b5cf6' },
            ].map(stat => (
              <div key={stat.label} style={{ background: 'white', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{stat.label}</div>
              </div>
            ))}
          </div>
          {data?.by_method && Object.keys(data.by_method).length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#1a1a2e' }}>Payment Methods</div>
              {Object.entries(data.by_method).map(([method, amount]) => (
                <div key={method} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ color: '#555' }}>{method}</span>
                  <span style={{ fontWeight: 700 }}>£{amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          {data?.orders?.length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#1a1a2e' }}>Recent Orders</div>
              {data.orders.slice(0, 10).map(order => (
                <div key={order.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ color: '#555' }}>Table {order.table_number} · #{order.id} · {order.method}</span>
                  <span style={{ fontWeight: 700, color: '#1a1a2e' }}>£{(order.total || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          {data?.orders?.length === 0 && <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60, fontSize: 16 }}>No orders found for this period</div>}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// AI MENU SCANNER MODAL
// ─────────────────────────────────────────────
function AIScannerModal({ onClose, onImported }) {
  const [stage, setStage]             = useState('upload');
  const [file, setFile]               = useState(null);
  const [fileData, setFileData]       = useState(null);
  const [scanStep, setScanStep]       = useState(0);
  const [scannedMenu, setScannedMenu] = useState(null);
  const [addedItems, setAddedItems]   = useState(new Set());
  const [loadingItem, setLoadingItem] = useState(null);
  const [error, setError]             = useState('');
  const fileInputRef                  = useRef(null);

  const SCAN_STEPS = [
    '👁️ Reading menu layout & text',
    '🍽️ Identifying dishes & categories',
    '⚠️ Detecting allergens in each dish',
    '💷 Estimating prices from context',
    '🇹🇭 Generating Thai dish names',
  ];

  function handleFile(f) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = e => setFileData(e.target.result);
    reader.readAsDataURL(f);
  }

  async function runScan() {
    if (!file || !fileData) return;
    setError('');
    setStage('scanning');
    setScanStep(0);
    setAddedItems(new Set());

    let idx = 0;
    const interval = setInterval(() => {
      idx++;
      setScanStep(idx);
      if (idx >= SCAN_STEPS.length) clearInterval(interval);
    }, 1800);

    try {
      const base64     = fileData.split(',')[1];
      const media_type = file.type || 'image/jpeg';

      const res = await fetch(`${SERVER_URL}/api/ai/scan-menu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64, media_type }),
      });

      clearInterval(interval);
      setScanStep(SCAN_STEPS.length);

      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');

      await new Promise(r => setTimeout(r, 600));
      setScannedMenu(data.menu);
      setStage('results');

    } catch (err) {
      clearInterval(interval);
      setError(err.message || 'Scan failed — try again');
      setStage('upload');
    }
  }

  async function handleAddItem(dish, globalIndex) {
    setLoadingItem(globalIndex);
    try {
      const menuRes = await fetch(`${SERVER_URL}/api/menu/all`);
      const menuData = await menuRes.json();
      const firstCategoryId = menuData?.[0]?.id || 1;

      await fetch(`${SERVER_URL}/api/menu/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:           dish.name_en,
          name_alt:       dish.name_th || '',
          description:    dish.description || '',
          price:          parseFloat(dish.price) || 0,
          category_id:    firstCategoryId,
          subcategory_id: null,
        }),
      });

      setAddedItems(prev => new Set([...prev, globalIndex]));
      onImported();
    } catch (err) {
      alert('Failed to add item — try again');
    } finally {
      setLoadingItem(null);
    }
  }

  const allDishes = scannedMenu?.categories?.flatMap(c => c.dishes) || [];
  const addedCount = addedItems.size;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.4)' }}>

        <div style={{ background: 'linear-gradient(135deg,#1a1a2e,#2d2a4a)', padding: '20px 28px', borderRadius: '20px 20px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 10 }}>
          <div>
            <div style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>🤖 AI Menu Scanner</div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>
              Upload a menu photo → AI extracts dishes → Add items one by one
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', borderRadius: 8, width: 34, height: 34, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <div style={{ padding: 28 }}>

          {stage === 'upload' && (
            <div>
              {error && (
                <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>
                  ⚠️ {error}
                </div>
              )}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                style={{
                  border: `2px dashed ${file ? '#22c55e' : '#C9A84C'}`,
                  borderRadius: 16, padding: '40px 24px', textAlign: 'center',
                  cursor: 'pointer', marginBottom: 20,
                  background: file ? '#f0fdf4' : '#fffdf0',
                }}
              >
                <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files[0])} />
                {file ? (
                  <div>
                    {file.type.startsWith('image/') && fileData && (
                      <img src={fileData} alt="preview" style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 10, marginBottom: 12, objectFit: 'contain' }} />
                    )}
                    <div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div>
                    <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>📷</div>
                    <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop menu photo here or click to upload</div>
                    <div style={{ color: '#888', fontSize: 13 }}>JPG, PNG, or PDF · Phone photos work great</div>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>Cancel</button>
                <button onClick={runScan} disabled={!file} style={{
                  flex: 2, padding: '12px', borderRadius: 10, border: 'none',
                  background: file ? '#1a1a2e' : '#ddd',
                  color: file ? 'white' : '#aaa',
                  cursor: file ? 'pointer' : 'not-allowed',
                  fontWeight: 700, fontSize: 15,
                }}>🔍 Scan with AI</button>
              </div>
            </div>
          )}

          {stage === 'scanning' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{
                width: 52, height: 52, border: '4px solid #f0f0f0',
                borderTop: '4px solid #C9A84C', borderRadius: '50%',
                margin: '0 auto 20px',
                animation: 'spin 0.8s linear infinite',
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>AI is reading your menu…</div>
              <div style={{ color: '#888', fontSize: 13, marginBottom: 28 }}>This usually takes 15–30 seconds</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340, margin: '0 auto' }}>
                {SCAN_STEPS.map((step, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 14px', borderRadius: 8, fontSize: 13,
                    background: i < scanStep ? '#f0fdf4' : i === scanStep ? '#fffdf0' : 'transparent',
                    color: i < scanStep ? '#15803d' : i === scanStep ? '#C9A84C' : '#aaa',
                    fontWeight: i === scanStep ? 700 : 400,
                  }}>
                    <span>{i < scanStep ? '✓' : i === scanStep ? '⏳' : '○'}</span>
                    {step}
                  </div>
                ))}
              </div>
            </div>
          )}

          {stage === 'results' && scannedMenu && (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'Dishes found',  value: allDishes.length,  color: '#3b82f6' },
                  { label: 'Added so far',  value: addedCount,        color: '#22c55e' },
                  { label: 'With allergens',value: allDishes.filter(d => d.allergens?.length > 0).length, color: '#ef4444' },
                ].map(s => (
                  <div key={s.label} style={{ flex: 1, minWidth: 90, background: '#f8f8f8', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: '#f0f7ff', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>
                💡 Click <strong>+</strong> to add each item to your menu. You can assign categories in Menu Manager afterwards.
              </div>

              <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
                {(() => {
                  let globalIndex = 0;
                  return scannedMenu.categories?.map(cat => (
                    <div key={cat.name}>
                      <div style={{ background: '#1a1a2e', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: '#C9A84C', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{cat.name}</span>
                        <span style={{ background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 11, padding: '1px 8px', borderRadius: 10 }}>{cat.dishes?.length} items</span>
                      </div>
                      {cat.dishes?.map((dish) => {
                        const idx     = globalIndex++;
                        const isAdded = addedItems.has(idx);
                        const isLoading = loadingItem === idx;

                        return (
                          <div key={idx} style={{
                            display: 'flex', alignItems: 'center', gap: 12,
                            padding: '12px 16px', borderBottom: '1px solid #f0f0f0',
                            background: isAdded ? '#f0fdf4' : 'white',
                            transition: 'background 0.2s',
                          }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e' }}>{dish.name_en}</span>
                                {dish.name_th && <span style={{ fontSize: 12, color: '#C9A84C' }}>{dish.name_th}</span>}
                              </div>
                              {dish.description && (
                                <div style={{ fontSize: 12, color: '#888', marginTop: 2, lineHeight: 1.4 }}>{dish.description}</div>
                              )}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 800, color: '#e94560', fontSize: 14 }}>£{(dish.price || 0).toFixed(2)}</span>
                                {dish.allergens?.length > 0 && dish.allergens.map(a => (
                                  <span key={a} style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>{a}</span>
                                ))}
                              </div>
                            </div>
                            <button
                              onClick={() => !isAdded && !isLoading && handleAddItem(dish, idx)}
                              disabled={isAdded || isLoading}
                              style={{
                                width: 40, height: 40, borderRadius: 10, border: 'none',
                                cursor: isAdded ? 'default' : 'pointer',
                                fontWeight: 800, fontSize: 20, flexShrink: 0,
                                background: isAdded ? '#dcfce7' : isLoading ? '#f0f0f0' : '#e94560',
                                color: isAdded ? '#15803d' : isLoading ? '#aaa' : 'white',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'all 0.2s',
                              }}
                            >
                              {isAdded ? '✓' : isLoading ? '⏳' : '+'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ));
                })()}
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={() => { setStage('upload'); setScannedMenu(null); setAddedItems(new Set()); }}
                  style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>
                  ↩ Scan Again
                </button>
                <button onClick={onClose} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: addedCount > 0 ? '#1a1a2e' : '#f0f0f0',
                  color: addedCount > 0 ? 'white' : '#aaa',
                  cursor: 'pointer', fontWeight: 700,
                }}>
                  {addedCount > 0 ? `✓ Done — ${addedCount} item${addedCount > 1 ? 's' : ''} added` : 'Close'}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MENU SECTION
// ─────────────────────────────────────────────
function MenuSection() {
  const [menu, setMenu]                     = useState([]);
  const [subcategories, setSubcategories]   = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [showForm, setShowForm]             = useState(false);
  const [showScanner, setShowScanner]       = useState(false);
  const [editItem, setEditItem]             = useState(null);
  const [form, setForm]                     = useState({ name: '', name_alt: '', description: '', price: '', category_id: '', subcategory_id: null });
  const [modifierItem, setModifierItem]     = useState(null);
  const [modifiers, setModifiers]           = useState([]);
  const [newGroup, setNewGroup]             = useState({ name: '', required: true, multi_select: false });
  const [newOption, setNewOption]           = useState({ name: '', extra_price: '' });
  const [activeGroup, setActiveGroup]       = useState(null);
  const [showSubcatManager, setShowSubcatManager] = useState(false);
  const [newSubcatName, setNewSubcatName]   = useState('');

  const [dragIndex, setDragIndex]   = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [localItems, setLocalItems] = useState([]);

  const fetchMenu = async () => {
    const data = await getMenu();
    const subs = await getSubcategories();
    setMenu(data);
    setSubcategories(subs);
    if (data.length > 0 && !activeCategory) setActiveCategory(data[0].id);
  };

  useEffect(() => { fetchMenu(); }, []);

  useEffect(() => {
    const items = menu.find(c => c.id === activeCategory)?.items || [];
    setLocalItems([...items]);
  }, [activeCategory, menu]);

  const openAddForm = () => {
    setForm({ name: '', description: '', price: '', category_id: activeCategory, subcategory_id: null });
    setEditItem(null);
    setShowForm(true);
  };

  const openEditForm = (item) => {
    setForm({ name: item.name, name_alt: item.name_alt || '', description: item.description || '', price: item.price, category_id: item.category_id, subcategory_id: item.subcategory_id || null });
    setEditItem(item);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.price) return alert('Name and price are required!');
    if (editItem) await updateMenuItem(editItem.id, { ...form, is_available: 1 });
    else await addMenuItem(form);
    setShowForm(false);
    fetchMenu();
  };

  const toggleAvailable = async (item) => {
    await updateMenuItem(item.id, { ...item, is_available: item.is_available ? 0 : 1 });
    fetchMenu();
  };

  const openModifiers = async (item) => {
    setModifierItem(item);
    setActiveGroup(null);
    const data = await getItemModifiers(item.id);
    setModifiers(data);
  };

  const handleAddGroup = async () => {
    if (!newGroup.name) return alert('Group name is required!');
    await addModifierGroup(modifierItem.id, newGroup);
    setNewGroup({ name: '', required: true, multi_select: false });
    setModifiers(await getItemModifiers(modifierItem.id));
  };

  const handleAddOption = async () => {
    if (!newOption.name) return alert('Option name is required!');
    await addModifierOption(activeGroup, { name: newOption.name, extra_price: newOption.extra_price || 0 });
    setNewOption({ name: '', extra_price: '' });
    setModifiers(await getItemModifiers(modifierItem.id));
  };

  const handleDeleteGroup = async (groupId) => {
    if (!confirm('Delete this group and all its options?')) return;
    await deleteModifierGroup(groupId);
    setModifiers(await getItemModifiers(modifierItem.id));
    if (activeGroup === groupId) setActiveGroup(null);
  };

  const handleDeleteOption = async (optionId) => {
    await deleteModifier(optionId);
    setModifiers(await getItemModifiers(modifierItem.id));
  };

  function handleDragStart(e, index) {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }

  function handleDrop(e, dropIndex) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newItems = [...localItems];
    const draggedItem = newItems[dragIndex];
    newItems.splice(dragIndex, 1);
    newItems.splice(dropIndex, 0, draggedItem);

    setLocalItems(newItems);
    setDragIndex(null);
    setDragOverIndex(null);

    saveSortOrder(newItems);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setDragOverIndex(null);
  }

  async function saveSortOrder(items) {
    try {
      const payload = items.map((item, index) => ({
        id: item.id,
        sort_order: index,
      }));
      await fetch(`${SERVER_URL}/api/menu/items/sort-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payload }),
      });
    } catch (err) {
      console.error('Failed to save sort order:', err);
    }
  }

  const activeCatSubs = subcategories.filter(s => s.category_id === activeCategory);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Menu Manager</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {menu.map(cat => (
          <button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={{
            padding: '8px 20px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600,
            background: activeCategory === cat.id ? '#1a1a2e' : '#e0e0e0',
            color: activeCategory === cat.id ? 'white' : '#555',
          }}>{cat.name} ({cat.items?.length || 0})</button>
        ))}
        <button onClick={() => setShowSubcatManager(!showSubcatManager)} style={{
          padding: '8px 16px', borderRadius: 20, border: '2px dashed #3b82f6',
          background: 'white', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, fontSize: 13
        }}>⊕ Sub-categories</button>
      </div>

      {showSubcatManager && (
        <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginBottom: 20, border: '1px solid #bfdbfe' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#1e40af', marginBottom: 12 }}>Manage Sub-categories</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <select value={activeCategory} onChange={e => setActiveCategory(Number(e.target.value))} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
              {menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
            </select>
            <input value={newSubcatName} onChange={e => setNewSubcatName(e.target.value)} placeholder="e.g. Wine, Curry, Stir-fried..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
            <button onClick={async () => {
              if (!newSubcatName) return;
              await addSubcategory(activeCategory, newSubcatName);
              setNewSubcatName('');
              fetchMenu();
            }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#3b82f6', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {activeCatSubs.map(sub => (
              <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', borderRadius: 20, padding: '4px 12px', border: '1px solid #bfdbfe' }}>
                <span style={{ fontSize: 13, color: '#1e40af', fontWeight: 500 }}>{sub.name}</span>
                <button onClick={async () => {
                  if (!confirm(`Delete "${sub.name}"?`)) return;
                  await deleteSubcategory(sub.id);
                  fetchMenu();
                }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16 }}>×</button>
              </div>
            ))}
            {activeCatSubs.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>No sub-categories yet</span>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#888' }}>
          {localItems.length > 0 && '≡ Drag to reorder'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setShowScanner(true)} style={{
            background: 'linear-gradient(135deg,#1a1a2e,#2d2a4a)',
            color: 'white', border: 'none', padding: '10px 18px',
            borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
          }}>🤖 AI Scanner</button>
          <button onClick={openAddForm} style={{
            background: '#e94560', color: 'white', border: 'none',
            padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600,
          }}>+ Add Item</button>
        </div>
      </div>

      {localItems.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60 }}>
          No items yet — click "+ Add Item" or use 🤖 AI Scanner
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {localItems.map((item, index) => {
            const subcat      = subcategories.find(s => s.id === item.subcategory_id);
            const isDragging  = dragIndex === index;
            const isOver      = dragOverIndex === index;

            return (
              <div
                key={item.id}
                draggable
                onDragStart={e => handleDragStart(e, index)}
                onDragOver={e => handleDragOver(e, index)}
                onDrop={e => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                style={{
                  background: 'white',
                  borderRadius: 12,
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  boxShadow: isDragging
                    ? '0 8px 24px rgba(0,0,0,0.15)'
                    : '0 1px 4px rgba(0,0,0,0.08)',
                  opacity: isDragging ? 0.5 : 1,
                  border: isOver
                    ? '2px solid #3b82f6'
                    : '2px solid transparent',
                  transform: isDragging ? 'scale(1.01)' : 'scale(1)',
                  transition: 'border 0.15s, box-shadow 0.15s',
                  cursor: 'grab',
                }}
              >
                <div style={{
                  color: '#ccc', fontSize: 18, cursor: 'grab',
                  userSelect: 'none', flexShrink: 0, lineHeight: 1,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} />
                  </div>
                </div>

                <div style={{ flex: 1, opacity: item.is_available ? 1 : 0.5 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>{item.name}</div>
                  {item.name_alt && <div style={{ fontSize: 12, color: '#C9A84C', marginTop: 1 }}>{item.name_alt}</div>}
                  {subcat && <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginTop: 2 }}>📁 {subcat.name}</div>}
                  {item.description && <div style={{ fontSize: 13, color: '#888' }}>{item.description}</div>}
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e94560', marginTop: 2 }}>£{Number(item.price).toFixed(2)}</div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <button
                    onClick={e => { e.stopPropagation(); toggleAvailable(item); }}
                    style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: item.is_available ? '#dcfce7' : '#fee2e2', color: item.is_available ? '#14532d' : '#991b1b' }}
                  >
                    {item.is_available ? 'Available' : 'Off menu'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); openModifiers(item); }}
                    style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fef9c3', color: '#713f12', fontWeight: 600, fontSize: 12 }}
                  >
                    Options
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); openEditForm(item); }}
                    style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={async e => {
                      e.stopPropagation();
                      if (!window.confirm(`Delete "${item.name}" permanently?`)) return;
                      try {
                        const res = await fetch(`${SERVER_URL}/api/menu/items/${item.id}`, { method: 'DELETE' });
                        const data = await res.json();
                        if (data.success) fetchMenu();
                        else alert('Delete failed: ' + (data.error || 'Unknown error'));
                      } catch (err) {
                        alert('Delete error: ' + err.message);
                      }
                    }}
                    style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontWeight: 600, fontSize: 12 }}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showScanner && (
        <AIScannerModal
          onClose={() => { fetchMenu(); setShowScanner(false); }}
          onImported={() => fetchMenu()}
        />
      )}

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: '#1a1a2e' }}>{editItem ? 'Edit Item' : 'Add New Item'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Category</label>
                <select value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value, subcategory_id: null })}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                  {menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                </select>
              </div>
              {subcategories.filter(s => s.category_id === Number(form.category_id)).length > 0 && (
                <div>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Sub-category</label>
                  <select value={form.subcategory_id || ''} onChange={e => setForm({ ...form, subcategory_id: e.target.value || null })}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                    <option value="">No sub-category</option>
                    {subcategories.filter(s => s.category_id === Number(form.category_id)).map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Item name (English) *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Satay"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
                  Second language name <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span>
                </label>
                <input value={form.name_alt || ''} onChange={e => setForm({ ...form, name_alt: e.target.value })} placeholder="e.g. ไก่ผัดเม็ดมะม่วง"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #C9A84C', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Description</label>
                <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Optional"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Price (£) *</label>
                <input value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder="e.g. 12.99" type="number" step="0.01"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>{editItem ? 'Save Changes' : 'Add Item'}</button>
            </div>
          </div>
        </div>
      )}

      {modifierItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 520, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Options — {modifierItem.name}</h2>
              <button onClick={() => setModifierItem(null)} style={{ background: '#f0f0f0', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600 }}>Close</button>
            </div>
            {modifiers.map(group => (
              <div key={group.id} style={{ background: '#f8f8f8', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{group.name}</span>
                    <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{group.required ? 'Required' : 'Optional'} · {group.multi_select ? 'Multi' : 'Pick one'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setActiveGroup(activeGroup === group.id ? null : group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#1a1a2e', color: 'white', fontSize: 12, fontWeight: 600 }}>+ Add option</button>
                    <button onClick={() => handleDeleteGroup(group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontSize: 12, fontWeight: 600 }}>Delete</button>
                  </div>
                </div>
                {group.modifiers?.map(opt => (
                  <div key={opt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #eee' }}>
                    <span style={{ fontSize: 14 }}>{opt.name} {opt.extra_price > 0 && <span style={{ color: '#e94560' }}>+£{Number(opt.extra_price).toFixed(2)}</span>}</span>
                    <button onClick={() => handleDeleteOption(opt.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18 }}>×</button>
                  </div>
                ))}
                {activeGroup === group.id && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <input value={newOption.name} onChange={e => setNewOption({ ...newOption, name: e.target.value })} placeholder="Option name"
                      style={{ flex: 2, padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }} />
                    <input value={newOption.extra_price} onChange={e => setNewOption({ ...newOption, extra_price: e.target.value })} placeholder="+£ extra" type="number" step="0.01"
                      style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }} />
                    <button onClick={handleAddOption} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button>
                  </div>
                )}
              </div>
            ))}
            <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add new option group</div>
              <input value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} placeholder="e.g. Choose Meat"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', marginBottom: 10 }} />
              <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={newGroup.required} onChange={e => setNewGroup({ ...newGroup, required: e.target.checked })} /> Required
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={newGroup.multi_select} onChange={e => setNewGroup({ ...newGroup, multi_select: e.target.checked })} /> Allow multiple
                </label>
              </div>
              <button onClick={handleAddGroup} style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Create Group</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// TABLE PLAN SECTION
// ─────────────────────────────────────────────
function TablePlanSection() {
  const [tables, setTables] = useState([]);
  const [selected, setSelected] = useState(null);
  const canvasRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const fetchTables = async () => {
    const { getTables } = await import('../api');
    const data = await getTables();
    setTables(data.map((t, i) => ({
      ...t,
      pos_x: t.pos_x || (i % 5) * 120 + 40,
      pos_y: t.pos_y || Math.floor(i / 5) * 120 + 40,
      width: t.width || 80, height: t.height || 80, shape: t.shape || 'square'
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
      const { updateTablePlan } = await import('../api');
      const table = tables.find(t => t.id === dragging);
      if (table) await updateTablePlan(table.id, table);
    }
    setDragging(null);
  };

  const handleAddTable = async () => {
    const { addTable } = await import('../api');
    const maxNum = Math.max(...tables.map(t => Number(t.table_number) || 0), 0);
    await addTable({ table_number: maxNum + 1, capacity: 4, pos_x: 40, pos_y: 40, shape: 'square', width: 80, height: 80 });
    fetchTables();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this table?')) return;
    const { deleteTable } = await import('../api');
    await deleteTable(id);
    setSelected(null);
    fetchTables();
  };

  const updateSelected = async (changes) => {
    const { updateTablePlan } = await import('../api');
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
            <div key={table.id} onMouseDown={e => handleMouseDown(e, table)} style={{
              position: 'absolute', left: table.pos_x, top: table.pos_y,
              width: table.width || 80, height: table.height || 80,
              borderRadius: table.shape === 'round' ? '50%' : table.shape === 'rectangle' ? 8 : 12,
              background: selected === table.id ? '#1a1a2e' : 'white',
              border: `3px solid ${selected === table.id ? '#e94560' : '#1a1a2e'}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              cursor: 'grab', userSelect: 'none',
              boxShadow: selected === table.id ? '0 4px 20px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.1)',
            }}>
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
                <input key={selectedTable.id + '_num'} defaultValue={selectedTable.table_number}
                  onBlur={e => updateSelected({ table_number: e.target.value })} placeholder="e.g. 1, Bar 1, Terrace"
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Click away to save</div>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Capacity (seats)</label>
                <input type="number" key={selectedTable.id + '_cap'} defaultValue={selectedTable.capacity}
                  onBlur={e => updateSelected({ capacity: Number(e.target.value) })}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Shape</label>
                <select value={selectedTable.shape || 'square'} onChange={e => updateSelected({ shape: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                  <option value="square">Square</option>
                  <option value="round">Round</option>
                  <option value="rectangle">Rectangle</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Size</label>
                <select onChange={e => { const [w, h] = e.target.value.split('x').map(Number); updateSelected({ width: w, height: h }); }}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                  <option value="">— Pick a size —</option>
                  <option value="70x70">Small (2 seats)</option>
                  <option value="80x80">Medium (4 seats)</option>
                  <option value="100x100">Large (6 seats)</option>
                  <option value="120x120">Extra large (8+ seats)</option>
                  <option value="120x70">Rectangle small</option>
                  <option value="160x70">Rectangle medium</option>
                  <option value="200x70">Rectangle large</option>
                </select>
              </div>
              <button onClick={() => handleDelete(selectedTable.id)} style={{ padding: '8px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>🗑️ Delete Table</button>
            </div>
          ) : <div style={{ color: '#bbb', fontSize: 13 }}>Click a table to edit</div>}
          <div style={{ marginTop: 20, padding: '12px', background: '#f8f8f8', borderRadius: 8, fontSize: 12, color: '#888' }}>💡 Drag tables to move them</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// REPORTS SECTION
// ─────────────────────────────────────────────
function ReportsSection() {
  const [tab, setTab] = useState('sales');
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState(null);
  const [itemData, setItemData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { from, to } = getDateRange(period);
    setLoading(true);
    Promise.all([getSummaryReport(from, to), getItemSalesReport(from, to)]).then(([s, i]) => {
      setData(s); setItemData(i); setLoading(false);
    });
  }, [period]);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Reports</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['today', 'weekly', 'monthly'].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '6px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, textTransform: 'capitalize', background: period === p ? '#1a1a2e' : '#e0e0e0', color: period === p ? 'white' : '#555' }}>{p}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['sales', 'items'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, background: tab === t ? '#e94560' : '#f0f0f0', color: tab === t ? 'white' : '#555' }}>
            {t === 'sales' ? 'Sales Report' : 'Item Sales'}
          </button>
        ))}
      </div>
      {loading ? <div style={{ color: '#888' }}>Loading...</div> : (
        <>
          {tab === 'sales' && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ padding: '12px 20px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 80px', fontWeight: 700, fontSize: 13, color: '#555' }}>
                <span>Order #</span><span>Table</span><span>Method</span><span>Covers</span><span style={{ textAlign: 'right' }}>Total</span>
              </div>
              {data?.orders?.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No orders for this period</div>}
              {data?.orders?.map(order => (
                <div key={order.id} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '80px 1fr 100px 80px 80px', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ color: '#888' }}>#{order.id}</span>
                  <span>Table {order.table_number}</span>
                  <span>{order.method || '-'}</span>
                  <span>{order.covers || '-'}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>£{(order.total || 0).toFixed(2)}</span>
                </div>
              ))}
              {data?.orders?.length > 0 && (
                <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', background: '#f8f8f8', fontWeight: 700 }}>
                  <span>Total ({data.order_count} orders · {data.total_covers} covers)</span>
                  <span style={{ color: '#e94560' }}>£{(data.total_sales || 0).toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          {tab === 'items' && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ padding: '12px 20px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', fontWeight: 700, fontSize: 13, color: '#555' }}>
                <span>Item</span><span>Price</span><span>Qty Sold</span><span style={{ textAlign: 'right' }}>Revenue</span>
              </div>
              {itemData.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No sales for this period</div>}
              {itemData.map((item, i) => (
                <div key={i} style={{ padding: '10px 20px', display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{item.name}</span>
                  <span>£{Number(item.price).toFixed(2)}</span>
                  <span style={{ color: '#3b82f6', fontWeight: 700 }}>{item.qty_sold}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700, color: '#e94560' }}>£{Number(item.total_revenue).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Z REPORT SECTION
// ─────────────────────────────────────────────
function ZReportSection() {
  const [step, setStep] = useState(1);
  const [reportType, setReportType] = useState(null);
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [floatAmount, setFloatAmount] = useState('');
  const [pettyCash, setPettyCash] = useState('');
  const [pettyCashReason, setPettyCashReason] = useState('');
  const [actualCash, setActualCash] = useState('');

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = now.toISOString();

  useEffect(() => {
    getZReportHistory().then(setHistory);
    setFromTime(todayStart.slice(0, 16));
    setToTime(todayEnd.slice(0, 16));
  }, []);

  const loadReport = async (type) => {
    setReportType(type);
    setLoading(true);
    setSaved(false);
    try {
      const from = type === 'day' ? todayStart : new Date(fromTime).toISOString();
      const to   = type === 'day' ? todayEnd   : new Date(toTime).toISOString();
      const data = await getZReportPreview(from, to);
      setReportData({ ...data, from, to });
      setStep(2);
    } catch (err) {
      alert('Failed to load report!');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSave = async () => {
    if (reportData.open_orders?.length > 0) {
      const ok = window.confirm(`⚠️ ${reportData.open_orders.length} tables still open:\n` + reportData.open_orders.map(o => `Table ${o.table_number}`).join(', ') + '\n\nAre you sure?');
      if (!ok) return;
    }
    const floatNum  = parseFloat(floatAmount) || 0;
    const pettyNum  = parseFloat(pettyCash) || 0;
    const actualNum = parseFloat(actualCash) || 0;
    const expectedCash = (reportData.total_cash || 0) - floatNum - pettyNum;
    const difference = actualNum - expectedCash;
    try {
      await saveZReport(reportType, reportData.from, reportData.to, reportData, floatNum, pettyNum, pettyCashReason, actualNum, difference);
      setSaved(true);
      setStep(4);
      getZReportHistory().then(setHistory);
    } catch (err) {
      alert('Failed to save Z Report!');
    }
  };

  const formatDateTime = (dt) => {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const floatNum     = parseFloat(floatAmount) || 0;
  const pettyNum     = parseFloat(pettyCash) || 0;
  const actualNum    = parseFloat(actualCash) || 0;
  const expectedCash = reportData ? (reportData.total_cash || 0) - floatNum - pettyNum : 0;
  const difference   = actualNum - expectedCash;
  const inputStyle   = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 15, boxSizing: 'border-box' };

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>🔐 Z Report / Close Shift</h1>
        <button onClick={() => setShowHistory(!showHistory)} style={{ background: '#f0f0f0', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          {showHistory ? 'Hide History' : '📋 View History'}
        </button>
      </div>

      {showHistory && (
        <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Past Z Reports</div>
          {history.length === 0 ? <div style={{ color: '#aaa', fontSize: 14 }}>No Z reports yet</div> : history.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>{r.type === 'day' ? '🌙 End of Day' : '⏰ Shift Close'}</span>
                <span style={{ color: '#888' }}>{formatDateTime(r.closed_at)}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ color: '#555' }}>{r.total_orders} orders</span>
                <span style={{ fontWeight: 700, color: '#e94560' }}>£{(r.total_sales || 0).toFixed(2)}</span>
                {r.cash_difference !== 0 && (
                  <span style={{ fontWeight: 700, fontSize: 12, color: r.cash_difference > 0 ? '#22c55e' : '#ef4444' }}>
                    {r.cash_difference > 0 ? `Over £${Number(r.cash_difference).toFixed(2)}` : `Short £${Math.abs(Number(r.cash_difference)).toFixed(2)}`}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: '#fff8f0', borderRadius: 12, padding: 24, border: '1px solid #fed7aa' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#c2410c', marginBottom: 8 }}>⏰ Close Shift</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>For lunch or dinner shift. Choose your time range.</div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From</label>
                <input type="datetime-local" value={fromTime} onChange={e => setFromTime(e.target.value)}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To</label>
                <input type="datetime-local" value={toTime} onChange={e => setToTime(e.target.value)}
                  style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            </div>
            <button onClick={() => loadReport('shift')} disabled={loading} style={{ padding: '14px 28px', borderRadius: 10, border: 'none', background: '#f97316', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>
              {loading ? 'Loading...' : '⏰ Run Shift Z Report'}
            </button>
          </div>
          <div style={{ background: '#fff0f3', borderRadius: 12, padding: 24, border: '1px solid #fecdd3' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#e94560', marginBottom: 8 }}>🌙 End of Day</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Closes all of today's trading from midnight to now.</div>
            <button onClick={() => loadReport('day')} disabled={loading} style={{ padding: '14px 28px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>
              {loading ? 'Loading...' : '🌙 Run End of Day'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && reportData && (
        <div>
          {reportData.open_orders?.length > 0 && (
            <div style={{ background: '#fef9c3', borderRadius: 12, padding: 16, marginBottom: 20, border: '2px solid #eab308' }}>
              <div style={{ fontWeight: 700, color: '#713f12', marginBottom: 4 }}>⚠️ {reportData.open_orders.length} tables still open!</div>
              <div style={{ fontSize: 13, color: '#92400e' }}>{reportData.open_orders.map(o => `Table ${o.table_number}`).join(' · ')}</div>
            </div>
          )}
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', paddingBottom: 16, marginBottom: 16, borderBottom: '2px dashed #eee' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>{reportType === 'day' ? '🌙 END OF DAY' : '⏰ SHIFT CLOSE'}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>💰 Sales Summary</div>
              {[
                { label: '💵 Cash Sales', value: reportData.total_cash || 0, color: '#22c55e' },
                { label: '💳 Card Sales', value: reportData.total_card || 0, color: '#3b82f6' },
                { label: '🔄 Other',      value: reportData.total_other || 0, color: '#8b5cf6' },
              ].map(p => (
                <div key={p.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 15 }}>
                  <span>{p.label}</span><span style={{ fontWeight: 700, color: p.color }}>£{p.value.toFixed(2)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontSize: 20, fontWeight: 800, color: '#e94560' }}>
                <span>TOTAL SALES</span><span>£{(reportData.total_sales || 0).toFixed(2)}</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Orders',    value: reportData.total_orders || 0,                     color: '#3b82f6' },
                { label: 'Covers',    value: reportData.total_covers || 0,                     color: '#22c55e' },
                { label: 'Avg/Cover', value: `£${(reportData.avg_per_cover || 0).toFixed(2)}`, color: '#8b5cf6' },
              ].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 10, padding: 12, border: '1px solid #bbf7d0' }}>
                <div style={{ fontSize: 11, color: '#888' }}>Discounts Given</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#22c55e' }}>£{(reportData.total_discounts || 0).toFixed(2)}</div>
              </div>
              <div style={{ flex: 1, background: '#fff0f3', borderRadius: 10, padding: 12, border: '1px solid #fecdd3' }}>
                <div style={{ fontSize: 11, color: '#888' }}>Void Items</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#e94560' }}>{reportData.void_count || 0} items</div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setStep(3)} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: '#1a1a2e', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Next — Till Reconciliation →</button>
            <button onClick={() => { setStep(1); setReportData(null); }} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 3 && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: '#1a1a2e' }}>💵 Till Reconciliation</div>
            <div style={{ background: '#f0f7ff', borderRadius: 10, padding: 14, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, color: '#555' }}>Cash Sales from System</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#1e40af' }}>£{(reportData.total_cash || 0).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>💰 Float at Start of Shift</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span>
                  <input type="number" step="0.01" value={floatAmount} onChange={e => setFloatAmount(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🧾 Petty Cash Out</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span>
                  <input type="number" step="0.01" value={pettyCash} onChange={e => setPettyCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} />
                </div>
                <input value={pettyCashReason} onChange={e => setPettyCashReason(e.target.value)} placeholder="Reason e.g. Bought supplies..." style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🏦 Actual Cash Counted</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span>
                  <input type="number" step="0.01" value={actualCash} onChange={e => setActualCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} />
                </div>
              </div>
            </div>
            {actualCash !== '' && (
              <div style={{ marginTop: 20, background: '#f8f8f8', borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: '#1a1a2e' }}>📊 Cash Calculation</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, color: '#555' }}><span>Cash Sales</span><span>£{(reportData.total_cash || 0).toFixed(2)}</span></div>
                {floatNum > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, color: '#555' }}><span>Less Float</span><span>-£{floatNum.toFixed(2)}</span></div>}
                {pettyNum > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, color: '#555' }}><span>Less Petty Cash</span><span>-£{pettyNum.toFixed(2)}</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginBottom: 8, paddingTop: 8, borderTop: '1px solid #eee' }}><span>Expected Cash</span><span>£{expectedCash.toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginBottom: 8 }}><span>Actual Counted</span><span>£{actualNum.toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800, paddingTop: 10, borderTop: '2px solid #eee', color: difference === 0 ? '#22c55e' : difference > 0 ? '#3b82f6' : '#ef4444' }}>
                  <span>{difference === 0 ? '✅ Exact!' : difference > 0 ? '📈 Over' : '📉 Short'}</span>
                  <span>£{Math.abs(difference).toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={handleConfirmSave} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: reportType === 'day' ? '#e94560' : '#f97316', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>
              {reportType === 'day' ? '🌙 Confirm End of Day' : '⏰ Confirm Close Shift'}
            </button>
            <button onClick={() => window.print()} style={{ flex: 1, padding: '16px', borderRadius: 12, border: '2px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>🖨️ Print</button>
            <button onClick={() => setStep(2)} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 4 && saved && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 48 }}>✅</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginTop: 8 }}>{reportType === 'day' ? 'End of Day Complete!' : 'Shift Closed!'}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Total Sales', value: `£${(reportData.total_sales || 0).toFixed(2)}`, color: '#e94560' },
                { label: 'Cash Sales',  value: `£${(reportData.total_cash  || 0).toFixed(2)}`, color: '#22c55e' },
                { label: 'Card Sales',  value: `£${(reportData.total_card  || 0).toFixed(2)}`, color: '#3b82f6' },
                { label: 'Orders',      value: reportData.total_orders || 0,                   color: '#8b5cf6' },
              ].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 14, textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ background: difference === 0 ? '#f0fdf4' : difference > 0 ? '#eff6ff' : '#fff0f3', borderRadius: 12, padding: 16, border: `2px solid ${difference === 0 ? '#bbf7d0' : difference > 0 ? '#bfdbfe' : '#fecdd3'}`, textAlign: 'center' }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>Cash Reconciliation</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: difference === 0 ? '#22c55e' : difference > 0 ? '#3b82f6' : '#ef4444' }}>
                {difference === 0 ? '✅ Exact Match!' : difference > 0 ? `📈 Over by £${difference.toFixed(2)}` : `📉 Short by £${Math.abs(difference).toFixed(2)}`}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => window.print()} style={{ flex: 2, padding: '16px', borderRadius: 12, border: '2px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>🖨️ Print Z Report</button>
            <button onClick={() => { setStep(1); setReportData(null); setSaved(false); setFloatAmount(''); setPettyCash(''); setPettyCashReason(''); setActualCash(''); }}
              style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// STAFF SECTION
// ─────────────────────────────────────────────
function StaffSection() {
  const [staff, setStaff] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editStaff, setEditStaff] = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [form, setForm] = useState({ name: '', pin: '', role: 'waiter', start_date: '', notes: '', employment_status: 'active' });
  const [filterStatus, setFilterStatus] = useState('active');

  useEffect(() => { getStaff().then(setStaff); }, []);

  const roleColors = { admin: '#e94560', manager: '#8b5cf6', supervisor: '#3b82f6', waiter: '#22c55e', kitchen: '#f97316', bar: '#eab308' };

  const filteredStaff = staff.filter(s => {
    if (filterStatus === 'active') return s.is_active;
    if (filterStatus === 'inactive') return !s.is_active;
    return true;
  });

  const handleSave = async () => {
    if (!form.name || (!editStaff && !form.pin)) return alert('Name and PIN are required!');
    if (form.pin && form.pin.length !== 4) return alert('PIN must be 4 digits!');
    try {
      if (editStaff) await updateStaff(editStaff.id, form);
      else await addStaff(form);
      setShowForm(false);
      setEditStaff(null);
      getStaff().then(setStaff);
    } catch (err) {
      alert('Save failed!');
    }
  };

  const toggleActive = async (s) => {
    await updateStaff(s.id, { ...s, is_active: s.is_active ? 0 : 1 });
    getStaff().then(setStaff);
  };

  const handleDelete = async (s) => {
    if (!confirm(`Permanently delete ${s.name}? This cannot be undone.`)) return;
    try {
      await fetch(`${SERVER_URL}/api/staff/${s.id}`, { method: 'DELETE' });
      setSelectedStaff(null);
      getStaff().then(setStaff);
    } catch (err) {
      alert('Delete failed!');
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>👥 Staff</h1>
        <button onClick={() => { setEditStaff(null); setForm({ name: '', pin: '', role: 'waiter', start_date: '', notes: '', employment_status: 'active' }); setShowForm(true); }}
          style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Staff</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[
          { key: 'active', label: `Active (${staff.filter(s => s.is_active).length})` },
          { key: 'inactive', label: `Inactive (${staff.filter(s => !s.is_active).length})` },
          { key: 'all', label: `All (${staff.length})` },
        ].map(f => (
          <button key={f.key} onClick={() => setFilterStatus(f.key)} style={{
            padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            background: filterStatus === f.key ? '#1a1a2e' : '#f0f0f0',
            color: filterStatus === f.key ? 'white' : '#555'
          }}>{f.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filteredStaff.map(s => (
          <div key={s.id}>
            <div onClick={() => setSelectedStaff(selectedStaff?.id === s.id ? null : s)} style={{
              background: 'white', borderRadius: 12, padding: '16px 20px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)', opacity: s.is_active ? 1 : 0.6, cursor: 'pointer',
              border: selectedStaff?.id === s.id ? '2px solid #e94560' : '2px solid transparent'
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>{s.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ background: roleColors[s.role] || '#888', color: 'white', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>{s.role}</span>
                  {!s.is_active && <span style={{ background: '#fee2e2', color: '#ef4444', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>Inactive</span>}
                  {s.start_date && <span style={{ fontSize: 12, color: '#888' }}>📅 Started: {s.start_date}</span>}
                  {s.employment_status && s.employment_status !== 'active' && <span style={{ fontSize: 12, color: '#f97316', fontWeight: 600 }}>• {s.employment_status}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={e => { e.stopPropagation(); setEditStaff(s); setForm({ name: s.name, pin: '', role: s.role, start_date: s.start_date || '', notes: s.notes || '', employment_status: s.employment_status || 'active' }); setShowForm(true); }}
                  style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>✏️ Edit</button>
                <button onClick={e => { e.stopPropagation(); toggleActive(s); }} style={{
                  padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12,
                  background: s.is_active ? '#fff3cd' : '#dcfce7', color: s.is_active ? '#92400e' : '#14532d'
                }}>{s.is_active ? 'Deactivate' : 'Reactivate'}</button>
                <span style={{ color: '#ccc' }}>▾</span>
              </div>
            </div>
            {selectedStaff?.id === s.id && (
              <div style={{ background: '#f8f8f8', borderRadius: '0 0 12px 12px', padding: '16px 20px', border: '2px solid #e94560', borderTop: 'none' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  {[
                    { label: 'Start Date',    value: s.start_date || '—' },
                    { label: 'Status',        value: s.employment_status || 'Active' },
                    { label: 'Member Since',  value: s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—' },
                    { label: 'Role',          value: s.role },
                  ].map(item => (
                    <div key={item.label} style={{ background: 'white', borderRadius: 8, padding: '12px 16px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>{item.value}</div>
                    </div>
                  ))}
                </div>
                {s.notes && (
                  <div style={{ background: 'white', borderRadius: 8, padding: '12px 16px', marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>Notes</div>
                    <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5 }}>{s.notes}</div>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={() => handleDelete(s)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>🗑️ Permanently Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: '#1a1a2e' }}>{editStaff ? '✏️ Edit Staff' : '+ Add Staff'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Full Name *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Somchai Smith" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>{editStaff ? 'New PIN (leave blank to keep)' : 'PIN (4 digits) *'}</label><input value={form.pin} onChange={e => setForm({ ...form, pin: e.target.value })} placeholder="4 digit PIN" type="password" maxLength={4} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Role *</label><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="admin">Admin</option><option value="manager">Manager</option><option value="supervisor">Supervisor</option><option value="waiter">Waiter</option><option value="kitchen">Kitchen</option><option value="bar">Bar</option></select></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Start Date</label><input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Employment Status</label><select value={form.employment_status} onChange={e => setForm({ ...form, employment_status: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="active">Active</option><option value="part-time">Part-time</option><option value="probation">Probation</option><option value="notice">On Notice</option><option value="left">Left</option></select></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Notes <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Food hygiene cert expires Jan 2026..." rows={3} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', resize: 'none' }} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{editStaff ? 'Save Changes' : 'Add Staff'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// SETTINGS SECTION
// ─────────────────────────────────────────────
function SettingsSection() {
  const [settings, setSettings] = useState({
    service_charge_percent: '12.5', service_charge_enabled: '1',
    company_name: '', company_address: '', company_phone: '',
    company_email: '', company_vat: '', receipt_footer: 'Thank you for dining with us!'
  });
  const [reasons, setReasons] = useState([]);
  const [newReason, setNewReason] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then(s => setSettings(prev => ({ ...prev, ...s })));
    getDiscountReasons().then(r => setReasons(r));
  }, []);

  const handleSaveSettings = async () => {
    await updateSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 };

  return (
    <div style={{ padding: 24, maxWidth: 600 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 24 }}>Settings</h1>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>🏢 Business Details</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><label style={labelStyle}>Restaurant Name</label><input value={settings.company_name} onChange={e => setSettings({ ...settings, company_name: e.target.value })} placeholder="e.g. The Golden Spoon" style={inputStyle} /></div>
          <div><label style={labelStyle}>Address</label><input value={settings.company_address} onChange={e => setSettings({ ...settings, company_address: e.target.value })} placeholder="e.g. 123 High Street, London" style={inputStyle} /></div>
          <div><label style={labelStyle}>Phone Number</label><input value={settings.company_phone} onChange={e => setSettings({ ...settings, company_phone: e.target.value })} placeholder="e.g. 020 1234 5678" style={inputStyle} /></div>
          <div><label style={labelStyle}>Email</label><input value={settings.company_email} onChange={e => setSettings({ ...settings, company_email: e.target.value })} placeholder="e.g. info@myrestaurant.com" style={inputStyle} /></div>
          <div><label style={labelStyle}>VAT Number</label><input value={settings.company_vat} onChange={e => setSettings({ ...settings, company_vat: e.target.value })} placeholder="e.g. GB123456789" style={inputStyle} /></div>
          <div><label style={labelStyle}>Receipt Footer</label><input value={settings.receipt_footer} onChange={e => setSettings({ ...settings, receipt_footer: e.target.value })} placeholder="e.g. Thank you for dining with us!" style={inputStyle} /></div>
        </div>
      </div>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>💳 Service Charge</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" checked={settings.service_charge_enabled === '1'} onChange={e => setSettings({ ...settings, service_charge_enabled: e.target.checked ? '1' : '0' })} />
            Enable automatic service charge
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 14, fontWeight: 600, color: '#555' }}>Service charge %</label>
          <input value={settings.service_charge_percent} onChange={e => setSettings({ ...settings, service_charge_percent: e.target.value })} type="number" step="0.5"
            style={{ width: 100, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
        </div>
      </div>
      <button onClick={handleSaveSettings} style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: saved ? '#22c55e' : '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 16, marginBottom: 20 }}>
        {saved ? '✓ Saved!' : 'Save All Settings'}
      </button>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>🏷️ Discount Reasons</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {reasons.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8f8f8', borderRadius: 8 }}>
              <span style={{ fontSize: 14 }}>{r.reason}</span>
              <button onClick={async () => { await deleteDiscountReason(r.id); getDiscountReasons().then(setReasons); }} style={{ background: '#fee2e2', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#ef4444', fontSize: 12, fontWeight: 600 }}>Remove</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="Add new discount reason..." style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
          <button onClick={async () => { if (!newReason) return; await addDiscountReason(newReason); setNewReason(''); getDiscountReasons().then(setReasons); }} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button>
        </div>
      </div>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 8 }}>🍹 Bar Categories</h2>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Select which categories show on the Bar screen</p>
        <BarCategoryManager />
      </div>
    </div>
  );
}

function BarCategoryManager() {
  const [categories, setCategories] = useState([]);
  useEffect(() => { getCategories().then(setCategories); }, []);

  const toggleBar = async (cat) => {
    await updateCategoryBar(cat.id, cat.is_bar ? 0 : 1);
    getCategories().then(setCategories);
  };

  const setDefaultCourse = async (cat, course) => {
    await updateCategoryDefaultCourse(cat.id, course);
    getCategories().then(setCategories);
  };

  const courseColors = { 1: '#3b82f6', 2: '#e94560', 3: '#8b5cf6', 4: '#22c55e' };
  const courseLabels = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ background: '#f8f8f8', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: cat.is_bar ? 0 : 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>{cat.name}</span>
            <button onClick={() => toggleBar(cat)} style={{
              padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12,
              background: cat.is_bar ? '#dbeafe' : '#f0f0f0', color: cat.is_bar ? '#1e40af' : '#555'
            }}>{cat.is_bar ? '🍹 Bar ✓' : 'Not bar'}</button>
          </div>
          {!cat.is_bar && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase' }}>Default course when ordering:</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[1, 2, 3, 4].map(c => (
                  <button key={c} onClick={() => setDefaultCourse(cat, c)} style={{
                    padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12,
                    background: (cat.default_course || 1) === c ? courseColors[c] : '#e0e0e0',
                    color: (cat.default_course || 1) === c ? 'white' : '#555',
                  }}>{courseLabels[c]}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}