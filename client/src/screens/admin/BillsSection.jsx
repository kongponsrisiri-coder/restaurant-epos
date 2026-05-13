import { useState, useEffect } from 'react';
import { getBills, getBillItems, deleteOrder } from '../../api';

export default function BillsSection() {
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(new Date().toISOString().split('T')[0]);
  const [to, setTo] = useState(new Date().toISOString().split('T')[0]);
  const [method, setMethod] = useState('all');
  const [selectedBill, setSelectedBill] = useState(null);
  const [billItems, setBillItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);  // SEPOS-042 — bill awaiting manager-PIN confirmation
  const COURSE_LABELS = { 0: 'Bar', 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };

  const fetchBills = async () => {
    setLoading(true);
    try { const data = await getBills(from, to, method); setBills(Array.isArray(data) ? data : []); }
    catch { alert('Failed to load bills!'); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchBills(); }, []);

  const handleSelectBill = async (bill) => {
    if (selectedBill?.id === bill.id) { setSelectedBill(null); setBillItems([]); return; }
    setSelectedBill(bill); setLoadingItems(true);
    try { const items = await getBillItems(bill.id); setBillItems(Array.isArray(items) ? items : []); }
    catch { setBillItems([]); }
    finally { setLoadingItems(false); }
  };

  const totalSales = bills.reduce((s, b) => s + (b.total || 0), 0);
  const totalCash  = bills.filter(b => b.method === 'Cash').reduce((s, b) => s + (b.total || 0), 0);
  const totalCard  = bills.filter(b => b.method === 'Card').reduce((s, b) => s + (b.total || 0), 0);
  const formatDateTime = (dt) => dt ? new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const itemsByCourse = {};
  billItems.forEach(item => { const c = item.course ?? 0; if (!itemsByCourse[c]) itemsByCourse[c] = []; itemsByCourse[c].push(item); });

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 20 }}>🧾 Bill Records</h1>
      <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From Date</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} /></div>
          <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To Date</label><input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} /></div>
          <div><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>Payment Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}>
              <option value="all">All Methods</option><option value="Cash">Cash</option><option value="Card">Card</option><option value="Other">Other</option>
            </select></div>
          <button onClick={fetchBills} style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>Search</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[{ label: 'Total Bills', value: bills.length, color: '#3b82f6' }, { label: 'Total Sales', value: `£${totalSales.toFixed(2)}`, color: '#e94560' }, { label: 'Cash', value: `£${totalCash.toFixed(2)}`, color: '#22c55e' }, { label: 'Card', value: `£${totalCard.toFixed(2)}`, color: '#8b5cf6' }].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      {loading ? <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading...</div> : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px 50px', padding: '12px 20px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>
            <span>Bill #</span><span>Table</span><span>Cvr</span><span>Date & Time</span><span>Method</span><span style={{ textAlign: 'right' }}>Discount</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ textAlign: 'center' }}></span>
          </div>
          {bills.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No bills found for this period</div>}
          {bills.map(bill => (
            <div key={bill.id}>
              <div onClick={() => handleSelectBill(bill)} style={{ display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px 50px', padding: '12px 20px', borderBottom: selectedBill?.id === bill.id ? 'none' : '1px solid #f0f0f0', fontSize: 14, cursor: 'pointer', background: selectedBill?.id === bill.id ? '#f0f7ff' : 'white', alignItems: 'center' }}>
                <span style={{ color: '#888', fontWeight: 600 }}>#{bill.id}</span>
                <span style={{ fontWeight: 600 }}>T{bill.table_number}</span>
                <span style={{ color: '#555' }}>{bill.covers || '—'}</span>
                <span style={{ color: '#555' }}>{formatDateTime(bill.closed_at)}</span>
                <span><span style={{ background: bill.method === 'Cash' ? '#dcfce7' : bill.method === 'Card' ? '#dbeafe' : '#f3f4f6', color: bill.method === 'Cash' ? '#14532d' : bill.method === 'Card' ? '#1e40af' : '#374151', padding: '2px 8px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>{bill.method === 'Cash' ? '💵' : bill.method === 'Card' ? '💳' : '🔄'} {bill.method}</span></span>
                <span style={{ textAlign: 'right', color: bill.discount_value > 0 ? '#22c55e' : '#bbb', fontSize: 13 }}>{bill.discount_value > 0 ? bill.discount_type === 'percent' ? `-${bill.discount_value}%` : `-£${bill.discount_value}` : '—'}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: '#1a1a2e' }}>£{(bill.total || 0).toFixed(2)}</span>
                <span style={{ textAlign: 'center' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(bill); }}
                    title="Delete this transaction (manager PIN required)"
                    style={{ background: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16, padding: '4px 6px', borderRadius: 6 }}
                  >🗑️</button>
                </span>
              </div>
              {selectedBill?.id === bill.id && (
                <div style={{ background: '#f8fbff', padding: '16px 20px', borderBottom: '1px solid #dbeafe', borderLeft: '4px solid #3b82f6' }}>
                  {loadingItems ? <div style={{ color: '#888', fontSize: 13 }}>Loading items...</div> : (
                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                      <div style={{ flex: 2, minWidth: 280 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af', marginBottom: 10 }}>Order Items</div>
                        {Object.keys(itemsByCourse).sort().map(course => (
                          <div key={course} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>{COURSE_LABELS[course] || `Course ${course}`}</div>
                            {itemsByCourse[course].map(item => (
                              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                                <span>{item.quantity}× {item.name}{item.notes && <span style={{ color: '#aaa', marginLeft: 6 }}>({item.notes})</span>}{item.item_note && <span style={{ color: '#3b82f6', marginLeft: 6 }}>📝 {item.item_note}</span>}</span>
                                <span style={{ fontWeight: 600, marginLeft: 12 }}>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af', marginBottom: 10 }}>Bill Summary</div>
                        {[{ label: 'Date', value: formatDateTime(bill.closed_at) }, { label: 'Method', value: bill.method }, { label: 'Covers', value: bill.covers || '—' }, { label: 'Discount', value: bill.discount_value > 0 ? `${bill.discount_type === 'percent' ? bill.discount_value + '%' : '£' + bill.discount_value} (${bill.discount_reason})` : 'None' }, { label: 'Amount Paid', value: `£${(bill.paid_amount || 0).toFixed(2)}` }].map(item => (
                          <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                            <span style={{ color: '#888' }}>{item.label}</span><span style={{ fontWeight: 600 }}>{item.value}</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, paddingTop: 8, borderTop: '2px solid #3b82f6', marginTop: 4 }}>
                          <span>Total</span><span style={{ color: '#e94560' }}>£{(bill.total || 0).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {bills.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '70px 70px 60px 1fr 90px 90px 90px 50px', padding: '14px 20px', background: '#f8f8f8', fontWeight: 800, fontSize: 15 }}>
              <span style={{ color: '#555', gridColumn: '1 / 7' }}>Total — {bills.length} bills</span>
              <span style={{ textAlign: 'right', color: '#e94560' }}>£{totalSales.toFixed(2)}</span>
              <span></span>
            </div>
          )}
        </div>
      )}
      {deleteTarget && (
        <DeleteBillModal
          bill={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); setSelectedBill(null); fetchBills(); }}
        />
      )}
    </div>
  );
}

// SEPOS-042 — manager-PIN-gated delete modal. Asks for PIN + reason,
// posts to DELETE /api/orders/:id, surfaces per-step errors so a
// failed delete isn't silent.
function DeleteBillModal({ bill, onClose, onDeleted }) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e?.preventDefault();
    if (!pin.trim() || !reason.trim()) { setErr('Manager PIN and reason are both required.'); return; }
    setSubmitting(true); setErr('');
    try {
      const r = await deleteOrder(bill.id, pin.trim(), reason.trim());
      if (r?.error) {
        setErr(r.error);
      } else if (r?.steps?.order?.ok === false) {
        setErr(`Delete failed: ${r.steps.order.error}`);
      } else {
        onDeleted();
      }
    } catch (e) {
      setErr(e?.message || 'Delete failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} style={{ background: 'white', borderRadius: 14, padding: 28, width: 460, boxShadow: '0 30px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
          <div style={{ fontSize: 28 }}>🗑️</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: '#1a1a2e' }}>Delete bill #{bill.id}?</h2>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              Table {bill.table_number || '—'} · £{(bill.total || 0).toFixed(2)} · {bill.method}
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, color: '#94a3b8', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          ⚠ This permanently removes the order, its items, payments and any sale-source stock movements. A record (who/when/why) is kept in <code>order_deletions</code> for the audit trail.
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Manager PIN</label>
        <input type="password" autoFocus inputMode="numeric" pattern="[0-9]*" value={pin} onChange={(e) => setPin(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 18, marginBottom: 14, letterSpacing: 4, fontFamily: 'monospace', textAlign: 'center' }} />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reason</label>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Test bill / wrong table / customer disputed"
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, marginBottom: 16 }} />

        {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', background: '#f1f5f9', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={submitting} style={{ padding: '9px 18px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Deleting…' : 'Delete bill'}
          </button>
        </div>
      </form>
    </div>
  );
}
