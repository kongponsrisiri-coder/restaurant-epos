import { useState, useEffect, useRef, useMemo } from 'react';
import { SERVER_URL } from '../../../api';
import { invAPI, today } from '../shared';

// ── Invoice History (embedded — Sandy design) ─────────────────────
function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtCurrency(n) { return `£${(parseFloat(n) || 0).toFixed(2)}`; }
function fmtDate(ds) {
  if (!ds) return '—';
  try { return new Date(ds.split('T')[0] + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ds || '—'; }
}
const STATUS_STYLE = {
  processed: { bg: '#dcfce7', color: '#14532d', label: 'Processed' },
  pending:   { bg: '#fef9c3', color: '#92400e', label: 'Pending'   },
  cancelled: { bg: '#f3f4f6', color: '#4b5563', label: 'Cancelled' },
};
const hStatCard  = { background: 'white', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #eee' };
const hStatLabel = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 };
const hStatSub   = { fontSize: 12, color: '#aaa', marginTop: 2 };
const hDetLbl    = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 };
const hDetVal    = { fontSize: 14, fontWeight: 600, color: '#333' };
const hLblSt     = { display: 'block', fontSize: 11, fontWeight: 700, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' };
const hInpSt     = { padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, outline: 'none', fontFamily: 'system-ui, -apple-system, sans-serif' };

function InvoiceHistory() {
  const [invoices, setInvoices]             = useState([]);
  const [loading, setLoading]               = useState(true);
  const [expandedId, setExpandedId]         = useState(null);
  const [filterMonth, setFilterMonth]       = useState(currentMonthStr());
  const [filterSupplier, setFilterSupplier] = useState('all');
  const [search, setSearch]                 = useState('');

  useEffect(() => {
    fetch(`${SERVER_URL}/api/supplier-invoices`)
      .then(r => r.json())
      .then(data => setInvoices(Array.isArray(data) ? data : []))
      .catch(() => setInvoices([]))
      .finally(() => setLoading(false));
  }, []);

  const suppliers = useMemo(() =>
    [...new Set(invoices.map(i => i.supplier_name).filter(Boolean))].sort()
  , [invoices]);

  const filtered = useMemo(() => invoices.filter(inv => {
    const invMonth   = (inv.invoice_date || inv.created_at || '').slice(0, 7);
    const monthOk    = filterMonth ? invMonth === filterMonth : true;
    const supplierOk = filterSupplier === 'all' || inv.supplier_name === filterSupplier;
    const q          = search.toLowerCase();
    const searchOk   = !q || (inv.supplier_name || '').toLowerCase().includes(q) || (inv.invoice_number || '').toLowerCase().includes(q);
    return monthOk && supplierOk && searchOk;
  }), [invoices, filterMonth, filterSupplier, search]);

  const stats = useMemo(() => {
    const total      = filtered.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0);
    const bySupplier = {};
    filtered.forEach(i => { if (i.supplier_name) bySupplier[i.supplier_name] = (bySupplier[i.supplier_name] || 0) + (parseFloat(i.total_amount) || 0); });
    const topSupplier     = Object.entries(bySupplier).sort((a, b) => b[1] - a[1])[0];
    const uniqueSuppliers = Object.keys(bySupplier).length;
    return { total, count: filtered.length, topSupplier, uniqueSuppliers, bySupplier };
  }, [filtered]);

  if (loading) return <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}><div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div><p>Loading invoice history…</p></div>;

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18, padding: '14px 18px', background: 'white', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #eee' }}>
        <div><label style={hLblSt}>Month</label><input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={hInpSt} /></div>
        <div><label style={hLblSt}>Supplier</label>
          <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={{ ...hInpSt, minWidth: 160 }}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}><label style={hLblSt}>Search</label><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Invoice # or supplier…" style={{ ...hInpSt, width: '100%', boxSizing: 'border-box' }} /></div>
        <div style={{ paddingTop: 20 }}><button onClick={() => { setFilterMonth(currentMonthStr()); setFilterSupplier('all'); setSearch(''); }} style={{ padding: '9px 16px', border: '1px solid #ddd', borderRadius: 8, background: 'white', color: '#555', fontSize: 13, cursor: 'pointer' }}>Clear</button></div>
        <div style={{ marginLeft: 'auto', paddingTop: 20, color: '#888', fontSize: 13 }}>{filtered.length} invoice{filtered.length !== 1 ? 's' : ''}</div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={hStatCard}><div style={hStatLabel}>Total Spend</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{fmtCurrency(stats.total)}</div><div style={hStatSub}>{filterMonth || 'all time'}</div></div>
        <div style={hStatCard}><div style={hStatLabel}>Invoices</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{stats.count}</div><div style={hStatSub}>{stats.uniqueSuppliers} supplier{stats.uniqueSuppliers !== 1 ? 's' : ''}</div></div>
        <div style={hStatCard}><div style={hStatLabel}>Avg Invoice</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{fmtCurrency(stats.count > 0 ? stats.total / stats.count : 0)}</div><div style={hStatSub}>per invoice</div></div>
        {stats.topSupplier && <div style={{ ...hStatCard, borderTop: '3px solid #C9A84C' }}><div style={hStatLabel}>Top Supplier</div><div style={{ fontSize: 15, fontWeight: 700, color: '#0D1B3E', marginTop: 4 }}>{stats.topSupplier[0]}</div><div style={hStatSub}>{fmtCurrency(stats.topSupplier[1])}</div></div>}
      </div>

      {/* Supplier spend breakdown */}
      {stats.uniqueSuppliers > 1 && (
        <div style={{ background: 'white', borderRadius: 12, padding: '14px 18px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #eee' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Spend by Supplier</div>
          {Object.entries(stats.bySupplier).sort((a, b) => b[1] - a[1]).map(([name, amount]) => {
            const pct = stats.total > 0 ? (amount / stats.total) * 100 : 0;
            return (
              <div key={name} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: '#0D1B3E' }}>{name}</span>
                  <span style={{ color: '#555' }}>{fmtCurrency(amount)} · {pct.toFixed(0)}%</span>
                </div>
                <div style={{ height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: '#C9A84C', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invoice list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '50px 20px', color: '#888', background: 'white', borderRadius: 12, border: '1px solid #eee' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <p style={{ fontSize: 16, margin: '0 0 4px' }}>No invoices found</p>
          <p style={{ fontSize: 13, color: '#aaa' }}>{filterMonth ? `Nothing in ${filterMonth}` : 'Try adjusting your filters'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map(inv => {
            const isOpen = expandedId === inv.id;
            const sc     = STATUS_STYLE[inv.status] || STATUS_STYLE.processed;
            return (
              <div key={inv.id} style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: isOpen ? '0 4px 16px rgba(13,27,62,0.1)' : '0 1px 4px rgba(0,0,0,0.06)', border: isOpen ? '2px solid #0D1B3E' : '2px solid transparent', transition: 'box-shadow 0.15s, border 0.15s' }}>
                <div onClick={() => setExpandedId(isOpen ? null : inv.id)} style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', flexWrap: 'wrap' }}>
                  <span style={{ color: '#0D1B3E', fontSize: 13, fontWeight: 700, flexShrink: 0, width: 14 }}>{isOpen ? '▼' : '▶'}</span>
                  <span style={{ fontSize: 13, color: '#888', minWidth: 100 }}>{fmtDate(inv.invoice_date || inv.created_at)}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#0D1B3E', flex: 1, minWidth: 120 }}>{inv.supplier_name || '—'}</span>
                  {inv.invoice_number && <span style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace', minWidth: 90 }}>#{inv.invoice_number}</span>}
                  <span style={{ background: sc.bg, color: sc.color, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20 }}>{sc.label}</span>
                  <span style={{ fontWeight: 800, fontSize: 16, color: '#0D1B3E', marginLeft: 'auto', minWidth: 80, textAlign: 'right' }}>{fmtCurrency(inv.total_amount)}</span>
                </div>
                {isOpen && (
                  <div style={{ borderTop: '1px solid #f0f0f0', background: '#f8f9fb', padding: '16px 20px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 16 }}>
                      {[{ label: 'Supplier', value: inv.supplier_name || '—' }, { label: 'Invoice Date', value: fmtDate(inv.invoice_date) }, { label: 'Invoice Number', value: `#${inv.invoice_number || '—'}`, mono: true }, { label: 'Recorded', value: fmtDate(inv.created_at) }].map(f => (
                        <div key={f.label}><div style={hDetLbl}>{f.label}</div><div style={{ ...hDetVal, fontFamily: f.mono ? 'monospace' : 'inherit' }}>{f.value}</div></div>
                      ))}
                      <div><div style={hDetLbl}>Total Amount</div><div style={{ ...hDetVal, fontSize: 20, fontWeight: 800, color: '#0D1B3E' }}>{fmtCurrency(inv.total_amount)}</div></div>
                      <div><div style={hDetLbl}>Status</div><span style={{ background: sc.bg, color: sc.color, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{sc.label}</span></div>
                    </div>
                    <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px', border: '1px dashed #e0e0e0', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 18 }}>📋</span>
                      <div><div style={{ fontSize: 13, color: '#555', fontWeight: 600 }}>Line items not stored</div><div style={{ fontSize: 12, color: '#aaa' }}>Re-scan the original invoice to see the full breakdown</div></div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Invoice Scanner ───────────────────────────────────────────────
export default function InvoiceScannerTab() {
  const [mainTab, setMainTab]         = useState('scan');
  const [mode, setMode]               = useState('invoice');
  const [stage, setStage]             = useState('upload');
  const [file, setFile]               = useState(null);
  const [fileData, setFileData]       = useState(null);
  const [invoiceData, setInvoiceData] = useState({ supplier_name: '', invoice_date: '', invoice_number: '', total_amount: '' });
  const [expenseData, setExpenseData] = useState({ vendor: '', date: today, description: '', category: 'overhead', total_amount: '' });
  const [lineItems, setLineItems]     = useState([]);
  const [expLines, setExpLines]       = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [error, setError]             = useState('');
  const [confirming, setConfirming]   = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [confirmResult, setConfirmResult] = useState(null);
  const fileInputRef                  = useRef(null);

  useEffect(() => { invAPI.getIngredients().then(d => setIngredients(Array.isArray(d) ? d : [])); }, []);

  const detectUnit = (name) => {
    const n = (name || '').toUpperCase();
    if (n.includes('ML'))                              return 'ml';
    if (n.match(/\d+(\.\d+)?L\b/) || n.endsWith('L')) return 'L';
    if (n.includes('KG'))                              return 'kg';
    if (n.match(/\d+G\b/))                             return 'g';
    return 'unit';
  };

  const fuzzyMatch = (extractedName) => {
    const lower = (extractedName || '').toLowerCase();
    let best = null, bestScore = 0;
    for (const ing of ingredients) {
      const ingLower = ing.name_en.toLowerCase();
      let score = 0;
      if (lower === ingLower) score = 20;
      else if (lower.includes(ingLower) || ingLower.includes(lower)) score = 10;
      else if (ingLower.includes(lower.split(' ')[0])) score = 7;
      else ingLower.split(' ').forEach(w => { if (w.length > 3 && lower.includes(w)) score += 3; });
      if (score > bestScore) { bestScore = score; best = ing.id; }
    }
    return bestScore >= 3 ? best : null;
  };

  const resetAll = () => {
    setStage('upload'); setFile(null); setFileData(null); setError('');
    setLineItems([]); setExpLines([]); setEditingLine(null); setConfirmResult(null);
    setInvoiceData({ supplier_name: '', invoice_date: '', invoice_number: '', total_amount: '' });
    setExpenseData({ vendor: '', date: today, description: '', category: 'overhead', total_amount: '' });
  };

  const handleFile = (f) => { if (!f) return; setFile(f); const reader = new FileReader(); reader.onload = e => setFileData(e.target.result); reader.readAsDataURL(f); };

  const runScan = async () => {
    if (!file || !fileData) return;
    setError(''); setStage('scanning');
    try {
      const base64 = fileData.split(',')[1]; const media_type = file.type || 'image/jpeg';
      const endpoint = mode === 'invoice' ? '/api/ai/scan-invoice' : '/api/ai/scan-expense';
      const res  = await fetch(`${SERVER_URL}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: base64, media_type }) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');
      if (mode === 'invoice') {
        const inv = data.invoice;
        setInvoiceData({ supplier_name: inv.supplier_name || '', invoice_date: inv.invoice_date || '', invoice_number: inv.invoice_number || '', total_amount: inv.total_amount || 0 });
        setLineItems((inv.line_items || []).map(item => ({ name_extracted: item.name || '', quantity: item.quantity || 0, unit: (item.unit && item.unit !== 'each') ? item.unit : detectUnit(item.name), unit_price: item.unit_price || 0, line_total: item.line_total || (item.quantity * item.unit_price) || 0, matched_ingredient_id: fuzzyMatch(item.name) })));
      } else {
        const exp = data.expense;
        setExpenseData({ vendor: exp.vendor || '', date: exp.date || today, description: exp.description || '', category: exp.category || 'overhead', total_amount: exp.total_amount || 0 });
        setExpLines(exp.line_items || []);
      }
      setStage('review');
    } catch (err) { setError(err.message || 'Scan failed — check backend is running'); setStage('upload'); }
  };

  const updateLine = (index, field, value) => {
    setLineItems(prev => prev.map((l, i) => {
      if (i !== index) return l;
      const updated = { ...l, [field]: value };
      if (field === 'quantity' || field === 'unit_price') updated.line_total = (parseFloat(updated.quantity) || 0) * (parseFloat(updated.unit_price) || 0);
      return updated;
    }));
  };
  const setMatch      = (index, ingredientId) => setLineItems(prev => prev.map((l, i) => i === index ? { ...l, matched_ingredient_id: ingredientId ? Number(ingredientId) : null } : l));
  const addManualLine = () => { const newIndex = lineItems.length; setLineItems(prev => [...prev, { name_extracted: 'New Item', quantity: 1, unit: 'unit', unit_price: 0, line_total: 0, matched_ingredient_id: null }]); setEditingLine(newIndex); };
  const removeLine    = (index) => { setLineItems(prev => prev.filter((_, i) => i !== index)); setEditingLine(null); };

  const confirmInvoice = async () => {
    setConfirming(true);
    try {
      const res  = await fetch(`${SERVER_URL}/api/supplier-invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...invoiceData, line_items: lineItems }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save invoice');
      setConfirmResult(data); setStage('done');
    } catch (err) { setError(err.message); } finally { setConfirming(false); }
  };

  const confirmExpense = async () => {
    setConfirming(true);
    try {
      const res  = await fetch(`${SERVER_URL}/api/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(expenseData) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save expense');
      setConfirmResult({ expense: true }); setStage('done');
    } catch (err) { setError(err.message); } finally { setConfirming(false); }
  };

  const inStyle = { padding: '6px 8px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 13, width: '100%', boxSizing: 'border-box' };

  const uploadArea = (
    <div style={{ maxWidth: 580 }}>
      <div style={{ background: mode === 'invoice' ? '#f0f7ff' : '#fff8f0', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: mode === 'invoice' ? '#1e40af' : '#92400e', border: `1px solid ${mode === 'invoice' ? '#bfdbfe' : '#fed7aa'}` }}>
        {mode === 'invoice' ? '💡 Photo your supplier delivery note or invoice. AI reads every line item — items not in your system are auto-created as ingredients.' : '💡 Photo any receipt, bill or expense document. AI extracts the cost and auto-categorises it.'}
      </div>
      {error && <div style={{ background: '#fee2e2', borderRadius: 10, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 14 }}>⚠️ {error}</div>}
      <div onClick={() => fileInputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }} style={{ border: `2px dashed ${file ? '#22c55e' : '#1a1a2e'}`, borderRadius: 16, padding: '44px 24px', textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: file ? '#f0fdf4' : 'white' }}>
        <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        {file ? (<div>{file.type.startsWith('image/') && fileData && <img src={fileData} alt="preview" style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 8, marginBottom: 12, objectFit: 'contain' }} />}<div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✅ {file.name}</div><div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>{(file.size / 1024 / 1024).toFixed(1)} MB · Click to change</div></div>
        ) : (<div><div style={{ fontSize: 44, marginBottom: 12 }}>🧾</div><div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Drop {mode === 'invoice' ? 'invoice' : 'receipt'} photo here or click</div><div style={{ color: '#888', fontSize: 13 }}>JPG, PNG or PDF · Phone photo is fine</div></div>)}
      </div>
      <button onClick={runScan} disabled={!file} style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: file ? '#1a1a2e' : '#ddd', color: file ? 'white' : '#aaa', fontWeight: 700, fontSize: 16, cursor: file ? 'pointer' : 'not-allowed' }}>🤖 Scan with AI</button>
    </div>
  );

  return (
    <div>
      {/* Main tab selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '2px solid #f0f0f0', paddingBottom: 16 }}>
        {[{ id: 'scan', label: '📷 Scan Invoice' }, { id: 'history', label: '📋 Invoice History' }].map(t => (
          <button key={t.id} onClick={() => setMainTab(t.id)} style={{ padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, background: mainTab === t.id ? '#1a1a2e' : '#f0f0f0', color: mainTab === t.id ? 'white' : '#555' }}>{t.label}</button>
        ))}
      </div>

      {mainTab === 'history' && <InvoiceHistory />}

      {mainTab === 'scan' && <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {[{ id: 'invoice', label: '📦 Supplier Invoice', desc: 'Records stock + delivery' }, { id: 'expense', label: '🏢 Expense / Receipt', desc: 'Records overhead cost' }].map(m => (
            <button key={m.id} onClick={() => { setMode(m.id); resetAll(); }} style={{ flex: 1, padding: '12px 16px', borderRadius: 12, border: 'none', cursor: 'pointer', textAlign: 'left', background: mode === m.id ? '#1a1a2e' : 'white', color: mode === m.id ? 'white' : '#555', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{m.label}</div><div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{m.desc}</div>
            </button>
          ))}
        </div>

        {stage === 'upload' && uploadArea}

        {stage === 'scanning' && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ width: 56, height: 56, border: '5px solid #f0f0f0', borderTop: '5px solid #1a1a2e', borderRadius: '50%', margin: '0 auto 24px', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>Scanning with AI…</div>
            <div style={{ color: '#888', marginTop: 8, fontSize: 14 }}>Reading {mode === 'invoice' ? 'line items' : 'expense details'}…</div>
          </div>
        )}

        {stage === 'review' && mode === 'invoice' && (
          <div>
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>📋 Invoice Details — confirm or correct before recording</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 12 }}>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Supplier</label><input value={invoiceData.supplier_name} onChange={e => setInvoiceData(p => ({ ...p, supplier_name: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Invoice Date</label><input type="date" value={invoiceData.invoice_date} onChange={e => setInvoiceData(p => ({ ...p, invoice_date: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Invoice Number</label><input value={invoiceData.invoice_number} onChange={e => setInvoiceData(p => ({ ...p, invoice_number: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Total Amount (£)</label><input type="number" step="0.01" value={invoiceData.total_amount} onChange={e => setInvoiceData(p => ({ ...p, total_amount: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              </div>
            </div>
            <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 80px 80px 1fr 80px', padding: '8px 16px', background: '#f8f8f8', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <span>Item</span><span style={{ textAlign: 'right' }}>Qty</span><span style={{ textAlign: 'center' }}>Unit</span><span style={{ textAlign: 'right' }}>Unit £</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ paddingLeft: 12 }}>Match Ingredient</span><span></span>
              </div>
              {lineItems.map((item, i) => {
                const isMatched = !!item.matched_ingredient_id;
                const isEditing = editingLine === i;
                return (
                  <div key={i} style={{ borderBottom: '1px solid #f5f5f5', background: isEditing ? '#f0f7ff' : 'white' }}>
                    {isEditing ? (
                      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 90px 90px', gap: 8 }}>
                          <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Item Name</label><input value={item.name_extracted} onChange={e => updateLine(i, 'name_extracted', e.target.value)} style={inStyle} /></div>
                          <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Qty</label><input type="number" step="0.001" value={item.quantity} onChange={e => updateLine(i, 'quantity', e.target.value)} style={inStyle} /></div>
                          <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Unit</label><select value={item.unit} onChange={e => updateLine(i, 'unit', e.target.value)} style={inStyle}>{['unit','kg','g','L','ml','box','case','pack','dozen'].map(u => <option key={u} value={u}>{u}</option>)}</select></div>
                          <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Unit Price £</label><input type="number" step="0.01" value={item.unit_price} onChange={e => updateLine(i, 'unit_price', e.target.value)} style={inStyle} /></div>
                          <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Line Total £</label><input type="number" step="0.01" value={item.line_total} onChange={e => updateLine(i, 'line_total', e.target.value)} style={inStyle} /></div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <div style={{ flex: 1 }}><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 3 }}>Link to existing ingredient (optional)</label><select value={item.matched_ingredient_id || ''} onChange={e => setMatch(i, e.target.value || null)} style={inStyle}><option value="">🤖 Auto-create new ingredient</option>{ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name_en}</option>)}</select></div>
                          <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
                            <button onClick={() => setEditingLine(null)} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#22c55e', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>✓ Done</button>
                            <button onClick={() => removeLine(i)} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>🗑️</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 80px 80px 1fr 80px', padding: '10px 16px', fontSize: 13, alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{item.name_extracted || <span style={{ color: '#aaa' }}>—</span>}</span>
                        <span style={{ textAlign: 'right', color: '#555' }}>{item.quantity}</span>
                        <span style={{ textAlign: 'center', color: '#555' }}>{item.unit}</span>
                        <span style={{ textAlign: 'right', color: '#555' }}>£{Number(item.unit_price).toFixed(2)}</span>
                        <span style={{ textAlign: 'right', fontWeight: 700 }}>£{Number(item.line_total).toFixed(2)}</span>
                        <div style={{ paddingLeft: 12 }}>
                          <select value={item.matched_ingredient_id || ''} onChange={e => setMatch(i, e.target.value || null)} style={{ width: '100%', padding: '5px 8px', borderRadius: 6, fontSize: 12, border: `1px solid ${isMatched ? '#22c55e' : '#bfdbfe'}`, background: isMatched ? '#f0fdf4' : '#f0f7ff', color: isMatched ? '#14532d' : '#1e40af' }}>
                            <option value="">🤖 Auto-create ingredient</option>{ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name_en}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button onClick={() => setEditingLine(i)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>✏️</button>
                          <button onClick={() => removeLine(i)} style={{ padding: '4px 8px', borderRadius: 6, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>×</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ padding: '10px 16px', borderTop: '2px dashed #e0e0e0', display: 'flex', justifyContent: 'center' }}>
                <button onClick={addManualLine} style={{ padding: '8px 20px', borderRadius: 8, border: '2px dashed #3b82f6', background: 'white', color: '#3b82f6', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>➕ Add Item Manually</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, fontSize: 13, color: '#555' }}><span style={{ color: '#1a1a2e', fontWeight: 700 }}>📦 {lineItems.length} item{lineItems.length !== 1 ? 's' : ''} to record</span><span style={{ color: '#888', marginLeft: 8, fontSize: 12 }}>— new ingredients will be auto-created</span></div>
              <button onClick={resetAll} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Re-scan</button>
              <button onClick={confirmInvoice} disabled={confirming || lineItems.length === 0} style={{ padding: '12px 28px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: confirming || lineItems.length === 0 ? 'default' : 'pointer', background: confirming || lineItems.length === 0 ? '#ddd' : '#1a1a2e', color: 'white' }}>{confirming ? 'Recording...' : `✓ Confirm & Record ${lineItems.length} Item${lineItems.length !== 1 ? 's' : ''}`}</button>
            </div>
          </div>
        )}

        {stage === 'review' && mode === 'expense' && (
          <div>
            <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 14 }}>🧾 Expense Details — confirm or correct</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 12 }}>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Vendor / Source</label><input value={expenseData.vendor} onChange={e => setExpenseData(p => ({ ...p, vendor: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Date</label><input type="date" value={expenseData.date} onChange={e => setExpenseData(p => ({ ...p, date: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Category</label><select value={expenseData.category} onChange={e => setExpenseData(p => ({ ...p, category: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="overhead">🏢 Overhead</option><option value="labour">👥 Labour</option><option value="other">📌 Other</option></select></div>
                <div><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Total Amount (£)</label><input type="number" step="0.01" value={expenseData.total_amount} onChange={e => setExpenseData(p => ({ ...p, total_amount: e.target.value }))} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              </div>
              <div style={{ marginTop: 12 }}><label style={{ fontSize: 11, fontWeight: 700, color: '#888', display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Description</label><input value={expenseData.description} onChange={e => setExpenseData(p => ({ ...p, description: e.target.value }))} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
            </div>
            {expLines.length > 0 && (<div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}><div style={{ padding: '10px 16px', background: '#f8f8f8', fontWeight: 700, fontSize: 12, color: '#555' }}>Line Items on Receipt</div>{expLines.map((l, i) => (<div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}><span style={{ color: '#555' }}>{l.description}</span><span style={{ fontWeight: 700 }}>£{Number(l.amount).toFixed(2)}</span></div>))}</div>)}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={resetAll} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555' }}>↩ Re-scan</button>
              <button onClick={confirmExpense} disabled={confirming} style={{ padding: '12px 28px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: confirming ? 'default' : 'pointer', background: confirming ? '#ddd' : '#e94560', color: 'white' }}>{confirming ? 'Saving...' : `✓ Save Expense £${Number(expenseData.total_amount).toFixed(2)}`}</button>
            </div>
          </div>
        )}

        {stage === 'done' && (
          <div style={{ maxWidth: 520, textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginBottom: 8 }}>{mode === 'invoice' ? 'Invoice Recorded!' : 'Expense Saved!'}</div>
            {confirmResult && mode === 'invoice' && (
              <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', textAlign: 'left' }}>
                {confirmResult.created?.length > 0 && (<div style={{ marginBottom: 12 }}><div style={{ fontWeight: 700, fontSize: 13, color: '#22c55e', marginBottom: 6 }}>🆕 {confirmResult.created.length} new ingredient{confirmResult.created.length > 1 ? 's' : ''} created:</div>{confirmResult.created.map(n => <div key={n} style={{ fontSize: 13, color: '#555', padding: '2px 0', paddingLeft: 12 }}>• {n}</div>)}</div>)}
                {confirmResult.updated?.length > 0 && (<div><div style={{ fontWeight: 700, fontSize: 13, color: '#3b82f6', marginBottom: 6 }}>🔄 {confirmResult.updated.length} ingredient{confirmResult.updated.length > 1 ? 's' : ''} cost updated:</div>{confirmResult.updated.map(n => <div key={n} style={{ fontSize: 13, color: '#555', padding: '2px 0', paddingLeft: 12 }}>• {n}</div>)}</div>)}
                <div style={{ marginTop: 12, fontSize: 12, color: '#888', borderTop: '1px solid #f0f0f0', paddingTop: 10 }}>📦 All quantities recorded in Stock Log · Go to <strong>📋 Recipes & Costs</strong> to build recipes using these ingredients</div>
              </div>
            )}
            {confirmResult?.expense && <div style={{ fontSize: 14, color: '#888', marginBottom: 20 }}>£{Number(expenseData.total_amount).toFixed(2)} added to Cost vs Sales</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 8 }}>
              <button onClick={resetAll} style={{ padding: '12px 24px', borderRadius: 10, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>📷 Scan Another</button>
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}