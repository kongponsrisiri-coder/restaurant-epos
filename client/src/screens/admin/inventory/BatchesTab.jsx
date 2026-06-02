// SEPOS-BATCH-001 — Kitchen batch prep tab.
//
// Two panes side-by-side:
//   LEFT  — Active batches list with countdown. Expired rows in red with
//           ✓ Discard / ✓ Still good (+1 day) action buttons.
//   RIGHT — Batch recipes list + "+ New batch recipe" form. Tap any
//           recipe to "Make batch" — deducts raw stock, locks cost,
//           creates a batch instance.
//
// Tick-off model: expired batches stay usable until the chef explicitly
// taps an action. Discard subtracts remaining qty from the batch
// ingredient's stock + writes a wastage row. Extend bumps expires_on
// by 1 day (capped at 3 extensions to prevent indefinite deferral).

import { useEffect, useState, useMemo } from 'react';
import { confirm } from '../../../utils/confirm';
import { invAPI, calcLineCost } from '../shared';
import { downloadCsv } from '../../../utils/csv';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDate(d)  {
  if (!d) return '—';
  try {
    return new Date(String(d).slice(0, 10) + 'T12:00:00')
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch { return String(d).slice(0, 10); }
}
function daysLeft(expiresOn) {
  if (!expiresOn) return null;
  const today = new Date();   today.setHours(0,0,0,0);
  const exp   = new Date(String(expiresOn).slice(0, 10) + 'T12:00:00');
  return Math.floor((exp - today) / 86400000);
}

const STATUS = {
  active:    { bg: '#dcfce7', fg: '#15803d', label: 'Active' },
  expired:   { bg: '#fef3c7', fg: '#92400e', label: '⏱ Expired' },
  discarded: { bg: '#fee2e2', fg: '#991b1b', label: '🗑 Discarded' },
  used_up:   { bg: '#e0e7ff', fg: '#4338ca', label: '⊘ Used up' },
};

export default function BatchesTab() {
  const [batches,      setBatches]      = useState([]);
  const [batchRecipes, setBatchRecipes] = useState([]);
  const [ingredients,  setIngredients]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [editing,      setEditing]      = useState(null);   // batch_recipe being edited / created
  const [making,       setMaking]       = useState(null);   // batch_recipe being made
  const [discarding,   setDiscarding]   = useState(null);   // batch being discarded
  const [showHistory,  setShowHistory]  = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [b, br, ing] = await Promise.all([
        invAPI.getBatches(),
        invAPI.getBatchRecipes(),
        invAPI.getIngredients(),
      ]);
      setBatches(Array.isArray(b) ? b : []);
      setBatchRecipes(Array.isArray(br) ? br : []);
      setIngredients(Array.isArray(ing) ? ing : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const activeBatches = useMemo(() =>
    batches.filter(b => b.status === 'active' || b.status === 'expired'),
    [batches]);
  const historyBatches = useMemo(() =>
    batches.filter(b => b.status === 'discarded' || b.status === 'used_up'),
    [batches]);

  const exportCsv = () => {
    if (!batches.length) return;
    const rows = [['Batch #', 'Recipe', 'Made on', 'Expires', 'Qty', 'Unit', 'Cost/unit £', 'Total £', 'Status']];
    batches.forEach(b => {
      rows.push([
        b.id, b.recipe_name || '', fmtDate(b.made_on), fmtDate(b.expires_on),
        Number(b.original_quantity || 0).toFixed(3), b.unit || '',
        Number(b.locked_cost_per_unit || 0).toFixed(4),
        (Number(b.original_quantity || 0) * Number(b.locked_cost_per_unit || 0)).toFixed(2),
        b.status,
      ]);
    });
    downloadCsv(`batches_${new Date().toISOString().slice(0,10)}.csv`, rows);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, paddingTop: 8 }}>

      {/* ── LEFT: Active batches ───────────────────────────── */}
      <div style={{ background: 'white', borderRadius: 12, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1a2e' }}>🥣 Active batches</div>
            <div style={{ fontSize: 12, color: '#888' }}>{activeBatches.length} in the fridge</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowHistory(s => !s)}
              style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #ccc', background: showHistory ? '#fdf6ec' : 'white', color: '#555', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              {showHistory ? '← Active' : `History (${historyBatches.length})`}
            </button>
            <button onClick={exportCsv}
              style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              ⬇ CSV
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>Loading…</div>
        ) : (showHistory ? historyBatches : activeBatches).length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#bbb', fontSize: 14 }}>
            {showHistory
              ? 'No history yet'
              : 'No batches yet — set up a recipe on the right and tap "Make batch"'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(showHistory ? historyBatches : activeBatches).map(b => {
              const dl = daysLeft(b.expires_on);
              const pillStatus = b.status === 'active' && dl != null && dl <= 1 ? 'expired' : b.status;
              const pill = STATUS[pillStatus] || STATUS.active;
              const isUrgent = b.status === 'active' && dl != null && dl <= 1;
              const isExpired = b.status === 'expired';
              return (
                <div key={b.id} style={{
                  border: `1px solid ${isExpired ? '#fecaca' : isUrgent ? '#fde68a' : '#e5e7eb'}`,
                  background: isExpired ? '#fef2f2' : isUrgent ? '#fffbeb' : '#fafafa',
                  borderRadius: 10, padding: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>
                        {b.recipe_name || `Batch #${b.id}`} <span style={{ color: '#888', fontWeight: 500 }}>· #{b.id}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                        {Number(b.original_quantity || 0).toFixed(b.original_quantity >= 1 ? 1 : 3)} {b.unit} ·
                        made {fmtDate(b.made_on)} · expires {fmtDate(b.expires_on)}
                        {b.extended_count > 0 && ` (+${b.extended_count}d)`}
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                        Cost {fmtMoney(b.locked_cost_per_unit)}/{b.unit} · total {fmtMoney(Number(b.original_quantity || 0) * Number(b.locked_cost_per_unit || 0))}
                        {b.made_by_name && ` · by ${b.made_by_name}`}
                      </div>
                      {b.discarded_qty != null && (
                        <div style={{ fontSize: 11, color: '#991b1b', marginTop: 4 }}>
                          Discarded {Number(b.discarded_qty).toFixed(2)} {b.unit} · loss {fmtMoney(Number(b.discarded_qty) * Number(b.locked_cost_per_unit))}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ background: pill.bg, color: pill.fg, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 12, display: 'inline-block' }}>{pill.label}</span>
                      {b.status === 'active' && dl != null && dl > 1 && (
                        <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{dl} days left</div>
                      )}
                      {isUrgent && b.status === 'active' && (
                        <div style={{ fontSize: 11, color: '#92400e', marginTop: 4, fontWeight: 700 }}>{dl === 0 ? 'expires today' : 'expires tomorrow'}</div>
                      )}
                    </div>
                  </div>
                  {(b.status === 'active' || b.status === 'expired') && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button onClick={() => setDiscarding(b)}
                        style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #ef4444', background: 'white', color: '#b91c1c', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                        🗑 Discard
                      </button>
                      {b.status === 'expired' && (b.extended_count || 0) < 3 && (
                        <button onClick={async () => { await invAPI.extendBatch(b.id); load(); }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #22c55e', background: 'white', color: '#15803d', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                          ✓ Still good (+1 day)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── RIGHT: Batch recipes ───────────────────────────── */}
      <div style={{ background: 'white', borderRadius: 12, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1a2e' }}>📜 Batch recipes</div>
            <div style={{ fontSize: 12, color: '#888' }}>{batchRecipes.length} on file</div>
          </div>
          <button onClick={() => setEditing({ new: true, name: '', output_quantity: 1, output_unit: 'kg', shelf_life_days: 3, lines: [] })}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            + New recipe
          </button>
        </div>

        {batchRecipes.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#bbb', fontSize: 14 }}>No recipes yet — tap + New recipe</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {batchRecipes.map(br => {
              const hasInStock = batches.some(b => b.batch_recipe_id === br.id && b.status === 'active');
              return (
                <div key={br.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fafafa' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>
                        {br.name}
                        {hasInStock && <span style={{ marginLeft: 6, fontSize: 10, color: '#15803d', background: '#dcfce7', padding: '1px 6px', borderRadius: 10 }}>in stock</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                        Output {Number(br.output_quantity).toFixed(br.output_quantity >= 1 ? 1 : 3)} {br.output_unit} ·
                        cost {fmtMoney(br.cost_per_unit)}/{br.output_unit} ·
                        shelf {br.shelf_life_days}d ·
                        {(br.lines || []).length} ingredient{(br.lines || []).length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => setMaking(br)}
                        style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: '#C9A84C', color: '#1a1a2e', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                        🥣 Make
                      </button>
                      <button onClick={() => setEditing(br)}
                        style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', background: 'white', color: '#555', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                        Edit
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Modals ───────────────────────────── */}
      {editing && (
        <BatchRecipeModal
          recipe={editing} ingredients={ingredients}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {making && (
        <MakeBatchModal
          recipe={making}
          onClose={() => setMaking(null)}
          onMade={() => { setMaking(null); load(); }}
        />
      )}
      {discarding && (
        <DiscardModal
          batch={discarding}
          onClose={() => setDiscarding(null)}
          onDone={() => { setDiscarding(null); load(); }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
function BatchRecipeModal({ recipe, ingredients, onClose, onSaved }) {
  // Only RAW ingredients can be lines in a batch recipe (no
  // batch-from-batch — would let the operator build cost loops).
  const rawIngredients = ingredients.filter(i => !i.is_batch);
  const [name,    setName]   = useState(recipe.name || '');
  const [outQ,    setOutQ]   = useState(recipe.output_quantity || 1);
  const [outU,    setOutU]   = useState(recipe.output_unit || 'kg');
  const [shelf,   setShelf]  = useState(recipe.shelf_life_days || 3);
  const [notes,   setNotes]  = useState(recipe.notes || '');
  const [lines,   setLines]  = useState(recipe.lines || []);
  const [busy,    setBusy]   = useState(false);
  const [err,     setErr]    = useState('');

  const totalCost = useMemo(() => lines.reduce((s, l) => s + (Number(l.line_cost) || 0), 0), [lines]);
  const costPer   = Number(outQ) > 0 ? totalCost / Number(outQ) : 0;

  const addLine = () => setLines([...lines, { ingredient_id: '', quantity_used: 0, unit: '', line_cost: 0 }]);
  const setLine = (i, patch) => setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const rmLine  = (i) => setLines(lines.filter((_, idx) => idx !== i));

  const onIngChange = (i, ingId) => {
    const ing = rawIngredients.find(x => x.id === Number(ingId));
    if (!ing) return setLine(i, { ingredient_id: '' });
    const q = Number(lines[i].quantity_used || 0);
    setLine(i, {
      ingredient_id: ing.id,
      unit: ing.unit,
      line_cost: calcLineCost(q, ing.cost_per_unit, ing.yield_percentage),
    });
  };
  const onQtyChange = (i, qty) => {
    const ing = rawIngredients.find(x => x.id === Number(lines[i].ingredient_id));
    const c   = calcLineCost(qty, ing?.cost_per_unit, ing?.yield_percentage);
    setLine(i, { quantity_used: qty, line_cost: c });
  };

  async function save() {
    if (!name || !outQ || !outU) return setErr('Name + output quantity + unit required');
    if (lines.length === 0)       return setErr('Add at least one ingredient line');
    if (lines.some(l => !l.ingredient_id || !Number(l.quantity_used))) return setErr('Every line needs an ingredient and a quantity');
    setBusy(true); setErr('');
    try {
      const body = { name, output_quantity: outQ, output_unit: outU, shelf_life_days: shelf, notes, lines };
      const r = recipe.new
        ? await invAPI.addBatchRecipe(body)
        : await invAPI.updateBatchRecipe(recipe.id, body);
      if (r.error) throw new Error(r.error);
      onSaved();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally     { setBusy(false); }
  }

  async function doDelete() {
    if (!await confirm(`Delete "${recipe.name}"? Existing batches keep their history; the matching ingredient row is removed.`)) return;
    setBusy(true);
    try {
      const r = await invAPI.deleteBatchRecipe(recipe.id);
      if (r.error) throw new Error(r.error);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally     { setBusy(false); }
  }

  return (
    <ModalShell title={recipe.new ? 'New batch recipe' : 'Edit batch recipe'} onClose={onClose}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)}
          style={modalInput}/>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px', gap: 10 }}>
        <Field label="Output qty">
          <input type="number" min="0.001" step="0.001" value={outQ} onChange={(e) => setOutQ(parseFloat(e.target.value) || 0)} style={modalInput}/>
        </Field>
        <Field label="Unit">
          <input value={outU} onChange={(e) => setOutU(e.target.value)} style={modalInput} placeholder="kg / l / portion"/>
        </Field>
        <Field label="Shelf (days)">
          <input type="number" min="1" max="30" value={shelf} onChange={(e) => setShelf(parseInt(e.target.value, 10) || 1)} style={modalInput}/>
        </Field>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>Ingredients</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 70px 80px 32px', gap: 6, alignItems: 'center' }}>
            <select value={l.ingredient_id} onChange={(e) => onIngChange(i, e.target.value)} style={modalInput}>
              <option value="">— pick ingredient —</option>
              {rawIngredients.map(ing => (
                <option key={ing.id} value={ing.id}>{ing.name_en} ({fmtMoney(ing.cost_per_unit)}/{ing.unit})</option>
              ))}
            </select>
            <input type="number" min="0" step="0.001" value={l.quantity_used}
              onChange={(e) => onQtyChange(i, parseFloat(e.target.value) || 0)} style={modalInput}/>
            <span style={{ fontSize: 13, color: '#555' }}>{l.unit}</span>
            <span style={{ fontSize: 13, color: '#1a1a2e', fontWeight: 700, textAlign: 'right' }}>{fmtMoney(l.line_cost)}</span>
            <button onClick={() => rmLine(i)} style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 18 }}>×</button>
          </div>
        ))}
        <button onClick={addLine} style={{ marginTop: 4, padding: '8px 12px', borderRadius: 6, border: '1px dashed #ccc', background: 'white', color: '#555', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
          + Add ingredient
        </button>
      </div>

      <Field label="Notes (optional)" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...modalInput, minHeight: 50, fontFamily: 'inherit' }}/>
      </Field>

      <div style={{ marginTop: 14, padding: '10px 12px', background: '#fdf6ec', borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#5b4a2a' }}>
        <span>Cost</span>
        <span>{fmtMoney(totalCost)} total · {fmtMoney(costPer)}/{outU}</span>
      </div>

      {err && <div style={{ marginTop: 12, padding: '10px 12px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>⚠️ {err}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        {!recipe.new && (
          <button onClick={doDelete} disabled={busy}
            style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid #fecaca', background: 'white', color: '#b91c1c', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            Delete
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <button onClick={onClose} disabled={busy}
          style={{ padding: '12px 18px', borderRadius: 8, border: '1px solid #ccc', background: 'white', color: '#555', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={save} disabled={busy}
          style={{ padding: '12px 22px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function MakeBatchModal({ recipe, onClose, onMade }) {
  const [notes, setNotes] = useState('');
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState('');

  async function make() {
    setBusy(true); setErr('');
    try {
      const r = await invAPI.makeBatch({ batch_recipe_id: recipe.id, notes });
      if (r.error) throw new Error(r.error);
      onMade();
    } catch (e) { setErr(e.message || 'Make failed'); }
    finally     { setBusy(false); }
  }

  return (
    <ModalShell title={`Make ${recipe.name}`} onClose={onClose}>
      <p style={{ fontSize: 14, color: '#555', margin: '0 0 14px' }}>
        Confirms the chef physically prepared this batch. The system will:
      </p>
      <ul style={{ fontSize: 13, color: '#666', paddingLeft: 18, marginTop: 0 }}>
        <li>Deduct {recipe.lines?.length || 0} raw ingredient{(recipe.lines || []).length === 1 ? '' : 's'} from stock</li>
        <li>Add <strong>{Number(recipe.output_quantity).toFixed(recipe.output_quantity >= 1 ? 1 : 3)} {recipe.output_unit}</strong> to <strong>{recipe.name}</strong> stock</li>
        <li>Lock cost at <strong>{fmtMoney(recipe.cost_per_unit)}/{recipe.output_unit}</strong></li>
        <li>Set expiry to <strong>+{recipe.shelf_life_days} days</strong></li>
      </ul>

      <Field label="Notes (optional — e.g. 'used substitute palm sugar')" style={{ marginTop: 14 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...modalInput, minHeight: 50, fontFamily: 'inherit' }}/>
      </Field>

      {err && <div style={{ marginTop: 12, padding: '10px 12px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>⚠️ {err}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
        <button onClick={onClose} disabled={busy}
          style={{ padding: '12px 18px', borderRadius: 8, border: '1px solid #ccc', background: 'white', color: '#555', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={make} disabled={busy}
          style={{ padding: '12px 22px', borderRadius: 8, border: 'none', background: '#C9A84C', color: '#1a1a2e', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Making…' : '🥣 Make batch'}
        </button>
      </div>
    </ModalShell>
  );
}

function DiscardModal({ batch, onClose, onDone }) {
  const [qty, setQty]     = useState(Number(batch.original_quantity).toFixed(3));
  const [reason, setReason] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');
  const lossPreview = Number(qty || 0) * Number(batch.locked_cost_per_unit || 0);

  async function discard() {
    setBusy(true); setErr('');
    try {
      const r = await invAPI.discardBatch(batch.id, { quantity: Number(qty), reason });
      if (r.error) throw new Error(r.error);
      onDone();
    } catch (e) { setErr(e.message || 'Discard failed'); }
    finally     { setBusy(false); }
  }

  return (
    <ModalShell title={`Discard ${batch.recipe_name || 'batch'} #${batch.id}`} onClose={onClose}>
      <p style={{ fontSize: 14, color: '#555', margin: '0 0 14px' }}>
        Removes from stock and logs to the wastage report. How much was left when discarded?
      </p>
      <Field label={`Quantity (${batch.unit || ''})`}>
        <input type="number" min="0" step="0.001" value={qty}
          onChange={(e) => setQty(e.target.value)} style={modalInput}/>
      </Field>
      <Field label="Reason (optional)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} style={modalInput}
          placeholder="e.g. spoiled, smelled off, contaminated"/>
      </Field>

      <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', borderRadius: 8, display: 'flex', justifyContent: 'space-between', color: '#991b1b', fontWeight: 700, fontSize: 13 }}>
        <span>Wastage cost</span>
        <span>−£{lossPreview.toFixed(2)}</span>
      </div>

      {err && <div style={{ marginTop: 12, padding: '10px 12px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>⚠️ {err}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
        <button onClick={onClose} disabled={busy}
          style={{ padding: '12px 18px', borderRadius: 8, border: '1px solid #ccc', background: 'white', color: '#555', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={discard} disabled={busy}
          style={{ padding: '12px 22px', borderRadius: 8, border: 'none', background: '#ef4444', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Discarding…' : '🗑 Discard'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── shared modal scaffolding ────────────────────────────────────
function ModalShell({ title, onClose, children }) {
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 600, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: 22 }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, style, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10, ...(style || {}) }}>
      <span style={{ display: 'block', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
}
const modalInput = { width: '100%', padding: '10px 12px', border: '1px solid #ccc', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' };
