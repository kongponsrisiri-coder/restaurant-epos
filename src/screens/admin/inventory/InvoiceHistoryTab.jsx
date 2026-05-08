import { useState, useEffect, useMemo } from 'react';
import { SERVER_URL } from '../../../api';

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function formatCurrency(n) { return `£${(parseFloat(n) || 0).toFixed(2)}`; }
function formatDate(ds) {
  if (!ds) return '—';
  try { return new Date(ds.split('T')[0] + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ds || '—'; }
}

const STATUS_STYLE = {
  processed: { bg: '#dcfce7', color: '#14532d', label: 'Processed' },
  pending:   { bg: '#fef9c3', color: '#92400e', label: 'Pending'   },
  cancelled: { bg: '#f3f4f6', color: '#4b5563', label: 'Cancelled' },
};

export default function InvoiceHistoryTab() {
  const [invoices, setInvoices]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [expandedId, setExpandedId]     = useState(null);
  const [filterMonth, setFilterMonth]   = useState(currentMonthStr());
  const [filterSupplier, setFilterSupplier] = useState('all');
  const [search, setSearch]             = useState('');

  useEffect(() => {
    fetch(`${SERVER_URL}/api/supplier-invoices`)
      .then(r => r.json())
      .then(data => setInvoices(Array.isArray(data) ? data : []))
      .catch(() => setInvoices([]))
      .finally(() => setLoading(false));
  }, []);

  const suppliers = useMemo(() => {
    return [...new Set(invoices.map(i => i.supplier_name).filter(Boolean))].sort();
  }, [invoices]);

  const filtered = useMemo(() => {
    return invoices.filter(inv => {
      const invMonth   = (inv.invoice_date || inv.created_at || '').slice(0, 7);
      const monthOk    = filterMonth ? invMonth === filterMonth : true;
      const supplierOk = filterSupplier === 'all' || inv.supplier_name === filterSupplier;
      const q          = search.toLowerCase();
      const searchOk   = !q || (inv.supplier_name || '').toLowerCase().includes(q) || (inv.invoice_number || '').toLowerCase().includes(q);
      return monthOk && supplierOk && searchOk;
    });
  }, [invoices, filterMonth, filterSupplier, search]);

  const stats = useMemo(() => {
    const total      = filtered.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0);
    const count      = filtered.length;
    const bySupplier = {};
    filtered.forEach(i => { if (i.supplier_name) bySupplier[i.supplier_name] = (bySupplier[i.supplier_name] || 0) + (parseFloat(i.total_amount) || 0); });
    const topSupplier     = Object.entries(bySupplier).sort((a, b) => b[1] - a[1])[0];
    const uniqueSuppliers = Object.keys(bySupplier).length;
    return { total, count, topSupplier, uniqueSuppliers, bySupplier };
  }, [filtered]);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}><div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div><p>Loading invoice history…</p></div>;
  }

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18, padding: '14px 18px', background: 'white', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #eee' }}>
        <div>
          <label style={labelSt}>Month</label>
          <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Supplier</label>
          <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={{ ...inputSt, minWidth: 160 }}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label style={labelSt}>Search</label>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Invoice # or supplier…" style={inputSt} />
        </div>
        <div style={{ paddingTop: 20 }}>
          <button onClick={() => { setFilterMonth(currentMonthStr()); setFilterSupplier('all'); setSearch(''); }} style={{ padding: '9px 16px', border: '1px solid #ddd', borderRadius: 8, background: 'white', color: '#555', fontSize: 13, cursor: 'pointer' }}>Clear</button>
        </div>
        <div style={{ marginLeft: 'auto', paddingTop: 20, color: '#888', fontSize: 13 }}>{filtered.length} invoice{filtered.length !== 1 ? 's' : ''}</div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={statCard}><div style={statLabel}>Total Spend</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{formatCurrency(stats.total)}</div><div style={statSub}>{filterMonth || 'all time'}</div></div>
        <div style={statCard}><div style={statLabel}>Invoices</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{stats.count}</div><div style={statSub}>{stats.uniqueSuppliers} supplier{stats.uniqueSuppliers !== 1 ? 's' : ''}</div></div>
        <div style={statCard}><div style={statLabel}>Avg Invoice</div><div style={{ fontSize: 26, fontWeight: 800, color: '#0D1B3E' }}>{formatCurrency(stats.count > 0 ? stats.total / stats.count : 0)}</div><div style={statSub}>per invoice</div></div>
        {stats.topSupplier && (
          <div style={{ ...statCard, borderTop: '3px solid #C9A84C' }}>
            <div style={statLabel}>Top Supplier</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0D1B3E', marginTop: 4 }}>{stats.topSupplier[0]}</div>
            <div style={statSub}>{formatCurrency(stats.topSupplier[1])}</div>
          </div>
        )}
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
                  <span style={{ color: '#555' }}>{formatCurrency(amount)} · {pct.toFixed(0)}%</span>
                </div>
                <div style={{ height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: '#C9A84C', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Invoice accordion list */}
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
                  <span style={{ fontSize: 13, color: '#888', minWidth: 100 }}>{formatDate(inv.invoice_date || inv.created_at)}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#0D1B3E', flex: 1, minWidth: 120 }}>{inv.supplier_name || '—'}</span>
                  {inv.invoice_number && <span style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace', minWidth: 90 }}>#{inv.invoice_number}</span>}
                  <span style={{ background: sc.bg, color: sc.color, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20 }}>{sc.label}</span>
                  <span style={{ fontWeight: 800, fontSize: 16, color: '#0D1B3E', marginLeft: 'auto', minWidth: 80, textAlign: 'right' }}>{formatCurrency(inv.total_amount)}</span>
                </div>
                {isOpen && (
                  <div style={{ borderTop: '1px solid #f0f0f0', background: '#f8f9fb', padding: '16px 20px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 16 }}>
                      {[
                        { label: 'Supplier',       value: inv.supplier_name || '—' },
                        { label: 'Invoice Date',    value: formatDate(inv.invoice_date) },
                        { label: 'Invoice Number',  value: `#${inv.invoice_number || '—'}`, mono: true },
                        { label: 'Recorded',        value: formatDate(inv.created_at) },
                      ].map(f => (
                        <div key={f.label}>
                          <div style={detailLabel}>{f.label}</div>
                          <div style={{ ...detailValue, fontFamily: f.mono ? 'monospace' : 'inherit' }}>{f.value}</div>
                        </div>
                      ))}
                      <div>
                        <div style={detailLabel}>Total Amount</div>
                        <div style={{ ...detailValue, fontSize: 20, fontWeight: 800, color: '#0D1B3E' }}>{formatCurrency(inv.total_amount)}</div>
                      </div>
                      <div>
                        <div style={detailLabel}>Status</div>
                        <span style={{ background: sc.bg, color: sc.color, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{sc.label}</span>
                      </div>
                    </div>
                    <div style={{ background: 'white', borderRadius: 8, padding: '10px 14px', border: '1px dashed #e0e0e0', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 18 }}>📋</span>
                      <div>
                        <div style={{ fontSize: 13, color: '#555', fontWeight: 600 }}>Line items not stored</div>
                        <div style={{ fontSize: 12, color: '#aaa' }}>Re-scan the original invoice to see the full breakdown</div>
                      </div>
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

const statCard    = { background: 'white', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #eee' };
const statLabel   = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 };
const statSub     = { fontSize: 12, color: '#aaa', marginTop: 2 };
const detailLabel = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 };
const detailValue = { fontSize: 14, fontWeight: 600, color: '#333' };
const labelSt     = { display: 'block', fontSize: 11, fontWeight: 700, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' };
const inputSt     = { padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, outline: 'none', fontFamily: 'system-ui, -apple-system, sans-serif' };