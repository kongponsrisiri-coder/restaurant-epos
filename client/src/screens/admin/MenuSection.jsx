import { useState, useEffect, useRef } from 'react';
import { SERVER_URL, authHeaders } from '../../api';
import {
  getAllMenu as getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getItemModifiers, addModifierGroup, addModifierOption,
  deleteModifierGroup, deleteModifier,
  getModifierLibrary, createLibraryGroup, attachGroupToItem, detachGroupFromItem,
  getSubcategories, addSubcategory, deleteSubcategory, updateCategory, deleteCategory,
  updateCategoryBar, updateCategorySortOrder, updateSubcategorySortOrder, updateMenuItemsSortOrder,
  addCategory, updateCategoryDefaultCourse,
  createDietaryPreset,
  getPrinters, setCategoryPrinter,
  assertOk,
} from '../../api';
import { confirm } from '../../utils/confirm';

// ── Add-option row (SEPOS-059) ────────────────────────────────────
// Self-contained so the input's state is LOCAL. Previously the option-name
// field lived in a shared parent state INSIDE modifiers.map(), so anything that
// re-rendered the modal could interrupt typing ("can't type the name"). Keeping
// state here means each keystroke only re-renders this little row. autoFocus
// also focuses the field the moment "+ Add option" is tapped — which pops the
// on-screen keyboard on a touchscreen till. Enter submits for fast entry.
function OptionAdder({ onAdd }) {
  const [name, setName]   = useState('');
  const [price, setPrice] = useState('');
  const submit = () => {
    const n = name.trim();
    if (!n) return alert('Option name is required!');
    onAdd(n, price);
    setName('');
    setPrice('');
  };
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={onKey} placeholder="Option name" style={{ flex: '2 1 160px', minWidth: 0, padding: '13px 14px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16 }} />
      <input value={price} onChange={e => setPrice(e.target.value)} onKeyDown={onKey} placeholder="+£ extra" type="number" step="0.01" style={{ flex: '1 1 90px', minWidth: 0, padding: '13px 14px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16 }} />
      <button onClick={submit} style={{ padding: '13px 20px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>Add</button>
    </div>
  );
}

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
      const res = await fetch(`${SERVER_URL}/api/ai/scan-menu`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ image_base64: base64, media_type }) });
      clearInterval(interval); setScanStep(SCAN_STEPS.length);
      const data = await res.json();
      if (!res.ok || !data.success) {
        // SEPOS-046h — surface upstream Anthropic diagnostic so the operator
        // knows whether to rotate the key, retry, or report a model change.
        const detail = data.upstream_status
          ? ` (upstream ${data.upstream_status})`
          : '';
        throw new Error((data.error || 'Scan failed') + detail);
      }
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
      await fetch(`${SERVER_URL}/api/menu/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: dish.name_en, name_alt: dish.name_th || '', description: dish.description || '', price: parseFloat(dish.price) || 0, category_id: firstCategoryId, subcategory_id: null, allergens: dish.allergens || [] }) });
      setAddedItems(prev => new Set([...prev, globalIndex])); onImported();
    } catch { alert('Failed to add item — try again'); }
    finally { setLoadingItem(null); }
  }

  const allDishes = scannedMenu?.categories?.flatMap(c => c.dishes) || [];
  const addedCount = addedItems.size;

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.4)' }}>
        <div style={{ background: 'linear-gradient(135deg,var(--brand-primary, #1a1a2e),#2d2a4a)', padding: '20px 28px', borderRadius: '20px 20px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 10 }}>
          <div><div style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>🤖 AI Menu Scanner</div><div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>Upload a menu photo → AI extracts dishes → Add items one by one</div></div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', borderRadius: 8, width: 34, height: 34, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ padding: 28 }}>
          {stage === 'upload' && (
            <div>
              {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>⚠️ {error}</div>}
              <div onClick={() => fileInputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }} style={{ border: `2px dashed ${file ? '#22c55e' : 'var(--brand-accent,#C9A84C)'}`, borderRadius: 16, padding: '40px 24px', textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: file ? '#f0fdf4' : '#fffdf0' }}>
                <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
                {file ? (<div>{file.type.startsWith('image/') && fileData && <img src={fileData} alt="preview" style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 10, marginBottom: 12, objectFit: 'contain' }} />}<div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div><div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div></div>
                ) : (<div><div style={{ fontSize: 40, marginBottom: 12 }}>📷</div><div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop menu photo here or click to upload</div><div style={{ color: '#888', fontSize: 13 }}>JPG, PNG, or PDF · Phone photos work great</div></div>)}
              </div>
              <div style={{ display: 'flex', gap: 10 }}><button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>Cancel</button><button onClick={runScan} disabled={!file} style={{ flex: 2, padding: '12px', borderRadius: 10, border: 'none', background: file ? 'var(--brand-primary, #1a1a2e)' : '#ddd', color: file ? 'white' : '#aaa', cursor: file ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 15 }}>🔍 Scan with AI</button></div>
            </div>
          )}
          {stage === 'scanning' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ width: 52, height: 52, border: '4px solid #f0f0f0', borderTop: '4px solid var(--brand-accent,#C9A84C)', borderRadius: '50%', margin: '0 auto 20px', animation: 'spin 0.8s linear infinite' }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>AI is reading your menu…</div>
              <div style={{ color: '#888', fontSize: 13, marginBottom: 28 }}>This usually takes 15–30 seconds</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340, margin: '0 auto' }}>
                {SCAN_STEPS.map((step, i) => (<div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 8, fontSize: 13, background: i < scanStep ? '#f0fdf4' : i === scanStep ? '#fffdf0' : 'transparent', color: i < scanStep ? '#15803d' : i === scanStep ? 'var(--brand-accent,#C9A84C)' : '#aaa', fontWeight: i === scanStep ? 700 : 400 }}><span>{i < scanStep ? '✓' : i === scanStep ? '⏳' : '○'}</span>{step}</div>))}
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
                {(() => { let globalIndex = 0; return scannedMenu.categories?.map(cat => (<div key={cat.name}><div style={{ background: 'var(--brand-primary, #1a1a2e)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ color: 'var(--brand-accent,#C9A84C)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{cat.name}</span><span style={{ background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 11, padding: '1px 8px', borderRadius: 10 }}>{cat.dishes?.length} items</span></div>{cat.dishes?.map((dish) => { const idx = globalIndex++; const isAdded = addedItems.has(idx); const isLoading = loadingItem === idx; return (<div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #f0f0f0', background: isAdded ? '#f0fdf4' : 'white' }}><div style={{ flex: 1 }}><div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}><span style={{ fontWeight: 700, fontSize: 14, color: 'var(--brand-primary, #1a1a2e)' }}>{dish.name_en}</span>{dish.name_th && <span style={{ fontSize: 12, color: 'var(--brand-accent,#C9A84C)' }}>{dish.name_th}</span>}</div>{dish.description && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{dish.description}</div>}<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}><span style={{ fontWeight: 800, color: '#e94560', fontSize: 14 }}>£{(dish.price || 0).toFixed(2)}</span>{dish.allergens?.length > 0 && dish.allergens.map(a => (<span key={a} style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>{a}</span>))}</div></div><button onClick={() => !isAdded && !isLoading && handleAddItem(dish, idx)} disabled={isAdded || isLoading} style={{ width: 40, height: 40, borderRadius: 10, border: 'none', cursor: isAdded ? 'default' : 'pointer', fontWeight: 800, fontSize: 20, flexShrink: 0, background: isAdded ? '#dcfce7' : isLoading ? '#f0f0f0' : '#e94560', color: isAdded ? '#15803d' : isLoading ? '#aaa' : 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isAdded ? '✓' : isLoading ? '⏳' : '+'}</button></div>); })}</div>)); })()}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={() => { setStage('upload'); setScannedMenu(null); setAddedItems(new Set()); }} style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Scan Again</button>
                <button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: addedCount > 0 ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0', color: addedCount > 0 ? 'white' : '#aaa', cursor: 'pointer', fontWeight: 700 }}>{addedCount > 0 ? `✓ Done — ${addedCount} item${addedCount > 1 ? 's' : ''} added` : 'Close'}</button>
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
  const [library, setLibrary]               = useState([]);  // SEPOS-059 reusable groups
  const [printers, setPrinters]             = useState([]);  // SEPOS-STATION-001 extra printer stations
  const [newGroup, setNewGroup]             = useState({ name: '', required: true, multi_select: false });
  const [activeGroup, setActiveGroup]       = useState(null);
  const [pickGroup, setPickGroup]           = useState(''); // shared-group dropdown selection
  const [showSubcatManager, setShowSubcatManager] = useState(false);
  const [newSubcatName, setNewSubcatName]   = useState('');
  // SEPOS-046s — in-flight guard for the Add Sub-category button so a slow
  // POST can't be double-fired into a duplicate row. Same pattern would
  // help the per-chip delete + add-category buttons but Add Sub is where
  // Korakot kept hitting it.
  const [subcatBusy, setSubcatBusy]         = useState(false);
  const [newCatName, setNewCatName]         = useState('');
  const [showAddCat, setShowAddCat]         = useState(false);
  // SEPOS-046n — inline rename state for the active category chip
  const [editingCatId, setEditingCatId]     = useState(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [dragIndex, setDragIndex]           = useState(null);  // holds the dragged item's ID
  const [dragOverIndex, setDragOverIndex]   = useState(null);  // holds the hovered item's ID
  const [subFilter, setSubFilter]           = useState(null);  // null=all, id=that sub-cat, '__none__'=un-filed
  const [localItems, setLocalItems]         = useState([]);

  const fetchMenu = async () => {
    const data = await getMenu(); const subs = await getSubcategories();
    setMenu(data); setSubcategories(subs);
    if (data.length > 0 && !activeCategory) setActiveCategory(data[0].id);
  };
  useEffect(() => { fetchMenu(); }, []);
  useEffect(() => { getPrinters().then(p => setPrinters(Array.isArray(p) ? p : [])).catch(() => {}); }, []);
  useEffect(() => { const items = menu.find(c => c.id === activeCategory)?.items || []; setLocalItems([...items]); }, [activeCategory, menu]);
  useEffect(() => { setSubFilter(null); }, [activeCategory]);  // sub-cat filter is per-category

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    const cat = await addCategory(newCatName.trim());
    setNewCatName(''); setShowAddCat(false);
    await fetchMenu();
    if (cat?.id) setActiveCategory(cat.id);
  };

  const openAddForm  = () => { setForm({ name: '', description: '', price: '', category_id: activeCategory, subcategory_id: null, vat_rate: 20, default_course: '' }); setEditItem(null); setShowForm(true); };
  const openEditForm = (item) => { setForm({ name: item.name, name_alt: item.name_alt || '', description: item.description || '', price: item.price, category_id: item.category_id, subcategory_id: item.subcategory_id || null, vat_rate: item.vat_rate ?? 20, default_course: item.default_course ?? '' }); setEditItem(item); setShowForm(true); };

  // SEPOS-046v — optimistic item save. Reflects the change in local menu
  // state immediately (including moving the item between categories when
  // category_id changes), then fires the network request in background.
  // No fetchMenu reconcile — it'd read stale local SQLite and could
  // revive the old position. Rollback to true state only on error.
  const handleSave = async () => {
    if (!form.name || !form.price) return alert('Name and price are required!');
    if (editItem) {
      const newCatId = Number(form.category_id);
      // Optimistic: rebuild each category's items array; remove the edited
      // item everywhere, then append the patched item to its new category.
      setMenu(prev => prev.map(cat => {
        const without = (cat.items || []).filter(it => it.id !== editItem.id);
        if (cat.id !== newCatId) return { ...cat, items: without };
        const patched = { ...editItem, ...form, id: editItem.id, category_id: newCatId, is_available: 1 };
        return { ...cat, items: [...without, patched] };
      }));
      setShowForm(false);
      try { assertOk(await updateMenuItem(editItem.id, { ...form, is_available: 1 })); }
      catch (err) { alert('Save failed: ' + (err?.message || 'unknown')); fetchMenu(); }
    } else {
      // ADD: insert with a temp negative id, then patch the id with the
      // server's response when it arrives.
      const tempId = -Date.now();
      const newCatId = Number(form.category_id);
      const draft = { id: tempId, ...form, category_id: newCatId, is_available: 1, is_online: 1 };
      setMenu(prev => prev.map(cat => cat.id === newCatId
        ? { ...cat, items: [...(cat.items || []), draft] }
        : cat));
      setShowForm(false);
      try {
        const res = assertOk(await addMenuItem(form));
        if (res?.id) {
          setMenu(prev => prev.map(cat => ({
            ...cat,
            items: (cat.items || []).map(it => it.id === tempId ? { ...it, id: res.id } : it),
          })));
        }
      } catch (err) {
        alert('Add failed: ' + (err?.message || 'unknown'));
        setMenu(prev => prev.map(cat => ({ ...cat, items: (cat.items || []).filter(it => it.id !== tempId) })));
      }
    }
  };

  const toggleAvailable = async (item) => {
    const next = item.is_available ? 0 : 1;
    setMenu(prev => prev.map(cat => ({
      ...cat,
      items: (cat.items || []).map(it => it.id === item.id ? { ...it, is_available: next } : it),
    })));
    try { assertOk(await updateMenuItem(item.id, { ...item, is_available: next })); }
    catch (err) { alert('Could not update — check connection.'); fetchMenu(); }
  };

  const toggleOnline = async (item) => {
    const next = (item.is_online === 0) ? 1 : 0;
    setMenu(prev => prev.map(cat => ({
      ...cat,
      items: (cat.items || []).map(it => it.id === item.id ? { ...it, is_online: next } : it),
    })));
    try { assertOk(await updateMenuItem(item.id, { ...item, is_online: next })); }
    catch (err) { alert('Could not update — check connection.'); fetchMenu(); }
  };
  const openModifiers   = async (item) => { setModifierItem(item); setActiveGroup(null); const [data, lib] = await Promise.all([getItemModifiers(item.id), getModifierLibrary()]); setModifiers(data); setLibrary(Array.isArray(lib) ? lib : []); };
  const refreshModifiers = async () => { const [data, lib] = await Promise.all([getItemModifiers(modifierItem.id), getModifierLibrary()]); setModifiers(data); setLibrary(Array.isArray(lib) ? lib : []); };
  // SEPOS-059 — create a reusable (library) group and auto-attach to this dish,
  // or a one-off dish-specific group, depending on the "Reusable" tick.
  const handleAddGroup  = async () => {
    if (!newGroup.name) return alert('Group name is required!');
    if (newGroup.shared) {
      const r = await createLibraryGroup({ name: newGroup.name, required: newGroup.required, multi_select: newGroup.multi_select });
      if (r?.id) await attachGroupToItem(modifierItem.id, r.id);
    } else {
      await addModifierGroup(modifierItem.id, newGroup);
    }
    setNewGroup({ name: '', required: true, multi_select: false, shared: false });
    await refreshModifiers();
  };
  // Tick/untick a library group for this dish (attach/detach the link).
  const toggleLibrary = async (groupId, attached) => {
    if (attached) await detachGroupFromItem(modifierItem.id, groupId);
    else await attachGroupToItem(modifierItem.id, groupId);
    await refreshModifiers();
  };
  const handleAddOption = async (name, extra_price) => { await addModifierOption(activeGroup, { name, extra_price: extra_price || 0 }); await refreshModifiers(); };
  // SEPOS-ALLERGEN-OPT-001 — one-tap standard GLOBAL dietary/allergen group.
  const handleAddDietaryPreset = async () => {
    try {
      const r = await createDietaryPreset();
      await refreshModifiers();
      if (r && r.created === false) alert('The standard dietary group already exists — it applies to every dish.');
    } catch (e) { alert('Could not add dietary group: ' + (e.message || e)); }
  };
  const handleDeleteGroup  = async (groupId) => { if (!await confirm('Delete this group and all its options?', { danger: true, okLabel: 'Delete' })) return; await deleteModifierGroup(groupId); await refreshModifiers(); if (activeGroup === groupId) setActiveGroup(null); };
  // SEPOS-059 — delete a SHARED (reusable) group from the library entirely. It's
  // removed from every dish that uses it, so warn clearly. (Detaching from just
  // one dish is the "Remove" button on an attached group.)
  const handleDeleteLibraryGroup = async (g) => { if (!await confirm(`Delete the shared group "${g.name}"?\n\nThis removes it from EVERY dish that uses it — not just this one.`, { danger: true, okLabel: 'Delete everywhere' })) return; await deleteModifierGroup(g.id); await refreshModifiers(); };
  const handleDeleteOption = async (optionId) => { await deleteModifier(optionId); setModifiers(await getItemModifiers(modifierItem.id)); };

  // Item-based drag (dragIndex/dragOverIndex hold item IDs) so a sub-category
  // filter can show a subset yet still reorder within the FULL category list,
  // preserving every other item's relative position.
  function handleDragStart(e, item) { setDragIndex(item.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(item.id)); }
  function handleDragOver(e, item)  { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIndex(item.id); }
  function handleDrop(e, dropItem) {
    e.preventDefault();
    const dragId = dragIndex;
    if (dragId == null || dragId === dropItem.id) { setDragIndex(null); setDragOverIndex(null); return; }
    const from = localItems.findIndex(i => i.id === dragId);
    const to   = localItems.findIndex(i => i.id === dropItem.id);
    if (from < 0 || to < 0) { setDragIndex(null); setDragOverIndex(null); return; }
    const newItems = [...localItems]; const [moved] = newItems.splice(from, 1); newItems.splice(to, 0, moved);
    setLocalItems(newItems); setDragIndex(null); setDragOverIndex(null); saveSortOrder(newItems);
  }
  function handleDragEnd() { setDragIndex(null); setDragOverIndex(null); }
  async function saveSortOrder(items) {
    // Use the api.js helper (native-safe) — a raw fetch from the Sunmi WebView
    // silently fails, so the drag reorder never persisted and reverted on reload.
    try {
      // 1-based: the boot migration (database.js) resets sort_order=0 → id,
      // treating 0 as "never arranged". Starting at 1 keeps the item you drag
      // to the top from being clobbered back to its id on the next restart.
      const res = await updateMenuItemsSortOrder(items.map((item, index) => ({ id: item.id, sort_order: index + 1 })));
      if (res && res.error) console.error('Failed to save sort order:', res.error);
    } catch (err) { console.error('Failed to save sort order:', err); }
  }

  const activeCatSubs = subcategories.filter(s => s.category_id === activeCategory);
  // Sub-category filter for the item list. Drag-reorder still works on the full
  // localItems (item-based), so filtering here only changes what's shown.
  const hasUnfiled = localItems.some(i => !i.subcategory_id);
  const displayItems = subFilter == null ? localItems
    : subFilter === '__none__' ? localItems.filter(i => !i.subcategory_id)
    : localItems.filter(i => i.subcategory_id === subFilter);

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 20 }}>Menu Manager</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {menu.map((cat, catIdx) => {
          const itemCount = cat.items?.length || 0;
          const isActive  = activeCategory === cat.id;
          const isEditing = editingCatId === cat.id;
          const canDelete = isActive && itemCount === 0 && !isEditing;
          const canEdit   = isActive && !isEditing;
          const isBar     = Number(cat.is_bar) === 1;
          const canMoveLeft  = isActive && !isEditing && catIdx > 0;
          const canMoveRight = isActive && !isEditing && catIdx < menu.length - 1;
          const swapAt = async (otherIdx) => {
            const reordered = [...menu];
            [reordered[catIdx], reordered[otherIdx]] = [reordered[otherIdx], reordered[catIdx]];
            try {
              await updateCategorySortOrder(reordered.map((c, i) => ({ id: c.id, sort_order: i })));
              fetchMenu();
            } catch (err) {
              alert('Could not reorder: ' + (err?.message || 'unknown error'));
            }
          };
          const toggleBar = async () => {
            try {
              await updateCategoryBar(cat.id, isBar ? 0 : 1);
              fetchMenu();
            } catch (err) {
              alert('Could not toggle bar: ' + (err?.message || 'unknown error'));
            }
          };
          const saveRename = async () => {
            const trimmed = editingCatName.trim();
            if (!trimmed || trimmed === cat.name) { setEditingCatId(null); return; }
            try {
              const res = await updateCategory(cat.id, trimmed);
              if (res?.error) { alert(res.error); return; }
              setEditingCatId(null);
              fetchMenu();
            } catch (err) {
              alert('Could not rename: ' + (err?.message || 'unknown error'));
            }
          };
          return (
          <div key={cat.id} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 20, overflow: 'hidden' }}>
              {isEditing ? (
                <>
                  <input
                    autoFocus value={editingCatName}
                    onChange={e => setEditingCatName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setEditingCatId(null); }}
                    onBlur={saveRename}
                    style={{ padding: '8px 16px', border: '2px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 600, fontSize: 14, borderRadius: 20, outline: 'none', width: 140 }}
                  />
                </>
              ) : (
                <>
                  {canMoveLeft && (
                    <button onClick={() => swapAt(catIdx - 1)} title="Move category left" style={{ padding: '0 10px', border: 'none', cursor: 'pointer', fontWeight: 800, background: 'var(--brand-primary, #1a1a2e)', color: 'white', borderRadius: '20px 0 0 20px', fontSize: 12 }}>◀</button>
                  )}
                  <button onClick={() => setActiveCategory(cat.id)} style={{ padding: '8px 20px', border: 'none', cursor: 'pointer', fontWeight: 600, background: isActive ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0', color: isActive ? 'white' : '#555', borderRadius: canMoveLeft ? 0 : ((canEdit || canMoveRight) ? '20px 0 0 20px' : 20) }}>{isBar ? '🍹 ' : ''}{cat.name} ({itemCount})</button>
                  {canEdit && (
                    <button
                      onClick={toggleBar}
                      title={isBar ? 'Stop routing to bar printer (set is_bar=0)' : 'Send this category to the bar printer (set is_bar=1) — for Drinks, Cocktails, etc.'}
                      style={{ padding: '0 10px', border: 'none', borderLeft: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', fontWeight: 800, background: isBar ? '#7c2d12' : 'var(--brand-primary, #1a1a2e)', color: isBar ? '#fde68a' : '#888', fontSize: 13 }}
                    >🍹</button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() => { setEditingCatName(cat.name); setEditingCatId(cat.id); }}
                      title="Rename this category"
                      style={{ padding: '0 10px', border: 'none', borderLeft: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', fontWeight: 800, background: 'var(--brand-primary, #1a1a2e)', color: 'var(--brand-accent,#C9A84C)', fontSize: 13 }}
                    >✎</button>
                  )}
                  {canDelete && (
                    <button
                      onClick={async () => {
                        if (!await confirm(`Delete category "${cat.name}"? It has no items, so this is safe.`)) return;
                        try {
                          const res = await deleteCategory(cat.id);
                          if (res?.error) { alert(res.error); return; }
                          setActiveCategory(menu.find(c => c.id !== cat.id)?.id || null);
                          fetchMenu();
                        } catch (err) {
                          alert('Could not delete: ' + (err?.message || 'unknown error'));
                        }
                      }}
                      title="Delete this empty category"
                      style={{ padding: '0 12px', border: 'none', borderLeft: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', fontWeight: 800, background: '#991b1b', color: 'white', fontSize: 14 }}
                    >🗑️</button>
                  )}
                  {canMoveRight && (
                    <button onClick={() => swapAt(catIdx + 1)} title="Move category right" style={{ padding: '0 10px', border: 'none', borderLeft: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', fontWeight: 800, background: 'var(--brand-primary, #1a1a2e)', color: 'white', borderRadius: '0 20px 20px 0', fontSize: 12 }}>▶</button>
                  )}
                </>
              )}
            </div>
            <select
              value={cat.default_course || 1}
              onChange={async e => { await updateCategoryDefaultCourse(cat.id, Number(e.target.value)); fetchMenu(); }}
              title="Which course does this appear as on the kitchen screen?"
              style={{ fontSize: 10, padding: '1px 4px', borderRadius: 6, border: '1px solid #ddd', background: ['','#fde68a','#bbf7d0','#fca5a5','#bfdbfe'][cat.default_course||1] || '#eee', cursor: 'pointer', fontWeight: 600, color: '#333' }}
            >
              <option value={1}>🟡 Starter</option>
              <option value={2}>🟢 Main</option>
              <option value={3}>🔴 Dessert</option>
              <option value={4}>🔵 Extra</option>
            </select>
            {/* SEPOS-STATION-001 — route this category to a printer station (only
                shown once stations exist; blank = default kitchen/bar routing). */}
            {printers.length > 0 && (
              <select
                value={cat.printer_id || ''}
                onChange={async e => { await setCategoryPrinter(cat.id, e.target.value ? Number(e.target.value) : null); fetchMenu(); }}
                title="Which printer station does this category print to?"
                style={{ fontSize: 10, padding: '1px 4px', borderRadius: 6, border: '1px solid #ddd', background: cat.printer_id ? '#e0e7ff' : '#eee', cursor: 'pointer', fontWeight: 600, color: '#333' }}
              >
                <option value="">🖨 Default</option>
                {printers.map(p => <option key={p.id} value={p.id}>🏭 {p.name}</option>)}
              </select>
            )}
          </div>
          );
        })}
        {showAddCat ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input autoFocus value={newCatName} onChange={e => setNewCatName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAddCategory(); if (e.key === 'Escape') { setShowAddCat(false); setNewCatName(''); } }} placeholder="Category name…" style={{ padding: '7px 12px', borderRadius: 20, border: '2px solid var(--brand-primary, #1a1a2e)', fontSize: 13, outline: 'none', width: 160 }} />
            <button onClick={handleAddCategory} style={{ padding: '7px 14px', borderRadius: 20, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Add</button>
            <button onClick={() => { setShowAddCat(false); setNewCatName(''); }} style={{ padding: '7px 12px', borderRadius: 20, border: 'none', background: '#e0e0e0', color: '#555', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>✕</button>
          </div>
        ) : (
          <button onClick={() => setShowAddCat(true)} style={{ padding: '8px 16px', borderRadius: 20, border: '2px dashed var(--brand-accent,#C9A84C)', background: 'white', color: 'var(--brand-accent,#C9A84C)', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>+ Category</button>
        )}
        <button onClick={() => setShowSubcatManager(!showSubcatManager)} style={{ padding: '8px 16px', borderRadius: 20, border: '2px dashed #3b82f6', background: 'white', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>⊕ Sub-categories</button>
      </div>
      {showSubcatManager && (
        <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginBottom: 20, border: '1px solid #bfdbfe' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#1e40af', marginBottom: 12 }}>Manage Sub-categories</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <select value={activeCategory} onChange={e => setActiveCategory(Number(e.target.value))} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>{menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select>
            <input
              value={newSubcatName}
              onChange={e => setNewSubcatName(e.target.value)}
              onKeyDown={async e => {
                if (e.key !== 'Enter') return;
                if (subcatBusy) return;
                const trimmed = newSubcatName.trim();
                if (!trimmed) return;
                setSubcatBusy(true);
                setNewSubcatName('');
                const tempId = -Date.now();
                setSubcategories(prev => [...prev, { id: tempId, category_id: activeCategory, name: trimmed }]);
                try {
                  // SEPOS-046u — replace the temp id with the server-returned
                  // canonical id. NO fetchMenu reconcile — that read from
                  // local SQLite which lags behind cloud by up to 5s, so
                  // it kept wiping the optimistic chip with stale data.
                  const res = assertOk(await addSubcategory(activeCategory, trimmed));
                  if (res?.id) {
                    setSubcategories(prev => prev.map(s => s.id === tempId ? { ...s, id: res.id } : s));
                  }
                }
                catch (err) {
                  alert('Could not add: ' + (err?.message || 'unknown'));
                  setNewSubcatName(trimmed);
                  setSubcategories(prev => prev.filter(s => s.id !== tempId));
                }
                finally { setSubcatBusy(false); }
              }}
              placeholder="e.g. Wine, Curry, Stir-fried..."
              disabled={subcatBusy}
              style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, opacity: subcatBusy ? 0.6 : 1 }}
            />
            <button
              disabled={subcatBusy || !newSubcatName.trim()}
              onClick={async () => {
                if (subcatBusy) return;
                const trimmed = newSubcatName.trim();
                if (!trimmed) return;
                setSubcatBusy(true);
                setNewSubcatName('');
                const tempId = -Date.now();
                setSubcategories(prev => [...prev, { id: tempId, category_id: activeCategory, name: trimmed }]);
                try {
                  // SEPOS-046u — server returns the canonical id; we patch
                  // it onto the optimistic chip in place. No fetchMenu
                  // reconcile (it would read stale local SQLite).
                  const res = assertOk(await addSubcategory(activeCategory, trimmed));
                  if (res?.id) {
                    setSubcategories(prev => prev.map(s => s.id === tempId ? { ...s, id: res.id } : s));
                  }
                }
                catch (err) {
                  alert('Could not add: ' + (err?.message || 'unknown'));
                  setNewSubcatName(trimmed);
                  setSubcategories(prev => prev.filter(s => s.id !== tempId));
                }
                finally { setSubcatBusy(false); }
              }}
              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: subcatBusy ? '#94a3b8' : '#3b82f6', color: 'white', cursor: subcatBusy ? 'wait' : 'pointer', fontWeight: 600, opacity: (subcatBusy || !newSubcatName.trim()) ? 0.6 : 1 }}
            >{subcatBusy ? '…' : 'Add'}</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {activeCatSubs.map((sub, subIdx) => {
              // SEPOS-046ab — ◀ ▶ reorder, same optimistic pattern as the
              // category arrows: resequence local state instantly, persist
              // in background, fetchMenu rollback only on error.
              const swapSub = async (otherIdx) => {
                const reordered = [...activeCatSubs];
                if (reordered.some(s => s.id < 0)) return alert('Still saving — try again in a second.');
                [reordered[subIdx], reordered[otherIdx]] = [reordered[otherIdx], reordered[subIdx]];
                const updates = reordered.map((s, i) => ({ id: s.id, sort_order: i }));
                const orderMap = Object.fromEntries(updates.map(u => [u.id, u.sort_order]));
                setSubcategories(prev => prev
                  .map(s => orderMap[s.id] !== undefined ? { ...s, sort_order: orderMap[s.id] } : s)
                  .sort((a, b) => (a.category_id - b.category_id) || ((a.sort_order || 0) - (b.sort_order || 0))));
                try { assertOk(await updateSubcategorySortOrder(updates)); }
                catch (err) { alert('Could not reorder: ' + (err?.message || 'unknown')); fetchMenu(); }
              };
              return (<div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', borderRadius: 20, padding: '4px 12px', border: '1px solid #bfdbfe' }}>
              {subIdx > 0 && <button onClick={() => swapSub(subIdx - 1)} title="Move left" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3b82f6', fontSize: 11, fontWeight: 800, padding: 0 }}>◀</button>}
              <span style={{ fontSize: 13, color: '#1e40af', fontWeight: 500 }}>{sub.name}</span>
              {subIdx < activeCatSubs.length - 1 && <button onClick={() => swapSub(subIdx + 1)} title="Move right" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3b82f6', fontSize: 11, fontWeight: 800, padding: 0 }}>▶</button>}
              <button onClick={async () => {
              if (!await confirm(`Delete "${sub.name}"?`)) return;
              // SEPOS-046t/u — optimistic delete. Chip already gone from
              // state — no fetchMenu reconcile (it'd read stale local
              // SQLite and could revive the chip). On failure, fetchMenu
              // rolls back to true state.
              setSubcategories(prev => prev.filter(s => s.id !== sub.id));
              try {
                assertOk(await deleteSubcategory(sub.id));
              } catch (err) {
                alert('Could not delete: ' + (err?.message || 'unknown error'));
                fetchMenu(); // rollback only on error
              }
            }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16 }}>×</button></div>);
            })}
            {activeCatSubs.length === 0 && <span style={{ color: '#94a3b8', fontSize: 13 }}>No sub-categories yet</span>}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#888' }}>{localItems.length > 0 && '≡ Drag to reorder'}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setShowScanner(true)} style={{ background: 'linear-gradient(135deg,var(--brand-primary, #1a1a2e),#2d2a4a)', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>🤖 AI Scanner</button>
          <button onClick={openAddForm} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Item</button>
        </div>
      </div>
      {/* SEPOS-MENU-SUBFILTER — click a sub-category to show only its dishes. */}
      {activeCatSubs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {[{ k: null, label: `All (${localItems.length})` },
            ...activeCatSubs.map(s => ({ k: s.id, label: `${s.name} (${localItems.filter(i => i.subcategory_id === s.id).length})` })),
            ...(hasUnfiled ? [{ k: '__none__', label: `No sub-category (${localItems.filter(i => !i.subcategory_id).length})` }] : [])
          ].map(({ k, label }) => {
            const on = subFilter === k;
            return <button key={String(k)} onClick={() => setSubFilter(k)} style={{ padding: '7px 14px', borderRadius: 16, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              border: on ? 'none' : '1px solid #ddd', background: on ? '#3b82f6' : '#fff', color: on ? '#fff' : '#555' }}>{label}</button>;
          })}
        </div>
      )}
      {displayItems.length === 0 ? <div style={{ textAlign: 'center', color: '#bbb', marginTop: 60 }}>{subFilter == null ? 'No items yet — click "+ Add Item" or use 🤖 AI Scanner' : 'No dishes in this sub-category.'}</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {displayItems.map((item) => {
            const subcat = subcategories.find(s => s.id === item.subcategory_id);
            const isDragging = dragIndex === item.id; const isOver = dragOverIndex === item.id;
            return (
              <div key={item.id} draggable onDragStart={e => handleDragStart(e, item)} onDragOver={e => handleDragOver(e, item)} onDrop={e => handleDrop(e, item)} onDragEnd={handleDragEnd}
                style={{ background: 'white', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.15)' : '0 1px 4px rgba(0,0,0,0.08)', opacity: isDragging ? 0.5 : 1, border: isOver ? '2px solid #3b82f6' : '2px solid transparent', cursor: 'grab' }}>
                <div style={{ color: '#ccc', fontSize: 18, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{[0,1,2].map(r => <div key={r} style={{ display: 'flex', gap: 3 }}><div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} /><div style={{ width: 4, height: 4, borderRadius: '50%', background: '#ccc' }} /></div>)}</div></div>
                <div style={{ flex: 1, opacity: item.is_available ? 1 : 0.5 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--brand-primary, #1a1a2e)' }}>{item.name}</div>
                  {item.name_alt && <div style={{ fontSize: 12, color: 'var(--brand-accent,#C9A84C)', marginTop: 1 }}>{item.name_alt}</div>}
                  {subcat && <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginTop: 2 }}>📁 {subcat.name}</div>}
                  {item.description && <div style={{ fontSize: 13, color: '#888' }}>{item.description}</div>}
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e94560', marginTop: 2 }}>£{Number(item.price).toFixed(2)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onMouseDown={e => e.stopPropagation()}>
                  <button onClick={e => { e.stopPropagation(); toggleAvailable(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: item.is_available ? '#dcfce7' : '#fee2e2', color: item.is_available ? '#14532d' : '#991b1b' }}>{item.is_available ? 'Available' : 'Off menu'}</button>
                  <button onClick={e => { e.stopPropagation(); toggleOnline(item); }} title={item.is_online === 0 ? 'Hidden from online ordering' : 'Visible on online ordering'} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: item.is_online === 0 ? '#e5e7eb' : '#dbeafe', color: item.is_online === 0 ? '#374151' : '#1e40af' }}>{item.is_online === 0 ? '🌐 Hidden' : '🌐 Online'}</button>
                  <button onClick={e => { e.stopPropagation(); openModifiers(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fef9c3', color: '#713f12', fontWeight: 600, fontSize: 12 }}>Options</button>
                  <button onClick={e => { e.stopPropagation(); openEditForm(item); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>Edit</button>
                  <button onClick={async e => {
                    e.stopPropagation();
                    if (!await confirm(`Delete "${item.name}" permanently?`)) return;
                    // SEPOS-046v — optimistic delete: drop the row from
                    // local menu state immediately; network DELETE runs
                    // in background. Rollback via fetchMenu only on error.
                    setMenu(prev => prev.map(cat => ({
                      ...cat,
                      items: (cat.items || []).filter(it => it.id !== item.id),
                    })));
                    try {
                      const res = await fetch(`${SERVER_URL}/api/menu/items/${item.id}`, { method: 'DELETE' });
                      const data = await res.json();
                      if (!data.success) { alert('Delete failed: ' + (data.error || 'Unknown error')); fetchMenu(); }
                    } catch (err) {
                      alert('Delete error: ' + err.message);
                      fetchMenu();
                    }
                  }} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontWeight: 600, fontSize: 12 }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showScanner && <AIScannerModal onClose={() => { fetchMenu(); setShowScanner(false); }} onImported={() => fetchMenu()} />}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: 'var(--brand-primary, #1a1a2e)' }}>{editItem ? 'Edit Item' : 'Add New Item'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Category</label><select value={form.category_id} onChange={e => setForm({ ...form, category_id: e.target.value, subcategory_id: null })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>{menu.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select></div>
              {subcategories.filter(s => s.category_id === Number(form.category_id)).length > 0 && (<div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Sub-category</label><select value={form.subcategory_id || ''} onChange={e => setForm({ ...form, subcategory_id: e.target.value || null })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="">No sub-category</option>{subcategories.filter(s => s.category_id === Number(form.category_id)).map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}</select></div>)}
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Item name (English) *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Second language name <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label><input value={form.name_alt || ''} onChange={e => setForm({ ...form, name_alt: e.target.value })} placeholder="e.g. ไก่ผัดเม็ดมะม่วง" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--brand-accent,#C9A84C)', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Description</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Price (£) *</label><input value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} type="number" step="0.01" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>VAT rate</label><select value={form.vat_rate ?? 20} onChange={e => setForm({ ...form, vat_rate: Number(e.target.value) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value={20}>20% (standard)</option><option value={5}>5% (reduced)</option><option value={0}>0% (zero rated)</option></select><div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Prices are VAT-inclusive — this affects the VAT breakdown on bills + reports.</div></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Kitchen course</label><select value={form.default_course ?? ''} onChange={e => setForm({ ...form, default_course: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="">Inherit from category</option><option value={1}>Starter</option><option value={2}>Main</option><option value={3}>Dessert</option><option value={4}>Extra</option></select><div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Set this for a mixed category (e.g. a Lunch menu) so this dish always prints on the right course — otherwise it follows the category.</div></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}><button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button><button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>{editItem ? 'Save Changes' : 'Add Item'}</button></div>
          </div>
        </div>
      )}
      {modifierItem && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 'min(640px, 94vw)', maxHeight: '86vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}><h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>Options — {modifierItem.name}</h2><button onClick={() => setModifierItem(null)} style={{ background: '#f0f0f0', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600 }}>Close</button></div>
            {modifiers.map(group => (
              <div key={group.id} style={{ background: '#f8f8f8', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div><span style={{ fontWeight: 700, fontSize: 15 }}>{group.name}</span>{(group.is_global || group.is_allergen) ? <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4 }}>{group.is_global ? 'GLOBAL' : ''}{group.is_global && group.is_allergen ? ' · ' : ''}{group.is_allergen ? '⚠️ ALLERGEN' : ''}</span> : (group.menu_item_id == null && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: '#e0e7ff', color: '#3730a3', padding: '2px 6px', borderRadius: 4 }}>♻️ SHARED</span>)}<span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{group.required ? 'Required' : 'Optional'} · {group.multi_select ? 'Multi' : 'Pick one'}</span></div>
                  <div style={{ display: 'flex', gap: 6 }}><button onClick={() => setActiveGroup(activeGroup === group.id ? null : group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontSize: 12, fontWeight: 600 }}>+ Add option</button>{group.menu_item_id == null ? <button onClick={() => toggleLibrary(group.id, true)} title="Remove from this dish (keeps the shared group for other dishes)" style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fde68a', color: '#713f12', fontSize: 12, fontWeight: 600 }}>Remove</button> : <button onClick={() => handleDeleteGroup(group.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#991b1b', fontSize: 12, fontWeight: 600 }}>Delete</button>}</div>
                </div>
                {group.modifiers?.map(opt => (<div key={opt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #eee' }}><span style={{ fontSize: 14 }}>{opt.name} {opt.extra_price > 0 && <span style={{ color: '#e94560' }}>+£{Number(opt.extra_price).toFixed(2)}</span>}</span><button onClick={() => handleDeleteOption(opt.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18 }}>×</button></div>))}
                {activeGroup === group.id && <OptionAdder key={group.id} onAdd={handleAddOption} />}
              </div>
            ))}
            {library.filter(g => !modifiers.some(m => m.id === g.id)).length > 0 && (
              <div style={{ background: '#eef2ff', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>♻️ Add a shared group</div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>Reusable groups you defined once. Pick one to add to this dish — edit the group once and every dish updates.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={pickGroup} onChange={e => setPickGroup(e.target.value)} style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #c7d2fe', fontSize: 13, background: 'white', cursor: 'pointer' }}>
                    <option value="">— Choose a shared group —</option>
                    {library.filter(g => !modifiers.some(m => m.id === g.id)).map(g => (
                      <option key={g.id} value={g.id}>{g.name} ({g.required ? 'Required' : 'Optional'}, {g.multi_select ? 'multi' : 'pick one'}) — {(g.modifiers || []).map(o => o.name).join(', ') || 'no options yet'}</option>
                    ))}
                  </select>
                  <button disabled={!pickGroup} onClick={() => { toggleLibrary(Number(pickGroup), false); setPickGroup(''); }} style={{ flexShrink: 0, padding: '10px 16px', borderRadius: 8, border: 'none', cursor: pickGroup ? 'pointer' : 'default', background: pickGroup ? 'var(--brand-primary, #1a1a2e)' : '#cbd5e1', color: 'white', fontWeight: 700, fontSize: 13 }}>Add</button>
                  <button disabled={!pickGroup} title="Delete this shared group everywhere" onClick={async () => { const g = library.find(x => String(x.id) === pickGroup); if (g) { await handleDeleteLibraryGroup(g); setPickGroup(''); } }} style={{ flexShrink: 0, padding: '10px 14px', borderRadius: 8, border: 'none', cursor: pickGroup ? 'pointer' : 'default', background: pickGroup ? '#fee2e2' : '#f1f5f9', color: '#991b1b', fontWeight: 700, fontSize: 13 }}>🗑️</button>
                </div>
              </div>
            )}
            <div style={{ background: '#f0f7ff', borderRadius: 12, padding: 16, marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add new option group</div>
              <input value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} placeholder="e.g. Choose Meat" style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', marginBottom: 10 }} />
              <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={newGroup.required} onChange={e => setNewGroup({ ...newGroup, required: e.target.checked })} /> Required</label><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={newGroup.multi_select} onChange={e => setNewGroup({ ...newGroup, multi_select: e.target.checked })} /> Allow multiple</label><label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#3730a3', fontWeight: 600 }} title="Save to the shared library so you can reuse it on other dishes"><input type="checkbox" checked={newGroup.shared || false} onChange={e => setNewGroup({ ...newGroup, shared: e.target.checked })} /> ♻️ Reusable</label></div>
              <button onClick={handleAddGroup} style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Create Group</button>
            </div>
            {/* SEPOS-ALLERGEN-OPT-001 — one-tap standard GLOBAL dietary/allergen group.
                Applies to EVERY dish; prints with ⚠️ emphasis; free (never a surcharge). */}
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: 16, marginTop: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2, color: '#92400e' }}>🧾 Dietary / allergen requests</div>
              <div style={{ fontSize: 12, color: '#78716c', marginBottom: 10 }}>A single global group (No nuts, Vegan, No shellfish…) that appears on <b>every</b> dish and prints with a ⚠️ on the kitchen ticket. Set it up once — safer than typing allergies into a note.</div>
              {modifiers.some(g => g.is_allergen) ? (
                <div style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>✓ Standard dietary group is set up — it's on every dish. Edit its options above.</div>
              ) : (
                <button onClick={handleAddDietaryPreset} style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: 'var(--brand-accent, #C9A84C)', color: 'white', cursor: 'pointer', fontWeight: 700 }}>🧾 Add standard dietary group</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
