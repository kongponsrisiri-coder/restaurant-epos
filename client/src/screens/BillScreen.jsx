import { useState, useEffect, useRef } from 'react';
import { getBill, markBillPrinted, getVoucher, redeemVoucher, applyDiscount, removeVoucherFromBill, getOrderDeposit, getOrderDepositApplied, assertOk, serverOpenDrawer } from '../api';
import { printReceipt } from './ReceiptPrinter';
import QRPayModal from '../components/QRPayModal';
import { orderShortLabelPlain, orderSubLabel, isTakeaway } from '../utils/orderLabel';
import AmountInput from '../components/AmountInput';
import { confirm } from '../utils/confirm';

// SEPOS-PAY-ONETAP-001 — 2-second "paid" toast. Plain DOM appended to <body>
// so it survives the Bill screen unmounting when onPay closes the table.
// Cash change is THE thing staff must see, so it leads, huge.
function showPaidToast(pd, label) {
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:18%;left:50%;transform:translateX(-50%);z-index:99999;background:#14532d;color:#fff;border-radius:18px;padding:22px 34px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;min-width:280px';
    const change = Number(pd?.change || 0);
    // Review LOW — build with textContent, never interpolate labels into HTML.
    const line = (text, css) => { const d = document.createElement('div'); d.style.cssText = css; d.textContent = text; el.appendChild(d); };
    if (change > 0.001) {
      line('💚 Change to give', 'font-size:15px;opacity:.85;margin-bottom:2px');
      line('£' + change.toFixed(2), 'font-size:46px;font-weight:900;color:#4ade80');
      line('✓ ' + label + ' paid', 'font-size:14px;margin-top:6px;opacity:.85');
    } else {
      line('✅', 'font-size:34px;margin-bottom:4px');
      line(label + ' paid', 'font-size:18px;font-weight:800');
      line(String(pd?.method || ''), 'font-size:14px;opacity:.85');
    }
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 450); }, change > 0.001 ? 3200 : 2000);
  } catch { /* a toast must never break a payment */ }
}

export default function BillScreen({ orderId, onClose, onPay }) {

  const [bill, setBill]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [paymentInput, setPaymentInput]     = useState('');
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [stage, setStage]                   = useState('bill');
  const [paymentDetails, setPaymentDetails] = useState(null);
  // SEPOS-DBLPAY-001 — in-flight guard so the "Done — Close" button can't be
  // double-tapped into two payments (the Thann Thai T1 double-charge).
  const [paying, setPaying]                 = useState(false);

  const [splitCount, setSplitCount]         = useState(2);
  const [splitPaid, setSplitPaid]           = useState([]);
  // SEPOS-062 — per-tender breakdown {amount, method} captured as each split is
  // settled, so the close records real Cash/Card rows (not one lumped 'Split').
  const [splitTenders, setSplitTenders]     = useState([]);
  // Mixed payment (part cash / part card on one bill) — reuses splitTenders.
  const [mixMethod, setMixMethod]           = useState('Cash');
  const [showQrPay, setShowQrPay]           = useState(false); // SIAMPAY-QR-001
  const [mixInput,  setMixInput]            = useState('');
  // SEPOS-VOUCHER-SPLIT-001 — voucher as one tender inside a mixed payment.
  const [mixVoucherCode, setMixVoucherCode] = useState('');
  const [mixVoucherAmt,  setMixVoucherAmt]  = useState('');
  const [mixVoucherErr,  setMixVoucherErr]  = useState('');
  const [mixVoucherBusy, setMixVoucherBusy] = useState(false);
  // SEPOS-DEPOSIT-001 — booking deposit as one tender (method 'Deposit').
  const [mixDepositCode, setMixDepositCode] = useState('');
  const [mixDepositAmt,  setMixDepositAmt]  = useState('');
  const [orderDeposit,   setOrderDeposit]   = useState(undefined); // undefined=not fetched, null=none, {..}=found
  // SEPOS-DEPOSIT-ORDER-001 — deposit already redeemed on the Order screen
  // (model A). It reduces the balance due and prints as "Deposit paid".
  const [depositApplied, setDepositApplied] = useState({ amount: 0, code: null });
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
    getBill(orderId)
      .then(data => { setBill(data); setLoading(false); markBillPrinted(orderId); })
      .catch(() => setLoading(false));   // never hang on a fetch failure (offline / cloud error)
    // SEPOS-DEPOSIT-ORDER-001 — pick up any deposit already redeemed on the
    // Order screen so the bill charges only the balance and prints the deposit.
    getOrderDepositApplied(orderId)
      .then(r => setDepositApplied({ amount: Number(r?.applied || 0), code: r?.code || null }))
      .catch(() => {});
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
    <div style={{ position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
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

  // SEPOS-021 / SEPOS-VATMODE-001 — VAT breakdown by rate. vat_mode decides:
  //   'inclusive' (default) — menu prices contain VAT: net = gross × 100/(100+rate)
  //   'exclusive' — menu prices are net; VAT is rate% ON TOP: vat = net × rate/100
  // Service charge and bill-level discount are out of the VAT scope either way.
  const vatMode = settings.vat_mode === 'exclusive' ? 'exclusive' : 'inclusive';
  const vatBuckets = {};
  for (const i of billItems) {
    const rate = Number(i.vat_rate ?? 20);
    let g = i.unit_price * i.quantity;
    if (i.discount_value > 0) {
      g -= i.discount_type === 'percent' ? g * (i.discount_value / 100) : Math.min(i.discount_value, g);
    }
    let net, vat;
    if (rate <= 0)                    { net = g; vat = 0; }
    else if (vatMode === 'exclusive') { net = g; vat = g * (rate / 100); }
    else                              { net = g * (100 / (100 + rate)); vat = g - net; }
    if (!vatBuckets[rate]) vatBuckets[rate] = { rate, net: 0, vat: 0, gross: 0 };
    vatBuckets[rate].net   += net;
    vatBuckets[rate].vat   += vat;
    vatBuckets[rate].gross += (net + vat);
  }
  const vatBreakdown = Object.values(vatBuckets).sort((a, b) => a.rate - b.rate);
  const vatTotal = vatBreakdown.reduce((s, b) => s + b.vat, 0);

  const discountAmount = order.discount_value > 0
    ? order.discount_type === 'percent' ? subtotal * (order.discount_value / 100) : parseFloat(order.discount_value)
    : 0;
  const discountRate  = subtotal > 0 ? discountAmount / subtotal : 0;
  const afterDiscount = subtotal - discountAmount;
  // SEPOS — honour the per-order "Remove service charge" flag persisted from
  // the Order screen. Previously the Bill recomputed SC from the global setting
  // only and silently re-added it after staff removed it on the Order screen.
  // SEPOS-TAKEAWAY-TABLE — only dine-in carries a service charge. Takeaway
  // (walk-in table or online) and counter orders never do.
  const noServiceCharge = !!order.no_service_charge || (order.order_type && order.order_type !== 'dine_in');
  const serviceCharge = (serviceChargeEnabled && !noServiceCharge) ? afterDiscount * serviceChargePercent : 0;
  const grossTotalPence = Math.round(afterDiscount * 100) + Math.round(serviceCharge * 100);
  const grossTotal      = grossTotalPence / 100;
  // SEPOS-DEPOSIT-ORDER-001 — a deposit redeemed on the Order screen is already
  // paid, so the amount still to collect is the balance. billTotal is that
  // balance-due everywhere below (payment maths, split, quick-tender buttons).
  const depositPaid     = Math.min(depositApplied.amount || 0, grossTotal);
  const billTotalPence  = grossTotalPence - Math.round(depositPaid * 100);
  const billTotal       = Math.max(0, billTotalPence / 100);

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
    const personService      = (serviceChargeEnabled && !noServiceCharge) ? personAfterDiscount * serviceChargePercent : 0;
    return { items: personItems, subtotal: personSubtotal, discount: personDiscount, afterDiscount: personAfterDiscount, service: personService, total: personAfterDiscount + personService };
  };

  const unassignedItems = billItems.filter(item => itemAssignments[item.id] === undefined);
  const allAssigned     = unassignedItems.length === 0 && billItems.length > 0;
  const personColors    = ['#e94560','#3b82f6','#22c55e','#8b5cf6','#f97316','#06b6d4','#ec4899','#eab308'];

  // SEPOS-PENNY-001 (part 2) — the same push-from-the-right entry for the
  // TYPED amount boxes on the one-flow Payment screen (cash/card amount,
  // voucher amount, deposit amount). Whatever lands in the box is reduced to
  // its digits and read as pence: typing 3201 shows £32.01 (was £3201.00 —
  // Korakot's screenshot, 2026-07-14). Editing/backspace anywhere behaves:
  // the surviving digits re-read as pence. 6-digit cap = £9,999.99.
  const pennyType = (raw) => {
    const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '').slice(0, 6);
    return digits ? (parseInt(digits, 10) / 100).toFixed(2) : '';
  };

  // SEPOS-PENNY-001 — ATM/card-machine style amount entry (staff feedback via
  // Korakot 2026-07-14: "they don't want to type the decimal point"). Digits
  // push in from the right: 2 → £0.02, 29 → £0.29, 2919 → £29.19 — exactly how
  // the card terminal they already use works. The "." key is gone; "00" (a
  // standard till key) makes round amounts fast: 2,00,0 → £20.00. The stored
  // string stays a normal "29.19" decimal so every consumer (parseFloat at
  // amountPaid, quick-amount highlight compares) is untouched.
  const handleNumpad = (btn) => {
    if (btn === 'C')  { setPaymentInput(''); return; }
    const pence = Math.round((parseFloat(paymentInput) || 0) * 100);
    if (btn === '⌫') {
      const next = Math.floor(pence / 10);
      setPaymentInput(next > 0 ? (next / 100).toFixed(2) : '');
      return;
    }
    if (btn === '00') {
      if (pence === 0 || pence > 9999) return; // no-op on empty; cap £9,999.99
      setPaymentInput(((pence * 100) / 100).toFixed(2));
      return;
    }
    if (!/^\d$/.test(btn)) return;
    if (pence > 99999) return; // cap £9,999.99 — fat-finger guard
    setPaymentInput(((pence * 10 + Number(btn)) / 100).toFixed(2));
  };

  // ── The shared receipt payload — pre-calculated totals from BillScreen ──
  // SEPOS-DEPOSIT-ORDER-001 — the receipt shows the FULL total then the deposit
  // deduction + balance, so billTotal on the receipt is the gross (not the
  // already-reduced balance); depositPaid drives the "Deposit paid / Balance due".
  const receiptTotals = { subtotal, discountAmount, serviceCharge, billTotal: grossTotal, depositPaid };

  const handlePrintBill = () => {
    // SEPOS-DEPOSIT-PRINT — if a booking deposit has been applied, show it on
    // the printed bill (Deposit paid −£X + Balance due) so the customer sees it.
    const depositPaid = splitTenders.filter(t => t.method === 'Deposit')
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    printReceipt({ order: { ...order }, items: billItems, settings: { ...settings }, paymentDetails: { ...receiptTotals, depositPaid } });
  };

  const handlePrintReceipt = () => {
    printReceipt({ order: { ...order }, items: billItems, settings: { ...settings }, paymentDetails: { ...receiptTotals, ...paymentDetails } });
  };

  const handleConfirmPayment = () => {
    if (amountPaidPence < billTotalPence) { alert(`Amount £${amountPaid.toFixed(2)} is less than bill £${billTotal.toFixed(2)}`); return; }
    setPaymentDetails({ method: selectedMethod, amountPaid, tip: actualTip, change: Math.max(0, change) });
    setStage('receipt');
  };

  // SEPOS-PAY-ONE-001 — ONE payment flow. Every method (Card / Cash / Deposit /
  // Voucher) opens the accumulating payment screen, where each payment is added
  // as a partial tender that reduces what's left. The bill closes only once the
  // tenders cover the total; an overpayment (cash) shows as change, an
  // underpayment can't be closed. Replaces the old separate Split-payment +
  // Mixed-payment buttons.
  const startPayment = (method) => {
    setSplitTenders([]);
    setMixVoucherCode(''); setMixVoucherAmt(''); setMixDepositCode(''); setMixDepositAmt(''); setMixVoucherErr('');
    setMixMethod(method);
    setMixInput(method === 'Card' ? billTotal.toFixed(2) : '');   // card usually = the full amount; editable
    if (method === 'Deposit') fetchOrderDeposit();
    setStage('mixed');
  };

  // SEPOS-VOUCHER-001 — voucher redemption
  const handleVoucherLookup = async () => {
    const code = (voucherCode || '').trim().toUpperCase();
    if (!code) { setVoucherErr('Enter a voucher code'); return; }
    setVoucherLoading(true); setVoucherErr(''); setVoucherDetails(null);
    try {
      const v = await getVoucher(code);
      if (v.error) { setVoucherErr(v.error); }
      else if (v.type === 'deposit')    { setVoucherErr('This is a booking deposit — use the Deposit tender, not the voucher discount.'); }
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
        // SEPOS-AUDIT-001 — persist a marker NOW: the balance is already
        // redeemed server-side, so if the till reloads/crashes before "Done"
        // the reopened bill used to show a plain full-price bill with the
        // customer's balance silently gone (they'd be charged twice). A
        // £0-value discount_reason makes the applied voucher visible on any
        // reopened bill (hasVoucherDiscount keys on the 'Voucher ' prefix)
        // without touching the maths; voucher-remove clears it by prefix.
        try {
          await applyDiscount(orderId, null, 0, `Voucher ${code} — covers full bill £${billTotal.toFixed(2)}`);
        } catch { /* marker is best-effort — never block the payment */ }
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

  // SEPOS-VOUCHER-SPLIT-001 — redeem a voucher as ONE tender in the mixed flow.
  // Bill stays at full total; the voucher covers part, cash/card settle the
  // rest. Redeems immediately (server decrements balance under a lock), so
  // removing the tender or backing out restores it. One voucher per split.
  const addMixVoucher = async (remaining) => {
    if (mixVoucherBusy) return;
    const code = (mixVoucherCode || '').trim().toUpperCase();
    if (!code) { setMixVoucherErr('Enter a voucher code or reference'); return; }
    if (splitTenders.some(t => t.method === 'Voucher')) { setMixVoucherErr('One voucher per bill'); return; }
    if (remaining <= 0) { setMixVoucherErr('Bill already settled'); return; }
    // No cap at the remaining — any method may be tendered over what's left
    // (change is given). The only hard limit is a MATCHED voucher's real
    // balance (you can't redeem more than it actually holds).
    const enteredAmt = parseFloat(mixVoucherAmt) || 0;
    setMixVoucherBusy(true); setMixVoucherErr('');
    try {
      // Best-effort lookup. A match against OUR voucher DB → redeem for real
      // (balance tracked). No match → BYPASS: the venue sold vouchers on their
      // previous system that aren't in our DB, so accept it as a tender for the
      // amount the operator enters, keeping their code as a reference. Nothing
      // to redeem, so nothing to restore later.
      let v = null;
      try { v = await getVoucher(code); } catch { v = null; }
      const matched = v && !v.error && v.status === 'active' && Number(v.balance) > 0;
      if (matched) {
        // SEPOS-AUDIT-001 — cap at the REMAINING too, not just the balance.
        // Typing the face value (say £50) on a £30 bill used to redeem the
        // full £50 off the customer's balance and misclassify the £20 excess
        // as a 'card tip' — a voucher can't give change, so never redeem more
        // than what's left on the bill.
        const useAmount = enteredAmt > 0
          ? Math.min(Number(v.balance), enteredAmt, remaining)
          : Math.min(Number(v.balance), remaining);
        const r = await redeemVoucher(code, useAmount, orderId, null);
        if (r && r.error) { setMixVoucherErr(r.error); return; }
        const deducted = Number(r.amount_used ?? useAmount);
        setSplitTenders(prev => [...prev, { amount: deducted, method: 'Voucher', voucher_code: code, external: false }]);
      } else {
        if (!(enteredAmt > 0)) { setMixVoucherErr('Enter the voucher amount'); return; }
        // External bypass tender — no change can be given off it either.
        setSplitTenders(prev => [...prev, { amount: Math.min(enteredAmt, remaining), method: 'Voucher', voucher_code: code, external: true }]);
      }
      setMixVoucherCode(''); setMixVoucherAmt('');
    } catch (e) { setMixVoucherErr(e.message || 'Could not add voucher'); }
    finally     { setMixVoucherBusy(false); }
  };

  // A tender needs its server-side redemption restored when removed if it's a
  // real redeemed voucher OR a matched deposit (both decremented a balance).
  // External/bypass tenders (voucher OR deposit taken on another system) had
  // no redemption in our DB, so there's nothing to undo.
  const tenderNeedsRestore = (t) => t && !t.external && (t.method === 'Voucher' || t.method === 'Deposit');

  // Remove a tender from the mix; restore THIS tender's redemption by its code
  // (a bill may carry both a voucher AND a deposit — restoring "most-recent"
  // would credit back the wrong one).
  const removeMixTender = async (i) => {
    const t = splitTenders[i];
    if (tenderNeedsRestore(t)) {
      // SEPOS-AUDIT-001 — a failed restore means the customer's balance is
      // still redeemed while the tender disappears from the split. Surface it
      // so staff can retry / call support instead of silently eating balance.
      try { await removeVoucherFromBill(orderId, t.voucher_code); }
      catch (e) { alert(`⚠️ Could not restore ${t.voucher_code}'s balance (${e.message || 'network error'}). The tender was removed from this bill but the balance may still be deducted — check Admin → Vouchers.`); }
    }
    setSplitTenders(prev => prev.filter((_, idx) => idx !== i));
  };

  // Leave the mixed flow — restore EVERY real redemption (each by its own code)
  // so an abandoned split never eats voucher/deposit balance.
  const cancelMix = async () => {
    for (const t of splitTenders) {
      if (tenderNeedsRestore(t)) {
        try { await removeVoucherFromBill(orderId, t.voucher_code); }
        catch (e) { alert(`⚠️ Could not restore ${t.voucher_code}'s balance (${e.message || 'network error'}) — check Admin → Vouchers before re-charging the customer.`); } // SEPOS-AUDIT-001
      }
    }
    setSplitTenders([]); setMixVoucherCode(''); setMixVoucherAmt(''); setMixVoucherErr('');
    setMixDepositCode(''); setMixDepositAmt('');
    setStage('bill');
  };

  // SEPOS-DEPOSIT-001 — redeem a booking DEPOSIT as one tender (method
  // 'Deposit'). Same tender mechanism as the voucher split, but the code must
  // be a type='deposit' voucher (a gift code is rejected — use the Voucher
  // option). Full sale value stays; the deposit reduces the balance owed.
  const fetchOrderDeposit = async () => {
    if (orderDeposit !== undefined) return;             // fetch once
    try { const r = await getOrderDeposit(orderId); setOrderDeposit(r && r.deposit ? r.deposit : null); }
    catch { setOrderDeposit(null); }
  };
  const addMixDeposit = async (remaining) => {
    if (mixVoucherBusy) return;
    const code = (mixDepositCode || orderDeposit?.code || '').trim().toUpperCase();
    if (!code) { setMixVoucherErr('Enter or scan the deposit code'); return; }
    if (splitTenders.some(t => t.method === 'Deposit')) { setMixVoucherErr('One deposit per bill'); return; }
    if (remaining <= 0) { setMixVoucherErr('Bill already settled'); return; }
    // No cap at the remaining (see addMixVoucher) — the only hard limit is a
    // MATCHED deposit's real balance.
    const enteredAmt = parseFloat(mixDepositAmt) || 0;
    setMixVoucherBusy(true); setMixVoucherErr('');
    try {
      // Best-effort lookup. A match against a type='deposit' voucher in OUR DB
      // → redeem for real (balance tracked, so it can be restored on removal).
      // No match → BYPASS: the deposit was taken on another system / as cash and
      // isn't in our DB, so accept it as a tender for the amount the operator
      // enters, keeping the code as a reference. The rest of the bill is settled
      // by another method. A code that matches a real GIFT voucher is bounced to
      // the Voucher option (a gift card isn't a booking deposit).
      let v = null;
      try { v = await getVoucher(code); } catch { v = null; }
      const known = v && !v.error && v.status === 'active' && Number(v.balance) > 0;
      if (known && v.type !== 'deposit') { setMixVoucherErr("That's a gift voucher — use the Voucher option"); return; }
      if (known && v.type === 'deposit') {
        const bal = Number(v.balance);
        // SEPOS-AUDIT-001 — like vouchers, a deposit can't give change: cap the
        // redemption at the bill remaining too, never just the balance.
        const useAmount = enteredAmt > 0 ? Math.min(bal, enteredAmt, remaining) : Math.min(bal, remaining);
        const r = await redeemVoucher(code, useAmount, orderId, null);
        if (r && r.error)            { setMixVoucherErr(r.error); return; }
        const deducted = Number(r.amount_used ?? useAmount);
        setSplitTenders(prev => [...prev, { amount: deducted, method: 'Deposit', voucher_code: code, deposit: true, external: false }]);
      } else {
        if (!(enteredAmt > 0)) { setMixVoucherErr('Enter the deposit amount'); return; }
        setSplitTenders(prev => [...prev, { amount: Math.min(enteredAmt, remaining), method: 'Deposit', voucher_code: code, deposit: true, external: true }]);
      }
      setMixDepositCode(''); setMixDepositAmt('');
    } catch (e) { setMixVoucherErr(e.message || 'Could not apply deposit'); }
    finally     { setMixVoucherBusy(false); }
  };

  const handleFinish = async () => {
    // SEPOS-DBLPAY-001 — ignore repeat taps while a payment is being recorded.
    if (paying) return;
    setPaying(true);
    try {
      // SEPOS-062 — pass the per-tender breakdown for splits so each Cash/Card
      // amount is recorded as its own payment row (correct Z-report reconciliation).
      // Review C1 (class fix) — gate the drawer on real success too.
      const ok = await onPay(billTotal, paymentDetails?.method, paymentDetails?.amountPaid, paymentDetails?.tip, paymentDetails?.tenders);
      // SEPOS-DRAWER-001 — open the cash drawer on payment (fire-and-forget;
      // never blocks/fails the close). Silent no-op where there's no raw
      // ESC/POS receipt printer (browser print / no drawer / disabled setting).
      if (ok === true) serverOpenDrawer().catch(() => {});
    } finally {
      // onPay closes the bill on success; on failure it keeps the bill open,
      // so re-enable the button to allow a genuine retry.
      setPaying(false);
    }
  };

  // SEPOS-PAY-ONETAP-001 — splits finish one-tap too: the LAST share tap
  // records the payment, kicks the drawer and toasts — no confirmed card.
  // Whole-bill receipt stays available via Print Bill before paying or
  // Admin → Bills reprint after.
  const finalizeSplit = (pd) => {
    if (paying) return;
    setPaymentDetails(pd);
    setPaying(true);
    (async () => {
      try {
        // Review C1 — gate on onPay's boolean (it never rejects).
        const ok = await onPay(billTotal, pd.method, pd.amountPaid, pd.tip, pd.tenders);
        if (ok !== true) return;
        serverOpenDrawer().catch(() => {});
        showPaidToast(pd, orderShortLabelPlain(order));
      } catch (e) {
        alert('Payment could not be recorded: ' + (e?.message || 'unknown') + '\nThe bill is still open — try again.');
      } finally { setPaying(false); }
    })();
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
    if (isLast) { finalizeSplit({ method:'Split', amountPaid:billTotal, tip:0, change:0, tenders:newTenders }); }
  };

  const handleSplitItemPayment = (personIdx, method = 'Cash') => {
    const newPaid = [...splitItemPaid, personIdx];
    // SEPOS-AUDIT-001 — a person with NO items assigned never shows a pay
    // button, so `newPaid.length >= splitItemCount` could never fire and the
    // receipt stage was unreachable (bill stuck mid-split). isLast keys on the
    // people who actually HOLD items.
    const personsWithItems = new Set(billItems.map(i => itemAssignments[i.id]).filter(p => p !== undefined));
    const isLast = personsWithItems.size > 0
      ? [...personsWithItems].every(p => newPaid.includes(p))
      : newPaid.length >= splitItemCount;
    const prevSum = splitTenders.reduce((s, t) => s + t.amount, 0);
    const amount = isLast ? Number((billTotal - prevSum).toFixed(2)) : Number(getPersonTotal(personIdx).total.toFixed(2));
    setSplitItemPaid(newPaid);
    const newTenders = [...splitTenders, { amount, method }];
    setSplitTenders(newTenders);
    if (isLast) { finalizeSplit({ method:'Split by Item', amountPaid:billTotal, tip:0, change:0, tenders:newTenders }); }
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

  const overlay = { position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:isMobile?'white':'rgba(0,0,0,0.75)', display:'flex', alignItems:isMobile?'flex-start':'center', justifyContent:'center', zIndex:9999, padding:isMobile?0:16, overflowY:'auto' };
  const card    = { background:'white', borderRadius:isMobile?0:20, width:'100%', maxWidth:isMobile?'100%':(stage==='amount'?820:stage==='split_items'?600:480), maxHeight:isMobile?'none':'95vh', overflowY:isMobile?'visible':'auto', boxShadow:isMobile?'none':'0 20px 60px rgba(0,0,0,0.5)' };

  const mobileTopBar = (title, onBack, backLabel='← Back') => isMobile && (
    <div style={{ padding:'14px 16px', borderBottom:'1px solid #eee', display:'flex', alignItems:'center', gap:12, background:'white', position:'sticky', top:0, zIndex:10, flexShrink:0 }}>
      <button onClick={onBack} style={{ background:'#f0f0f0', border:'none', borderRadius:8, padding:'8px 14px', fontWeight:700, fontSize:13, cursor:'pointer', color:'#555', flexShrink:0 }}>{backLabel}</button>
      <div style={{ flex:1, textAlign:'center', fontWeight:700, fontSize:15, color:'var(--brand-primary, #1a1a2e)' }}>{title}</div>
      <div style={{ width:70, flexShrink:0 }} />
    </div>
  );

  // ── Redesigned two-column Bill / Pay (design_handoff screen 5) ───────────────
  // Uses ONLY existing state + handlers; all other stages render via the modal
  // return below, unchanged. On a small screen it stacks (still works).
  if (stage === 'bill' && !isMobile) {
    const NAVY = 'var(--brand-primary,#0D1B3E)', GOLD = 'var(--brand-accent,#C9A84C)', RED = '#e94560', PAPER = '#F4F1EA';
    const INK = 'var(--brand-primary, #1a1a2e)', MUTED = '#7C766A', FAINT = '#9A9488', BORDER = '#E7E2D6';
    const GREENB = '#5FD39B', GOLD_L = '#9A7B1F';
    const SERIF = "Georgia, 'Times New Roman', serif";
    // SEPOS-QR-ORDER-001 — QR dine-in orders are prepaid like online takeaway:
    // same "already paid online" close path, never the card machine again.
    const tkPaid = (isTakeaway(order) || order.source === 'qr') && (order.payment_status === 'paid' || order.payment_status === 'mock');
    const courseNames = { 1: 'Starters', 2: 'Mains', 3: 'Sides', 4: 'Drinks', 5: 'Desserts' };
    const byCourse = {};
    billItems.forEach(it => { const c = it.course || 1; (byCourse[c] = byCourse[c] || []).push(it); });
    const courses = Object.keys(byCourse).map(Number).sort((a, b) => a - b);
    const quickTenders = [billTotal, Math.ceil(billTotal / 5) * 5, Math.ceil(billTotal / 10) * 10, Math.ceil(billTotal / 20) * 20].filter((v, i, a) => a.indexOf(v) === i);
    const seg = (label, active, onClick) => (
      <button onClick={onClick} style={{ flex: 1, height: 56, borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 15,
        background: active ? GOLD : 'transparent', color: active ? NAVY : '#fff',
        border: active ? 'none' : '1.5px solid rgba(255,255,255,.4)' }}>{label}</button>
    );
    const outlineBtn = { height: 50, borderRadius: 12, border: `1.5px solid ${BORDER}`, background: '#fff', color: INK, fontWeight: 700, fontSize: 14, cursor: 'pointer' };

    return (
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', background: PAPER, zIndex: 9999, fontFamily: "'Archivo', system-ui, sans-serif" }}>
        {/* LEFT — bill */}
        <div style={{ flex: 1, padding: '28px 36px', overflowY: 'auto' }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: GOLD_L, fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: 0 }}>‹ Back to order</button>
          <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: INK, marginTop: 8 }}>Bill · {orderShortLabelPlain(order)}</div>
          <div style={{ color: MUTED, fontSize: 13.5, marginTop: 4, marginBottom: 18 }}>
            {isTakeaway(order) ? (orderSubLabel(order) || '') : `${order.covers || 1} covers`} · {dateStr} {timeStr}
          </div>

          {order.source === 'qr' && tkPaid && (
            <div style={{ background: '#dcfce7', border: '2px solid #16a34a', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13.5, color: '#14532d', fontWeight: 800 }}>
              📱💳 PAID ONLINE{order.payment_status === 'mock' ? ' (demo)' : ''} — the customer paid when ordering. Do not charge again.
            </div>
          )}
          {hasVoucherDiscount && (
            <div style={{ background: '#FBF4DF', border: `1px solid ${GOLD}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 13.5, color: GOLD_L, fontWeight: 700 }}>🎁 {order.discount_reason}</div>
              <button onClick={handleRemoveVoucher} disabled={removingVoucher} style={{ ...outlineBtn, height: 38, borderColor: '#dc2626', color: '#dc2626' }}>{removingVoucher ? '…' : '✕ Remove'}</button>
            </div>
          )}

          <div style={{ background: '#fff', borderRadius: 16, border: `1px solid ${BORDER}`, padding: 24, boxShadow: '0 1px 2px rgba(13,27,62,.05)' }}>
            {courses.map(c => (
              <div key={c} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.5px', textTransform: 'uppercase', color: GOLD_L, marginBottom: 8 }}>{courseNames[c] || 'Items'}</div>
                {byCourse[c].map(item => {
                  const p = item.unit_price * item.quantity;
                  const d = item.discount_value > 0 ? item.discount_type === 'percent' ? p * (item.discount_value / 100) : Math.min(item.discount_value, p) : 0;
                  return (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 16, fontWeight: 800, color: FAINT, fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>{item.quantity}×</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 600, color: INK }}>{item.name}</div>
                        {item.notes && <div style={{ fontSize: 12.5, fontWeight: 600, color: GOLD_L }}>{item.notes}</div>}
                        {item.item_note && <div style={{ fontSize: 12.5, color: '#3b82f6' }}>📝 {item.item_note}</div>}
                      </div>
                      <span style={{ fontSize: 16, fontWeight: 800, color: INK, fontVariantNumeric: 'tabular-nums' }}>£{(p - d).toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, marginTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: MUTED, marginBottom: 6 }}><span>Subtotal</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>£{subtotal.toFixed(2)}</span></div>
              {discountAmount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#2E9E6E', marginBottom: 6 }}><span>Discount</span><span>-£{discountAmount.toFixed(2)}</span></div>}
              {serviceChargeEnabled && !noServiceCharge && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: MUTED, marginBottom: 6 }}><span>Service charge ({parseFloat(settings.service_charge_rate || settings.service_charge_percent || 12.5)}%)</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>£{serviceCharge.toFixed(2)}</span></div>}
              {depositPaid > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#2563eb', marginBottom: 6 }}><span>Deposit paid</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>-£{depositPaid.toFixed(2)}</span></div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: `2px solid ${INK}`, marginTop: 10, paddingTop: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{depositPaid > 0 ? 'Balance due' : 'Total due'}</span>
                <span style={{ fontSize: 34, fontWeight: 800, color: INK, fontVariantNumeric: 'tabular-nums' }}>£{billTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button onClick={() => { setSplitPaid([]); setSplitTenders([]); setStage('split_equal'); }} style={{ ...outlineBtn, flex: 1 }}>Split equally</button>
            <button onClick={() => { setItemAssignments({}); setSplitItemPaid([]); setSplitTenders([]); setActivePerson(0); setStage('split_items'); }} style={{ ...outlineBtn, flex: 1 }}>Split by item</button>
            <button onClick={handlePrintBill} style={{ ...outlineBtn, flex: 1 }}>🖨 Print</button>
          </div>
        </div>

        {/* RIGHT — pay panel */}
        <div style={{ width: 480, flexShrink: 0, background: NAVY, color: '#fff', padding: 28, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          <div style={{ color: GOLD, fontSize: 12.5, fontWeight: 800, letterSpacing: '.8px', textTransform: 'uppercase' }}>Take payment</div>

          {tkPaid ? (
            <div style={{ marginTop: 24, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 15, color: 'rgba(255,255,255,.7)' }}>Already paid online</div>
              <div style={{ fontSize: 54, fontWeight: 800, fontVariantNumeric: 'tabular-nums', margin: '6px 0 24px' }}>£{billTotal.toFixed(2)}</div>
              <button onClick={() => { const method = order.payment_status === 'paid' ? 'Online (Stripe)' : 'Online (mock)'; setPaymentDetails({ method, amountPaid: billTotal, tip: 0, change: 0 }); setStage('receipt'); }}
                style={{ height: 68, borderRadius: 14, border: 'none', background: RED, color: '#fff', fontWeight: 800, fontSize: 18, cursor: 'pointer', boxShadow: '0 8px 18px rgba(233,69,96,.28)' }}>
                ✓ Confirm collection · £{billTotal.toFixed(2)}
              </button>
            </div>
          ) : (
            <>
              {/* SEPOS-PAY-ONE-001 — one payment flow. Pick a method → the payment
                  screen accumulates partial tenders and closes once covered.
                  Splitting the bill per person lives on the LEFT (Split equally /
                  Split by item). */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '20px 0 16px' }}>
                {[
                  { m: 'Card',    label: '💳 Card' },
                  { m: 'Cash',    label: '💵 Cash' },
                  { m: 'Deposit', label: '🧾 Deposit' },
                  { m: 'Voucher', label: '🎁 Voucher' },
                ].map(({ m, label }) => (
                  <button key={m} onClick={() => startPayment(m)} style={{ height: 84, borderRadius: 14, cursor: 'pointer', fontWeight: 800, fontSize: 18, background: 'rgba(255,255,255,.08)', color: '#fff', border: '1.5px solid rgba(255,255,255,.25)' }}>{label}</button>
                ))}
              </div>
              <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 14, lineHeight: 1.6 }}>
                Add one or more payments — cash, card, deposit or voucher. Take part on one method and the rest on another; the bill closes only once it's fully covered. Splitting the bill per guest is on the left.
              </div>
              <div style={{ marginTop: 'auto', color: 'rgba(255,255,255,.4)', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                <span>Total due</span><span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'rgba(255,255,255,.7)' }}>£{billTotal.toFixed(2)}</span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={overlay}>
      {/* SEPOS-VOUCHER-SCAN-001 — camera scanner overlay */}
      {scanning && (
        <div style={{ position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:'rgba(0,0,0,0.95)', zIndex:10001, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ color:'white', fontSize:18, fontWeight:700, marginBottom:6, textAlign:'center' }}>Scan voucher QR</div>
          <div style={{ color:'#ccc', fontSize:13, marginBottom:18, textAlign:'center', maxWidth:340 }}>Point the camera at the QR on the customer's Apple Wallet pass</div>
          <div id="voucher-qr-reader" style={{ width:'min(90vw, 360px)', background:'black', borderRadius:14, overflow:'hidden', border:'2px solid var(--brand-accent,#C9A84C)' }} />
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
                <div style={{ fontSize:22, fontWeight:800, color:'var(--brand-primary, #1a1a2e)' }}>{settings.company_name || settings.restaurant_name || 'My Restaurant'}</div>
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
                {serviceChargeEnabled && !noServiceCharge && <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, marginBottom:6, color:'#555' }}><span>Service charge ({parseFloat(settings.service_charge_rate||settings.service_charge_percent||12.5)}%)</span><span>£{serviceCharge.toFixed(2)}</span></div>}
                {/* VAT breakdown removed — VAT is the owner/accountant's domain (VAT Report kept for them). */}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:24, fontWeight:800, marginTop:10, color:'var(--brand-primary, #1a1a2e)' }}><span>TOTAL</span><span>£{billTotal.toFixed(2)}</span></div>
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
                  <button onClick={() => startPayment('Cash')} style={{ padding:'18px', borderRadius:12, border:'none', background:'var(--brand-primary, #1a1a2e)', color:'white', fontSize:18, fontWeight:800, cursor:'pointer' }}>💳 Take Payment — £{billTotal.toFixed(2)}</button>
                  {/* SIAMPAY-QR-001 — customer scans + pays on their phone (Apple/Google Pay). */}
                  <button onClick={() => setShowQrPay(true)} style={{ padding:'14px', borderRadius:12, border:'2px solid #16a34a', background:'white', color:'#16a34a', fontSize:15, fontWeight:700, cursor:'pointer' }}>📱 QR Pay — customer scans (£{billTotal.toFixed(2)})</button>
                  <button onClick={() => { setSplitPaid([]); setSplitTenders([]); setStage('split_equal'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid var(--brand-accent,#C9A84C)', background:'white', color:'var(--brand-accent,#C9A84C)', fontSize:15, fontWeight:700, cursor:'pointer' }}>✂️ Split Equally</button>
                  <button onClick={() => { setItemAssignments({}); setSplitItemPaid([]); setSplitTenders([]); setActivePerson(0); setStage('split_items'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid #3b82f6', background:'white', color:'#3b82f6', fontSize:15, fontWeight:700, cursor:'pointer' }}>🍽️ Split by Item</button>
                </>
              )}
              <button onClick={handlePrintBill} style={{ padding:'12px', borderRadius:10, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontSize:14, fontWeight:600, cursor:'pointer' }}>🖨️ Print Bill</button>
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
              <div style={{ fontSize:32, fontWeight:800, color:'var(--brand-primary, #1a1a2e)', marginBottom:4 }}>£{billTotal.toFixed(2)}</div>
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
                <button onClick={handlePrintReceipt} style={{ padding:'16px 24px', borderRadius:12, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontSize:16, fontWeight:700, cursor:'pointer' }}>🖨️ Print Receipt</button>
                <button onClick={handleFinish} disabled={paying} style={{ padding:'18px 24px', borderRadius:12, border:'none', background: paying ? '#9ca3af' : 'var(--brand-primary, #1a1a2e)', color:'white', fontSize:17, fontWeight:800, cursor: paying ? 'not-allowed' : 'pointer' }}>{paying ? 'Processing…' : '✓ Done — Close'}</button>
              </div>
              <p style={{ fontSize:11, color:'#bbb', marginTop:20 }}>Printer not shown? Set your thermal printer as the default printer in your browser settings.</p>
            </div>
          </div>
        )}

        {/* ═══════════════ SPLIT EQUALLY ═══════════════ */}
        {stage === 'mixed' && (() => {
          const mixPaid = splitTenders.reduce((s, t) => s + t.amount, 0);
          const mixRemaining = Math.max(0, billTotal - mixPaid);
          const mixOver = Math.max(0, mixPaid - billTotal);
          // What happens to an over-tender depends on which tender caused it:
          //  • cash → CHANGE handed back (£20 cash for £18.84 → £1.16), but
          //    change can never exceed the cash physically tendered;
          //  • card → you can't give cash back off a card, so the extra is a
          //    TIP (gratuity added on the terminal), never change.
          // SEPOS-AUDIT-001 — split the overage: up to the cash amount is
          // change, anything beyond that (a deliberate card over-tender in the
          // same mix) is tip. Vouchers/deposits are capped at the remaining in
          // their handlers, so they can never create overage.
          const cashPaid  = splitTenders.filter(t => t.method === 'Cash').reduce((s, t) => s + t.amount, 0);
          const mixChange = Math.min(mixOver, cashPaid);
          const mixTip    = Math.max(0, mixOver - mixChange);
          const settled = mixPaid + 0.005 >= billTotal;
          // Cash/Card may be tendered OVER what's left (change given); vouchers &
          // deposits cap themselves at the remaining inside their own handlers.
          const amtNum = parseFloat(mixInput) || 0;
          return (
            <div>
              {mobileTopBar('Payment', () => { cancelMix(); }, '← Bill')}
              <div style={{ padding: isMobile ? '20px 16px' : 32 }}>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand-primary,#0D1B3E)' }}>💳 Payment</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>Add each payment — cash, card, deposit or voucher. You can take part on one method and the rest on another; the bill closes once it's fully covered.</div>
                </div>
                <div style={{ background: '#f8f8f8', borderRadius: 14, padding: 18, marginBottom: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 6, color: '#555' }}><span>Bill total</span><span style={{ fontWeight: 800, color: 'var(--brand-primary,#0D1B3E)' }}>£{billTotal.toFixed(2)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 6, color: '#22c55e' }}><span>Paid so far</span><span style={{ fontWeight: 800 }}>£{mixPaid.toFixed(2)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 800, color: settled ? (mixTip > 0 ? '#8b5cf6' : '#22c55e') : '#e94560', paddingTop: 8, borderTop: '1px solid #eee' }}><span>{settled ? (mixChange > 0 ? '💚 Change due' : mixTip > 0 ? '💜 Card tip' : '✅ Settled') : 'Remaining'}</span><span>£{(settled ? (mixChange || mixTip) : mixRemaining).toFixed(2)}</span></div>
                </div>
                {splitTenders.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    {splitTenders.map((t, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, color: 'var(--brand-primary,#0D1B3E)' }}>{t.method === 'Cash' ? '💵' : t.method === 'Card' ? '💳' : t.method === 'Voucher' ? '🎁' : t.method === 'Deposit' ? '🧾' : '🔄'} {t.method}{t.voucher_code ? ` ${t.voucher_code}` : ''}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}><b>£{t.amount.toFixed(2)}</b>
                          <button onClick={() => removeMixTender(i)} style={{ border: 'none', background: '#fee2e2', color: '#ef4444', borderRadius: 6, padding: '4px 9px', cursor: 'pointer', fontWeight: 700 }}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {!settled && (() => {
                  const hasVoucher = splitTenders.some(t => t.method === 'Voucher');
                  // SEPOS-DEPOSIT-ORDER-001 — block a 2nd deposit tender when one
                  // was already redeemed on the Order screen (no double-redeem).
                  const hasDeposit = splitTenders.some(t => t.method === 'Deposit') || depositPaid > 0;
                  const methods = [
                    { m: 'Cash',    label: '💵 Cash' },
                    { m: 'Card',    label: '💳 Card' },
                    { m: 'Deposit', label: '🧾 Deposit' },
                    { m: 'Voucher', label: '🎁 Voucher' },
                  ];
                  return (
                  <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                      {methods.map(({ m, label }) => {
                        const disabled = (m === 'Voucher' && hasVoucher) || (m === 'Deposit' && hasDeposit);
                        return (
                        <button key={m} disabled={disabled} onClick={() => { setMixMethod(m); setMixVoucherErr(''); if (m === 'Deposit') fetchOrderDeposit(); }} style={{ flex: '1 1 22%', height: 46, borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 14, border: mixMethod === m ? 'none' : '1.5px solid #ddd', background: disabled ? '#f3f4f6' : mixMethod === m ? 'var(--brand-primary,#0D1B3E)' : '#fff', color: disabled ? '#bbb' : mixMethod === m ? '#fff' : 'var(--brand-primary,#0D1B3E)' }}>{label}</button>
                        );
                      })}
                    </div>
                    {mixMethod === 'Deposit' ? (
                      <>
                        {orderDeposit && (
                          <div style={{ background: '#eef6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px', marginBottom: 8, fontSize: 14, color: '#1e40af' }}>
                            🧾 Booking deposit found: <b>£{Number(orderDeposit.balance).toFixed(2)}</b> <span style={{ color: '#64748b' }}>({orderDeposit.code})</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <input value={mixDepositCode} onChange={e => { setMixDepositCode(e.target.value.toUpperCase()); setMixVoucherErr(''); }} placeholder={orderDeposit ? orderDeposit.code : 'Deposit code / reference'} style={{ flex: 2, height: 48, padding: '0 14px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16, boxSizing: 'border-box', textTransform: 'uppercase' }} />
                          <div style={{ position: 'relative', flex: 1 }}>
                            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#888' }}>£</span>
                            <AmountInput value={mixDepositAmt} onChange={(v) => { setMixDepositAmt(v); setMixVoucherErr(''); }} placeholder={(orderDeposit ? Math.min(Number(orderDeposit.balance), mixRemaining) : mixRemaining).toFixed(2)} style={{ width: '100%', height: 48, padding: '0 12px 0 22px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16, boxSizing: 'border-box' }} />
                          </div>
                        </div>
                        {mixVoucherErr && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>{mixVoucherErr}</div>}
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>A booking deposit in our system applies against its balance. A deposit taken elsewhere (or as cash) is accepted for the amount you enter, with the rest paid by another method. The bill total is unchanged.</div>
                        <button onClick={() => addMixDeposit(mixRemaining)} disabled={mixVoucherBusy || (!mixDepositCode.trim() && !orderDeposit)} style={{ width: '100%', height: 52, borderRadius: 12, border: 'none', cursor: (mixVoucherBusy || (!mixDepositCode.trim() && !orderDeposit)) ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: 16, background: (mixVoucherBusy || (!mixDepositCode.trim() && !orderDeposit)) ? '#eee' : 'var(--brand-primary,#0D1B3E)', color: (mixVoucherBusy || (!mixDepositCode.trim() && !orderDeposit)) ? '#aaa' : '#fff', marginBottom: 12 }}>{mixVoucherBusy ? 'Applying…' : `🧾 Apply deposit${orderDeposit ? ` £${Number(orderDeposit.balance).toFixed(2)}` : ''}`}</button>
                      </>
                    ) : mixMethod === 'Voucher' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <input value={mixVoucherCode} onChange={e => { setMixVoucherCode(e.target.value.toUpperCase()); setMixVoucherErr(''); }} placeholder="Voucher code / reference" style={{ flex: 2, height: 48, padding: '0 14px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16, boxSizing: 'border-box', textTransform: 'uppercase' }} />
                          <div style={{ position: 'relative', flex: 1 }}>
                            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#888' }}>£</span>
                            <AmountInput value={mixVoucherAmt} onChange={(v) => { setMixVoucherAmt(v); setMixVoucherErr(''); }} placeholder={mixRemaining.toFixed(2)} style={{ width: '100%', height: 48, padding: '0 12px 0 22px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16, boxSizing: 'border-box' }} />
                          </div>
                        </div>
                        {mixVoucherErr && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>{mixVoucherErr}</div>}
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>Our vouchers redeem against their balance. A code we don't recognise (e.g. sold on your old system) is accepted for the amount you enter, with the code kept as a reference.</div>
                        <button onClick={() => addMixVoucher(mixRemaining)} disabled={mixVoucherBusy || !mixVoucherCode.trim()} style={{ width: '100%', height: 52, borderRadius: 12, border: 'none', cursor: mixVoucherBusy || !mixVoucherCode.trim() ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: 16, background: mixVoucherBusy || !mixVoucherCode.trim() ? '#eee' : 'var(--brand-accent,#C9A84C)', color: mixVoucherBusy || !mixVoucherCode.trim() ? '#aaa' : '#fff', marginBottom: 12 }}>{mixVoucherBusy ? 'Adding…' : '🎁 Add voucher'}</button>
                      </>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                          <div style={{ position: 'relative', flex: 1 }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }}>£</span>
                            <AmountInput value={mixInput} onChange={setMixInput} placeholder={mixRemaining.toFixed(2)} style={{ width: '100%', height: 48, padding: '0 12px 0 28px', borderRadius: 10, border: '1px solid #ddd', fontSize: 16, boxSizing: 'border-box' }} />
                          </div>
                          <button onClick={() => setMixInput(mixRemaining.toFixed(2))} style={{ height: 48, padding: '0 16px', borderRadius: 10, border: '1.5px solid #ddd', background: '#fff', cursor: 'pointer', fontWeight: 700 }}>Rest</button>
                        </div>
                        <button onClick={() => { if (amtNum <= 0) return; setSplitTenders(prev => [...prev, { amount: amtNum, method: mixMethod }]); setMixInput(''); }} disabled={amtNum <= 0} style={{ width: '100%', height: 52, borderRadius: 12, border: 'none', cursor: amtNum > 0 ? 'pointer' : 'not-allowed', fontWeight: 800, fontSize: 16, background: amtNum > 0 ? 'var(--brand-primary,#0D1B3E)' : '#eee', color: amtNum > 0 ? '#fff' : '#aaa', marginBottom: 12 }}>+ Add {mixMethod} £{amtNum.toFixed(2)}</button>
                      </>
                    )}
                  </>
                  );
                })()}
                {settled && (() => {
                  // SEPOS-PAY-ONETAP-001 — one card, one tap. Confirm records the
                  // payment, optionally prints, shows a 2s toast (big CHANGE for
                  // cash) and returns to the floor — the old "Payment Confirmed!"
                  // card is gone from this path.
                  const doConfirm = async (printAfter) => {
                    if (paying) return;
                    const paid = splitTenders.reduce((s, t) => s + t.amount, 0);
                    // SEPOS-CASHCHANGE-001 — cash change is handed BACK, so it must not be
                    // recorded as money taken. Reduce the cash tender(s) by the change so the
                    // RECORDED tenders foot to the BILL, not the over-tender. (Card over-tender
                    // is a genuine tip — mixTip — and is left intact.)
                    let toDrop = mixChange;
                    const recTenders = splitTenders.map(t => {
                      if (toDrop > 0.001 && t.method === 'Cash') {
                        const cut = Math.min(toDrop, t.amount);
                        toDrop = Number((toDrop - cut).toFixed(2));
                        return { ...t, amount: Number((t.amount - cut).toFixed(2)) };
                      }
                      return t;
                    }).filter(t => t.amount > 0.001);
                    let method = recTenders.length === 1 ? recTenders[0].method : 'Split';
                    let pd = { method, amountPaid: paid, tip: mixTip, change: mixChange, tenders: recTenders };
                    // F2 — deposit fully covered the bill: nothing left to tender,
                    // but /pay rejects £0. Record the deposit AS the tender so the
                    // bill closes covered (same rows a pay-screen deposit writes).
                    if (recTenders.length === 0 && billTotal <= 0.005 && depositPaid > 0) {
                      pd = { method: 'Deposit', amountPaid: depositPaid, tip: 0, change: 0, tenders: [{ amount: depositPaid, method: 'Deposit' }] };
                    }
                    setPaymentDetails(pd);
                    setPaying(true);
                    try {
                      // Review C1 — onPay resolves true/false (it never rejects).
                      // Celebrate ONLY on true: no drawer, no receipt, no toast
                      // for a failed payment; onPay already alerted the error.
                      const ok = await onPay(pd.tenders.length && billTotal <= 0.005 ? pd.amountPaid : billTotal, pd.method, pd.amountPaid, pd.tip, pd.tenders);
                      if (ok !== true) return;
                      serverOpenDrawer().catch(() => {});
                      if (printAfter) printReceipt({ order: { ...order }, items: billItems, settings: { ...settings }, paymentDetails: { ...receiptTotals, ...pd } });
                      showPaidToast(pd, orderShortLabelPlain(order));
                    } catch (e) {
                      alert('Payment could not be recorded: ' + (e?.message || 'unknown') + '\nThe bill is still open — try again.');
                    } finally { setPaying(false); }
                  };
                  const suffix = mixChange > 0 ? ` (£${mixChange.toFixed(2)} change)` : mixTip > 0 ? ` (£${mixTip.toFixed(2)} tip)` : '';
                  return (
                    <>
                      <button onClick={() => doConfirm(false)} disabled={paying} style={{ width: '100%', height: 56, borderRadius: 12, border: 'none', background: paying ? '#9ca3af' : '#22c55e', color: '#fff', fontWeight: 800, fontSize: 17, cursor: paying ? 'wait' : 'pointer', marginBottom: 10 }}>{paying ? 'Recording…' : <>✓ Confirm — £{billTotal.toFixed(2)}{suffix}</>}</button>
                      <button onClick={() => doConfirm(true)} disabled={paying} style={{ width: '100%', height: 50, borderRadius: 12, border: '2px solid #22c55e', background: '#fff', color: '#15803d', fontWeight: 800, fontSize: 15, cursor: paying ? 'wait' : 'pointer', marginBottom: 12 }}>🖨 Confirm &amp; Print receipt</button>
                    </>
                  );
                })()}
                <button onClick={cancelMix} style={{ width: '100%', padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>← Back to Bill</button>
              </div>
            </div>
          );
        })()}

        {stage === 'split_equal' && (
          <div>
            {mobileTopBar('Split Equally', () => setStage('bill'), '← Bill')}
            <div style={{ padding:isMobile?'20px 16px':32 }}>
              {!isMobile && <div style={{ textAlign:'center', marginBottom:24 }}><div style={{ fontSize:22, fontWeight:800, color:'var(--brand-primary, #1a1a2e)' }}>✂️ Split Equally</div><div style={{ fontSize:14, color:'#888', marginTop:4 }}>Total: £{billTotal.toFixed(2)}</div></div>}
              {isMobile  && <div style={{ textAlign:'center', marginBottom:20 }}><div style={{ fontSize:15, color:'#888' }}>Total: <span style={{ fontWeight:800, color:'var(--brand-primary, #1a1a2e)', fontSize:20 }}>£{billTotal.toFixed(2)}</span></div></div>}
              <div style={{ marginBottom:24 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'#555', marginBottom:12, textAlign:'center' }}>Split between how many people?</div>
                <div style={{ display:'grid', gridTemplateColumns:isMobile?'repeat(3,1fr)':'repeat(5,1fr)', gap:8 }}>
                  {[2,3,4,5,6,7,8,9,10].map(n => (
                    <button key={n} onClick={() => {
                      // SEPOS-AUDIT-001 — changing the head-count restarts the
                      // split: clearing paid WITHOUT clearing the tenders left
                      // already-taken money in the sum, so the last person's
                      // remainder went negative (server 400, bill stuck) or
                      // recorded the wrong amount. Warn if money was taken.
                      if (splitTenders.length > 0) alert('Split restarted — payments already taken were cleared. Re-take each person\'s payment.');
                      setSplitCount(n); setSplitPaid([]); setSplitTenders([]);
                    }} style={{ padding:isMobile?'16px 8px':'14px 8px', borderRadius:10, border:'none', cursor:'pointer', fontWeight:700, fontSize:18, background:splitCount===n?'var(--brand-primary, #1a1a2e)':'#f0f0f0', color:splitCount===n?'white':'var(--brand-primary, #1a1a2e)' }}>{n}</button>
                  ))}
                </div>
              </div>
              <div style={{ background:'#f8f8f8', borderRadius:14, padding:20, marginBottom:24 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, color:'#555', marginBottom:8 }}><span>Each person pays</span><span style={{ fontWeight:800, fontSize:24, color:'var(--brand-primary, #1a1a2e)' }}>£{splitAmount.toFixed(2)}</span></div>
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
                      <div><div style={{ fontWeight:700, color:isPaid?'#22c55e':'var(--brand-primary, #1a1a2e)' }}>{isPaid?'✅':'👤'} Person {i+1}</div><div style={{ fontSize:13, color:'#888' }}>£{splitAmount.toFixed(2)}</div></div>
                      {!isPaid
                        ? <div style={{ display:'flex', gap:8 }}>
                            <button onClick={() => handleSplitEqualPayment(i, 'Cash')} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'var(--brand-primary, #1a1a2e)', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                            <button onClick={() => handleSplitEqualPayment(i, 'Card')} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'var(--brand-accent,#C9A84C)', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
                            <button onClick={() => handleSplitEqualPrint(i)} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontWeight:700, fontSize:13, cursor:'pointer' }}>🖨️ Print</button>
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
              {!isMobile && <div style={{ textAlign:'center', marginBottom:20 }}><div style={{ fontSize:22, fontWeight:800, color:'var(--brand-primary, #1a1a2e)' }}>🍽️ Split by Item</div><div style={{ fontSize:13, color:'#888', marginTop:4 }}>Assign each item to a person</div></div>}
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#555', marginBottom:10 }}>How many people?</div>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {[2,3,4,5,6,7,8].map(n => (
                    <button key={n} onClick={() => {
                      // SEPOS-AUDIT-001 — same tender-leak fix as split-equal.
                      if (splitTenders.length > 0) alert('Split restarted — payments already taken were cleared. Re-take each person\'s payment.');
                      setSplitItemCount(n); setItemAssignments({}); setSplitItemPaid([]); setSplitTenders([]); setActivePerson(0);
                    }} style={{ padding:isMobile?'12px 18px':'10px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:16, background:splitItemCount===n?'var(--brand-primary, #1a1a2e)':'#f0f0f0', color:splitItemCount===n?'white':'var(--brand-primary, #1a1a2e)' }}>{n}</button>
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
                        <div style={{ fontWeight:600, fontSize:isMobile?15:14, color:'var(--brand-primary, #1a1a2e)' }}>{item.quantity}× {item.name}</div>
                        {item.notes && <div style={{ fontSize:11, color:'#888' }}>{item.notes}</div>}
                        {item.discount_value>0 && <div style={{ fontSize:11, color:'#22c55e' }}>🏷️ -£{d.toFixed(2)}</div>}
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ fontWeight:700, color:'var(--brand-primary, #1a1a2e)' }}>£{(p-d).toFixed(2)}</span>
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
                          <div style={{ fontWeight:800, fontSize:18, color:'var(--brand-primary, #1a1a2e)' }}>£{p.total.toFixed(2)}</div>
                        </div>
                        {p.items.map(item => <div key={item.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:2 }}><span>{item.quantity}× {item.name}</span><span>£{(item.unit_price*item.quantity).toFixed(2)}</span></div>)}
                        <div style={{ borderTop:'1px dashed #ccc', marginTop:8, paddingTop:8 }}>
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:3 }}><span>Subtotal</span><span>£{p.subtotal.toFixed(2)}</span></div>
                          {p.discount>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#22c55e', marginBottom:3 }}><span>Discount</span><span>-£{p.discount.toFixed(2)}</span></div>}
                          {serviceChargeEnabled&&p.service>0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#555', marginBottom:3 }}><span>Service ({parseFloat(settings.service_charge_rate||12.5)}%)</span><span>£{p.service.toFixed(2)}</span></div>}
                        </div>
                        {!isPaid && <div style={{ display:'flex', gap:8, marginTop:12 }}>
                          <button onClick={() => handleSplitItemPayment(i, 'Cash')} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:'var(--brand-primary, #1a1a2e)', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                          <button onClick={() => handleSplitItemPayment(i, 'Card')} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:personColors[i], color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
                          <button onClick={() => handleSplitItemPrint(i)} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontWeight:700, fontSize:13, cursor:'pointer' }}>🖨️ Print</button>
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
                <div style={{ fontSize:42, fontWeight:800, color:'var(--brand-primary, #1a1a2e)' }}>£{billTotal.toFixed(2)}</div>
                {serviceChargeEnabled&&serviceCharge>0 && <div style={{ fontSize:13, color:'#888', marginTop:4 }}>Incl. service charge £{serviceCharge.toFixed(2)}</div>}
              </div>
              {hasVoucherDiscount && (
                <div style={{ background:'#fdf6ec', border:'2px solid var(--brand-accent,#C9A84C)', borderRadius:12, padding:'12px 16px', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
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
                  <button key={method} onClick={() => { setSelectedMethod(method); setPaymentInput(''); setStage('amount'); }} style={{ padding:isMobile?'22px':'20px', borderRadius:12, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontSize:isMobile?22:20, fontWeight:700, cursor:'pointer' }}>{icon} {method}</button>
                ))}
                <button onClick={() => { setSplitTenders([]); setMixInput(''); setMixVoucherCode(''); setMixVoucherAmt(''); setMixDepositCode(''); setMixDepositAmt(''); setMixVoucherErr(''); setMixMethod('Voucher'); setStage('mixed'); }} style={{ padding:isMobile?'22px':'20px', borderRadius:12, border:'2px solid var(--brand-accent,#C9A84C)', background:'#fdf6ec', color:'#5b4a2a', fontSize:isMobile?22:20, fontWeight:700, cursor:'pointer' }}>🎁 Voucher</button>
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
                <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>£{billTotal.toFixed(2)}</div>
              </div>

              <div style={{ background: '#fdf6ec', border: '2px solid var(--brand-accent,#C9A84C)', borderRadius: 12, padding: 18, marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: '#5b4a2a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>Voucher code</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" autoFocus value={voucherCode}
                    onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleVoucherLookup(); }}
                    placeholder="GIFT-XXXXXXXX"
                    style={{ flex: 1, padding: '14px', border: '1px solid var(--brand-accent,#C9A84C)', borderRadius: 8, fontFamily: 'Menlo,Consolas,monospace', fontSize: 18, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', background: 'white' }} />
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
                    style={{ marginTop: 14, width: '100%', padding: 16, borderRadius: 10, border: 'none', background: 'var(--brand-accent,#C9A84C)', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 800, fontSize: 16, cursor: 'pointer', opacity: voucherLoading ? 0.5 : 1 }}>
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
                <div style={{ background:'var(--brand-primary,#0D1B3E)', padding:'20px 20px 16px', display:'flex', flexDirection:'column' }}>
                  <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginBottom:4 }}>Amount received</div>
                  <div style={{ fontSize:46, fontWeight:800, color:'white', fontFamily:'monospace', letterSpacing:1 }}>£{paymentInput||'0.00'}</div>
                  {canPay&&selectedMethod==='Cash'&&change>0 && <div style={{ marginTop:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}><span style={{ fontSize:13, color:'rgba(255,255,255,0.5)' }}>Change to give</span><span style={{ fontSize:22, fontWeight:800, color:'#22c55e' }}>£{change.toFixed(2)}</span></div>}
                  {canPay&&actualTip>0&&selectedMethod!=='Cash' && <div style={{ marginTop:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}><span style={{ fontSize:13, color:'rgba(255,255,255,0.5)' }}>Tip</span><span style={{ fontSize:22, fontWeight:800, color:'#8b5cf6' }}>£{actualTip.toFixed(2)}</span></div>}
                </div>
                <div style={{ padding:'12px 16px 8px' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
                    {['7','8','9','4','5','6','1','2','3','00','0','⌫'].map(btn => (
                      <button key={btn} onClick={() => handleNumpad(btn)} style={{ height:72, borderRadius:12, border:'none', fontSize:26, fontWeight:700, cursor:'pointer', background:btn==='⌫'?'#fee2e2':'#f8f8f8', color:btn==='⌫'?'#ef4444':'var(--brand-primary,#0D1B3E)' }}>{btn}</button>
                    ))}
                  </div>
                  <button onClick={() => handleNumpad('C')} style={{ width:'100%', marginTop:10, padding:'14px', borderRadius:12, border:'none', background:'#f0f0f0', color:'#555', fontSize:16, fontWeight:700, cursor:'pointer' }}>Clear</button>
                </div>
                <div style={{ padding:'8px 16px' }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'#aaa', marginBottom:8 }}>Quick amounts</div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
                    {[billTotal,Math.ceil(billTotal/5)*5,Math.ceil(billTotal/10)*10,Math.ceil(billTotal/20)*20].filter((v,i,a)=>a.indexOf(v)===i).map(amount => (
                      <button key={amount} onClick={() => setPaymentInput(amount.toFixed(2))} style={{ padding:'13px', borderRadius:10, border:`2px solid ${paymentInput===amount.toFixed(2)?'var(--brand-accent,#C9A84C)':'#e0e0e0'}`, background:paymentInput===amount.toFixed(2)?'var(--brand-accent,#C9A84C)':'white', color:paymentInput===amount.toFixed(2)?'white':'var(--brand-primary,#0D1B3E)', fontWeight:700, cursor:'pointer', fontSize:16 }}>£{amount.toFixed(2)}</button>
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
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, color:'#555', marginBottom:10 }}><span>Amount received</span><span style={{ fontWeight:800, color:'var(--brand-primary, #1a1a2e)', fontSize:18 }}>£{amountPaid>0?amountPaid.toFixed(2):'—'}</span></div>
                    {canPay&&selectedMethod==='Cash' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:20, fontWeight:800, color:'#22c55e', borderTop:'2px solid #eee', paddingTop:10, marginTop:4 }}><span>💚 Change</span><span>£{Math.max(0,change).toFixed(2)}</span></div>}
                    {canPay&&amountPaid>billTotal&&selectedMethod!=='Cash' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:20, fontWeight:800, color:'#8b5cf6', borderTop:'2px solid #eee', paddingTop:10, marginTop:4 }}><span>💜 Tip</span><span>£{actualTip.toFixed(2)}</span></div>}
                  </div>
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:'#888', marginBottom:10 }}>Quick amounts</div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
                      {[billTotal,Math.ceil(billTotal/5)*5,Math.ceil(billTotal/10)*10,Math.ceil(billTotal/20)*20].filter((v,i,a)=>a.indexOf(v)===i).map(amount => (
                        <button key={amount} onClick={() => setPaymentInput(amount.toFixed(2))} style={{ padding:'12px', borderRadius:10, border:`2px solid ${paymentInput===amount.toFixed(2)?'var(--brand-accent,#C9A84C)':'var(--brand-primary, #1a1a2e)'}`, background:paymentInput===amount.toFixed(2)?'var(--brand-accent,#C9A84C)':'white', color:paymentInput===amount.toFixed(2)?'white':'var(--brand-primary, #1a1a2e)', fontWeight:700, cursor:'pointer', fontSize:15 }}>£{amount.toFixed(2)}</button>
                      ))}
                    </div>
                  </div>
                  <button onClick={handleConfirmPayment} disabled={!canPay} style={{ width:'100%', padding:'18px', borderRadius:12, border:'none', background:canPay?'#22c55e':'#ddd', color:'white', fontSize:18, fontWeight:800, cursor:canPay?'pointer':'not-allowed', marginBottom:10 }}>
                    {canPay?selectedMethod==='Cash'?change>0?`✓ Confirm — Give change £${change.toFixed(2)}`:'✓ Confirm — Exact Amount':actualTip>0?`✓ Confirm — Tip £${actualTip.toFixed(2)}`:'✓ Confirm Payment':`Enter amount (min £${billTotal.toFixed(2)})`}
                  </button>
                  <button onClick={() => setStage('method')} style={{ width:'100%', padding:'12px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:14 }}>← Back</button>
                </div>
                <div style={{ width:280, padding:24, display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ background:'var(--brand-primary, #1a1a2e)', borderRadius:14, padding:'20px', textAlign:'right', marginBottom:8 }}>
                    <div style={{ fontSize:13, color:'#aaa', marginBottom:6 }}>Amount received</div>
                    <div style={{ fontSize:36, fontWeight:800, color:'white', fontFamily:'monospace' }}>£{paymentInput||'0.00'}</div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                    {['7','8','9','4','5','6','1','2','3','00','0','⌫'].map(btn => (
                      <button key={btn} onClick={() => handleNumpad(btn)} style={{ height:68, borderRadius:12, border:'none', fontSize:22, fontWeight:700, cursor:'pointer', background:btn==='⌫'?'#fee2e2':'#f8f8f8', color:btn==='⌫'?'#ef4444':'var(--brand-primary, #1a1a2e)' }}>{btn}</button>
                    ))}
                  </div>
                  <button onClick={() => handleNumpad('C')} style={{ padding:'16px', borderRadius:12, border:'none', background:'#f0f0f0', color:'#555', fontSize:16, fontWeight:700, cursor:'pointer' }}>Clear</button>
                </div>
              </div>
            )}
          </>
        )}

      </div>

      {/* SIAMPAY-QR-001 — customer scans + pays; on success the payment is
          recorded as 'QR Card' and the normal receipt/close flow takes over. */}
      {showQrPay && (
        <QRPayModal
          orderId={orderId}
          amount={billTotal}
          onClose={() => setShowQrPay(false)}
          onPaid={() => {
            setShowQrPay(false);
            setPaymentDetails({ method: 'QR Card', amountPaid: billTotal, tip: 0, change: 0 });
            setStage('receipt');
          }}
        />
      )}
    </div>
  );
}
