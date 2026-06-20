import { useState, useEffect, useRef } from 'react';
import { getBill, markBillPrinted, getVoucher, redeemVoucher, applyDiscount, removeVoucherFromBill, assertOk } from '../api';
import { printReceipt } from './ReceiptPrinter';
import { orderShortLabelPlain, orderSubLabel, isTakeaway } from '../utils/orderLabel';
import { confirm } from '../utils/confirm';

export default function BillScreen({ orderId, onClose, onPay }) {

  const [bill, setBill]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [paymentInput, setPaymentInput]     = useState('');
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [stage, setStage]                   = useState('bill');
  const [paymentDetails, setPaymentDetails] = useState(null);

  const [splitCount, setSplitCount]         = useState(2);
  const [splitPaid, setSplitPaid]           = useState([]);
  // SEPOS-062 — per-tender breakdown {amount, method} captured as each split is
  // settled, so the close records real Cash/Card rows (not one lumped 'Split').
  const [splitTenders, setSplitTenders]     = useState([]);
  const [splitItemCount, setSplitItemCount] = useState(2);
  const [itemAssignments, setItemAssignments] = useState({});
  const [splitItemPaid, setSplitItemPaid]   = useState([]);
  const [activePerson, setActivePerson]     = useState(0);

  // SEPOS-VOUCHER-001 — gift voucher redemption state
  const [voucherCode,    setVoucherCode]    = useState('');
  const [voucherLoading, setVoucherLoading] = useState(false);
  const [voucherDetails, setVoucherDetails] = useState(null); // {code, balance, status, ...}
  const [voucherErr,     setVoucherErr]     = useState('');
  // SEPOS-VOUCHER-SCAN-001 — camera QR scanner for Apple Wallet passes
  const [scanning,       setScanning]       = useState(false);
  const scannerRef = useRef(null);
  // SEPOS-VOUCHER-REMOVE-001 — remove-voucher button loading state
  const [removingVoucher, setRemovingVoucher] = useState(false);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    getBill(orderId).then(data => { setBill(data); setLoading(false); markBillPrinted(orderId); });
  }, [orderId]);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  // SEPOS-VOUCHER-SCAN-001 — mount the QR scanner when `scanning` flips
  // true. Dynamic-import keeps html5-qrcode (~250 KB) out of the main
  // bundle so cashiers who never use Scan don't pay for it. Rear camera
  // by default; falls back to whatever the device offers if rear isn't
  // available (older iPads).
  useEffect(() => {
    if (!scanning) return;
    let scanner;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        // Give the React tree one tick to mount #voucher-qr-reader.
        await new Promise(r => setTimeout(r, 50));
        if (cancelled) return;
        scanner = new Html5Qrcode('voucher-qr-reader');
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decoded) => {
            // Stop immediately so the camera releases before we re-render.
            try { await scanner.stop(); } catch {}
            const code = String(decoded || '').trim().toUpperCase();
            if (!code) return;
            setVoucherCode(code);
            setScanning(false);
            // Auto-lookup so cashier doesn't have to press "Look up" too.
            setVoucherLoading(true); setVoucherErr(''); setVoucherDetails(null);
            try {
              const v = await getVoucher(code);
              if (v.error)                      setVoucherErr(v.error);
              else if (v.status !== 'active')   setVoucherErr(`Voucher is ${v.status}`);
              else if (Number(v.balance) <= 0)  setVoucherErr('Voucher has no balance left');
              else                              setVoucherDetails(v);
            } catch (e) { setVoucherErr(e.message || 'Lookup failed'); }
            finally     { setVoucherLoading(false); }
          },
          () => { /* swallow per-frame decode errors */ }
        );
      } catch (e) {
        if (!cancelled) {
          setVoucherErr(e?.message || 'Camera unavailable — type the code instead');
          setScanning(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (scanner) { try { scanner.stop().catch(() => {}); } catch {} }
    };
  }, [scanning]);

  if (loading) return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ color:'white', fontSize:18 }}>Loading bill...</div>
    </div>
  );
  if (!bill || !bill.order) return null;

  const { order, settings } = bill;
  // SEPOS-VOUCHER-REMOVE-001 — flag for showing the "Remove voucher" banner
  const hasVoucherDiscount = order.status === 'open' && order.discount_reason && order.discount_reason.startsWith('Voucher ');
  const serviceChargePercent = parseFloat(settings.service_charge_rate || settings.service_charge_percent || 12.5) / 100;
  const serviceChargeEnabled = settings.service_charge_enabled !== '0' && settings.service_charge_enabled !== 'false';
  const billItems = order.items?.filter(i => !i.voided) || [];

  const subtotal = billItems.reduce((sum, i) => {
    const p = i.unit_price * i.quantity;
    const d = i.discount_value > 0
      ? i.discount_type === 'percent' ? p * (i.discount_value / 100) : Math.min(i.discount_value, p)
      : 0;
    return sum + p - d;
  }, 0);

  // SEPOS-021 — VAT breakdown by rate. UK convention: menu prices are
  // VAT-inclusive, so net = gross × 100 / (100 + rate). Service charge
  // and bill-level discount are out of the VAT scope.
  const vatBuckets = {};
  for (const i of billItems) {
    const rate = Number(i.vat_rate ?? 20);
    let g = i.unit_price * i.quantity;
    if (i.discount_value > 0) {
      g -= i.discount_type === 'percent' ? g * (i.discount_value / 100) : Math.min(i.discount_value, g);
    }
    const net = rate > 0 ? g * (100 / (100 + rate)) : g;
    const vat = g - net;
    if (!vatBuckets[rate]) vatBuckets[rate] = { rate, net: 0, vat: 0, gross: 0 };
    vatBuckets[rate].net   += net;
    vatBuckets[rate].vat   += vat;
    vatBuckets[rate].gross += g;
  }
  const vatBreakdown = Object.values(vatBuckets).sort((a, b) => a.rate - b.rate);
  const vatTotal = vatBreakdown.reduce((s, b) => s + b.vat, 0);

  const discountAmount = order.discount_value > 0
    ? order.discount_type === 'percent' ? subtotal * (order.discount_value / 100) : parseFloat(order.discount_value)
    : 0;
  const discountRate  = subtotal > 0 ? discountAmount / subtotal : 0;
  const afterDiscount = subtotal - discountAmount;
  const serviceCharge = serviceChargeEnabled ? afterDiscount * serviceChargePercent : 0;
  const billTotalPence = Math.round(afterDiscount * 100) + Math.round(serviceCharge * 100);
  const billTotal      = billTotalPence / 100;

  const amountPaid      = parseFloat(paymentInput) || 0;
  const amountPaidPence = Math.round(amountPaid * 100);
  const change          = amountPaid - billTotal;
  const actualTip       = selectedMethod !== 'Cash' ? Math.max(0, amountPaid - billTotal) : 0;
  const canPay          = amountPaidPence >= billTotalPence && amountPaidPence > 0;

  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  const splitAmount    = billTotal / splitCount;
  const paidCount      = splitPaid.length;
  const remainingEqual = billTotal - (paidCount * splitAmount);

  const getPersonTotal = (personIdx) => {
    const personItems = billItems.filter(item => itemAssignments[item.id] === personIdx);
    const personSubtotal = personItems.reduce((sum, i) => {
      const p = i.unit_price * i.quantity;
      const d = i.discount_value > 0 ? i.discount_type === 'percent' ? p * (i.discount_value / 100) : Math.min(i.discount_value, p) : 0;
      return sum + p - d;
    }, 0);
    const personDiscount     = personSubtotal * discountRate;
    const personAfterDiscount = personSubtotal - personDiscount;
    const personService      = serviceChargeEnabled ? personAfterDiscount * serviceChargePercent : 0;
    return { items: personItems, subtotal: personSubtotal, discount: personDiscount, afterDiscount: personAfterDiscount, service: personService, total: personAfterDiscount + personService };
  };

  const unassignedItems = billItems.filter(item => itemAssignments[item.id] === undefined);
  const allAssigned     = unassignedItems.length === 0 && billItems.length > 0;
  const personColors    = ['#e94560','#3b82f6','#22c55e','#8b5cf6','#f97316','#06b6d4','#ec4899','#eab308'];

  const handleNumpad = (btn) => {
    if (btn === 'C')  { setPaymentInput(''); return; }
    if (btn === '⌫') { setPaymentInput(p => p.slice(0,-1)); return; }
    if (btn === '.') { if (paymentInput.includes('.')) return; setPaymentInput(p => (p||'0')+'.'); return; }
    if (paymentInput.includes('.') && paymentInput.split('.')[1]?.length >= 2) return;
    setPaymentInput(p => p + btn);
  };

  // ── The shared receipt payload — pre-calculated totals from BillScreen ──
  const receiptTotals = { subtotal, discountAmount, serviceCharge, billTotal };

  const handlePrintBill = () => {
    printReceipt({ order: { ...order }, items: billItems, settings: { ...settings }, paymentDetails: { ...receiptTotals } });
  };

  const handlePrintReceipt = () => {
    printReceipt({ order: { ...order }, items: billItems, settings: { ...settings }, paymentDetails: { ...receiptTotals, ...paymentDetails } });
  };

  const handleConfirmPayment = () => {
    if (amountPaidPence < billTotalPence) { alert(`Amount £${amountPaid.toFixed(2)} is less than bill £${billTotal.toFixed(2)}`); return; }
    setPaymentDetails({ method: selectedMethod, amountPaid, tip: actualTip, change: Math.max(0, change) });
    setStage('receipt');
  };

  // SEPOS-VOUCHER-001 — voucher redemption
  const handleVoucherLookup = async () => {
    const code = (voucherCode || '').trim().toUpperCase();
    if (!code) { setVoucherErr('Enter a voucher code'); return; }
    setVoucherLoading(true); setVoucherErr(''); setVoucherDetails(null);
    try {
      const v = await getVoucher(code);
      if (v.error) { setVoucherErr(v.error); }
      else if (v.status !== 'active')   { setVoucherErr(`Voucher is ${v.status}`); }
      else if (Number(v.balance) <= 0)  { setVoucherErr('Voucher has no balance left'); }
      else                              { setVoucherDetails(v); }
    } catch (e) { setVoucherErr(e.message || 'Lookup failed'); }
    finally     { setVoucherLoading(false); }
  };

  // SEPOS-VOUCHER-SCAN-001 — operator pressed cancel on the scanner sheet
  const handleStopScan = () => {
    const s = scannerRef.current;
    if (s) { try { s.stop().catch(() => {}); } catch {} }
    setScanning(false);
  };

  // SEPOS-VOUCHER-REMOVE-001 — undo a partial voucher discount on an
  // open bill. Customer changed their mind and wants to pay the full
  // amount instead. Restores voucher balance + clears the discount row.
  const handleRemoveVoucher = async () => {
    if (!await confirm('Remove voucher from this bill? Voucher balance will be restored.')) return;
    setRemovingVoucher(true);
    try {
      const r = await removeVoucherFromBill(orderId);
      if (r.error) { alert('Could not remove: ' + r.error); return; }
      const fresh = await getBill(orderId);
      setBill(fresh);
    } catch (e) { alert(e.message || 'Remove failed'); }
    finally     { setRemovingVoucher(false); }
  };

  const handleVoucherApply = async () => {
    if (!voucherDetails) return;
    const code      = voucherDetails.code;
    const balance   = Number(voucherDetails.balance);
    const isFull    = balance >= billTotal;
    const useAmount = isFull ? billTotal : balance;
    setVoucherLoading(true); setVoucherErr('');
    try {
      const r = await redeemVoucher(code, useAmount, orderId, null);
      if (r.error) { setVoucherErr(r.error); setVoucherLoading(false); return; }
      if (isFull) {
        // SEPOS-047d — voucher covers the full bill. Do NOT call payOrder
        // here: the receipt "✓ Done" button (handleFinish → onPay) records
        // the single payment for EVERY method. The old payOrder('voucher')
        // here plus onPay('Voucher') on Done wrote TWO payment rows, double-
        // counting voucher takings in Z / Reports. Just show the receipt;
        // onPay closes the order as method='Voucher'.
        setPaymentDetails({ method: 'Voucher', amountPaid: billTotal, tip: 0, change: 0, voucher_code: code });
        setStage('receipt');
      } else {
        // Partial — apply as a discount, leave the bill open for Cash/Card
        // to settle the remainder. Customer-facing wording mirrors the
        // spa pattern so the receipt reads sensibly. assertOk so a failed
        // discount (after the voucher was already redeemed server-side)
        // surfaces in the catch instead of silently vanishing the balance.
        assertOk(await applyDiscount(orderId, 'fixed', useAmount, `Voucher ${code} −£${useAmount.toFixed(2)}`));
        const fresh = await getBill(orderId);
        setBill(fresh);
        setStage('bill');
      }
    } catch (e) { setVoucherErr(e.message || 'Apply failed'); }
    finally     { setVoucherLoading(false); }
  };

  const handleFinish = () => {
    // SEPOS-062 — pass the per-tender breakdown for splits so each Cash/Card
    // amount is recorded as its own payment row (correct Z-report reconciliation).
    onPay(billTotal, paymentDetails?.method, paymentDetails?.amountPaid, paymentDetails?.tip, paymentDetails?.tenders);
  };

  const handleSplitEqualPayment = (index, method = 'Cash') => {
    const newPaid = [...splitPaid, index];
    const isLast = newPaid.length >= splitCount;
    // SEPOS-062 — the LAST tender absorbs the rounding remainder so the recorded
    // payments sum to billTotal exactly (e.g. £10 / 3 = 3.33+3.33+3.34, not 9.99).
    const prevSum = splitTenders.reduce((s, t) => s + t.amount, 0);
    const amount = isLast ? Number((billTotal - prevSum).toFixed(2)) : Number(splitAmount.toFixed(2));
    setSplitPaid(newPaid);
    const newTenders = [...splitTenders, { amount, method }];
    setSplitTenders(newTenders);
    if (isLast) { setPaymentDetails({ method:'Split', amountPaid:billTotal, tip:0, change:0, tenders:newTenders }); setStage('receipt'); }
  };

  const handleSplitItemPayment = (personIdx, method = 'Cash') => {
    const newPaid = [...splitItemPaid, personIdx];
    const isLast = newPaid.length >= splitItemCount;
    const prevSum = splitTenders.reduce((s, t) => s + t.amount, 0);
    const amount = isLast ? Number((billTotal - prevSum).toFixed(2)) : Number(getPersonTotal(personIdx).total.toFixed(2));
    setSplitItemPaid(newPaid);
    const newTenders = [...splitTenders, { amount, method }];
    setSplitTenders(newTenders);
    if (isLast) { setPaymentDetails({ method:'Split by Item', amountPaid:billTotal, tip:0, change:0, tenders:newTenders }); setStage('receipt'); }
  };

  const handleSplitEqualPrint = (i) => {
    printReceipt({
      order: { ...order },
      items: billItems,
      settings: { ...settings },
      paymentDetails: {
        subtotal: afterDiscount / splitCount,
        discountAmount: discountAmount / splitCount,
        serviceCharge: serviceCharge / splitCount,
        billTotal: splitAmount,
        method: 'Split',
        amountPaid: splitAmount,
      }
    });
    // SEPOS-062 — print only; the staff then taps 💵 Cash / 💳 Card to settle
    // this person, so the real tender method is captured (not lost on print).
  };

  const handleSplitItemPrint = (personIdx) => {
    const p = getPersonTotal(personIdx);
    printReceipt({
      order: { ...order },
      items: p.items,
      settings: { ...settings },
      paymentDetails: {
        subtotal: p.subtotal,
        discountAmount: p.discount,
        serviceCharge: p.service,
        billTotal: p.total,
        method: 'Split by Item',
        amountPaid: p.total,
      }
    });
    // SEPOS-062 — print only; staff taps 💵 Cash / 💳 Card to settle this person.
  };

  const overlay = { position:'fixed', inset:0, background:isMobile?'white':'rgba(0,0,0,0.75)', display:'flex', alignItems:isMobile?'flex-start':'center', justifyContent:'center', zIndex:9999, padding:isMobile?0:16, overflowY:'auto' };
  const card    = { background:'white', borderRadius:isMobile?0:20, width:'100%', maxWidth:isMobile?'100%':(stage==='amount'?820:stage==='split_items'?600:480), maxHeight:isMobile?'none':'95vh', overflowY:isMobile?'visible':'auto', boxShadow:isMobile?'none':'0 20px 60px rgba(0,0,0,0.5)' };

  const mobileTopBar = (title, onBack, backLabel='← Back') => isMobile && (
    <div style={{ padding:'14px 16px', borderBottom:'1px solid #eee', display:'flex', alignItems:'center', gap:12, background:'white', position:'sticky', top:0, zIndex:10, flexShrink:0 }}>
      <button onClick={onBack} style={{ background:'#f0f0f0', border:'none', borderRadius:8, padding:'8px 14px', fontWeight:700, fontSize:13, cursor:'pointer', color:'#555', flexShrink:0 }}>{backLabel}</button>
      <div style={{ flex:1, textAlign:'center', fontWeight:700, fontSize:15, color:'#1a1a2e' }}>{title}</div>
      <div style={{ width:70, flexShrink:0 }} />
    </div>
  );

  return (
    <div style={overlay}>
      {/* SEPOS-VOUCHER-SCAN-001 — camera scanner overlay */}
      {scanning && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.95)', zIndex:10001, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ color:'white', fontSize:18, fontWeight:700, marginBottom:6, textAlign:'center' }}>Scan voucher QR</div>
          <div style={{ color:'#ccc', fontSize:13, marginBottom:18, textAlign:'center', maxWidth:340 }}>Point the camera at the QR on the customer's Apple Wallet pass</div>
          <div id="voucher-qr-reader" style={{ width:'min(90vw, 360px)', background:'black', borderRadius:14, overflow:'hidden', border:'2px solid #C9A84C' }} />
          <button onClick={handleStopScan}
            style={{ marginTop:22, padding:'14px 28px', borderRadius:10, border:'none', background:'#dc2626', color:'white', fontWeight:700, fontSize:16, cursor:'pointer' }}>
            ✕ Cancel
          </button>
        </div>
      )}
      <div style={card}>

        {/* ═══════════════ BILL ═══════════════ */}
        {stage === 'bill' && (
          <div>
            {mobileTopBar(orderShortLabelPlain(order), onClose, '✕ Close')}
            <div style={{ padding:isMobile?'20px 16px':'28px 24px' }}>
              <div style={{ textAlign:'center', marginBottom:20 }}>
                <div style={{ fontSize:22, fontWeight:800, color:'#1a1a2e' }}>{settings.company_name || settings.restaurant_name || 'My Restaurant'}</div>
                {settings.company_address && <div style={{ fontSize:12, color:'#555', marginTop:4 }}>{settings.company_address}</div>}
                {settings.company_phone   && <div style={{ fontSize:12, color:'#555' }}>Tel: {settings.company_phone}</div>}
                {settings.company_vat     && <div style={{ fontSize:12, color:'#555' }}>VAT: {settings.company_vat}</div>}
              </div>
              <div style={{ borderTop:'1px dashed #ccc', borderBottom:'1px dashed #ccc', padding:'8px 0', marginBottom:16, display:'flex', justifyContent:'space-between', fontSize:12, color:'#555' }}>
                <span>{orderShortLabelPlain(order)}{isTakeaway(order) ? (orderSubLabel(order) ? ` · ${orderSubLabel(order)}` : '') : ` · ${order.covers||1} covers`}</span>
                <span>{dateStr} {timeStr}</span>
              </div>
              <div style={{ marginBottom:16, fontFamily:'monospace' }}>
                {billItems.map(item => {
                  const p = item.unit_price * item.quantity;
                  const d = item.discount_value>0 ? item.discount_type==='percent' ? p*(item.discount_value/100) : Math.min(item.discount_value,p) : 0;
                  return (
                    <div key={item.id} style={{ marginBottom:8 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:14 }}>
                        <span>{item.quantity}× {item.name}</span>
                        <span>£{(p-d).toFixed(2)}</span>
                      </div>
                      {item.notes     && <div style={{ fontSize:11, color:'#888', marginLeft:16 }}>{item.notes}</div>}
                      {item.item_note && <div style={{ fontSize:11, color:'#3b82f6', marginLeft:16 }}>📝 {item.item_note}</div>}
                      {item.discount_value>0 && <div style={{ fontSize:11, color:'#22c55e', marginLeft:16 }}>🏷️ {item.discount_type==='percent'?`${item.discount_value}% off`:`£${item.discount_value} off`} (-£{d.toFixed(2)})</div>}
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop:'1px dashed #ccc', paddingTop:12, marginBottom:16 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, marginBottom:6, color:'#555' }}><span>Subtotal</span><span>£{subtotal.toFixed(2)}</span></div>
                {discountAmount>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, marginBottom:6, color:'#22c55e' }}><span>Discount ({order.discount_reason})</span><span>-£{discountAmount.toFixed(2)}</span></div>}
                {serviceChargeEnabled && <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, marginBottom:6, color:'#555' }}><span>Service charge ({parseFloat(settings.service_charge_rate||settings.service_charge_percent||12.5)}%)</span><span>£{serviceCharge.toFixed(2)}</span></div>}
                {/* SEPOS-021 VAT breakdown — informational; prices are VAT-inclusive */}
                {vatTotal > 0 && (
                  <div style={{ marginTop:8, padding:'8px 10px', background:'#f8f8f8', borderRadius:8, fontSize:12, color:'#555' }}>
                    <div style={{ fontWeight:700, marginBottom:4, color:'#1a1a2e' }}>VAT included</div>
                    {vatBreakdown.map(b => (
                      <div key={b.rate} style={{ display:'flex', justifyContent:'space-between' }}>
                        <span>@ {b.rate}% on £{b.net.toFixed(2)} net</span>
                        <span>£{b.vat.toFixed(2)}</span>
                      </div>
                    ))}
                    <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid #e0e0e0', marginTop:4, paddingTop:4, fontWeight:700 }}>
                      <span>Total VAT</span><span>£{vatTotal.toFixed(2)}</span>
                    </div>
                  </div>
                )}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:24, fontWeight:800, marginTop:10, color:'#1a1a2e' }}><span>TOTAL</span><span>£{billTotal.toFixed(2)}</span></div>
              </div>
              <div style={{ textAlign:'center', fontSize:12, color:'#888', borderTop:'1px dashed #ccc', paddingTop:12 }}>{settings.receipt_footer||'Thank you for dining with us!'}</div>
            </div>
            <div style={{ padding:isMobile?'0 16px 32px':'0 24px 24px', display:'flex', flexDirection:'column', gap:10 }}>
              {isTakeaway(order) && (order.payment_status === 'paid' || order.payment_status === 'mock') ? (
                // Online takeaway already paid via the widget. One-tap close
                // records the payment row so it lands in Reports / Z-Report /
                // VAT / Bills the same way Cash + Card orders do.
                <button
                  onClick={() => {
                    const method = order.payment_status === 'paid' ? 'Online (Stripe)' : 'Online (mock)';
                    setPaymentDetails({ method, amountPaid: billTotal, tip: 0, change: 0 });
                    setStage('receipt');
                  }}
                  style={{ padding:'18px', borderRadius:12, border:'none', background:'#16a34a', color:'white', fontSize:18, fontWeight:800, cursor:'pointer' }}
                >
                  ✓ Confirm Collection — Already Paid Online (£{billTotal.toFixed(2)})
                </button>
              ) : (
                <>
                  <button onClick={() => setStage('method')} style={{ padding:'18px', borderRadius:12, border:'none', background:'#1a1a2e', color:'white', fontSize:18, fontWeight:800, cursor:'pointer' }}>💳 Take Payment — £{billTotal.toFixed(2)}</button>
                  <button onClick={() => { setSplitPaid([]); setSplitTenders([]); setStage('split_equal'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid #C9A84C', background:'white', color:'#C9A84C', fontSize:15, fontWeight:700, cursor:'pointer' }}>✂️ Split Equally</button>
                  <button onClick={() => { setItemAssignments({}); setSplitItemPaid([]); setSplitTenders([]); setActivePerson(0); setStage('split_items'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid #3b82f6', background:'white', color:'#3b82f6', fontSize:15, fontWeight:700, cursor:'pointer' }}>🍽️ Split by Item</button>
                </>
              )}
              <button onClick={handlePrintBill} style={{ padding:'12px', borderRadius:10, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontSize:14, fontWeight:600, cursor:'pointer' }}>🖨️ Print Bill</button>
              {!isMobile && <button onClick={onClose} style={{ padding:'12px', borderRadius:10, border:'none', background:'#f0f0f0', color:'#555', fontSize:14, cursor:'pointer' }}>Close</button>}
            </div>
          </div>
        )}

        {/* ═══════════════ RECEIPT ═══════════════ */}
        {stage === 'receipt' && (
          <div>
            {mobileTopBar('Receipt', () => {}, '')}
            <div style={{ padding:isMobile?'32px 20px':40, textAlign:'center' }}>
              <div style={{ fontSize:72, marginBottom:16 }}>✅</div>
              <div style={{ fontSize:24, fontWeight:800, color:'#22c55e', marginBottom:8 }}>Payment Confirmed!</div>
              <div style={{ fontSize:32, fontWeight:800, color:'#1a1a2e', marginBottom:4 }}>£{billTotal.toFixed(2)}</div>
              <div style={{ fontSize:14, color:'#888', marginBottom:28 }}>{paymentDetails?.method} · {orderShortLabelPlain(order)}</div>
              {paymentDetails?.change > 0 && (
                <div style={{ background:'#f0fdf4', border:'2px solid #22c55e', borderRadius:14, padding:'16px 20px', marginBottom:24 }}>
                  <div style={{ fontSize:13, color:'#166534', marginBottom:4 }}>💚 Change to give customer</div>
                  <div style={{ fontSize:40, fontWeight:900, color:'#22c55e' }}>£{paymentDetails.change.toFixed(2)}</div>
                </div>
              )}
              {paymentDetails?.tip > 0 && (
                <div style={{ background:'#faf5ff', border:'2px solid #8b5cf6', borderRadius:14, padding:'12px 20px', marginBottom:24 }}>
                  <div style={{ fontSize:13, color:'#6d28d9', marginBottom:2 }}>💜 Tip</div>
                  <div style={{ fontSize:28, fontWeight:800, color:'#8b5cf6' }}>£{paymentDetails.tip.toFixed(2)}</div>
                </div>
              )}
              <div style={{ display:'flex', flexDirection:'column', gap:12, maxWidth:340, margin:'0 auto' }}>
                <button onClick={handlePrintReceipt} style={{ padding:'16px 24px', borderRadius:12, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontSize:16, fontWeight:700, cursor:'pointer' }}>🖨️ Print Receipt</button>
                <button onClick={handleFinish} style={{ padding:'18px 24px', borderRadius:12, border:'none', background:'#1a1a2e', color:'white', fontSize:17, fontWeight:800, cursor:'pointer' }}>✓ Done — Close</button>
              </div>
              <p style={{ fontSize:11, color:'#bbb', marginTop:20 }}>Printer not shown? Set your thermal printer as the default printer in your browser settings.</p>
            </div>
          </div>
        )}

        {/* ═══════════════ SPLIT EQUALLY ═══════════════ */}
        {stage === 'split_equal' && (
          <div>
            {mobileTopBar('Split Equally', () => setStage('bill'), '← Bill')}
            <div style={{ padding:isMobile?'20px 16px':32 }}>
              {!isMobile && <div style={{ textAlign:'center', marginBottom:24 }}><div style={{ fontSize:22, fontWeight:800, color:'#1a1a2e' }}>✂️ Split Equally</div><div style={{ fontSize:14, color:'#888', marginTop:4 }}>Total: £{billTotal.toFixed(2)}</div></div>}
              {isMobile  && <div style={{ textAlign:'center', marginBottom:20 }}><div style={{ fontSize:15, color:'#888' }}>Total: <span style={{ fontWeight:800, color:'#1a1a2e', fontSize:20 }}>£{billTotal.toFixed(2)}</span></div></div>}
              <div style={{ marginBottom:24 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'#555', marginBottom:12, textAlign:'center' }}>Split between how many people?</div>
                <div style={{ display:'grid', gridTemplateColumns:isMobile?'repeat(3,1fr)':'repeat(5,1fr)', gap:8 }}>
                  {[2,3,4,5,6,7,8,9,10].map(n => (
                    <button key={n} onClick={() => { setSplitCount(n); setSplitPaid([]); }} style={{ padding:isMobile?'16px 8px':'14px 8px', borderRadius:10, border:'none', cursor:'pointer', fontWeight:700, fontSize:18, background:splitCount===n?'#1a1a2e':'#f0f0f0', color:splitCount===n?'white':'#1a1a2e' }}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ background:'#f8f8f8', borderRadius:14, padding:20, marginBottom:24 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, color:'#555', marginBottom:8 }}><span>Each person pays</span><span style={{ fontWeight:800, fontSize:24, color:'#1a1a2e' }}>£{splitAmount.toFixed(2)}</span></div>
                {serviceChargeEnabled && serviceCharge>0 && <div style={{ fontSize:12, color:'#888', marginBottom:4 }}>Includes service charge (£{(serviceCharge/splitCount).toFixed(2)} each)</div>}
                {discountAmount>0 && <div style={{ fontSize:12, color:'#22c55e', marginBottom:4 }}>Includes discount (-£{(discountAmount/splitCount).toFixed(2)} each)</div>}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'#888', marginTop:8 }}><span>Paid so far</span><span>{paidCount} of {splitCount} people</span></div>
                {paidCount>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, color:'#22c55e', marginTop:8, fontWeight:700 }}><span>Remaining</span><span>£{remainingEqual.toFixed(2)}</span></div>}
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
                {Array.from({length:splitCount},(_,i) => {
                  const isPaid = splitPaid.includes(i);
                  return (
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 18px', borderRadius:12, background:isPaid?'#f0fdf4':'white', border:`2px solid ${isPaid?'#22c55e':'#e0e0e0'}` }}>
                      <div><div style={{ fontWeight:700, color:isPaid?'#22c55e':'#1a1a2e' }}>{isPaid?'✅':'👤'} Person {i+1}</div><div style={{ fontSize:13, color:'#888' }}>£{splitAmount.toFixed(2)}</div></div>
                      {!isPaid
                        ? <div style={{ display:'flex', gap:8 }}>
                            <button onClick={() => handleSplitEqualPayment(i, 'Cash')} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                            <button onClick={() => handleSplitEqualPayment(i, 'Card')} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'#C9A84C', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
                            <button onClick={() => handleSplitEqualPrint(i)} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontWeight:700, fontSize:13, cursor:'pointer' }}>🖨️ Print</button>
                          </div>
                        : <div style={{ color:'#22c55e', fontWeight:700 }}>Paid ✓</div>
                      }
                    </div>
                  );
                })}
              </div>
              {!isMobile && <button onClick={() => setStage('bill')} style={{ width:'100%', padding:'14px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:15 }}>← Back to Bill</button>}
            </div>
          </div>
        )}

        {/* ═══════════════ SPLIT BY ITEM ═══════════════ */}
        {stage === 'split_items' && (
          <div>
            {mobileTopBar('Split by Item', () => setStage('bill'), '← Bill')}
            <div style={{ padding:isMobile?'16px 16px':28 }}>
              {!isMobile && <div style={{ textAlign:'center', marginBottom:20 }}><div style={{ fontSize:22, fontWeight:800, color:'#1a1a2e' }}>🍽️ Split by Item</div><div style={{ fontSize:13, color:'#888', marginTop:4 }}>Assign each item to a person</div></div>}
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#555', marginBottom:10 }}>How many people?</div>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {[2,3,4,5,6,7,8].map(n => (
                    <button key={n} onClick={() => { setSplitItemCount(n); setItemAssignments({}); setSplitItemPaid([]); setActivePerson(0); }} style={{ padding:isMobile?'12px 18px':'10px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:16, background:splitItemCount===n?'#1a1a2e':'#f0f0f0', color:splitItemCount===n?'white':'#1a1a2e' }}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#555', marginBottom:10 }}>Assigning to:</div>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {Array.from({length:splitItemCount},(_,i) => (
                    <button key={i} onClick={() => setActivePerson(i)} style={{ padding:isMobile?'12px 16px':'10px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:13, background:activePerson===i?personColors[i]:'#f0f0f0', color:activePerson===i?'white':'#555', opacity:splitItemPaid.includes(i)?0.4:1 }}>👤 Person {i+1}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#555', marginBottom:10 }}>
                  Tap items to assign to Person {activePerson+1}:
                  {unassignedItems.length>0 && <span style={{ color:'#e94560', marginLeft:8 }}>{unassignedItems.length} unassigned</span>}
                </div>
                {billItems.map(item => {
                  const assignedTo=itemAssignments[item.id]; const isAssigned=assignedTo!==undefined;
                  const ac=isAssigned?personColors[assignedTo]:null;
                  const p=item.unit_price*item.quantity;
                  const d=item.discount_value>0?item.discount_type==='percent'?p*(item.discount_value/100):Math.min(item.discount_value,p):0;
                  return (
                    <div key={item.id} onClick={() => { if(splitItemPaid.includes(assignedTo)) return; setItemAssignments(prev=>({...prev,[item.id]:activePerson})); }}
                      style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:isMobile?'14px 16px':'12px 16px', borderRadius:10, marginBottom:8, border:`2px solid ${isAssigned?ac:'#e0e0e0'}`, background:isAssigned?`${ac}15`:'white', cursor:'pointer' }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:600, fontSize:isMobile?15:14, color:'#1a1a2e' }}>{item.quantity}× {item.name}</div>
                        {item.notes && <div style={{ fontSize:11, color:'#888' }}>{item.notes}</div>}
                        {item.discount_value>0 && <div style={{ fontSize:11, color:'#22c55e' }}>🏷️ -£{d.toFixed(2)}</div>}
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ fontWeight:700, color:'#1a1a2e' }}>£{(p-d).toFixed(2)}</span>
                        {isAssigned
                          ? <div style={{ background:ac, color:'white', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>P{assignedTo+1}</div>
                          : <div style={{ background:personColors[activePerson], color:'white', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700, opacity:0.4 }}>P{activePerson+1}</div>
                        }
                      </div>
                    </div>
                  );
                })}
              </div>
              {allAssigned && (
                <div style={{ marginBottom:20 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'#555', marginBottom:12 }}>💰 Payment Summary:</div>
                  {Array.from({length:splitItemCount},(_,i) => {
                    const p=getPersonTotal(i); const isPaid=splitItemPaid.includes(i);
                    if(p.items.length===0) return null;
                    return (
                      <div key={i} style={{ borderRadius:12, padding:16, marginBottom:10, border:`2px solid ${isPaid?'#22c55e':personColors[i]}`, background:isPaid?'#f0fdf4':`${personColors[i]}08` }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                          <div style={{ fontWeight:700, color:isPaid?'#22c55e':personColors[i], fontSize:15 }}>{isPaid?'✅':'👤'} Person {i+1}</div>
                          <div style={{ fontWeight:800, fontSize:18, color:'#1a1a2e' }}>£{p.total.toFixed(2)}</div>
                        </div>
                        {p.items.map(item => <div key={item.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:2 }}><span>{item.quantity}× {item.name}</span><span>£{(item.unit_price*item.quantity).toFixed(2)}</span></div>)}
                        <div style={{ borderTop:'1px dashed #ccc', marginTop:8, paddingTop:8 }}>
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:3 }}><span>Subtotal</span><span>£{p.subtotal.toFixed(2)}</span></div>
                          {p.discount>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#22c55e', marginBottom:3 }}><span>Discount</span><span>-£{p.discount.toFixed(2)}</span></div>}
                          {serviceChargeEnabled&&p.service>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:3 }}><span>Service ({parseFloat(settings.service_charge_rate||12.5)}%)</span><span>£{p.service.toFixed(2)}</span></div>}
                        </div>
                        {!isPaid && <div style={{ display:'flex', gap:8, marginTop:12 }}>
                          <button onClick={() => handleSplitItemPayment(i, 'Cash')} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                          <button onClick={() => handleSplitItemPayment(i, 'Card')} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:personColors[i], color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
                          <button onClick={() => handleSplitItemPrint(i)} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontWeight:700, fontSize:13, cursor:'pointer' }}>🖨️ Print</button>
                        </div>}
                      </div>
                    );
                  })}
                </div>
              )}
              {!allAssigned&&billItems.length>0 && <div style={{ background:'#fff3cd', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:13, color:'#856404', fontWeight:600 }}>⚠️ Please assign all {unassignedItems.length} remaining item{unassignedItems.length!==1?'s':''} before paying</div>}
              {!isMobile && <button onClick={() => setStage('bill')} style={{ width:'100%', padding:'14px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:15 }}>← Back to Bill</button>}
            </div>
          </div>
        )}

        {/* ═══════════════ METHOD ═══════════════ */}
        {stage === 'method' && (
          <div>
            {mobileTopBar('Payment Method', () => setStage('bill'), '← Bill')}
            <div style={{ padding:isMobile?'24px 16px 32px':32 }}>
              <div style={{ textAlign:'center', marginBottom:28 }}>
                <div style={{ fontSize:13, color:'#888', marginBottom:8 }}>Bill total</div>
                <div style={{ fontSize:42, fontWeight:800, color:'#1a1a2e' }}>£{billTotal.toFixed(2)}</div>
                {serviceChargeEnabled&&serviceCharge>0 && <div style={{ fontSize:13, color:'#888', marginTop:4 }}>Incl. service charge £{serviceCharge.toFixed(2)}</div>}
              </div>
              {hasVoucherDiscount && (
                <div style={{ background:'#fdf6ec', border:'2px solid #C9A84C', borderRadius:12, padding:'12px 16px', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:11, color:'#5b4a2a', textTransform:'uppercase', letterSpacing:0.5, fontWeight:700 }}>🎁 Voucher applied</div>
                    <div style={{ fontSize:14, color:'#5b4a2a', fontFamily:'Menlo,Consolas,monospace', fontWeight:700, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{order.discount_reason}</div>
                  </div>
                  <button onClick={handleRemoveVoucher} disabled={removingVoucher}
                    style={{ padding:'10px 14px', borderRadius:8, border:'1px solid #dc2626', background:'white', color:'#dc2626', fontWeight:700, fontSize:13, cursor:'pointer', whiteSpace:'nowrap', opacity:removingVoucher?0.5:1 }}>
                    {removingVoucher ? '…' : '✕ Remove'}
                  </button>
                </div>
              )}
              <div style={{ fontSize:16, fontWeight:700, color:'#555', marginBottom:16, textAlign:'center' }}>Select payment method</div>
              <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:16 }}>
                {[{method:'Cash',icon:'💵'},{method:'Card',icon:'💳'},{method:'Other',icon:'🔄'}].map(({method,icon}) => (
                  <button key={method} onClick={() => { setSelectedMethod(method); setPaymentInput(''); setStage('amount'); }} style={{ padding:isMobile?'22px':'20px', borderRadius:12, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontSize:isMobile?22:20, fontWeight:700, cursor:'pointer' }}>{icon} {method}</button>
                ))}
                <button onClick={() => { setVoucherCode(''); setVoucherDetails(null); setVoucherErr(''); setStage('voucher'); }} style={{ padding:isMobile?'22px':'20px', borderRadius:12, border:'2px solid #C9A84C', background:'#fdf6ec', color:'#5b4a2a', fontSize:isMobile?22:20, fontWeight:700, cursor:'pointer' }}>🎁 Voucher</button>
              </div>
              {!isMobile && <button onClick={() => setStage('bill')} style={{ width:'100%', padding:'14px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:15 }}>← Back to Bill</button>}
            </div>
          </div>
        )}

        {/* ═══════════════ VOUCHER ═══════════════ */}
        {stage === 'voucher' && (
          <div>
            {mobileTopBar('Gift Voucher', () => setStage('method'), '← Method')}
            <div style={{ padding: isMobile ? '24px 16px 32px' : 32 }}>
              <div style={{ textAlign: 'center', marginBottom: 22 }}>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 6 }}>Bill total</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: '#1a1a2e' }}>£{billTotal.toFixed(2)}</div>
              </div>

              <div style={{ background: '#fdf6ec', border: '2px solid #C9A84C', borderRadius: 12, padding: 18, marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: '#5b4a2a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>Voucher code</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" autoFocus value={voucherCode}
                    onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleVoucherLookup(); }}
                    placeholder="GIFT-XXXXXXXX"
                    style={{ flex: 1, padding: '14px', border: '1px solid #C9A84C', borderRadius: 8, fontFamily: 'Menlo,Consolas,monospace', fontSize: 18, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', background: 'white' }} />
                  <button onClick={() => { setVoucherErr(''); setScanning(true); }} title="Scan QR from customer's Apple Wallet pass"
                    style={{ padding: '14px 16px', borderRadius: 8, border: '2px solid #1e3a6e', background: 'white', color: '#1e3a6e', fontWeight: 700, fontSize: 18, cursor: 'pointer' }}>
                    📷
                  </button>
                  <button onClick={handleVoucherLookup} disabled={voucherLoading || !voucherCode}
                    style={{ padding: '14px 20px', borderRadius: 8, border: 'none', background: '#1e3a6e', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: voucherLoading || !voucherCode ? 0.5 : 1 }}>
                    {voucherLoading ? '…' : 'Look up'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 6, textAlign: 'center' }}>📷 scan customer's Apple Wallet QR, or type the code</div>
              </div>

              {voucherErr && (
                <div style={{ background: '#fee2e2', color: '#991b1b', padding: '12px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16 }}>
                  ⚠️ {voucherErr}
                </div>
              )}

              {voucherDetails && (
                <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 18, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 12, color: '#888' }}>Voucher</div>
                      <div style={{ fontFamily: 'Menlo,Consolas,monospace', fontWeight: 700, color: '#1e3a6e' }}>{voucherDetails.code}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 12, color: '#888' }}>Balance</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#22c55e' }}>£{Number(voucherDetails.balance).toFixed(2)}</div>
                    </div>
                  </div>
                  {Number(voucherDetails.balance) >= billTotal ? (
                    <div style={{ background: '#dcfce7', color: '#15803d', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>
                      ✅ Covers the full bill — £{(Number(voucherDetails.balance) - billTotal).toFixed(2)} will remain on the voucher
                    </div>
                  ) : (
                    <div style={{ background: '#fef3c7', color: '#92400e', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>
                      ⚠️ Partial — applies <strong>£{Number(voucherDetails.balance).toFixed(2)}</strong> as a discount. Customer pays remaining <strong>£{(billTotal - Number(voucherDetails.balance)).toFixed(2)}</strong> by Cash/Card.
                    </div>
                  )}
                  <button onClick={handleVoucherApply} disabled={voucherLoading}
                    style={{ marginTop: 14, width: '100%', padding: 16, borderRadius: 10, border: 'none', background: '#C9A84C', color: '#1a1a2e', fontWeight: 800, fontSize: 16, cursor: 'pointer', opacity: voucherLoading ? 0.5 : 1 }}>
                    {voucherLoading
                      ? 'Processing…'
                      : Number(voucherDetails.balance) >= billTotal
                        ? `Pay £${billTotal.toFixed(2)} with voucher`
                        : `Apply £${Number(voucherDetails.balance).toFixed(2)} from voucher`}
                  </button>
                </div>
              )}

              {!isMobile && <button onClick={() => setStage('method')} style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>← Back to Methods</button>}
            </div>
          </div>
        )}

        {/* ═══════════════ AMOUNT + NUMPAD ═══════════════ */}
        {stage === 'amount' && (
          <>
            {/* MOBILE */}
            {isMobile && (
              <div style={{ display:'flex', flexDirection:'column', minHeight:'100vh' }}>
                {mobileTopBar(`${selectedMethod==='Cash'?'💵 Cash':selectedMethod==='Card'?'💳 Card':'🔄 Other'} — £${billTotal.toFixed(2)}`, () => setStage('method'), '← Back')}
                <div style={{ background:'#0D1B3E', padding:'20px 20px 16px', display:'flex', flexDirection:'column' }}>
                  <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginBottom:4 }}>Amount received</div>
                  <div style={{ fontSize:46, fontWeight:800, color:'white', fontFamily:'monospace', letterSpacing:1 }}>£{paymentInput||'0.00'}</div>
                  {canPay&&selectedMethod==='Cash'&&change>0 && <div style={{ marginTop:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}><span style={{ fontSize:13, color:'rgba(255,255,255,0.5)' }}>Change to give</span><span style={{ fontSize:22, fontWeight:800, color:'#22c55e' }}>£{change.toFixed(2)}</span></div>}
                  {canPay&&actualTip>0&&selectedMethod!=='Cash' && <div style={{ marginTop:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}><span style={{ fontSize:13, color:'rgba(255,255,255,0.5)' }}>Tip</span><span style={{ fontSize:22, fontWeight:800, color:'#8b5cf6' }}>£{actualTip.toFixed(2)}</span></div>}
                </div>
                <div style={{ padding:'12px 16px 8px' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
                    {['7','8','9','4','5','6','1','2','3','.','0','⌫'].map(btn => (
                      <button key={btn} onClick={() => handleNumpad(btn)} style={{ height:72, borderRadius:12, border:'none', fontSize:26, fontWeight:700, cursor:'pointer', background:btn==='⌫'?'#fee2e2':'#f8f8f8', color:btn==='⌫'?'#ef4444':'#0D1B3E' }}>{btn}</button>
                    ))}
                  </div>
                  <button onClick={() => handleNumpad('C')} style={{ width:'100%', marginTop:10, padding:'14px', borderRadius:12, border:'none', background:'#f0f0f0', color:'#555', fontSize:16, fontWeight:700, cursor:'pointer' }}>Clear</button>
                </div>
                <div style={{ padding:'8px 16px' }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'#aaa', marginBottom:8 }}>Quick amounts</div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
                    {[billTotal,Math.ceil(billTotal/5)*5,Math.ceil(billTotal/10)*10,Math.ceil(billTotal/20)*20].filter((v,i,a)=>a.indexOf(v)===i).map(amount => (
                      <button key={amount} onClick={() => setPaymentInput(amount.toFixed(2))} style={{ padding:'13px', borderRadius:10, border:`2px solid ${paymentInput===amount.toFixed(2)?'#C9A84C':'#e0e0e0'}`, background:paymentInput===amount.toFixed(2)?'#C9A84C':'white', color:paymentInput===amount.toFixed(2)?'white':'#0D1B3E', fontWeight:700, cursor:'pointer', fontSize:16 }}>£{amount.toFixed(2)}</button>
                    ))}
                  </div>
                </div>
                <div style={{ padding:'12px 16px 32px', marginTop:'auto' }}>
                  <button onClick={handleConfirmPayment} disabled={!canPay} style={{ width:'100%', padding:'20px', borderRadius:14, border:'none', background:canPay?'#22c55e':'#e0e0e0', color:canPay?'white':'#aaa', fontSize:18, fontWeight:800, cursor:canPay?'pointer':'not-allowed' }}>
                    {canPay?selectedMethod==='Cash'&&change>0?`✓ Confirm — Change £${change.toFixed(2)}`:actualTip>0?`✓ Confirm — Tip £${actualTip.toFixed(2)}`:'✓ Confirm Payment':`Enter amount (min £${billTotal.toFixed(2)})`}
                  </button>
                </div>
              </div>
            )}
            {/* DESKTOP */}
            {!isMobile && (
              <div style={{ display:'flex', flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:280, padding:28, borderRight:'1px solid #eee' }}>
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:13, color:'#888', marginBottom:4 }}>Payment method</div>
                    <div style={{ fontSize:22, fontWeight:700 }}>{selectedMethod==='Cash'?'💵 Cash':selectedMethod==='Card'?'💳 Card':'🔄 Other'}</div>
                  </div>
                  <div style={{ background:'#f8f8f8', borderRadius:12, padding:16, marginBottom:20 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, color:'#555', marginBottom:10 }}><span>Bill total</span><span style={{ fontWeight:700 }}>£{billTotal.toFixed(2)}</span></div>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, color:'#555', marginBottom:10 }}><span>Amount received</span><span style={{ fontWeight:800, color:'#1a1a2e', fontSize:18 }}>£{amountPaid>0?amountPaid.toFixed(2):'—'}</span></div>
                    {canPay&&selectedMethod==='Cash' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:20, fontWeight:800, color:'#22c55e', borderTop:'2px solid #eee', paddingTop:10, marginTop:4 }}><span>💚 Change</span><span>£{Math.max(0,change).toFixed(2)}</span></div>}
                    {canPay&&amountPaid>billTotal&&selectedMethod!=='Cash' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:20, fontWeight:800, color:'#8b5cf6', borderTop:'2px solid #eee', paddingTop:10, marginTop:4 }}><span>💜 Tip</span><span>£{actualTip.toFixed(2)}</span></div>}
                  </div>
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:'#888', marginBottom:10 }}>Quick amounts</div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
                      {[billTotal,Math.ceil(billTotal/5)*5,Math.ceil(billTotal/10)*10,Math.ceil(billTotal/20)*20].filter((v,i,a)=>a.indexOf(v)===i).map(amount => (
                        <button key={amount} onClick={() => setPaymentInput(amount.toFixed(2))} style={{ padding:'12px', borderRadius:10, border:`2px solid ${paymentInput===amount.toFixed(2)?'#C9A84C':'#1a1a2e'}`, background:paymentInput===amount.toFixed(2)?'#C9A84C':'white', color:paymentInput===amount.toFixed(2)?'white':'#1a1a2e', fontWeight:700, cursor:'pointer', fontSize:15 }}>£{amount.toFixed(2)}</button>
                      ))}
                    </div>
                  </div>
                  <button onClick={handleConfirmPayment} disabled={!canPay} style={{ width:'100%', padding:'18px', borderRadius:12, border:'none', background:canPay?'#22c55e':'#ddd', color:'white', fontSize:18, fontWeight:800, cursor:canPay?'pointer':'not-allowed', marginBottom:10 }}>
                    {canPay?selectedMethod==='Cash'?change>0?`✓ Confirm — Give change £${change.toFixed(2)}`:'✓ Confirm — Exact Amount':actualTip>0?`✓ Confirm — Tip £${actualTip.toFixed(2)}`:'✓ Confirm Payment':`Enter amount (min £${billTotal.toFixed(2)})`}
                  </button>
                  <button onClick={() => setStage('method')} style={{ width:'100%', padding:'12px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:14 }}>← Back</button>
                </div>
                <div style={{ width:280, padding:24, display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ background:'#1a1a2e', borderRadius:14, padding:'20px', textAlign:'right', marginBottom:8 }}>
                    <div style={{ fontSize:13, color:'#aaa', marginBottom:6 }}>Amount received</div>
                    <div style={{ fontSize:36, fontWeight:800, color:'white', fontFamily:'monospace' }}>£{paymentInput||'0.00'}</div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                    {['7','8','9','4','5','6','1','2','3','.','0','⌫'].map(btn => (
                      <button key={btn} onClick={() => handleNumpad(btn)} style={{ height:68, borderRadius:12, border:'none', fontSize:22, fontWeight:700, cursor:'pointer', background:btn==='⌫'?'#fee2e2':'#f8f8f8', color:btn==='⌫'?'#ef4444':'#1a1a2e' }}>{btn}</button>
                    ))}
                  </div>
                  <button onClick={() => handleNumpad('C')} style={{ padding:'16px', borderRadius:12, border:'none', background:'#f0f0f0', color:'#555', fontSize:16, fontWeight:700, cursor:'pointer' }}>Clear</button>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
