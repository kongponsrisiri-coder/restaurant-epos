import { useState, useEffect } from 'react';
import { getBill, markBillPrinted } from '../api';
import { printReceipt } from './ReceiptPrinter';

export default function BillScreen({ orderId, onClose, onPay }) {

  const [bill, setBill]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [paymentInput, setPaymentInput]     = useState('');
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [stage, setStage]                   = useState('bill');
  const [paymentDetails, setPaymentDetails] = useState(null);

  const [splitCount, setSplitCount]         = useState(2);
  const [splitPaid, setSplitPaid]           = useState([]);
  const [splitItemCount, setSplitItemCount] = useState(2);
  const [itemAssignments, setItemAssignments] = useState({});
  const [splitItemPaid, setSplitItemPaid]   = useState([]);
  const [activePerson, setActivePerson]     = useState(0);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    getBill(orderId).then(data => { setBill(data); setLoading(false); markBillPrinted(orderId); });
  }, [orderId]);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  if (loading) return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ color:'white', fontSize:18 }}>Loading bill...</div>
    </div>
  );
  if (!bill || !bill.order) return null;

  const { order, settings } = bill;
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

  const handleFinish = () => {
    onPay(billTotal, paymentDetails?.method, paymentDetails?.amountPaid, paymentDetails?.tip);
  };

  const handleSplitEqualPayment = (index) => {
    const newPaid = [...splitPaid, index];
    setSplitPaid(newPaid);
    if (newPaid.length >= splitCount) { setPaymentDetails({ method:'Split', amountPaid:billTotal, tip:0, change:0 }); setStage('receipt'); }
  };

  const handleSplitItemPayment = (personIdx) => {
    const newPaid = [...splitItemPaid, personIdx];
    setSplitItemPaid(newPaid);
    if (newPaid.length >= splitItemCount) { setPaymentDetails({ method:'Split by Item', amountPaid:billTotal, tip:0, change:0 }); setStage('receipt'); }
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
      <div style={card}>

        {/* ═══════════════ BILL ═══════════════ */}
        {stage === 'bill' && (
          <div>
            {mobileTopBar(`Table ${order.table_number}`, onClose, '✕ Close')}
            <div style={{ padding:isMobile?'20px 16px':'28px 24px' }}>
              <div style={{ textAlign:'center', marginBottom:20 }}>
                <div style={{ fontSize:22, fontWeight:800, color:'#1a1a2e' }}>{settings.company_name || settings.restaurant_name || 'My Restaurant'}</div>
                {settings.company_address && <div style={{ fontSize:12, color:'#555', marginTop:4 }}>{settings.company_address}</div>}
                {settings.company_phone   && <div style={{ fontSize:12, color:'#555' }}>Tel: {settings.company_phone}</div>}
                {settings.company_vat     && <div style={{ fontSize:12, color:'#555' }}>VAT: {settings.company_vat}</div>}
              </div>
              <div style={{ borderTop:'1px dashed #ccc', borderBottom:'1px dashed #ccc', padding:'8px 0', marginBottom:16, display:'flex', justifyContent:'space-between', fontSize:12, color:'#555' }}>
                <span>Table {order.table_number} · {order.covers||1} covers</span>
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
              <button onClick={() => setStage('method')} style={{ padding:'18px', borderRadius:12, border:'none', background:'#1a1a2e', color:'white', fontSize:18, fontWeight:800, cursor:'pointer' }}>💳 Take Payment — £{billTotal.toFixed(2)}</button>
              <button onClick={() => { setSplitPaid([]); setStage('split_equal'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid #C9A84C', background:'white', color:'#C9A84C', fontSize:15, fontWeight:700, cursor:'pointer' }}>✂️ Split Equally</button>
              <button onClick={() => { setItemAssignments({}); setSplitItemPaid([]); setActivePerson(0); setStage('split_items'); }} style={{ padding:'14px', borderRadius:12, border:'2px solid #3b82f6', background:'white', color:'#3b82f6', fontSize:15, fontWeight:700, cursor:'pointer' }}>🍽️ Split by Item</button>
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
              <div style={{ fontSize:14, color:'#888', marginBottom:28 }}>{paymentDetails?.method} · Table {order.table_number}</div>
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
                            <button onClick={() => handleSplitEqualPayment(i)} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                            <button onClick={() => handleSplitEqualPayment(i)} style={{ padding:isMobile?'12px 14px':'10px 14px', borderRadius:8, border:'none', background:'#C9A84C', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
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
                          <button onClick={() => handleSplitItemPayment(i)} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💵 Cash</button>
                          <button onClick={() => handleSplitItemPayment(i)} style={{ flex:1, padding:isMobile?'14px':'10px', borderRadius:8, border:'none', background:personColors[i], color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>💳 Card</button>
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
              <div style={{ fontSize:16, fontWeight:700, color:'#555', marginBottom:16, textAlign:'center' }}>Select payment method</div>
              <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:16 }}>
                {[{method:'Cash',icon:'💵'},{method:'Card',icon:'💳'},{method:'Other',icon:'🔄'}].map(({method,icon}) => (
                  <button key={method} onClick={() => { setSelectedMethod(method); setPaymentInput(''); setStage('amount'); }} style={{ padding:isMobile?'22px':'20px', borderRadius:12, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontSize:isMobile?22:20, fontWeight:700, cursor:'pointer' }}>{icon} {method}</button>
                ))}
              </div>
              {!isMobile && <button onClick={() => setStage('bill')} style={{ width:'100%', padding:'14px', borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:15 }}>← Back to Bill</button>}
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
