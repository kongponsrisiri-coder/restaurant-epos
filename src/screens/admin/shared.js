import { SERVER_URL } from '../../api';

// ── Date helpers ──────────────────────────────
export const today = new Date().toISOString().split('T')[0];

export const getDateRange = (type) => {
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

// ── Inventory API helpers ─────────────────────
export const invAPI = {
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
  saveInvoice:      (data)     => fetch(`${SERVER_URL}/api/supplier-invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  getExpenses:      ()         => fetch(`${SERVER_URL}/api/expenses`).then(r => r.ok ? r.json() : []).catch(() => []),
  addExpense:       (data)     => fetch(`${SERVER_URL}/api/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
  deleteExpense:    (id)       => fetch(`${SERVER_URL}/api/expenses/${id}`, { method: 'DELETE' }).then(r => r.json()),
};

// ── Recipe costing helpers ────────────────────
export const calcLineCost = (qty, costPerUnit, yieldPct) => {
  const q = parseFloat(qty) || 0;
  const c = parseFloat(costPerUnit) || 0;
  const y = parseFloat(yieldPct) || 100;
  if (!q || !c) return 0;
  return (q * c) / (y / 100);
};

export const fcBadge = (pct) => {
  if (!pct || pct <= 0) return { color: '#888', bg: '#f0f0f0', label: '—' };
  if (pct < 35) return { color: '#22c55e', bg: '#dcfce7', label: `${pct.toFixed(1)}% ✅` };
  if (pct < 42) return { color: '#eab308', bg: '#fef9c3', label: `${pct.toFixed(1)}% 🟡` };
  return { color: '#ef4444', bg: '#fee2e2', label: `${pct.toFixed(1)}% 🔴` };
};
