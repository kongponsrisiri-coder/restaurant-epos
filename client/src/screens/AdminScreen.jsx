import { useState, useEffect, useRef } from 'react';
import {
  getAllMenu as getMenu, addMenuItem, updateMenuItem,
  getItemModifiers, addModifierGroup, addModifierOption,
  deleteModifierGroup, deleteModifier,
  getSettings, updateSettings,
  getDiscountReasons, addDiscountReason, deleteDiscountReason,
  getStaff, addStaff, updateStaff,
  getSummaryReport, getItemSalesReport,
  getCategories, updateCategoryBar,
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
    if (selectedBill?.id === bill.id) {
      setSelectedBill(null);
      setBillItems([]);
      return;
    }
    setSelectedBill(bill);
    setLoadingItems(true);
    try {
      const items = await getBillItems(bill.id);
      setBillItems(Array.isArray(items) ? items : []);
    } catch (err) {
      setBillItems([]);
    } finally {
      setLoadingItems(false);
    }
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
// MAIN ADMIN SCREEN
// ─────────────────────────────────────────────
export default function AdminScreen() {
  const [section, setSection] = useState('trading');

  const navItems = [
    { id: 'trading', label: '📊 Trading' },
    { id: 'menu', label: '🍽️ Menu' },
    { id: 'tableplan', label: '🗺️ Table Plan' },
    { id: 'reports', label: '📈 Reports' },
    { id: 'bills', label: '🧾 Bills' },
    { id: 'zreport', label: '🔐 Z Report' },
    { id: 'staff', label: '👥 Staff' },
    { id: 'settings', label: '⚙️ Settings' },
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
        {section === 'trading' && <TradingSection />}
        {section === 'menu' && <MenuSection />}
        {section === 'tableplan' && <TablePlanSection />}
        {section === 'reports' && <ReportsSection />}
        {section === 'bills' && <BillsSection />}
        {section === 'zreport' && <ZReportSection />}
        {section === 'staff' && <StaffSection />}
        {section === 'settings' && <SettingsSection />}
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

  const avgPerHead = data?.total_covers > 0 ? data.total_sales / data.total_covers : 0;
  const avgPerCover = data?.order_count > 0 ? data.total_sales / data.order_count : 0;

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
              { label: 'Total Sales', value: `£${(data?.total_sales || 0).toFixed(2)}`, color: '#e94560' },
              { label: 'Orders', value: data?.order_count || 0, color: '#3b82f6' },
              { label: 'Covers', value: data?.total_covers || 0, color: '#22c55e' },
              { label: 'Avg per Cover', value: `£${avgPerHead.toFixed(2)}`, color: '#eab308' },
              { label: 'Avg Order', value: `£${avgPerCover.toFixed(2)}`, color: '#8b5cf6' },
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
// MENU SECTION
// ─────────────────────────────────────────────
function MenuSection() {
  const [menu, setMenu] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', price: '', category_id: '', subcategory_id: null });
  const [modifierItem, setModifierItem] = useState(null);
  const [modifiers, setModifiers] = useState([]);
  const [newGroup, setNewGroup] = useState({ name: '', required: true, multi_select: false });
  const [newOption, setNewOption] = useState({ name: '', extra_price: '' });
  const [activeGroup, setActiveGroup] = useState(null);
  const [showSubcatManager, setShowSubcatManager] = useState(false);
  const [newSubcatName, setNewSubcatName] = useState('');

  const fetchMenu = async () => {
    const data = await getMenu();
    const subs = await getSubcategories();
    setMenu(data);
    setSubcategories(subs);
    if (data.length > 0 && !activeCategory) setActiveCategory(data[0].id);
  };

  useEffect(() => { fetchMenu(); }, []);

  const openAddForm = () => {
    setForm({ name: '', description: '', price: '', category_id: activeCategory, subcategory_id: null });
    setEditItem(null);
    setShowForm(true);
  };

  const openEditForm = (item) => {
    setForm({ name: item.name, description: item.description || '', price: item.price, category_id: item.category_id, subcategory_id: item.subcategory_id || null });
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

  const activeItems = menu.find(c => c.id === activeCategory)?.items || [];
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

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button onClick={openAddForm} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Item</button>
      </div>

      {activeItems.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60 }}>No items yet — click "+ Add Item"</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activeItems.map(item => {
            const subcat = subcategories.find(s => s.id === item.subcategory_id);
            return (
              <div key={item.id} style={{ background: 'white', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', opacity: item.is_available ? 1 : 0.5 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#1a1a2e' }}>{item.name}</div>
                  {subcat && <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginTop: 2 }}>📁 {subcat.name}</div>}
                  {item.description && <div style={{ fontSize: 13, color: '#888' }}>{item.description}</div>}
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e94560' }}>£{Number(item.price).toFixed(2)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => toggleAvailable(item)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: item.is_available ? '#dcfce7' : '#fee2e2', color: item.is_available ? '#14532d' : '#991b1b' }}>{item.is_available ? 'Available' : 'Off menu'}</button>
                  <button onClick={() => openModifiers(item)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fef9c3', color: '#713f12', fontWeight: 600, fontSize: 12 }}>Options</button>
                  <button onClick={() => openEditForm(item)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>Edit</button>
                </div>
              </div>
            );
          })}
        </div>
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
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Item name *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Satay"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
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
      const to = type === 'day' ? todayEnd : new Date(toTime).toISOString();
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
    const floatNum = parseFloat(floatAmount) || 0;
    const pettyNum = parseFloat(pettyCash) || 0;
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

  const floatNum = parseFloat(floatAmount) || 0;
  const pettyNum = parseFloat(pettyCash) || 0;
  const actualNum = parseFloat(actualCash) || 0;
  const expectedCash = reportData ? (reportData.total_cash || 0) - floatNum - pettyNum : 0;
  const difference = actualNum - expectedCash;
  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 15, boxSizing: 'border-box' };

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
                { label: '🔄 Other', value: reportData.total_other || 0, color: '#8b5cf6' },
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
                { label: 'Orders', value: reportData.total_orders || 0, color: '#3b82f6' },
                { label: 'Covers', value: reportData.total_covers || 0, color: '#22c55e' },
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
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>💰 Float at Start of Shift <span style={{ fontWeight: 400, color: '#aaa' }}>(cash in till before service)</span></label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span>
                  <input type="number" step="0.01" value={floatAmount} onChange={e => setFloatAmount(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🧾 Petty Cash Out <span style={{ fontWeight: 400, color: '#aaa' }}>(cash taken out during shift)</span></label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span>
                  <input type="number" step="0.01" value={pettyCash} onChange={e => setPettyCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} />
                </div>
                <input value={pettyCashReason} onChange={e => setPettyCashReason(e.target.value)} placeholder="Reason e.g. Bought supplies, staff meal..." style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🏦 Actual Cash Counted <span style={{ fontWeight: 400, color: '#aaa' }}>(what you physically count)</span></label>
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
                { label: 'Cash Sales', value: `£${(reportData.total_cash || 0).toFixed(2)}`, color: '#22c55e' },
                { label: 'Card Sales', value: `£${(reportData.total_card || 0).toFixed(2)}`, color: '#3b82f6' },
                { label: 'Orders', value: reportData.total_orders || 0, color: '#8b5cf6' },
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
  const [form, setForm] = useState({ name: '', pin: '', role: 'waiter' });

  const fetchStaff = async () => { const data = await getStaff(); setStaff(data); };
  useEffect(() => { fetchStaff(); }, []);

  const handleSave = async () => {
    if (!form.name || (!editStaff && !form.pin)) return alert('Name and PIN are required!');
    if (form.pin && form.pin.length !== 4) return alert('PIN must be 4 digits!');
    if (editStaff) await updateStaff(editStaff.id, { ...form, is_active: editStaff.is_active });
    else await addStaff(form);
    setShowForm(false);
    setForm({ name: '', pin: '', role: 'waiter' });
    fetchStaff();
  };

  const toggleActive = async (s) => { await updateStaff(s.id, { ...s, is_active: s.is_active ? 0 : 1 }); fetchStaff(); };
  const roleColors = { admin: '#e94560', manager: '#f97316', supervisor: '#22c55e', waiter: '#3b82f6', kitchen: '#eab308', bar: '#8b5cf6' };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>Staff Management</h1>
        <button onClick={() => { setEditStaff(null); setForm({ name: '', pin: '', role: 'waiter' }); setShowForm(true); }} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Staff</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {staff.map(s => (
          <div key={s.id} style={{ background: 'white', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', opacity: s.is_active ? 1 : 0.5 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#1a1a2e' }}>{s.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ background: roleColors[s.role] || '#888', color: 'white', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>{s.role}</span>
                <span style={{ fontSize: 12, color: '#888' }}>PIN: ••••</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setEditStaff(s); setForm({ name: s.name, pin: '', role: s.role }); setShowForm(true); }} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>Edit</button>
              <button onClick={() => toggleActive(s)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: s.is_active ? '#dcfce7' : '#fee2e2', color: s.is_active ? '#14532d' : '#991b1b' }}>{s.is_active ? 'Active' : 'Inactive'}</button>
            </div>
          </div>
        ))}
      </div>
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 380 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: '#1a1a2e' }}>{editStaff ? 'Edit Staff' : 'Add Staff'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Name *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Full name"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>{editStaff ? 'New PIN (leave blank to keep)' : 'PIN (4 digits) *'}</label>
                <input value={form.pin} onChange={e => setForm({ ...form, pin: e.target.value })} placeholder="4 digit PIN" type="password" maxLength={4}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Role *</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
                  <option value="admin">Admin</option>
                  <option value="manager">Manager</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="waiter">Waiter</option>
                  <option value="kitchen">Kitchen</option>
                  <option value="bar">Bar</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>{editStaff ? 'Save' : 'Add Staff'}</button>
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
  const toggle = async (cat) => {
    await updateCategoryBar(cat.id, cat.is_bar ? 0 : 1);
    getCategories().then(setCategories);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8f8f8', borderRadius: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{cat.name}</span>
          <button onClick={() => toggle(cat)} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: cat.is_bar ? '#dbeafe' : '#f0f0f0', color: cat.is_bar ? '#1e40af' : '#555' }}>
            {cat.is_bar ? '🍹 Bar ✓' : 'Not bar'}
          </button>
        </div>
      ))}
    </div>
  );
}