import { useState, useEffect } from 'react';
import { getSummaryReport, getWastageReport } from '../../../api';
import { invAPI, today } from '../shared';

export default function CostSalesTab() {
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const [from, setFrom]             = useState(firstOfMonth);
  const [to, setTo]                 = useState(today);
  const [revenue, setRevenue]       = useState(null);
  const [movements, setMovements]   = useState([]);
  const [expenses, setExpenses]     = useState([]);
  const [wastage, setWastage]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [expForm, setExpForm]       = useState({ category: 'overhead', description: '', amount: '', date: today });
  const [savingExp, setSavingExp]   = useState(false);
  const [activeExpSection, setActiveExpSection] = useState(true);

  const loadData = async () => {
    setLoading(true);
    const [rev, movs, exps, waste] = await Promise.all([
      getSummaryReport(from, to),
      invAPI.getMovements(),
      invAPI.getExpenses(),
      getWastageReport(from + ' 00:00:00', to + ' 23:59:59').catch(() => null),
    ]);
    setRevenue(rev);
    setMovements(Array.isArray(movs) ? movs : []);
    setExpenses(Array.isArray(exps) ? exps : []);
    setWastage(waste);
    setLoading(false);
  };
  useEffect(() => { loadData(); }, []);

  const cogsMovements = movements.filter(m => { if (m.movement_type !== 'delivery' || !m.created_at) return false; const d = m.created_at.split('T')[0]; return d >= from && d <= to; });
  const cogs          = cogsMovements.reduce((sum, m) => sum + (Number(m.cost_at_time || 0) * Number(m.quantity || 0)), 0);
  const filteredExp   = expenses.filter(e => { const d = (e.date || '').split('T')[0]; return d >= from && d <= to; });
  const overheads     = filteredExp.filter(e => e.category === 'overhead').reduce((s, e) => s + Number(e.amount || 0), 0);
  const labour        = filteredExp.filter(e => e.category === 'labour').reduce((s, e) => s + Number(e.amount || 0), 0);
  const other         = filteredExp.filter(e => e.category === 'other').reduce((s, e) => s + Number(e.amount || 0), 0);

  const totalRevenue   = revenue?.total_sales || 0;
  const grossProfit    = totalRevenue - cogs;
  const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const totalCosts     = cogs + overheads + labour + other;
  const netProfit      = totalRevenue - totalCosts;
  const netMarginPct   = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const marginColor    = (pct) => pct >= 25 ? '#22c55e' : pct >= 10 ? '#eab308' : '#ef4444';

  const addExpense = async () => {
    if (!expForm.description || !expForm.amount) return alert('Description and amount are required');
    setSavingExp(true);
    try { await invAPI.addExpense(expForm); setExpForm({ category: 'overhead', description: '', amount: '', date: today }); loadData(); }
    catch { alert('Save failed — check backend is running'); }
    finally { setSavingExp(false); }
  };
  const deleteExpense = async (id) => { if (!confirm('Delete this expense?')) return; await invAPI.deleteExpense(id); loadData(); };

  const catLabel = { overhead: '🏢 Overhead', labour: '👥 Labour', other: '📌 Other' };
  const catColor = { overhead: { color: '#8b5cf6', bg: '#ede9fe' }, labour: { color: '#3b82f6', bg: '#dbeafe' }, other: { color: '#f97316', bg: '#ffedd5' } };
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

  return (
    <div>
      <div style={{ background: 'white', borderRadius: 12, padding: 16, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} /></div>
        <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To</label><input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} /></div>
        <button onClick={loadData} style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>Calculate</button>
        <div style={{ display: 'flex', gap: 6 }}>
          {[{ label: 'This Month', from: firstOfMonth, to: today }, { label: 'Last 7 Days', from: new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0], to: today }, { label: 'Today', from: today, to: today }].map(p => (
            <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); }} style={{ padding: '6px 12px', borderRadius: 20, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600, fontSize: 12, color: '#555' }}>{p.label}</button>
          ))}
        </div>
      </div>
      {loading ? <div style={{ textAlign: 'center', color: '#888', padding: 60 }}>Loading...</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[{ label: 'Revenue', value: `£${totalRevenue.toFixed(2)}`, color: '#1a1a2e', bold: true }, { label: 'Stock Purchasing Cost', value: `£${cogs.toFixed(2)}`, color: '#ef4444' }, { label: 'Overheads', value: `£${overheads.toFixed(2)}`, color: '#8b5cf6' }, { label: 'Labour', value: `£${labour.toFixed(2)}`, color: '#3b82f6' }, { label: 'Other Costs', value: `£${other.toFixed(2)}`, color: '#f97316' }, { label: 'Total Costs', value: `£${totalCosts.toFixed(2)}`, color: '#ef4444', bold: true }].map(s => (
              <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}><div style={{ fontSize: 20, fontWeight: s.bold ? 900 : 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div></div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            {[{ title: 'GROSS PROFIT (after stock)', value: grossProfit, pct: grossMarginPct, label: 'Gross margin' }, { title: 'NET PROFIT (after all costs)', value: netProfit, pct: netMarginPct, label: 'Net margin' }].map(card => (
              <div key={card.title} style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 6, fontWeight: 600 }}>{card.title}</div>
                <div style={{ fontSize: 28, fontWeight: 900, color: marginColor(card.pct) }}>£{card.value.toFixed(2)}</div>
                <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>{card.label}: <span style={{ fontWeight: 800, color: marginColor(card.pct) }}>{card.pct.toFixed(1)}%</span></div>
                <div style={{ marginTop: 10, background: '#f5f5f5', borderRadius: 8, overflow: 'hidden', height: 8 }}><div style={{ height: '100%', width: `${Math.max(0, Math.min(card.pct, 100))}%`, background: marginColor(card.pct), borderRadius: 8, transition: 'width 0.4s' }} /></div>
              </div>
            ))}
          </div>
          {/* SEPOS-031 — wastage from voids × recipe cost_per_portion */}
          {wastage && wastage.total && (wastage.total.dish_count > 0) && (
            <div style={{ background:'white', borderRadius:12, padding:20, marginBottom:20, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
                <div style={{ fontWeight:700, fontSize:15, color:'#1a1a2e' }}>🗑 Wastage</div>
                <div style={{ fontSize:13, color:'#888' }}>
                  {wastage.total.dish_count} dishes voided · {' '}
                  <span style={{ fontWeight:800, color:'#ef4444' }}>£{Number(wastage.total.wastage_cost).toFixed(2)} cost</span>
                  {' '}· revenue lost £{Number(wastage.total.revenue_lost).toFixed(2)}
                </div>
              </div>

              {/* By void type */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px, 1fr))', gap:8, marginBottom:14 }}>
                {wastage.by_type.map(t => (
                  <div key={t.void_type} style={{
                    background: t.void_type === 'Wastage'      ? '#fee2e2'
                              : t.void_type === 'Comp'         ? '#ede9fe'
                              : t.void_type === 'Wrong Order'  ? '#fff7ed'
                              : '#f5f5f5',
                    border:'1px solid rgba(0,0,0,0.05)', borderRadius:10, padding:'10px 12px'
                  }}>
                    <div style={{ fontSize:11, color:'#666', fontWeight:700, marginBottom:4, textTransform:'uppercase' }}>
                      {t.void_type === 'Comp' ? '🎁 ' : ''}{t.void_type}
                    </div>
                    <div style={{ fontSize:16, fontWeight:800, color:'#1a1a2e' }}>£{Number(t.wastage_cost).toFixed(2)}</div>
                    <div style={{ fontSize:11, color:'#888', marginTop:2 }}>{t.dish_count} dishes</div>
                  </div>
                ))}
              </div>

              {/* Top wasted dishes */}
              {wastage.top_dishes && wastage.top_dishes.length > 0 && (
                <div>
                  <div style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>Top wasted dishes</div>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <thead>
                      <tr style={{ color:'#888', fontSize:11, textAlign:'left' }}>
                        <th style={{ padding:'4px 4px' }}>Dish</th>
                        <th style={{ padding:'4px 4px', textAlign:'right' }}>Qty</th>
                        <th style={{ padding:'4px 4px', textAlign:'right' }}>Cost</th>
                        <th style={{ padding:'4px 4px', textAlign:'right' }}>Revenue lost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wastage.top_dishes.map((d, i) => (
                        <tr key={d.menu_item_id ?? i} style={{ borderTop:'1px solid #f5f5f5' }}>
                          <td style={{ padding:'6px 4px', fontWeight:600 }}>{d.item_name}</td>
                          <td style={{ padding:'6px 4px', textAlign:'right' }}>{d.dish_count}</td>
                          <td style={{ padding:'6px 4px', textAlign:'right', color:'#ef4444', fontWeight:700 }}>£{Number(d.wastage_cost).toFixed(2)}</td>
                          <td style={{ padding:'6px 4px', textAlign:'right', color:'#888' }}>£{Number(d.revenue_lost).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ fontSize:11, color:'#aaa', marginTop:12, lineHeight:1.5 }}>
                Cost uses each dish's <strong>recipe.cost_per_portion</strong> × quantity voided. Items without
                a recipe show £0 cost — fill in their recipes for accurate wastage tracking.
              </div>
            </div>
          )}

          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📊 Profit Breakdown</div>
            {[{ label: 'Revenue', value: totalRevenue, color: '#22c55e', sign: '' }, { label: '– Stock Purchasing Cost', value: cogs, color: '#ef4444', sign: '–' }, { label: '= Gross Profit', value: grossProfit, color: grossProfit >= 0 ? '#22c55e' : '#ef4444', sign: '', bold: true }, { label: '– Overheads', value: overheads, color: '#8b5cf6', sign: '–' }, { label: '– Labour', value: labour, color: '#3b82f6', sign: '–' }, { label: '– Other', value: other, color: '#f97316', sign: '–' }, { label: '= Net Profit', value: netProfit, color: netProfit >= 0 ? '#22c55e' : '#ef4444', sign: '', bold: true }].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: row.bold ? '10px 0' : '7px 0', borderTop: row.bold ? '2px solid #eee' : '1px solid #f5f5f5', marginTop: row.bold ? 4 : 0 }}>
                <span style={{ fontSize: 14, color: '#555', fontWeight: row.bold ? 700 : 400, paddingLeft: row.sign === '–' ? 16 : 0 }}>{row.label}</span>
                <span style={{ fontSize: row.bold ? 18 : 14, fontWeight: row.bold ? 800 : 600, color: row.color }}>{row.sign === '–' ? '–' : ''}£{Math.abs(row.value).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <button onClick={() => setActiveExpSection(!activeExpSection)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0, marginBottom: activeExpSection ? 16 : 0 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>+ Log an Expense</span><span style={{ color: '#888', fontSize: 14 }}>{activeExpSection ? '▲' : '▼'}</span>
            </button>
            {activeExpSection && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 120 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Category</label><select value={expForm.category} onChange={e => setExpForm({ ...expForm, category: e.target.value })} style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="overhead">🏢 Overhead</option><option value="labour">👥 Labour</option><option value="other">📌 Other</option></select></div>
                <div style={{ flex: 3, minWidth: 160 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Description</label><input value={expForm.description} onChange={e => setExpForm({ ...expForm, description: e.target.value })} placeholder="e.g. Monthly rent, Gas bill, Chef wages..." style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div style={{ flex: 1, minWidth: 100 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Amount (£)</label><input type="number" step="0.01" value={expForm.amount} onChange={e => setExpForm({ ...expForm, amount: e.target.value })} placeholder="0.00" style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div style={{ flex: 1, minWidth: 130 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Date</label><input type="date" value={expForm.date} onChange={e => setExpForm({ ...expForm, date: e.target.value })} style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <button onClick={addExpense} disabled={savingExp} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{savingExp ? 'Saving...' : 'Add'}</button>
              </div>
            )}
          </div>
          {filteredExp.length > 0 && (
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ padding: '12px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>Logged Expenses — {from} to {to}</div>
              {filteredExp.map((e, i) => { const cc = catColor[e.category] || catColor.other; return (<div key={e.id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}><span style={{ background: cc.bg, color: cc.color, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>{catLabel[e.category]}</span><span style={{ flex: 1, color: '#1a1a2e' }}>{e.description}</span><span style={{ color: '#888', fontSize: 12 }}>{formatDate(e.date)}</span><span style={{ fontWeight: 700, color: '#ef4444' }}>£{Number(e.amount).toFixed(2)}</span><button onClick={() => deleteExpense(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 16, padding: 0 }}>×</button></div>); })}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', fontWeight: 800, fontSize: 15, background: '#f8f8f8', color: '#ef4444' }}>Total: £{(overheads + labour + other).toFixed(2)}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
