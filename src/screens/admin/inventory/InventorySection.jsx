import { useState } from 'react';
import IngredientsTab    from './IngredientsTab';
import RecipesTab        from './RecipesTab';
import StockTab          from './StockTab';
import InvoiceScannerTab from './InvoiceScannerTab';
import CostSalesTab      from './CostSalesTab';

export default function InventorySection() {
  const [tab, setTab] = useState('ingredients');

  const tabs = [
    { id: 'ingredients', label: '🧅 Ingredients' },
    { id: 'recipes',     label: '📋 Recipes & Costs' },
    { id: 'stock',       label: '📦 Stock Log' },
    { id: 'invoices',    label: '🧾 Invoice Scanner' },
    { id: 'costsales',   label: '💰 Cost vs Sales' },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Fixed header — never scrolls */}
      <div style={{ padding: '24px 24px 0', flexShrink: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>🥬 Inventory & Food Costs</h1>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Manage ingredients, recipe costing, and stock movements — Growth tier feature</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '10px 20px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14, background: tab === t.id ? '#1a1a2e' : '#e0e0e0', color: tab === t.id ? 'white' : '#555' }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Tab content — Recipes uses overflow:hidden so panels scroll independently, all others scroll normally */}
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === 'recipes' ? 'hidden' : 'auto', padding: '0 24px 24px' }}>
        {tab === 'ingredients' && <IngredientsTab />}
        {tab === 'recipes'     && <RecipesTab />}
        {tab === 'stock'       && <StockTab />}
        {tab === 'invoices'    && <InvoiceScannerTab />}
        {tab === 'costsales'   && <CostSalesTab />}
      </div>
    </div>
  );
}