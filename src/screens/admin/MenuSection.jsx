import { useState, useEffect, useRef } from 'react';
import { SERVER_URL } from '../../api';
import {
  getAllMenu as getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getItemModifiers, addModifierGroup, addModifierOption,
  deleteModifierGroup, deleteModifier,
  getSubcategories, addSubcategory, deleteSubcategory,
} from '../../api';

// ── AI Menu Scanner Modal ─────────────────────────────────────────
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
    setError(''); setStage('scanning'); setScanStep(0); setAddedItems(new Set());
    let idx = 0;
    const interval = setInterval(() => { idx++; setScanStep(idx); if (idx >= SCAN_STEPS.length) clearInterval(interval); }, 1800);
    try {
      const base64 = fileData.split(',')[1];
      const media_type = file.type || 'image/jpeg';
      const res = await fetch(`${SERVER_URL}/api/ai/scan-menu`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: base64, media_type }) });
      clearInterval(interval); setScanStep(SCAN_STEPS.length);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');
      await new Promise(r => setTimeout(r, 600));
      setScannedMenu(data.menu); setStage('results');
    } catch (err) { clearInterval(interval); setError(err.message || 'Scan failed — try again'); setStage('upload'); }
  }

  async function handleAddItem(dish, globalIndex) {
    setLoadingItem(globalIndex);
    try {
      const menuRes = await fetch(`${SERVER_URL}/api/menu/all`);
      const menuData = await menuRes.json();
      const firstCategoryId = menuData?.[0]?.id || 1;
      await fetch(`${SERVER_URL}/api/menu/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: dish.name_en, name_alt: dish.name_th || '', description: dish.description || '', price: parseFloat(dish.price) || 0, category_id: firstCategoryId, subcategory_id: null }) });
      setAddedItems(prev => new Set([...prev, globalIndex])); onImported();
    } catch { alert('Failed to add item — try again'); }
    finally { setLoadingItem(null); }
  }

  const allDishes = scannedMenu?.categories?.flatMap(c => c.dishes) || [];
  const addedCount = addedItems.size;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background: 'linear-gradient(135deg,#1a1a2e,#2d2a4a)', padding: '20px 28px', borderRadius: '20px 20px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 10 }}>
          <div><div style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>🤖 AI Menu Scanner</div><div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>Upload a menu photo → AI extracts dishes → Add items one by one</div></div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', borderRadius: 8, width: 34, height: 34, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ padding: 28 }}>
          {stage === 'upload' && (
            <div>
              {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>⚠️ {error}</div>}
              <div onClick={() => fileInputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }} style={{ border: `2px dashed ${file ? '#22c55e' : '#C9A84C'}`, borderRadius: 16, padding: '40px 24px', textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: file ? '#f0fdf4' : '#fffdf0' }}>
                <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
                {file ? (<div>{file.type.startsWith('image/') && fileData && <img src={fileData} alt="preview" style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 10, marginBottom: 12, objectFit: 'contain' }} />}<div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div><div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div></div>
                ) : (<div><div style={{ fontSize: 40, marginBottom: 12 }}>📷</div><div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop menu photo here or click to upload</div><div style={{ color: '#888', fontSize: 13 }}>JPG, PNG, or PDF · Phone photos work great</div></div>)}
              </div>
              <div style={{ display: 'flex', gap: 10 }}><button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>Cancel</button><button onClick={runScan} disabled={!file} style={{ flex: 2, padding: '12px', borderRadius: 10, border: 'none', background: file ? '#1a1a2e' : '#ddd', color: file ? 'white' : '#aaa', cursor: file ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 15 }}>🔍 Scan with AI</button></div>
            </div>
          )}
          {stage === 'scanning' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ width: 52, height: 52, border: '4px solid #f0f0f0', borderTop: '4px solid #C9A84C', borderRadius: '50%', margin: '0 auto 20px', animation: 'spin 0.8s linear infinite' }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>AI is reading your menu…</div>
              <div style={{ color: '#888', fontSize: 13, marginBottom: 28 }}>This usually takes 15–30 seconds</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340, margin: '0 auto' }}>
                {SCAN_STEPS.map((step, i) => (<div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 8, fontSize: 13, background: i < scanStep ? '#f0fdf4' : i === scanStep ? '#fffdf0' : 'transparent', color: i < scanStep ? '#15803d' : i === scanStep ? '#C9A84C' : '#aaa', fontWeight: i === scanStep ? 700 : 400 }}><span>{i < scanStep ? '✓' : i === scanStep ? '⏳' : '○'}</span>{step}</div>))}
              </div>
            </div>
          )}
          {stage === 'results' && scannedMenu && (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                {[{ label: 'Dishes found', value: allDishes.length, color: '#3b82f6' }, { label: 'Added so far', value: addedCount, color: '#22c55e' }, { label: 'With allergens', value: allDishes.filter(d => d.allergens?.length > 0).length, color: '#ef4444' }].map(s => (
                  <div key={s.label} style={{ flex: 1, minWidth: 90, background: '#f8f8f8', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div></div>
                ))}
              </div>
              <div style={{ background: '#f0f7ff', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>💡 Click <strong>+</strong> to add each item to your menu. Assign categories in Menu Manager afterwards.</div>
              <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
                {(() => { let globalIndex = 0; return scannedMenu.categories?.map(cat => (<div key={cat.name}><div style={{ background: '#1a1a2e', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ color: '#C9A84C', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{cat.name}</span><span style={{ background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 11, padding: '1px 8px', borderRadius: 10 }}>{cat.dishes?.length} items</span></div>{cat.dishes?.map((dish) => { const idx = globalIndex++; const isAdded = addedItems.has(idx); const isLoading = loadingItem === idx; return (<div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #f0f0f0', background: isAdded ? '#f0fdf4' : 'white' }}><div style={{ flex: 1 }}><div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}><span style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e' }}>{dish.name_en}</span>{dish.name_th && <span style={{ fontSize: 12, color: '#C9A84C' }}>{dish.name_th}</span>}</div>{dish.description && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{dish.description}</div>}<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}><span style={{ fontWeight: 800, color: '#e94560', fontSize: 14 }}>£{(dish.price || 0).toFixed(2)}</span>{dish.allergens?.length > 0 && dish.allergens.map(a => (<span key={a} style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>{a}</span>))}</div></div><button onClick={() => !isAdded && !isLoading && handleAddItem(dish, idx)} disabled={isAdded || isLoading} style={{ width: 40, height: 40, borderRadius: 10, border: 'none', cursor: isAdded ? 'default' : 'pointer', fontWeight: 800, fontSize: 20, flexShrink: 0, background: isAdded ? '#dcfce7' : isLoading ? '#f0f0f0' : '#e94560', color: isAdded ? '#15803d' : isLoading ? '#aaa' : 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isAdded ? '✓' : isLoading ? '⏳' : '+'}</button></div>); })}</div>)); })()}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={() => { setStage('upload'); setScannedMenu(null); setAddedItems(new Set()); }} style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Scan Again</button>
                <button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: addedCount > 0 ? '#1a1a2e' : '#f0f0f0', color: addedCount > 0 ? 'white' : '#aaa', cursor: 'pointer', fontWeight: 700 }}>{addedCount > 0 ? `✓ Done — ${addedCount} item${addedCount > 1 ? 's' : ''} added` : 'Close'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Menu Section ──────────────────────────────────────────────────
export default function MenuSection() {
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
  const [dragIndex, setDragIndex]           = useState(null);
  const [dragOverIndex, setDragOverIndex]   = useState(null);
  const [localItems, setLocalItems]         = useState([]);

  const fetchMenu = async () => {
    const data = await getMenu(); const subs = await getSubcategories();
    setMenu(data); setSubcategories(subs);
    if (data.length > 0 && !activeCategory) setActiveCategory(data[0].id);
  };
  useEffect(() => { fetchMenu(); }, []);
  useEffect(() => { const items = menu.find(c => c.id === activeCategory)?.items || []; setLocalItems([...items]); }, [activeCategory, menu]);

  const openAddForm  = () => { setForm({ name: '', description: '', price: '', category_id: activeCategory, subcategory_id: null }); setEditItem(null); setShowForm(true); };
  const openEditForm = (item) => { setForm({ name: item.name, name_alt: item.name_alt || '', description: item.description || '', price: item.price, category_id: item.category_id, subcategory_id: item.subcategory_id || null }); setEditItem(item); setShowForm(true); };
  const handleSave   = async () => { if (!form.name || !form.price) return alert('Name and price are required!'); if (editItem) await updateMenuItem(editItem.id, { ...form, is_available: 1 }); else await addMenuItem(form); setShowForm(false); fetchMenu(); };
  const toggleAvailable = async (item) => { await updateMenuItem(item.id, { ...item, is_available: item.is_available ? 0 : 1 }); fetchMenu(); };
  const openModifiers   = async (item) => { setModifierItem(item); setActiveGroup(null); const data = await getItemModifiers(item.id); setModifiers(data); };
  const handleAddGroup  = async () => { if (!newGroup.name) return alert('Group name is required!'); await addModifierGroup(modifierItem.id, newGroup); setNewGroup({ name: '', required: true, multi_select: false }); setModifiers(await getItemModifiers(modifierItem.id)); };
  const handleAddOption = async () => { if (!newOption.name) return alert('Option name is required!'); await addModifierOption(activeGroup, { name: newOption.name, extra_price: newOption.extra_price || 0 }); setNewOption({ name: '', extra_price: '' }); setModifiers(await getItemModifiers(modifierItem.id)); };
  const handleDeleteGroup  = async (groupId) => { if (!confirm('Delete this group and all its options?')) return; await deleteModifierGroup(groupId); setModifiers(await getItemModifiers(modifierItem.id)); if (activeGroup === groupId) setActiveGroup(null); };
  const handleDeleteOption = async (optionId) => { await deleteModifier(optionId); setModifiers(await getItemModifiers(modifierItem.id)); };

  function handleDragStart(e, index) { setDragIndex(index); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', index); }
  function handleDragOver(e, index)  { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIndex(index); }
  function handleDrop(e, dropIndex) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) { setDragIndex(null); setDragOverIndex(null); return; }
    const newItems = [...localItems]; const draggedItem = newItems[dragIndex]; newItems.splice(dragIndex, 1); newItems.splice(dropIndex, 0, draggedItem);
    setLocalItems(newItems); setDragIndex(null); setDragOverIndex(null); saveSortOrder(newItems);
  }
  function handleDragEnd() { setDragIndex(null); setDragOverIndex(null); }
  async function saveSortOrder(items) {
    try { await fetch(`${SERVER_URL}/api/menu/items/sort-order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map((item, index) => ({ id: item.id, sort_order: index })) }) }); }
    catch (err) { console.error('Failed to save sort order:', err); }
  }

  const activeCatSubs = subcategories.filter(s => s.category_id === activeCategory);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>Menu Manager</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {menu.map(cat => (<button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={{ padding: '8px 20px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, background: activeCategory === cat.id ? '#1a1a2e' : '#e0e0e0', color: activeCategory === cat.id ? 'white' : '#555' }}>{cat.name} ({cat.items?.length || 0})</button>))}
        <button onClick={() => setShowSubcatManager(!showSubcatManager)} style={{ padding: '8px 16px', borderRadius: 20, border: '2px dashed #3b82f6', background: 'white', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>⊕ Sub-categories</button>
      </div>
      {showSubcatManager && (
        <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginBottom: 20, border: '1px solid #bfdbfe' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#1e40af', marginBottom: 12 }}>Manage Sub-categories</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <select value={activeCategory} onChange={e => setActiveCategory(Number(e.target.value))} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>{menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select>
            <input value={newSubcatName} onChange={e => setNewSubcatName(e.target.value)} placeholder="e.g. Wine, Curry, Stir-fried..." style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
            <button onClick={async () => { if (!newSubcatName) return; await addSubcategory(activeCategory, newSubcatName); setNewSubcatName(''); fetchMenu(); }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#3b82f6', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {activeCatSubs.map(sub => (<div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', borderRadius: 20, padding: '4px 12px', border: '1px solid #bfdbfe' }}><span style={{ fontSize: 13, color: '#1e40af', fontWeight: 500 }}>{sub.name}</span><button onClick={async () => { if (!confirm(`Delete "${sub.name}"?`)) return; await deleteSubcategory(sub.id); fetchMenu(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16 }}>×</button></div>))}
            {activeCatSubs.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>No sub-categories yet</span>}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#888' }}>{localItems.length > 0 && '≡ Drag to reorder'}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setShowScanner(true)} style={{ background: 'linear-gradient(135deg,#1a1a2e,#2d2a4a)', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>🤖 AI Scanner</button>
          <button onClick={openAddForm} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Item</button>
        </div>
      </div>
      {localItems.length === 0 ? <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60 }}>No items yet — click "+ Add Item" or use 🤖 AI Scanner</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {localItems.map((item, index) => {
            const subcat = subcategories.find(s => s.id === item.subcategory_id);
            const isDragging = dragIndex === index; const isOver = dragOverIndex === index;
            return (
              <div key={item.id} draggable onDragStart={e => handleDragStart(e, index)} onDragOver={e => handleDragOver(e, index)} onDrop={e => handleDrop(e, index)} onDragEnd={handleDragEnd}
                style={{ background: 'white', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.15)' : '0 1px 4px rgba(0,0,0,0.08)', opacity: isDragging ? 0.5 : 1, border: isOver ? '2px solid #3b82f6' : '2px solid transparent', cursor: 'grab' }}>
                <div style={{ color: '#ccc', fontSize: 18, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{[0,1,2].map(r => <div key={r} style={{ display: 'flex', gap: 3 }}><div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} /><div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} /></div>)}</div></div>
                <div style={{ flex: 1, opacity: item.is_available ? 1 : 0.5 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>{item.name}</div>
                  {item.name_alt && <div style={{ fontSize: 12, color: '#C9A84C', marginTop: 1 }}>{item.name_alt}</div>}
                  {subcat && <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginTop: 2 }}>📁 {subcat.name}</div>}
                  {item.description && <div style={{ fontSize: 13, color: '#888' }}>{item.description}</div>}
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e94560', marginTop: 2 }}>£{Number(item.price).toFixed(2)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onMouseDown={e => e.stopPropagation()}>
                  <button onClick={e => { e.stopPropagation(); toggleAvailable(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: item.is_available ? '#dcfce7' : '#fee2e2', color: item.is_available ? '#14532d' : '#991b1b' }}>{item.is_available ? 'Available' : 'Off menu'}</button>
                  <button onClick={e => { e.stopPropagation(); openModifiers(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fef9c3', color: '#713f12', fontWeight: 600, fontSize: 12 }}>Options</button>
                  <button onClick={e => { e.stopPropagation(); openEditForm(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>Edit</button>
                  <button onClick={async e => { e.stopPropagation(); if (!window.confirm(`Delete "${item.name}" permanently?`)) return; try { const res = await fetch(`${SERVER_URL}/api/menu/items/${item.id}`, { method: 'DELETE' }); const data = await res.json(); if (data.success) fetchMenu(); else alert('Delete failed: ' + (data.error || 'Unknown error')); } catch (err) { alert('Delete error: ' + err.message); } }} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontWeight: 600, fontSize: 12 }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showScanner && <AIScannerModal onClose={() => { fetchMenu(); setShowScanner(false); }} onImported={() => fetchMenu()} />}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: '#1a1a2e' }}>{editItem ? 'Edit Item' : 'Add New Item'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Category</label><select value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value, subcategory_id: null })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>{menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select></div>
              {subcategories.filter(s => s.category_id === Number(form.category_id)).length > 0 && (<div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Sub-category</label><select value={form.subcategory_id || ''} onChange={e => setForm({ ...form, subcategory_id: e.target.value || null })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="">No sub-category</option>{subcategories.filter(s => s.category_id === Number(form.category_id)).map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}</select></div>)}
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Item name (English) *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Second language name <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label><input value={form.name_alt || ''} onChange={e => setForm({ ...form, name_alt: e.target.value })} placeholder="e.g. ไก่ผัดเม็ดมะม่วง" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #C9A84C', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Price (£) *</label><input value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} type="number" step="0.01" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}><button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button><button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>{editItem ? 'Save Changes' : 'Add Item'}</button></div>
          </div>
        </div>
      )}
      {modifierItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 520, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}><h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Options — {modifierItem.name}</h2><button onClick={() => setModifierItem(null)} style={{ background: '#f0f0f0', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600 }}>Close</button></div>
            {modifiers.map(group => (
              <div key={group.id} style={{ background: '#f8f8f8', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div><span style={{ fontWeight: 700, fontSize: 15 }}>{group.name}</span><span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{group.required ? 'Required' : 'Optional'} · {group.multi_select ? 'Multi' : 'Pick one'}</span></div>
                  <div style={{ display: 'flex', gap: 6 }}><button onClick={() => setActiveGroup(activeGroup === group.id ? null : group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#1a1a2e', color: 'white', fontSize: 12, fontWeight: 600 }}>+ Add option</button><button onClick={() => handleDeleteGroup(group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontSize: 12, fontWeight: 600 }}>Delete</button></div>
                </div>
                {group.modifiers?.map(opt => (<div key={opt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #eee' }}><span style={{ fontSize: 14 }}>{opt.name} {opt.extra_price > 0 && <span style={{ color: '#e94560' }}>+£{Number(opt.extra_price).toFixed(2)}</span>}</span><button onClick={() => handleDeleteOption(opt.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18 }}>×</button></div>))}
                {activeGroup === group.id && (<div style={{ display: 'flex', gap: 8, marginTop: 10 }}><input value={newOption.name} onChange={e => setNewOption({ ...newOption, name: e.target.value })} placeholder="Option name" style={{ flex: 2, padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }} /><input value={newOption.extra_price} onChange={e => setNewOption({ ...newOption, extra_price: e.target.value })} placeholder="+£ extra" type="number" step="0.01" style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }} /><button onClick={handleAddOption} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button></div>)}
              </div>
            ))}
            <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add new option group</div>
              <input value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} placeholder="e.g. Choose Meat" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', marginBottom: 10 }} />
              <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={newGroup.required} onChange={e => setNewGroup({ ...newGroup, required: e.target.checked })} /> Required</label><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={newGroup.multi_select} onChange={e => setNewGroup({ ...newGroup, multi_select: e.target.checked })} /> Allow multiple</label></div>
              <button onClick={handleAddGroup} style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Create Group</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
