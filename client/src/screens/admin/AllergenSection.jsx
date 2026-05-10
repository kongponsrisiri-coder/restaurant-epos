import { useState, useEffect, Fragment } from 'react';
import { SERVER_URL } from '../../api';
import { getAllMenu as getMenu } from '../../api';
import { invAPI } from './shared';

export default function AllergenSection() {
  const [menu,        setMenu]        = useState([]);
  const [recipes,     setRecipes]     = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [manualMap,   setManualMap]   = useState({});
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState({});
  const [syncing,     setSyncing]     = useState(false);

  const UK14 = [
    { code: 'Ce', name: 'Celery' },      { code: 'Gl', name: 'Gluten' },
    { code: 'Cr', name: 'Crustaceans' }, { code: 'Eg', name: 'Eggs' },
    { code: 'Fi', name: 'Fish' },        { code: 'Lu', name: 'Lupin' },
    { code: 'Mi', name: 'Milk' },        { code: 'Mo', name: 'Molluscs' },
    { code: 'Mu', name: 'Mustard' },     { code: 'Pn', name: 'Peanuts' },
    { code: 'Se', name: 'Sesame' },      { code: 'So', name: 'Soybeans' },
    { code: 'Su', name: 'Sulphites' },   { code: 'Nt', name: 'Tree Nuts' },
  ];

  // Normalise allergen names to match UK14 list (case-insensitive)
  const normaliseAllergen = (name) => {
    const n = (name || '').toLowerCase().trim();
    const match = UK14.find(a =>
      a.name.toLowerCase() === n ||
      a.code.toLowerCase() === n ||
      n.includes(a.name.toLowerCase())
    );
    return match ? match.name : null;
  };

  const parseAllergens = (raw) => {
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
      const set = new Set();
      arr.forEach(a => { const n = normaliseAllergen(a); if (n) set.add(n); });
      return set;
    } catch { return new Set(); }
  };

  useEffect(() => {
    Promise.all([
      getMenu(),
      invAPI.getRecipes(),
      invAPI.getIngredients(),
      fetch(`${SERVER_URL}/api/dish-allergens`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([m, r, i, d]) => {
      setMenu(Array.isArray(m) ? m : []);
      setRecipes(Array.isArray(r) ? r : []);
      setIngredients(Array.isArray(i) ? i : []);
      const map = {};
      (Array.isArray(d) ? d : []).forEach(row => {
        try { map[row.menu_item_id] = new Set(JSON.parse(row.allergens || '[]')); }
        catch { map[row.menu_item_id] = new Set(); }
      });
      setManualMap(map);
      setLoading(false);
    });
  }, []);

  // Build item lookup map
  const allCategories = Array.isArray(menu) ? menu : [];
  const menuItemMap   = {};
  allCategories.forEach(cat => { (cat.items || []).forEach(item => { menuItemMap[item.id] = item; }); });

  // ── Allergen source priority: recipe > manual > ai-scanned > none ──
  const getDishAllergens = (menuItemId) => {
    // 1. Auto from recipe lines → ingredients
    const recipe = recipes.find(r => r.menu_item_id === menuItemId);
    if (recipe && recipe.lines && recipe.lines.length > 0) {
      const set = new Set();
      recipe.lines.forEach(line => {
        const ing = ingredients.find(i => i.id === line.ingredient_id);
        if (ing) parseAllergens(ing.allergens).forEach(a => set.add(a));
      });
      return { allergens: set, source: 'recipe' };
    }

    // 2. Manually set in allergen screen (dish_allergens table)
    const manual = manualMap[menuItemId];
    if (manual && manual.size > 0) {
      return { allergens: manual, source: 'manual' };
    }

    // 3. AI scanner / batch import (menu_items.allergens)
    const menuItem = menuItemMap[menuItemId];
    if (menuItem?.allergens) {
      const scanned = parseAllergens(menuItem.allergens);
      if (scanned.size > 0) return { allergens: scanned, source: 'scanned' };
    }

    return { allergens: new Set(), source: 'none' };
  };

  // ── Toggle a single allergen (manual edit) ─────────────────────
  const toggleAllergen = async (menuItemId, allergenName) => {
    const recipe = recipes.find(r => r.menu_item_id === menuItemId);
    if (recipe && recipe.lines && recipe.lines.length > 0) return; // locked by recipe

    // Start from current allergens (manual or scanned), then toggle
    const { allergens: currentSet } = getDishAllergens(menuItemId);
    const current = new Set(currentSet);
    if (current.has(allergenName)) current.delete(allergenName);
    else current.add(allergenName);

    setManualMap(prev => ({ ...prev, [menuItemId]: current }));
    setSaving(prev => ({ ...prev, [menuItemId]: true }));
    try {
      await fetch(`${SERVER_URL}/api/dish-allergens/${menuItemId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allergens: JSON.stringify([...current]) }),
      });
    } catch (e) { console.error('Allergen save failed', e); }
    finally { setSaving(prev => ({ ...prev, [menuItemId]: false })); }
  };

  // ── Sync all AI-scanned allergens to dish_allergens in one go ──
  const syncAllScanned = async () => {
    const toSync = [];
    allCategories.forEach(cat => {
      (cat.items || []).forEach(item => {
        const { source } = getDishAllergens(item.id);
        // Only sync items that have scanned data but no manual/recipe yet
        if (source === 'scanned') {
          const scanned = parseAllergens(item.allergens);
          if (scanned.size > 0) toSync.push({ id: item.id, allergens: scanned });
        }
      });
    });
    if (toSync.length === 0) { alert('No AI-scanned allergens to sync — all items already have a recipe or manual entry.'); return; }
    if (!window.confirm(`Sync AI-scanned allergens for ${toSync.length} item${toSync.length !== 1 ? 's' : ''}? You can edit them individually afterwards.`)) return;

    setSyncing(true);
    try {
      await Promise.all(toSync.map(({ id, allergens }) =>
        fetch(`${SERVER_URL}/api/dish-allergens/${id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allergens: JSON.stringify([...allergens]) }),
        })
      ));
      // Update local manualMap
      const newMap = { ...manualMap };
      toSync.forEach(({ id, allergens }) => { newMap[id] = allergens; });
      setManualMap(newMap);
    } catch (e) { console.error('Sync failed', e); }
    finally { setSyncing(false); }
  };

  // ── Stats ──────────────────────────────────────────────────────
  const totalDishes  = allCategories.reduce((s, c) => s + (c.items || []).length, 0);
  const withRecipe   = allCategories.reduce((s, c) => s + (c.items || []).filter(i => getDishAllergens(i.id).source === 'recipe').length, 0);
  const withManual   = allCategories.reduce((s, c) => s + (c.items || []).filter(i => getDishAllergens(i.id).source === 'manual').length, 0);
  const withScanned  = allCategories.reduce((s, c) => s + (c.items || []).filter(i => getDishAllergens(i.id).source === 'scanned').length, 0);
  const notSet       = totalDishes - withRecipe - withManual - withScanned;

  return (
    <div style={{ padding: 24 }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          @page { size: A4 landscape; margin: 10mm; }
          .allergen-table-wrap { box-shadow: none !important; border-radius: 0 !important; max-height: none !important; overflow: visible !important; }
          thead th { position: static !important; }
        }
        .print-only { display: none; }
        .allergen-cell-empty:hover { background: #f5f5f5 !important; }
        .allergen-cell-contains:hover { opacity: 0.75; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }} className="no-print">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>🌿 Allergen Menu</h1>
          <p style={{ fontSize: 13, color: '#888', marginBottom: 0 }}>UK 14 mandatory allergens — compliant with Natasha's Law (2021)</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {withScanned > 0 && (
            <button onClick={syncAllScanned} disabled={syncing}
              style={{ padding: '12px 20px', borderRadius: 10, border: '2px solid #3b82f6', background: '#eff6ff', color: '#1e40af', fontWeight: 700, cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 14 }}>
              {syncing ? '⏳ Syncing…' : `🤖 Confirm AI Allergens (${withScanned})`}
            </button>
          )}
          <button onClick={() => window.print()}
            style={{ padding: '12px 24px', borderRadius: 10, border: '2px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
            🖨️ Print Allergen Sheet
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }} className="no-print">
        {[
          { label: 'Total dishes',       value: totalDishes, color: '#1a1a2e' },
          { label: '✅ Auto (recipe)',    value: withRecipe,  color: '#22c55e' },
          { label: '✏️ Set manually',     value: withManual,  color: '#eab308' },
          { label: '🤖 AI scanned',       value: withScanned, color: '#3b82f6' },
          { label: '⚠️ Not set yet',      value: notSet,      color: '#ef4444' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 10, padding: '10px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{s.label}</div>
          </div>
        ))}
        {withScanned > 0 && (
          <div style={{ background: '#eff6ff', borderRadius: 10, padding: '10px 16px', border: '1px solid #bfdbfe', fontSize: 13, color: '#1e40af', display: 'flex', alignItems: 'center', maxWidth: 320 }}>
            💡 <strong style={{ margin: '0 4px' }}>{withScanned} items</strong> have AI-scanned allergens. Review and click <strong style={{ margin: '0 4px' }}>Confirm AI Allergens</strong> to lock them in.
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }} className="no-print">
        {[
          { tick: '#ef4444', label: 'Red = Contains (auto from recipe)' },
          { tick: '#eab308', label: 'Yellow = Contains (set manually)' },
          { tick: '#3b82f6', label: 'Blue = AI scanned (click to edit)' },
        ].map(l => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#555' }}>
            <span style={{ display: 'inline-flex', width: 24, height: 24, borderRadius: 6, background: l.tick, color: 'white', fontSize: 14, fontWeight: 900, alignItems: 'center', justifyContent: 'center' }}>✓</span>
            {l.label}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#555' }}>
          <span style={{ display: 'inline-flex', width: 24, height: 24, borderRadius: 6, border: '2px dashed #ccc', color: '#ccc', fontSize: 12, alignItems: 'center', justifyContent: 'center' }}>○</span>
          Empty = Click to add
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#888' }}>Loading allergen data...</div>
      ) : (
        <div className="allergen-table-wrap" style={{ background: 'white', borderRadius: 12, overflow: 'auto', maxHeight: 'calc(100vh - 320px)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div className="print-only" style={{ padding: '16px 20px 0', borderBottom: '2px solid #1a1a2e', marginBottom: 4 }}>
            <div style={{ fontWeight: 900, fontSize: 22, color: '#1a1a2e' }}>ALLERGEN INFORMATION</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 4, marginBottom: 12 }}>Please inform a member of staff of any food allergies or intolerances before ordering. Dishes are prepared in a kitchen where all 14 allergens are handled.</div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: '14px 16px', textAlign: 'left', color: 'white', fontWeight: 700, fontSize: 13, minWidth: 220, position: 'sticky', top: 0, left: 0, zIndex: 5, background: '#1a1a2e', borderRight: '2px solid rgba(255,255,255,0.2)', boxShadow: '2px 2px 0 rgba(0,0,0,0.1)' }}>DISH</th>
                {UK14.map(a => (
                  <th key={a.code} style={{ padding: '8px 4px', textAlign: 'center', color: 'white', width: 46, minWidth: 46, position: 'sticky', top: 0, zIndex: 4, background: '#1a1a2e', boxShadow: '0 2px 0 rgba(0,0,0,0.1)' }}>
                    <div style={{ fontWeight: 900, fontSize: 12, lineHeight: 1.2 }}>{a.code}</div>
                    <div style={{ fontSize: 8, opacity: 0.6, fontWeight: 400, marginTop: 3, lineHeight: 1.3 }}>{a.name}</div>
                  </th>
                ))}
                <th style={{ padding: '14px 8px', color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 400, whiteSpace: 'nowrap', minWidth: 90, position: 'sticky', top: 0, zIndex: 4, background: '#1a1a2e', boxShadow: '0 2px 0 rgba(0,0,0,0.1)' }} className="no-print">SOURCE</th>
              </tr>
            </thead>
            <tbody>
              {allCategories.map(cat => {
                const items = cat.items || [];
                if (items.length === 0) return null;
                return (
                  <Fragment key={cat.id}>
                    <tr>
                      <td colSpan={UK14.length + 2} style={{ padding: '7px 16px', background: '#f0f0f0', fontWeight: 800, fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 1.5, borderTop: '2px solid #e0e0e0', borderBottom: '1px solid #e0e0e0', position: 'sticky', left: 0 }}>
                        {cat.name}
                      </td>
                    </tr>
                    {items.map((item, rowIndex) => {
                      const { allergens: allergenSet, source } = getDishAllergens(item.id);
                      const fromRecipe  = source === 'recipe';
                      const fromScanned = source === 'scanned';
                      const isEditable  = !fromRecipe;
                      const isSaving    = saving[item.id];
                      const rowBg       = rowIndex % 2 === 0 ? 'white' : '#fafafa';

                      // Tick colour by source
                      const tickColor = fromRecipe ? '#ef4444' : fromScanned ? '#3b82f6' : '#eab308';
                      const cellBg    = fromRecipe ? '#fee2e2' : fromScanned ? '#eff6ff' : '#fef9c3';

                      return (
                        <tr key={item.id} style={{ background: rowBg }}>
                          <td style={{ padding: '9px 16px', fontWeight: 600, color: '#1a1a2e', fontSize: 13, position: 'sticky', left: 0, zIndex: 2, background: rowBg, borderRight: '2px solid #eee', boxShadow: '2px 0 4px rgba(0,0,0,0.04)', borderBottom: '1px solid #f3f3f3' }}>
                            <div style={{ lineHeight: 1.3 }}>{item.name}</div>
                            {item.name_alt && <div style={{ fontSize: 10, color: '#C9A84C', marginTop: 1 }}>{item.name_alt}</div>}
                            {isSaving && <div style={{ fontSize: 9, color: '#aaa', marginTop: 2 }}>saving...</div>}
                          </td>
                          {UK14.map(a => {
                            const contains = allergenSet.has(a.name);
                            return (
                              <td key={a.code}
                                onClick={() => isEditable && toggleAllergen(item.id, a.name)}
                                className={contains ? 'allergen-cell-contains' : isEditable ? 'allergen-cell-empty' : ''}
                                title={fromRecipe
                                  ? `${a.name}: ${contains ? 'Contains (auto from recipe)' : 'Not in recipe'}`
                                  : fromScanned && contains
                                  ? `${a.name}: AI scanned — click to remove`
                                  : `${a.name}: ${contains ? 'Click to REMOVE' : 'Click to ADD'}`}
                                style={{ textAlign: 'center', padding: '7px 3px', cursor: isEditable ? 'pointer' : 'default', background: contains ? cellBg : 'transparent', borderBottom: '1px solid #f3f3f3', borderRight: '1px solid #f5f5f5' }}>
                                {contains ? (
                                  <span style={{ display: 'inline-flex', width: 26, height: 26, borderRadius: 6, background: tickColor, color: 'white', fontSize: 15, fontWeight: 900, alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}>✓</span>
                                ) : isEditable ? (
                                  <span style={{ display: 'inline-flex', width: 26, height: 26, borderRadius: 6, border: '2px dashed #d0d0d0', color: '#ccc', fontSize: 13, alignItems: 'center', justifyContent: 'center' }}>○</span>
                                ) : null}
                              </td>
                            );
                          })}
                          <td style={{ padding: '9px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid #f3f3f3' }} className="no-print">
                            {fromRecipe  ? <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 700 }}>✅ recipe</span>
                            : source === 'manual'  ? <span style={{ fontSize: 11, color: '#eab308', fontWeight: 700 }}>✏️ manual</span>
                            : fromScanned ? <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 700 }}>🤖 AI scan</span>
                            : <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>⚠️ not set</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <div style={{ padding: '12px 16px', fontSize: 10, color: '#888', textAlign: 'center', borderTop: '1px solid #f0f0f0', background: 'white', position: 'sticky', bottom: 0 }}>
            ✓ = Contains allergen | Ce=Celery Gl=Gluten Cr=Crustaceans Eg=Eggs Fi=Fish Lu=Lupin Mi=Milk Mo=Molluscs Mu=Mustard Pn=Peanuts Se=Sesame So=Soybeans Su=Sulphites Nt=Tree Nuts
            <br />Printed {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}.
          </div>
        </div>
      )}
    </div>
  );
}
