import { useState, useEffect } from 'react';
import { getAllMenu as getMenu } from '../../../api';
import { invAPI, calcLineCost, fcBadge } from '../shared';

export default function RecipesTab() {
  const [menuItems, setMenuItems]   = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [recipe, setRecipe]         = useState(null);
  const [lines, setLines]           = useState([]);
  const [serves, setServes]         = useState(1);
  const [saving, setSaving]         = useState(false);
  const [allRecipes, setAllRecipes] = useState([]);
  const [newLine, setNewLine]       = useState({ ingredient_id: '', quantity_used: '', unit: 'kg' });

  useEffect(() => {
    Promise.all([getMenu(), invAPI.getIngredients(), invAPI.getRecipes()]).then(([menu, ings, recs]) => {
      const flatItems = (Array.isArray(menu) ? menu : []).flatMap(cat => cat.items || []);
      setMenuItems(flatItems);
      setIngredients(Array.isArray(ings) ? ings : []);
      setAllRecipes(Array.isArray(recs) ? recs : []);
    });
  }, []);

  const loadRecipe = async (item) => {
    setSelectedItem(item); setLines([]); setRecipe(null); setServes(1); setNewLine({ ingredient_id: '', quantity_used: '', unit: 'kg' });
    const data = await invAPI.getRecipeForItem(item.id);
    if (data) { setRecipe(data); setLines(data.lines || []); setServes(data.serves || 1); }
  };

  const recipeForItem = (itemId) => allRecipes.find(r => r.menu_item_id === itemId);

  const addLine = () => {
    if (!newLine.ingredient_id || !newLine.quantity_used) return alert('Select an ingredient and enter a quantity');
    const ing = ingredients.find(i => i.id === Number(newLine.ingredient_id));
    if (!ing) return;
    const lineCost = calcLineCost(newLine.quantity_used, ing.cost_per_unit, ing.yield_percentage);
    setLines(prev => [...prev, { ingredient_id: Number(newLine.ingredient_id), ingredient_name: ing.name_en, ingredient_name_th: ing.name_th, quantity_used: Number(newLine.quantity_used), unit: newLine.unit || ing.unit, cost_per_unit: ing.cost_per_unit, yield_percentage: ing.yield_percentage, line_cost: lineCost }]);
    setNewLine({ ingredient_id: '', quantity_used: '', unit: 'kg' });
  };

  const removeLine = (index) => setLines(prev => prev.filter((_, i) => i !== index));

  const totalCost      = lines.reduce((sum, l) => sum + (l.line_cost || 0), 0);
  const costPerPortion = serves > 0 ? totalCost / serves : 0;
  const menuPrice      = selectedItem ? Number(selectedItem.price) : 0;
  const foodCostPct    = menuPrice > 0 ? (costPerPortion / menuPrice) * 100 : 0;
  const grossProfit    = menuPrice - costPerPortion;
  const fc             = fcBadge(foodCostPct);

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
    } catch { alert('Save failed — has Krit built the recipes backend yet?'); }
    finally { setSaving(false); }
  };

  const UNITS = ['kg', 'g', 'L', 'ml', 'unit'];

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* Left panel — menu item list */}
      <div style={{ width: 280, flexShrink: 0 }}>
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>Menu Items ({menuItems.length})</div>
          {menuItems.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#bbb', fontSize: 13 }}>No menu items found</div>}
          {menuItems.map(item => {
            const rec = recipeForItem(item.id); const isSelected = selectedItem?.id === item.id;
            return (
              <div key={item.id} onClick={() => loadRecipe(item)} style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: isSelected ? '#f0f7ff' : 'white', borderLeft: isSelected ? '4px solid #3b82f6' : '4px solid transparent' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#1a1a2e' }}>{item.name}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e94560' }}>£{Number(item.price).toFixed(2)}</span>
                  {rec ? (<span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: fcBadge(rec.food_cost_pct).bg, color: fcBadge(rec.food_cost_pct).color }}>{rec.food_cost_pct ? `${Number(rec.food_cost_pct).toFixed(1)}%` : 'Has recipe'}</span>) : (<span style={{ fontSize: 11, color: '#eab308', fontWeight: 700 }}>⚠️ No recipe</span>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — recipe builder — STICKY FIX: locks in place while left panel scrolls */}
      <div style={{ flex: 1, position: 'sticky', top: 0, alignSelf: 'flex-start' }}>
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
                <div><div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>{selectedItem.name}</div>{selectedItem.name_alt && <div style={{ fontSize: 13, color: '#C9A84C', marginTop: 2 }}>{selectedItem.name_alt}</div>}</div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 22, fontWeight: 800, color: '#e94560' }}>£{Number(selectedItem.price).toFixed(2)}</div><div style={{ fontSize: 12, color: '#888' }}>menu price</div></div>
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
                <span>Ingredient</span><span style={{ textAlign: 'right' }}>Qty</span><span style={{ textAlign: 'center' }}>Unit</span><span style={{ textAlign: 'right' }}>Line Cost</span><span></span>
              </div>
              {lines.length === 0 && <div style={{ padding: '24px 16px', textAlign: 'center', color: '#bbb', fontSize: 13 }}>No ingredients added yet</div>}
              {lines.map((line, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 36px', padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13, alignItems: 'center' }}>
                  <div><div style={{ fontWeight: 600, color: '#1a1a2e' }}>{line.ingredient_name}</div>{line.ingredient_name_th && <div style={{ fontSize: 11, color: '#C9A84C' }}>{line.ingredient_name_th}</div>}<div style={{ fontSize: 10, color: '#aaa' }}>yield {line.yield_percentage}% · £{Number(line.cost_per_unit).toFixed(2)}/{line.unit}</div></div>
                  <span style={{ textAlign: 'right', color: '#555' }}>{line.quantity_used}</span>
                  <span style={{ textAlign: 'center', color: '#555' }}>{line.unit}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{Number(line.line_cost).toFixed(2)}</span>
                  <button onClick={() => removeLine(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
                </div>
              ))}
              {/* Add new ingredient row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 36px', padding: '10px 16px', borderTop: '2px dashed #e0e0e0', gap: 6, alignItems: 'center' }}>
                <select value={newLine.ingredient_id} onChange={e => { const ing = ingredients.find(i => i.id === Number(e.target.value)); setNewLine({ ...newLine, ingredient_id: e.target.value, unit: ing?.unit || 'kg' }); }} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}>
                  <option value="">— Select ingredient —</option>{ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name_en}</option>)}
                </select>
                <input type="number" step="0.001" value={newLine.quantity_used} onChange={e => setNewLine({ ...newLine, quantity_used: e.target.value })} placeholder="Qty" style={{ padding: '7px 8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, textAlign: 'right' }} />
                <select value={newLine.unit} onChange={e => setNewLine({ ...newLine, unit: e.target.value })} style={{ padding: '7px 6px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
                <button onClick={addLine} style={{ padding: '7px 10px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>+ Add</button>
                <div />
              </div>
            </div>
            {/* Costing summary */}
            <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', marginBottom: 14 }}>Recipe Costing Summary</div>
              {[{ label: `Total recipe cost (${serves} portion${serves > 1 ? 's' : ''})`, value: `£${totalCost.toFixed(2)}`, color: '#555' }, { label: 'Cost per portion', value: `£${costPerPortion.toFixed(2)}`, color: '#1a1a2e', bold: true }, { label: 'Menu price', value: `£${menuPrice.toFixed(2)}`, color: '#e94560', bold: true }, { label: 'Gross profit per dish', value: `£${grossProfit.toFixed(2)}`, color: grossProfit >= 0 ? '#22c55e' : '#ef4444', bold: true }].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}><span style={{ color: '#555' }}>{row.label}</span><span style={{ fontWeight: row.bold ? 800 : 400, color: row.color }}>{row.value}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 0', marginTop: 4, borderTop: '2px solid #eee' }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>Food Cost %</span>
                <span style={{ background: fc.bg, color: fc.color, fontWeight: 800, fontSize: 18, padding: '6px 16px', borderRadius: 20 }}>{lines.length > 0 ? fc.label : '—'}</span>
              </div>
              {lines.length > 0 && foodCostPct >= 35 && (
                <div style={{ background: foodCostPct >= 42 ? '#fee2e2' : '#fef9c3', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: foodCostPct >= 42 ? '#991b1b' : '#713f12' }}>
                  {foodCostPct >= 42 ? '🔴 Food cost is too high — review portion sizes, pricing, or ingredient sourcing urgently.' : '🟡 Food cost is above target. Consider adjusting portion or increasing menu price slightly.'}
                </div>
              )}
            </div>
            <button onClick={handleSave} disabled={saving} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: saving ? '#bbb' : '#e94560', color: 'white', fontWeight: 800, fontSize: 16, cursor: saving ? 'default' : 'pointer' }}>{saving ? 'Saving...' : '💾 Save Recipe'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
