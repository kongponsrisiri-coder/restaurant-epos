import { useState, useEffect } from 'react';
import { getBills, getBillItems, loginStaff } from '../../api';
import DeleteOrderModal from '../../components/DeleteOrderModal';

// Manager-unlock window. After this many ms with no fresh PIN entry the
// delete buttons hide themselves again — same pattern OpenTable + Toast use
// so destructive admin actions aren't visible to customers or junior staff
// peeking at the till.
const UNLOCK_DURATION_MS = 5 * 60 * 1000;

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

  // Manager unlock state. The entry point is a hidden gesture: 5 rapid
  // taps on the "🧾 Bill Records" heading within 3 seconds. There is NO
  // visible lock icon — junior staff and customers peeking at the till
  // see just a normal heading. Managers who need to fix a mistaken bill
  // know the gesture.
  const [unlockedUntil, setUnlockedUntil]   = useState(null);
  const [unlockedRole, setUnlockedRole]     = useState(null);  // SEPOS-043 — track which role unlocked
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const [tick, setTick] = useState(0);
  const isUnlocked = unlockedUntil != null && unlockedUntil > Date.now();
  useEffect(() => {
    if (!unlockedUntil) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [unlockedUntil]);
  useEffect(() => {
    if (unlockedUntil && Date.now() > unlockedUntil) { setUnlockedUntil(null); setUnlockedRole(null); }
  }, [tick, unlockedUntil]);
  // Auto-relock on tab change / unmount.
  useEffect(() => () => { setUnlockedUntil(null); setUnlockedRole(null); }, []);
  // Tap counter auto-resets after 3 s of no taps. Prevents random taps
  // over a long period from accidentally triggering the unlock.
  useEffect(() => {
    if (tapCount === 0) return;
    const id = setTimeout(() => setTapCount(0), 3000);
    return () => clearTimeout(id);
  }, [tapCount]);

  const handleHeadingTap = () => {
    if (isUnlocked) return;  // already open, no need
    const next = tapCount + 1;
    if (next >= 5) {
      setTapCount(0);
      setShowUnlockModal(true);
    } else {
      setTapCount(next);
    }
  };

  const secondsRemaining = isUnlocked ? Math.max(0, Math.floor((unlockedUntil - Date.now()) / 1000)) : 0;
  const fmtCountdown = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        {/* The heading is the hidden gesture target. 5 taps within 3 s
            opens the manager PIN prompt. Looks like a plain heading to
            anyone who doesn't know — invisible to customers + junior
            staff. userSelect off so multi-taps don't select text. */}
        <h1
          onClick={handleHeadingTap}
          style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', margin: 0, cursor: 'default', userSelect: 'none' }}
        >
          🧾 Bill Records
        </h1>

        {/* Only shown WHEN unlocked — a green pill with countdown +
            relock-now. Locked state shows nothing at all. */}
        {isUnlocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#dcfce7', border: '1px solid #22c55e', borderRadius: 999, padding: '6px 14px' }}>
            <span style={{ fontSize: 13 }}>🔓</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>
              Manager mode · {fmtCountdown(secondsRemaining)}
            </span>
            <button
              onClick={() => { setUnlockedUntil(null); setUnlockedRole(null); }}
              title="Lock now"
              style={{ background: 'transparent', border: 'none', color: '#166534', cursor: 'pointer', fontWeight: 800, fontSize: 11, padding: 0 }}
            >
              Lock
            </button>
          </div>
        )}
      </div>
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
                  {/* Delete buttons hidden until a manager unlocks the
                      session (top-right 🔒). PIN re-validated at the
                      modal too — defence in depth.
                      SEPOS-043: supervisors can unlock but cannot delete
                      closed bills — hide the button for that role. */}
                  {isUnlocked && unlockedRole !== 'supervisor' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(bill); }}
                      title="Delete this transaction (manager PIN required)"
                      style={{ background: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16, padding: '4px 6px', borderRadius: 6 }}
                    >🗑️</button>
                  )}
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
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); setSelectedBill(null); fetchBills(); }}
        />
      )}

      {showUnlockModal && (
        <UnlockModal
          onClose={() => setShowUnlockModal(false)}
          onUnlocked={(staff) => {
            setUnlockedUntil(Date.now() + UNLOCK_DURATION_MS);
            setUnlockedRole((staff?.role || '').toLowerCase());  // SEPOS-043
            setShowUnlockModal(false);
          }}
        />
      )}
    </div>
  );
}

// Manager unlock modal. Validates the PIN via loginStaff (same backend gate
// the delete endpoint uses). Roles allowed: admin / manager / supervisor.
// SEPOS-043: supervisor can unlock (to see UI) but the 🗑️ button is hidden
// for their role — and the backend rejects the delete too if bypassed.
function UnlockModal({ onClose, onUnlocked }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!pin.trim()) { setErr('PIN required.'); return; }
    setBusy(true); setErr('');
    try {
      const staff = await loginStaff(pin.trim());
      if (!staff || staff.error) { setErr('Invalid PIN.'); setBusy(false); return; }
      const role = (staff.role || '').toLowerCase();
      if (!['admin', 'manager', 'supervisor'].includes(role)) {
        setErr('That PIN doesn\'t have permission to delete bills.');
        setBusy(false); return;
      }
      onUnlocked(staff);  // SEPOS-043 — pass staff so parent can track role
    } catch (e) {
      setErr(e.message || 'PIN check failed.');
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 20 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'white', borderRadius: 14, padding: 28, width: 'min(380px, 100%)', boxShadow: '0 30px 80px rgba(0,0,0,0.35)' }}>
        <div style={{ fontSize: 30, marginBottom: 6 }}>🔒</div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>Unlock manager actions</h2>
        <p style={{ margin: '6px 0 18px', fontSize: 13, color: '#666' }}>
          Enter a manager PIN to show delete buttons on closed bills for the next 5 minutes. PIN is re-checked when you actually hit delete — this just reveals the buttons.
        </p>
        <input
          type="password"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Manager PIN"
          maxLength={6}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 18, fontFamily: 'ui-monospace, monospace', textAlign: 'center', letterSpacing: 6, boxSizing: 'border-box' }}
        />
        {err && (
          <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginTop: 10 }}>{err}</div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'transparent', color: '#475569', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ background: '#0D1B3E', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}
