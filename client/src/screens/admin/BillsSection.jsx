import { useState, useEffect } from 'react';
import { getSettings } from '../../api';
import { dineTableLabel } from '../../utils/orderLabel';
import {
  thermalPrint, fullPagePrint, escPosPrint, pageHtml,
  fmt, fmtInt, dateLabel, restaurantName, nowStamp,
} from '../../utils/reportPrinter';
import { printReceipt } from '../ReceiptPrinter';
import { getBills, getBillItems, loginStaff, getBillAmendments, editBillPayment } from '../../api';
import DeleteOrderModal from '../../components/DeleteOrderModal';
import AmendPaymentModal from '../../components/AmendPaymentModal';
import { downloadCsv } from '../../utils/csv';

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
  const [amendTarget, setAmendTarget]   = useState(null);  // SEPOS-PAY-AMEND-001 — bill awaiting method change
  const [editTarget, setEditTarget]     = useState(null);  // SEPOS-BILLEDIT-001 — bill awaiting payment amount edit
  const [amendToast, setAmendToast]     = useState('');    // brief success banner after amend

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

  // Korakot 2026-06-02: "no service charge including in the report" —
  // these totals were summing orders.total (subtotal, excludes service
  // charge) when the operator's mental model is "how much money came in"
  // = paid_amount (includes the 12.5% service the customer actually
  // handed over). Switched to paid_amount so the headline Sales/Cash/Card
  // figures match the till + the Z-Report's cash/card splits which
  // already used paid_amount.
  const totalSales = bills.reduce((s, b) => s + Number(b.paid_amount || b.total || 0), 0);
  // SEPOS-SPLITBILL-001 — sum by TENDER, not by the bill's headline method, so a
  // "Split" bill's cash + card portions each land in the right column.
  const tenderSum = (m) => bills.reduce((s, b) =>
    s + (Array.isArray(b.tenders)
          ? b.tenders.filter(t => t.method === m).reduce((a, t) => a + Number(t.amount || 0), 0)
          : (b.method === m ? Number(b.paid_amount || b.total || 0) : 0)), 0);
  const totalCash  = tenderSum('Cash');
  const totalCard  = tenderSum('Card');
  const formatDateTime = (dt) => dt ? new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const itemsByCourse = {};
  billItems.forEach(item => { const c = item.course ?? 0; if (!itemsByCourse[c]) itemsByCourse[c] = []; itemsByCourse[c].push(item); });

  const [settings, setSettings] = useState({});
  useEffect(() => { getSettings().then(s => setSettings(s || {})).catch(() => {}); }, []);

  // Re-print a single closed bill as a receipt — uses the same
  // pipeline that fires at end-of-meal (server-side ESC/POS to the
  // receipt printer, Electron silent print fallback, browser popup
  // last resort). Requires items to be loaded (they are, because the
  // operator had to expand the bill row to see this button).
  const doReprintReceipt = (bill) => {
    if (!bill) return;
    if (!billItems.length) { alert('Items not loaded yet — try again in a moment.'); return; }
    const subtotal       = Number(bill.total || 0);
    const paid           = Number(bill.paid_amount || bill.total || 0);
    const serviceCharge  = Math.max(0, paid - subtotal);
    const discountAmount = bill.discount_value > 0
      ? (bill.discount_type === 'percent'
          ? subtotal * (bill.discount_value / 100)
          : Number(bill.discount_value))
      : 0;
    printReceipt({
      order: bill,
      items: billItems,
      settings,
      paymentDetails: {
        subtotal,
        discountAmount,
        serviceCharge,
        billTotal: paid,
        amountPaid: paid,
        change: 0,
        method: bill.method || '',
        tip: 0,
      },
    });
  };

  const doPrintBills = async (mode) => {
    if (!bills.length) return;
    const isThermal = (mode === 'thermal');
    if (isThermal) {
      const lines = buildBillsLines(bills, from, to, method, { totalSales, totalCash, totalCard }, settings);
      const r = await escPosPrint(lines);
      if (r && r.success) return;
      const body = buildBillsBody(bills, from, to, method, { totalSales, totalCash, totalCard }, settings, true);
      thermalPrint(pageHtml('Bills — ' + restaurantName(settings), body, 'thermal'));
      return;
    }
    const body = buildBillsBody(bills, from, to, method, { totalSales, totalCash, totalCard }, settings, false);
    fullPagePrint(pageHtml('Bills — ' + restaurantName(settings), body, 'full'));
  };

  const exportCsv = () => {
    if (!bills.length) return;
    const rows = [['Bill #', 'Table', 'Covers', 'Closed at', 'Method', 'Discount', 'Discount reason', 'Total £', 'Paid £']];
    bills.forEach(b => {
      const discountStr = b.discount_value > 0
        ? (b.discount_type === 'percent' ? `-${b.discount_value}%` : `-£${b.discount_value}`)
        : '';
      rows.push([
        b.id, (b.table_number ? dineTableLabel(b) : (b.customer_name || '')), b.covers || '',
        b.closed_at ? new Date(b.closed_at).toISOString() : '',
        b.method || '', discountStr, b.discount_reason || '',
        Number(b.total || 0).toFixed(2),
        Number(b.paid_amount || 0).toFixed(2),
      ]);
    });
    rows.push(['', '', '', '', '', '', `TOTAL (${bills.length} bills)`, totalSales.toFixed(2), '']);
    downloadCsv(`bills_${from}_to_${to}${method !== 'all' ? '_' + method : ''}.csv`, rows);
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        {/* The heading is the hidden gesture target. 5 taps within 3 s
            opens the manager PIN prompt. Looks like a plain heading to
            anyone who doesn't know — invisible to customers + junior
            staff. userSelect off so multi-taps don't select text. */}
        <h1
          onClick={handleHeadingTap}
          style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', margin: 0, cursor: 'default', userSelect: 'none' }}
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
          <button onClick={fetchBills} style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>Search</button>
          <button onClick={() => doPrintBills('thermal')} disabled={!bills.length} style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid var(--brand-primary, #1a1a2e)', background: bills.length ? 'var(--brand-primary, #1a1a2e)' : '#bbb', color: 'white', fontWeight: 700, fontSize: 14, cursor: bills.length ? 'pointer' : 'not-allowed' }}>🖨 Print</button>
          <button onClick={() => doPrintBills('full')}    disabled={!bills.length} style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 14, cursor: bills.length ? 'pointer' : 'not-allowed', opacity: bills.length ? 1 : 0.5 }}>📄 Export</button>
          <button onClick={exportCsv} disabled={!bills.length} style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 14, cursor: bills.length ? 'pointer' : 'not-allowed', opacity: bills.length ? 1 : 0.5 }}>⬇ CSV</button>
        </div>
      </div>
      {/* Summary cards — minmax(140px) so 2 cards fit on phones; clamp
          font so big numbers don't blow out the card on narrow widths. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[{ label: 'Total Bills', value: bills.length, color: '#3b82f6' }, { label: 'Total Sales', value: `£${totalSales.toFixed(2)}`, color: '#e94560' }, { label: 'Cash', value: `£${totalCash.toFixed(2)}`, color: '#22c55e' }, { label: 'Card', value: `£${totalCard.toFixed(2)}`, color: '#8b5cf6' }].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 'clamp(18px, 5vw, 22px)', fontWeight: 800, color: s.color, lineHeight: 1.15 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      {loading ? <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading...</div> : (
        // Horizontal-scroll wrapper so the 7-column bills table doesn't
        // overflow the viewport on mobile — desktop still renders
        // edge-to-edge because the table is wider than 768px below the
        // wrapper minWidth.
        <div style={{ background: 'white', borderRadius: 12, overflowX: 'auto', overflowY: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ minWidth: 860 }}>
          {/* Korakot 2026-06-02: dropped the "Bill #" column. Table number + date
              is the reference operators use day-to-day. */}
          <div style={{ display: 'grid', gridTemplateColumns: '70px 80px 60px 1fr 110px 100px 110px 190px', padding: '12px 20px', background: '#f8f8f8', fontWeight: 700, fontSize: 13, color: '#555' }}>
            <span>Order</span><span>Table</span><span>Cvr</span><span>Date & Time</span><span>Method</span><span style={{ textAlign: 'right' }}>Discount</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ textAlign: 'center' }}>Actions</span>
          </div>
          {bills.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No bills found for this period</div>}
          {bills.map(bill => (
            <div key={bill.id}>
              <div onClick={() => handleSelectBill(bill)} style={{ display: 'grid', gridTemplateColumns: '70px 80px 60px 1fr 110px 100px 110px 190px', padding: '12px 20px', borderBottom: selectedBill?.id === bill.id ? 'none' : '1px solid #f0f0f0', fontSize: 14, cursor: 'pointer', background: selectedBill?.id === bill.id ? '#f0f7ff' : 'white', alignItems: 'center' }}>
                {/* SEPOS-QR-RECEIPT-001 (Korakot 2026-08-07) — the order number a
                    customer's receipt shows. Without it staff had no way to find
                    the bill someone is asking about, or to reprint it. */}
                {/* the number the CUSTOMER sees is the cloud order id; on a Pro
                    till the local id differs, so show the one they'll quote. */}
                <span style={{ fontWeight: 700, color: '#777', fontVariantNumeric: 'tabular-nums' }}>#{bill.cloud_id || bill.id}</span>
                <span style={{ fontWeight: 700, color:'var(--brand-primary, #1a1a2e)' }}>{dineTableLabel(bill)}</span>
                <span style={{ color: '#555' }}>{bill.covers || '—'}</span>
                <span style={{ color: '#555' }}>{formatDateTime(bill.closed_at)}</span>
                <span><span style={{ background: bill.method === 'Cash' ? '#dcfce7' : bill.method === 'Card' ? '#dbeafe' : bill.method === 'Split' ? '#fef3c7' : '#f3f4f6', color: bill.method === 'Cash' ? '#14532d' : bill.method === 'Card' ? '#1e40af' : bill.method === 'Split' ? '#92400e' : '#374151', padding: '2px 8px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>{bill.method === 'Cash' ? '💵' : bill.method === 'Card' ? '💳' : bill.method === 'Split' ? '🔀' : '🔄'} {bill.method}{bill.method === 'Split' && Array.isArray(bill.tenders) ? ` (${bill.tenders.length})` : ''}</span></span>
                <span style={{ textAlign: 'right', color: bill.discount_value > 0 ? '#22c55e' : '#bbb', fontSize: 13 }}>{bill.discount_value > 0 ? bill.discount_type === 'percent' ? `-${bill.discount_value}%` : `-£${bill.discount_value}` : '—'}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>£{Number(bill.paid_amount || bill.total || 0).toFixed(2)}</span>
                <span style={{ textAlign: 'center', display:'flex', justifyContent:'center', alignItems:'center', gap:6 }}>
                  {/* SEPOS-PAY-AMEND-001 — labelled and always visible per
                      Korakot 2026-06-02: "i dont want the amend button need
                      to be in the manager gate, i think it suppose to show
                      obviously". Manager PIN is taken inside the modal —
                      server re-validates against staff role. */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setAmendTarget(bill); }}
                    title="Change payment method"
                    style={{ background:'var(--brand-primary,#0D1B3E)', border:'none', color:'white', cursor:'pointer', fontSize:11, fontWeight:700, padding:'5px 9px', borderRadius:6, whiteSpace:'nowrap' }}
                  >🔄 Change</button>
                  {/* SEPOS-BILLEDIT-001 — correct a wrong/duplicate paid amount (manager PIN in the modal). */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditTarget(bill); }}
                    title="Edit the paid amount / fix a duplicate payment"
                    style={{ background:'#f59e0b', border:'none', color:'white', cursor:'pointer', fontSize:11, fontWeight:700, padding:'5px 9px', borderRadius:6, whiteSpace:'nowrap' }}
                  >✏️ Edit</button>
                  {/* Delete still hidden until a manager unlocks (top-right
                      🔒). Destructive — different gate than the amend.
                      SEPOS-043: supervisors can unlock but cannot delete. */}
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
                                <span style={{ fontWeight: 600, marginLeft: 12 }}>£{(Number(item.unit_price || 0) * Number(item.quantity || 0)).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af' }}>Bill Summary</div>
                          <button onClick={() => doReprintReceipt(bill)} style={{
                            background:'var(--brand-primary,#0D1B3E)', color:'white', border:'none',
                            padding:'6px 12px', borderRadius:6, fontWeight:700,
                            fontSize:11, cursor:'pointer', letterSpacing:0.5,
                          }}>🖨 Re-print receipt</button>
                        </div>
                        {[{ label: 'Date', value: formatDateTime(bill.closed_at) }, { label: 'Method', value: bill.method }, { label: 'Covers', value: bill.covers || '—' }, { label: 'Discount', value: bill.discount_value > 0 ? `${bill.discount_type === 'percent' ? bill.discount_value + '%' : '£' + bill.discount_value} (${bill.discount_reason})` : 'None' }].map(item => (
                          <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                            <span style={{ color: '#888' }}>{item.label}</span><span style={{ fontWeight: 600 }}>{item.value}</span>
                          </div>
                        ))}
                        {/* Explicit Subtotal + Service Charge breakdown.
                            SEPOS-SVCFIX-001 — service charge is the bill's own
                            per-bill charge (dine-in × configured rate) sent by
                            the server, NOT paid−subtotal (which double-counts a
                            split's second tender or a double-charge). */}
                        {(() => {
                          const subtotal      = Number(bill.total || 0);
                          const paid          = Number(bill.paid_amount || bill.total || 0);
                          const serviceCharge = Number(bill.service_charge ?? Math.max(0, paid - subtotal));
                          const scRate        = Number(bill.service_charge_rate ?? 12.5);
                          const tenders       = Array.isArray(bill.tenders) ? bill.tenders : [];
                          const overpaid      = paid - subtotal - serviceCharge; // >0 = took more than the bill (e.g. double-charge)
                          return (
                            <>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff', marginTop: 6 }}>
                                <span style={{ color: '#888' }}>Subtotal</span>
                                <span style={{ fontWeight: 600 }}>£{subtotal.toFixed(2)}</span>
                              </div>
                              {serviceCharge > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #e0edff' }}>
                                  <span style={{ color: 'var(--brand-primary,#0D1B3E)' }}>Service charge ({scRate}%)</span>
                                  <span style={{ fontWeight: 700, color: 'var(--brand-primary,#0D1B3E)' }}>£{serviceCharge.toFixed(2)}</span>
                                </div>
                              )}
                              {/* SEPOS-SPLITBILL-001 — tender breakdown (Cash/Card split). */}
                              {tenders.length > 1 && (
                                <div style={{ padding: '6px 0', borderBottom: '1px solid #e0edff' }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', marginBottom: 4 }}>🔀 Split payment</div>
                                  {tenders.map((t, i) => (
                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                                      <span style={{ color: '#555' }}>{t.method === 'Cash' ? '💵' : t.method === 'Card' ? '💳' : '🔄'} {t.method}</span>
                                      <span style={{ fontWeight: 600 }}>£{Number(t.amount || 0).toFixed(2)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, paddingTop: 8, borderTop: '2px solid #3b82f6', marginTop: 4 }}>
                                <span>Total Paid</span><span style={{ color: '#e94560' }}>£{paid.toFixed(2)}</span>
                              </div>
                              {overpaid > 0.01 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#dc2626', marginTop: 6, background:'#fef2f2', padding:'6px 8px', borderRadius:6 }}>
                                  <span>⚠️ Paid over bill</span><span>+£{overpaid.toFixed(2)}</span>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {bills.length > 0 && (
            // Korakot 2026-06-02: grid template matches the new 7-col
            // header (no Bill # column). Footer total uses paid_amount
            // via the headline totalSales (already service-charge aware).
            <div style={{ display: 'grid', gridTemplateColumns: '70px 80px 60px 1fr 110px 100px 110px 190px', padding: '14px 20px', background: '#f8f8f8', fontWeight: 800, fontSize: 15 }}>
              <span style={{ color: '#555', gridColumn: '1 / 7' }}>Total — {bills.length} bills</span>
              <span style={{ textAlign: 'right', color: '#e94560' }}>£{totalSales.toFixed(2)}</span>
              <span></span>
            </div>
          )}
          </div>
        </div>
      )}
      {deleteTarget && (
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); setSelectedBill(null); fetchBills(); }}
        />
      )}

      {amendTarget && (
        <AmendPaymentModal
          bill={amendTarget}
          onClose={() => setAmendTarget(null)}
          onDone={(r) => {
            setAmendToast(`✓ ${dineTableLabel(amendTarget)} changed from ${r.from} → ${r.to}${r.by ? ' by ' + r.by : ''}`);
            setTimeout(() => setAmendToast(''), 5000);
            setAmendTarget(null);
            fetchBills();
          }}
        />
      )}
      {editTarget && (
        <EditPaymentModal
          bill={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={(r) => {
            setAmendToast(`✓ ${dineTableLabel(editTarget)} payment corrected${r.by ? ' by ' + r.by : ''}`);
            setTimeout(() => setAmendToast(''), 5000);
            setEditTarget(null);
            setSelectedBill(null);
            fetchBills();
          }}
        />
      )}
      {amendToast && (
        <div style={{ position:'fixed', bottom:24, right:24, background:'var(--brand-primary,#0D1B3E)', color:'white', padding:'12px 18px', borderRadius:10, fontWeight:600, fontSize:13, boxShadow:'0 8px 30px rgba(0,0,0,0.3)', zIndex:9000 }}>
          {amendToast}
        </div>
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

// SEPOS-BILLEDIT-001 — correct a wrong/duplicate PAID amount on a closed bill.
// Manager/admin PIN taken here; the server re-validates the role. Editing the
// record does NOT refund a card double-charge — that's done on the terminal.
function EditPaymentModal({ bill, onClose, onDone }) {
  const initial = (Array.isArray(bill.tenders) && bill.tenders.length
    ? bill.tenders
    : [{ id: null, method: bill.method || 'Card', amount: Number(bill.paid_amount || bill.total || 0) }]
  ).map(t => ({ id: t.id, method: t.method, amount: String(Number(t.amount || 0).toFixed(2)), remove: false }));
  const [rows, setRows] = useState(initial);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const subtotal = Number(bill.total || 0);
  const service  = Number(bill.service_charge || 0);
  const expected = subtotal + service; // what the bill SHOULD have been paid
  const newTotal = rows.reduce((s, r) => s + (r.remove ? 0 : (parseFloat(r.amount) || 0)), 0);
  const editable = rows.some(r => r.id != null);

  const setRow = (i, patch) => setRows(rows.map((r, j) => j === i ? { ...r, ...patch } : r));

  const save = async () => {
    if (busy) return;
    setErr('');
    const payments = rows.filter(r => r.id != null).map(r => ({
      id: r.id, remove: r.remove, method: r.method, amount: parseFloat(r.amount) || 0,
    }));
    if (!payments.length) { setErr('This bill has no editable payment rows.'); return; }
    if (!pin) { setErr('Manager PIN required.'); return; }
    setBusy(true);
    try {
      const r = await editBillPayment(bill.id, { payments, reason, pin });
      if (r && r.error) { setErr(r.error); setBusy(false); return; }
      onDone(r || {});
    } catch (e) { setErr(e.message || 'Failed to save'); setBusy(false); }
  };

  const box = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9500, padding:16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:'white', borderRadius:16, padding:24, width:'100%', maxWidth:440, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ fontWeight:800, fontSize:17, color:'var(--brand-primary,#0D1B3E)', marginBottom:4 }}>✏️ Edit payment — {dineTableLabel(bill)}</div>
        <div style={{ fontSize:12, color:'#888', marginBottom:14 }}>Bill £{subtotal.toFixed(2)}{service > 0 ? ` + service £${service.toFixed(2)}` : ''} = <b>£{expected.toFixed(2)}</b> expected</div>

        {rows.map((r, i) => (
          <div key={i} style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10, opacity: r.remove ? 0.45 : 1 }}>
            <select value={r.method} disabled={r.remove || r.id == null} onChange={e => setRow(i, { method:e.target.value })} style={{ ...box, width:110 }}>
              {['Cash','Card','Other','Stripe'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div style={{ position:'relative', flex:1 }}>
              <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#888' }}>£</span>
              <input type="number" step="0.01" value={r.amount} disabled={r.remove || r.id == null} onChange={e => setRow(i, { amount:e.target.value })} style={{ ...box, paddingLeft:22, textDecoration: r.remove ? 'line-through' : 'none' }} />
            </div>
            {r.id != null && (
              <button onClick={() => setRow(i, { remove: !r.remove })} title={r.remove ? 'Keep this payment' : 'Remove this payment'}
                style={{ background: r.remove ? '#6b7280' : '#fee2e2', color: r.remove ? 'white' : '#dc2626', border:'none', borderRadius:8, padding:'8px 10px', fontWeight:700, fontSize:12, cursor:'pointer', whiteSpace:'nowrap' }}>
                {r.remove ? 'Undo' : '✕ Remove'}
              </button>
            )}
          </div>
        ))}

        <div style={{ display:'flex', justifyContent:'space-between', fontWeight:800, fontSize:15, padding:'8px 0', borderTop:'2px solid #eee', marginTop:4, color: Math.abs(newTotal - expected) < 0.01 ? '#16a34a' : '#e94560' }}>
          <span>New total paid</span><span>£{newTotal.toFixed(2)}</span>
        </div>

        <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:8, padding:'8px 12px', fontSize:12, color:'#92400e', margin:'12px 0' }}>
          ⚠️ This corrects the recorded amount only. If a card was genuinely charged twice, also refund it on the card machine.
        </div>

        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (e.g. duplicate charge)" style={{ ...box, marginBottom:10 }} />
        <input value={pin} onChange={e => setPin(e.target.value)} type="password" inputMode="numeric" placeholder="Manager PIN" style={{ ...box, marginBottom:12 }} />
        {err && <div style={{ color:'#dc2626', fontSize:13, marginBottom:10 }}>{err}</div>}
        {!editable && <div style={{ color:'#dc2626', fontSize:12, marginBottom:10 }}>Older bill without linked payment rows — can't edit here.</div>}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={save} disabled={busy || !editable} style={{ flex:2, padding:'12px', borderRadius:10, border:'none', background: busy || !editable ? '#9ca3af' : 'var(--brand-primary,#0D1B3E)', color:'white', fontWeight:800, fontSize:15, cursor: busy || !editable ? 'not-allowed' : 'pointer' }}>{busy ? 'Saving…' : 'Save correction'}</button>
          <button onClick={onClose} style={{ flex:1, padding:'12px', borderRadius:10, border:'none', background:'#f0f0f0', fontWeight:600, cursor:'pointer' }}>Cancel</button>
        </div>
      </div>
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
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 20 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'white', borderRadius: 14, padding: 28, width: 'min(380px, 100%)', boxShadow: '0 30px 80px rgba(0,0,0,0.35)' }}>
        <div style={{ fontSize: 30, marginBottom: 6 }}>🔒</div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>Unlock manager actions</h2>
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
          <button onClick={submit} disabled={busy} style={{ background: 'var(--brand-primary,#0D1B3E)', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Print body builder ────────────────────────────────────────────
function buildBillsBody(bills, from, to, method, totals, settings, thermal) {
  const head = thermal
    ? `<div class="center" style="font-size:13px;font-weight:900;letter-spacing:1px;">${restaurantName(settings)}</div>
       <div class="center small">BILL RECORDS</div>
       <div class="center small muted">${dateLabel(from)} → ${dateLabel(to)}${method && method !== 'all' ? ' · ' + method : ''}</div>
       <div class="center small muted">${nowStamp()}</div>
       <hr class="divider"/>`
    : `<h1>${restaurantName(settings)} — Bill Records</h1>
       <div class="sub"><span class="pill">PERIOD</span> &nbsp; ${dateLabel(from)} → ${dateLabel(to)}${method && method !== 'all' ? ' &nbsp; · &nbsp; ' + method : ''}</div>`;

  const summary = thermal
    ? `<table>
         <tr><td>Bills</td><td class="right">${fmtInt(bills.length)}</td></tr>
         <tr><td>Cash</td><td class="right">${fmt(totals.totalCash)}</td></tr>
         <tr><td>Card</td><td class="right">${fmt(totals.totalCard)}</td></tr>
         <tr class="total-row"><td>TOTAL</td><td class="right">${fmt(totals.totalSales)}</td></tr>
       </table>`
    : `<div class="grid-3" style="margin-top:8px;">
         <div class="card"><div class="lbl">Bills</div><div class="val">${fmtInt(bills.length)}</div></div>
         <div class="card"><div class="lbl">Total sales</div><div class="val">${fmt(totals.totalSales)}</div></div>
         <div class="card"><div class="lbl">Cash / Card</div><div class="val" style="font-size:16px;">${fmt(totals.totalCash)} / ${fmt(totals.totalCard)}</div></div>
       </div>`;

  const list = thermal
    ? `<hr class="divider"/>
       <div class="section-head">Bills</div>
       <table>
         ${bills.map(b => {
           const t = b.closed_at ? new Date(b.closed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
           const lbl = b.table_number ? dineTableLabel(b) : (b.customer_name || '🥡');
           return `<tr><td>${lbl} · ${b.method || '-'} · ${t}</td><td class="right">${fmt(b.paid_amount || b.total)}</td></tr>`;
         }).join('')}
       </table>`
    : `<h2>Bills (${bills.length})</h2>
       <table>
         <thead><tr><th>Closed at</th><th>Table / Customer</th><th>Method</th><th class="right">Covers</th><th class="right">Subtotal</th><th class="right">Paid</th></tr></thead>
         <tbody>
           ${bills.map(b => {
             const t = b.closed_at ? new Date(b.closed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
             const lbl = b.table_number ? dineTableLabel(b) : (b.customer_name || '🥡 Online');
             return `<tr>
               <td>${t}</td>
               <td>${lbl}</td>
               <td>${b.method || '-'}</td>
               <td class="right">${b.covers || '-'}</td>
               <td class="right muted">${fmt(b.total)}</td>
               <td class="right" style="font-weight:700;">${fmt(b.paid_amount || b.total)}</td>
             </tr>`;
           }).join('')}
           <tr class="total-row"><td colspan="5">Total</td><td class="right">${fmt(totals.totalSales)}</td></tr>
         </tbody>
       </table>`;

  return head + summary + list;
}

// ── ESC/POS line builder ──────────────────────────────────────────
function buildBillsLines(bills, from, to, method, totals, settings) {
  const lines = [];
  lines.push({ kind: 'h1', text: restaurantName(settings) });
  lines.push({ kind: 'h2', text: 'BILL RECORDS' });
  lines.push({ kind: 'small', text: `${dateLabel(from)} -> ${dateLabel(to)}${method && method !== 'all' ? '  ' + method : ''}` });
  lines.push({ kind: 'small', text: nowStamp() });
  lines.push({ kind: 'div' });
  lines.push({ kind: 'row', left: 'Bills',  right: fmtInt(bills.length) });
  lines.push({ kind: 'row', left: 'Cash',   right: fmt(totals.totalCash) });
  lines.push({ kind: 'row', left: 'Card',   right: fmt(totals.totalCard) });
  lines.push({ kind: 'div' });
  for (const b of bills) {
    const t = b.closed_at ? new Date(b.closed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const label = b.table_number ? dineTableLabel(b) : (b.customer_name || 'TA');
    lines.push({ kind: 'row', left: `${label}  ${b.method || '-'}  ${t}`, right: fmt(b.paid_amount || b.total) });
  }
  lines.push({ kind: 'total', left: `TOTAL (${bills.length})`, right: fmt(totals.totalSales) });
  return lines;
}
