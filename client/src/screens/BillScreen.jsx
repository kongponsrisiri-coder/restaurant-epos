import { useState, useEffect } from 'react';
import { getBill, markBillPrinted } from '../api';

export default function BillScreen({ orderId, onClose, onPay }) {
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paymentInput, setPaymentInput] = useState('');
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [stage, setStage] = useState('bill');

  // Split equal state
  const [splitCount, setSplitCount] = useState(2);
  const [splitPaid, setSplitPaid] = useState([]);

  // Split by item state
  const [splitItemCount, setSplitItemCount] = useState(2);
  const [itemAssignments, setItemAssignments] = useState({});
  const [splitItemPaid, setSplitItemPaid] = useState([]);
  const [activePerson, setActivePerson] = useState(0);

  useEffect(() => {
    getBill(orderId).then(data => {
      setBill(data);
      setLoading(false);
      markBillPrinted(orderId);
    });
  }, [orderId]);

  if (loading) return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ color: 'white', fontSize: 18 }}>Loading bill...</div>
    </div>
  );

  if (!bill || !bill.order) return null;

  const { order, settings } = bill;
  const serviceChargePercent = parseFloat(settings.service_charge_percent || 12.5) / 100;

  // ✅ FIX: Default to ENABLED unless explicitly set to '0'
  const serviceChargeEnabled = settings.service_charge_enabled !== '0';

  const billItems = order.items?.filter(i => !i.voided) || [];

  const subtotal = billItems.reduce((sum, i) => {
    const itemPrice = i.unit_price * i.quantity;
    const itemDiscount = i.discount_value > 0
      ? i.discount_type === 'percent'
        ? itemPrice * (i.discount_value / 100)
        : Math.min(i.discount_value, itemPrice)
      : 0;
    return sum + itemPrice - itemDiscount;
  }, 0);

  const discountAmount = order.discount_value > 0
    ? order.discount_type === 'percent'
      ? subtotal * (order.discount_value / 100)
      : order.discount_value
    : 0;
  const discountRate = subtotal > 0 ? discountAmount / subtotal : 0;
  const afterDiscount = subtotal - discountAmount;
  const serviceCharge = serviceChargeEnabled ? afterDiscount * serviceChargePercent : 0;
  const billTotal = afterDiscount + serviceCharge;
  const amountPaid = parseFloat(paymentInput) || 0;
  const change = amountPaid - billTotal;
  const actualTip = selectedMethod !== 'Cash' ? Math.max(0, amountPaid - billTotal) : 0;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // Split equal calculations
  const splitAmount = billTotal / splitCount;
  const paidCount = splitPaid.length;
  const remainingEqual = billTotal - (paidCount * splitAmount);

  // Split by item calculations
  const getPersonTotal = (personIdx) => {
    const personItems = billItems.filter(item => itemAssignments[item.id] === personIdx);
    const personSubtotal = personItems.reduce((sum, i) => {
      const itemPrice = i.unit_price * i.quantity;
      const itemDiscount = i.discount_value > 0
        ? i.discount_type === 'percent'
          ? itemPrice * (i.discount_value / 100)
          : Math.min(i.discount_value, itemPrice)
        : 0;
      return sum + itemPrice - itemDiscount;
    }, 0);
    const personDiscount = personSubtotal * discountRate;
    const personAfterDiscount = personSubtotal - personDiscount;
    const personService = serviceChargeEnabled ? personAfterDiscount * serviceChargePercent : 0;
    return {
      items: personItems,
      subtotal: personSubtotal,
      discount: personDiscount,
      afterDiscount: personAfterDiscount,
      service: personService,
      total: personAfterDiscount + personService
    };
  };

  const unassignedItems = billItems.filter(item => itemAssignments[item.id] === undefined);
  const allAssigned = unassignedItems.length === 0 && billItems.length > 0;
  const personColors = ['#e94560', '#3b82f6', '#22c55e', '#8b5cf6', '#f97316', '#06b6d4', '#ec4899', '#eab308'];

  const handleNumpad = (btn) => {
    if (btn === 'C') { setPaymentInput(''); return; }
    if (btn === '⌫') { setPaymentInput(prev => prev.slice(0, -1)); return; }
    if (btn === '.') {
      if (paymentInput.includes('.')) return;
      setPaymentInput(prev => (prev || '0') + '.');
      return;
    }
    if (paymentInput.includes('.') && paymentInput.split('.')[1]?.length >= 2) return;
    setPaymentInput(prev => prev + btn);
  };

  const handleConfirmPayment = () => {
    if (amountPaid < billTotal) {
      alert(`Amount £${amountPaid.toFixed(2)} is less than bill £${billTotal.toFixed(2)}`);
      return;
    }
    onPay(billTotal, selectedMethod, amountPaid, actualTip);
  };

  const handleSplitEqualPayment = (index) => {
    const newPaid = [...splitPaid, index];
    setSplitPaid(newPaid);
    if (newPaid.length >= splitCount) {
      onPay(billTotal, 'Split', billTotal, 0);
    }
  };

  const handleSplitItemPayment = (personIdx) => {
    const newPaid = [...splitItemPaid, personIdx];
    setSplitItemPaid(newPaid);
    if (newPaid.length >= splitItemCount) {
      onPay(billTotal, 'Split by Item', billTotal, 0);
    }
  };

  const overlay = {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999, padding: 16
  };

  const card = {
    background: 'white', borderRadius: 20,
    width: '100%',
    maxWidth: stage === 'amount' ? 820 : stage === 'split_items' ? 600 : 480,
    maxHeight: '95vh', overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
  };

  return (
    <div style={overlay}>
      <div style={card}>

        {/* ─── BILL VIEW ─── */}
        {stage === 'bill' && (
          <div>
            <div style={{ padding: '28px 24px' }}>
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#1a1a2e' }}>
                  {settings.company_name || 'My Restaurant'}
                </div>
                {settings.company_address && <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>{settings.company_address}</div>}
                {settings.company_phone && <div style={{ fontSize: 12, color: '#555' }}>Tel: {settings.company_phone}</div>}
                {settings.company_vat && <div style={{ fontSize: 12, color: '#555' }}>VAT: {settings.company_vat}</div>}
              </div>

              <div style={{ borderTop: '1px dashed #ccc', borderBottom: '1px dashed #ccc', padding: '8px 0', marginBottom: 16, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555' }}>
                <span>Table {order.table_number} · {order.covers || 1} covers</span>
                <span>{dateStr} {timeStr}</span>
              </div>

              <div style={{ marginBottom: 16, fontFamily: 'monospace' }}>
                {billItems.map(item => {
                  const itemPrice = item.unit_price * item.quantity;
                  const itemDiscount = item.discount_value > 0
                    ? item.discount_type === 'percent'
                      ? itemPrice * (item.discount_value / 100)
                      : Math.min(item.discount_value, itemPrice)
                    : 0;
                  const itemTotal = itemPrice - itemDiscount;
                  return (
                    <div key={item.id} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                        <span>{item.quantity}× {item.name}</span>
                        <span>£{itemTotal.toFixed(2)}</span>
                      </div>
                      {item.notes && <div style={{ fontSize: 11, color: '#888', marginLeft: 16 }}>{item.notes}</div>}
                      {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>}
                      {item.discount_value > 0 && (
                        <div style={{ fontSize: 11, color: '#22c55e', marginLeft: 16 }}>
                          🏷️ {item.discount_type === 'percent' ? `${item.discount_value}% off` : `£${item.discount_value} off`}
                          {' '}(-£{itemDiscount.toFixed(2)})
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ borderTop: '1px dashed #ccc', paddingTop: 12, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6, color: '#555' }}>
                  <span>Subtotal</span><span>£{subtotal.toFixed(2)}</span>
                </div>
                {discountAmount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6, color: '#22c55e' }}>
                    <span>Discount ({order.discount_reason})</span>
                    <span>-£{discountAmount.toFixed(2)}</span>
                  </div>
                )}
                {serviceChargeEnabled && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6, color: '#555' }}>
                    <span>Service charge ({settings.service_charge_percent || 12.5}%)</span>
                    <span>£{serviceCharge.toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, fontWeight: 800, marginTop: 10, color: '#1a1a2e' }}>
                  <span>TOTAL</span><span>£{billTotal.toFixed(2)}</span>
                </div>
              </div>

              <div style={{ textAlign: 'center', fontSize: 12, color: '#888', borderTop: '1px dashed #ccc', paddingTop: 12 }}>
                {settings.receipt_footer || 'Thank you for dining with us!'}
              </div>
            </div>

            <div style={{ padding: '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => setStage('method')} style={{
                padding: '18px', borderRadius: 12, border: 'none',
                background: '#1a1a2e', color: 'white', fontSize: 18, fontWeight: 800, cursor: 'pointer'
              }}>
                💳 Take Payment — £{billTotal.toFixed(2)}
              </button>
              <button onClick={() => { setSplitPaid([]); setStage('split_equal'); }} style={{
                padding: '14px', borderRadius: 12, border: '2px solid #C9A84C',
                background: 'white', color: '#C9A84C', fontSize: 15, fontWeight: 700, cursor: 'pointer'
              }}>
                ✂️ Split Equally
              </button>
              <button onClick={() => {
                setItemAssignments({});
                setSplitItemPaid([]);
                setActivePerson(0);
                setStage('split_items');
              }} style={{
                padding: '14px', borderRadius: 12, border: '2px solid #3b82f6',
                background: 'white', color: '#3b82f6', fontSize: 15, fontWeight: 700, cursor: 'pointer'
              }}>
                🍽️ Split by Item
              </button>
              <button onClick={() => window.print()} style={{
                padding: '12px', borderRadius: 10, border: '2px solid #1a1a2e',
                background: 'white', color: '#1a1a2e', fontSize: 14, fontWeight: 600, cursor: 'pointer'
              }}>
                🖨️ Print Bill
              </button>
              <button onClick={onClose} style={{
                padding: '12px', borderRadius: 10, border: 'none',
                background: '#f0f0f0', color: '#555', fontSize: 14, cursor: 'pointer'
              }}>
                Close
              </button>
            </div>
          </div>
        )}

        {/* ─── SPLIT EQUALLY ─── */}
        {stage === 'split_equal' && (
          <div style={{ padding: 32 }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1a1a2e' }}>✂️ Split Equally</div>
              <div style={{ fontSize: 14, color: '#888', marginTop: 4 }}>Total: £{billTotal.toFixed(2)}</div>
            </div>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#555', marginBottom: 12, textAlign: 'center' }}>
                Split between how many people?
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                {[2,3,4,5,6,7,8,9,10].map(n => (
                  <button key={n} onClick={() => { setSplitCount(n); setSplitPaid([]); }} style={{
                    padding: '14px 8px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 16,
                    background: splitCount === n ? '#1a1a2e' : '#f0f0f0',
                    color: splitCount === n ? 'white' : '#1a1a2e',
                  }}>{n}</button>
                ))}
              </div>
            </div>
            <div style={{ background: '#f8f8f8', borderRadius: 14, padding: 20, marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, color: '#555', marginBottom: 8 }}>
                <span>Each person pays</span>
                <span style={{ fontWeight: 800, fontSize: 24, color: '#1a1a2e' }}>£{splitAmount.toFixed(2)}</span>
              </div>
              {serviceChargeEnabled && serviceCharge > 0 && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  Includes service charge (£{(serviceCharge / splitCount).toFixed(2)} each)
                </div>
              )}
              {discountAmount > 0 && (
                <div style={{ fontSize: 12, color: '#22c55e', marginBottom: 4 }}>
                  Includes discount (-£{(discountAmount / splitCount).toFixed(2)} each)
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#888', marginTop: 8 }}>
                <span>Paid so far</span>
                <span>{paidCount} of {splitCount} people</span>
              </div>
              {paidCount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#22c55e', marginTop: 8, fontWeight: 700 }}>
                  <span>Remaining</span>
                  <span>£{remainingEqual.toFixed(2)}</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {Array.from({ length: splitCount }, (_, i) => {
                const isPaid = splitPaid.includes(i);
                return (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '14px 18px', borderRadius: 12,
                    background: isPaid ? '#f0fdf4' : 'white',
                    border: `2px solid ${isPaid ? '#22c55e' : '#e0e0e0'}`
                  }}>
                    <div>
                      <div style={{ fontWeight: 700, color: isPaid ? '#22c55e' : '#1a1a2e' }}>
                        {isPaid ? '✅' : '👤'} Person {i + 1}
                      </div>
                      <div style={{ fontSize: 13, color: '#888' }}>£{splitAmount.toFixed(2)}</div>
                    </div>
                    {!isPaid ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => handleSplitEqualPayment(i)} style={{
                          padding: '10px 14px', borderRadius: 8, border: 'none',
                          background: '#1a1a2e', color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer'
                        }}>💵 Cash</button>
                        <button onClick={() => handleSplitEqualPayment(i)} style={{
                          padding: '10px 14px', borderRadius: 8, border: 'none',
                          background: '#C9A84C', color: 'white', fontWeight: 700, fontSize: 12, cursor: 'pointer'
                        }}>💳 Card</button>
                      </div>
                    ) : (
                      <div style={{ color: '#22c55e', fontWeight: 700 }}>Paid ✓</div>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={() => setStage('bill')} style={{
              width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
            }}>← Back to Bill</button>
          </div>
        )}

        {/* ─── SPLIT BY ITEM ─── */}
        {stage === 'split_items' && (
          <div style={{ padding: 28 }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1a1a2e' }}>🍽️ Split by Item</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>Assign each item to a person</div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 10 }}>How many people?</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[2,3,4,5,6,7,8].map(n => (
                  <button key={n} onClick={() => {
                    setSplitItemCount(n);
                    setItemAssignments({});
                    setSplitItemPaid([]);
                    setActivePerson(0);
                  }} style={{
                    padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 15,
                    background: splitItemCount === n ? '#1a1a2e' : '#f0f0f0',
                    color: splitItemCount === n ? 'white' : '#1a1a2e',
                  }}>{n}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 10 }}>Assigning to:</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Array.from({ length: splitItemCount }, (_, i) => (
                  <button key={i} onClick={() => setActivePerson(i)} style={{
                    padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 13,
                    background: activePerson === i ? personColors[i] : '#f0f0f0',
                    color: activePerson === i ? 'white' : '#555',
                    opacity: splitItemPaid.includes(i) ? 0.4 : 1
                  }}>
                    👤 Person {i + 1}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 10 }}>
                Tap items to assign to Person {activePerson + 1}:
                {unassignedItems.length > 0 && (
                  <span style={{ color: '#e94560', marginLeft: 8 }}>{unassignedItems.length} unassigned</span>
                )}
              </div>
              {billItems.map(item => {
                const assignedTo = itemAssignments[item.id];
                const isAssigned = assignedTo !== undefined;
                const assignedColor = isAssigned ? personColors[assignedTo] : null;
                const itemPrice = item.unit_price * item.quantity;
                const itemDiscount = item.discount_value > 0
                  ? item.discount_type === 'percent'
                    ? itemPrice * (item.discount_value / 100)
                    : Math.min(item.discount_value, itemPrice)
                  : 0;
                const itemTotal = itemPrice - itemDiscount;
                return (
                  <div key={item.id}
                    onClick={() => {
                      if (splitItemPaid.includes(assignedTo)) return;
                      setItemAssignments(prev => ({ ...prev, [item.id]: activePerson }));
                    }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '12px 16px', borderRadius: 10, marginBottom: 8,
                      border: `2px solid ${isAssigned ? assignedColor : '#e0e0e0'}`,
                      background: isAssigned ? `${assignedColor}15` : 'white',
                      cursor: 'pointer'
                    }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: '#1a1a2e' }}>
                        {item.quantity}× {item.name}
                      </div>
                      {item.notes && <div style={{ fontSize: 11, color: '#888' }}>{item.notes}</div>}
                      {item.discount_value > 0 && (
                        <div style={{ fontSize: 11, color: '#22c55e' }}>🏷️ -£{itemDiscount.toFixed(2)}</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontWeight: 700, color: '#1a1a2e' }}>£{itemTotal.toFixed(2)}</span>
                      {isAssigned ? (
                        <div style={{
                          background: assignedColor, color: 'white',
                          borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700
                        }}>P{assignedTo + 1}</div>
                      ) : (
                        <div style={{
                          background: personColors[activePerson], color: 'white',
                          borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700, opacity: 0.4
                        }}>P{activePerson + 1}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {allAssigned && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#555', marginBottom: 12 }}>💰 Payment Summary:</div>
                {Array.from({ length: splitItemCount }, (_, i) => {
                  const p = getPersonTotal(i);
                  const isPaid = splitItemPaid.includes(i);
                  if (p.items.length === 0) return null;
                  return (
                    <div key={i} style={{
                      borderRadius: 12, padding: 16, marginBottom: 10,
                      border: `2px solid ${isPaid ? '#22c55e' : personColors[i]}`,
                      background: isPaid ? '#f0fdf4' : `${personColors[i]}08`
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div style={{ fontWeight: 700, color: isPaid ? '#22c55e' : personColors[i], fontSize: 15 }}>
                          {isPaid ? '✅' : '👤'} Person {i + 1}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 18, color: '#1a1a2e' }}>£{p.total.toFixed(2)}</div>
                      </div>
                      {p.items.map(item => (
                        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555', marginBottom: 2 }}>
                          <span>{item.quantity}× {item.name}</span>
                          <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        </div>
                      ))}
                      <div style={{ borderTop: '1px dashed #ccc', marginTop: 8, paddingTop: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555', marginBottom: 3 }}>
                          <span>Subtotal</span><span>£{p.subtotal.toFixed(2)}</span>
                        </div>
                        {p.discount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#22c55e', marginBottom: 3 }}>
                            <span>Discount</span><span>-£{p.discount.toFixed(2)}</span>
                          </div>
                        )}
                        {serviceChargeEnabled && p.service > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555', marginBottom: 3 }}>
                            <span>Service ({settings.service_charge_percent || 12.5}%)</span>
                            <span>£{p.service.toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                      {!isPaid && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button onClick={() => handleSplitItemPayment(i)} style={{
                            flex: 1, padding: '10px', borderRadius: 8, border: 'none',
                            background: '#1a1a2e', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer'
                          }}>💵 Cash</button>
                          <button onClick={() => handleSplitItemPayment(i)} style={{
                            flex: 1, padding: '10px', borderRadius: 8, border: 'none',
                            background: personColors[i], color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer'
                          }}>💳 Card</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!allAssigned && billItems.length > 0 && (
              <div style={{ background: '#fff3cd', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#856404', fontWeight: 600 }}>
                ⚠️ Please assign all {unassignedItems.length} remaining item{unassignedItems.length > 1 ? 's' : ''} before paying
              </div>
            )}

            <button onClick={() => setStage('bill')} style={{
              width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
            }}>← Back to Bill</button>
          </div>
        )}

        {/* ─── METHOD SELECTION ─── */}
        {stage === 'method' && (
          <div style={{ padding: 32 }}>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Bill total</div>
              <div style={{ fontSize: 42, fontWeight: 800, color: '#1a1a2e' }}>£{billTotal.toFixed(2)}</div>
              {serviceChargeEnabled && serviceCharge > 0 && (
                <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
                  Incl. service charge £{serviceCharge.toFixed(2)}
                </div>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#555', marginBottom: 16, textAlign: 'center' }}>
              Select payment method
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
              {[
                { method: 'Cash', icon: '💵' },
                { method: 'Card', icon: '💳' },
                { method: 'Other', icon: '🔄' },
              ].map(({ method, icon }) => (
                <button key={method} onClick={() => {
                  setSelectedMethod(method);
                  setPaymentInput('');
                  setStage('amount');
                }} style={{
                  padding: '20px', borderRadius: 12, border: '2px solid #1a1a2e',
                  background: 'white', color: '#1a1a2e', fontSize: 20, fontWeight: 700, cursor: 'pointer'
                }}>
                  {icon} {method}
                </button>
              ))}
            </div>
            <button onClick={() => setStage('bill')} style={{
              width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
            }}>← Back to Bill</button>
          </div>
        )}

        {/* ─── AMOUNT + NUMPAD ─── */}
        {stage === 'amount' && (
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280, padding: 28, borderRight: '1px solid #eee' }}>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>Payment method</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {selectedMethod === 'Cash' ? '💵 Cash' : selectedMethod === 'Card' ? '💳 Card' : '🔄 Other'}
                </div>
              </div>

              <div style={{ background: '#f8f8f8', borderRadius: 12, padding: 16, marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, color: '#555', marginBottom: 10 }}>
                  <span>Bill total</span>
                  <span style={{ fontWeight: 700 }}>£{billTotal.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, color: '#555', marginBottom: 10 }}>
                  <span>Amount received</span>
                  <span style={{ fontWeight: 800, color: '#1a1a2e', fontSize: 18 }}>
                    £{amountPaid > 0 ? amountPaid.toFixed(2) : '—'}
                  </span>
                </div>
                {amountPaid >= billTotal && selectedMethod === 'Cash' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800, color: '#22c55e', borderTop: '2px solid #eee', paddingTop: 10, marginTop: 4 }}>
                    <span>💚 Change</span>
                    <span>£{change.toFixed(2)}</span>
                  </div>
                )}
                {amountPaid > billTotal && selectedMethod !== 'Cash' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800, color: '#8b5cf6', borderTop: '2px solid #eee', paddingTop: 10, marginTop: 4 }}>
                    <span>💜 Tip</span>
                    <span>£{actualTip.toFixed(2)}</span>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 10 }}>Quick amounts</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {[
                    billTotal,
                    Math.ceil(billTotal / 5) * 5,
                    Math.ceil(billTotal / 10) * 10,
                    Math.ceil(billTotal / 20) * 20,
                  ].filter((v, i, arr) => arr.indexOf(v) === i).map(amount => (
                    <button key={amount} onClick={() => setPaymentInput(amount.toFixed(2))} style={{
                      padding: '12px', borderRadius: 10,
                      border: `2px solid ${paymentInput === amount.toFixed(2) ? '#C9A84C' : '#1a1a2e'}`,
                      background: paymentInput === amount.toFixed(2) ? '#C9A84C' : 'white',
                      color: paymentInput === amount.toFixed(2) ? 'white' : '#1a1a2e',
                      fontWeight: 700, cursor: 'pointer', fontSize: 15
                    }}>
                      £{amount.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={handleConfirmPayment} disabled={amountPaid < billTotal} style={{
                width: '100%', padding: '18px', borderRadius: 12, border: 'none',
                background: amountPaid >= billTotal ? '#22c55e' : '#ddd',
                color: 'white', fontSize: 18, fontWeight: 800,
                cursor: amountPaid >= billTotal ? 'pointer' : 'not-allowed',
                marginBottom: 10
              }}>
                {amountPaid >= billTotal
                  ? selectedMethod === 'Cash'
                    ? `✓ Confirm — Give change £${change.toFixed(2)}`
                    : actualTip > 0
                      ? `✓ Confirm — Tip £${actualTip.toFixed(2)}`
                      : '✓ Confirm Payment'
                  : `Enter amount (min £${billTotal.toFixed(2)})`
                }
              </button>

              <button onClick={() => setStage('method')} style={{
                width: '100%', padding: '12px', borderRadius: 10, border: 'none',
                background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 14
              }}>← Back</button>
            </div>

            <div style={{ width: 280, padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ background: '#1a1a2e', borderRadius: 14, padding: '20px', textAlign: 'right', marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>Amount received</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: 'white', fontFamily: 'monospace' }}>
                  £{paymentInput || '0.00'}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {['7','8','9','4','5','6','1','2','3','.','0','⌫'].map(btn => (
                  <button key={btn} onClick={() => handleNumpad(btn)} style={{
                    height: 68, borderRadius: 12, border: 'none',
                    fontSize: 22, fontWeight: 700, cursor: 'pointer',
                    background: btn === '⌫' ? '#fee2e2' : '#f8f8f8',
                    color: btn === '⌫' ? '#ef4444' : '#1a1a2e',
                  }}>{btn}</button>
                ))}
              </div>
              <button onClick={() => handleNumpad('C')} style={{
                padding: '16px', borderRadius: 12, border: 'none',
                background: '#f0f0f0', color: '#555',
                fontSize: 16, fontWeight: 700, cursor: 'pointer'
              }}>Clear</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

const SERVER_URL = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host.startsWith('192.168.') || host.startsWith('10.'))
    return window.location.origin;
  return 'https://restaurant-epos-production.up.railway.app';
})();

export default function BillScreen() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [order, setOrder]           = useState(null);
  const [items, setItems]           = useState([]);
  const [settings, setSettings]     = useState({});
  const [stage, setStage]           = useState('bill');   // bill | method | cash | card | done
  const [cashInput, setCashInput]   = useState('');
  const [tip, setTip]               = useState(0);
  const [loading, setLoading]       = useState(true);
  const [paying, setPaying]         = useState(false);

  useEffect(() => { loadBill(); }, [id]);

  async function loadBill() {
    try {
      const [billRes, settingsRes] = await Promise.all([
        fetch(`${SERVER_URL}/api/orders/${id}/bill`).then(r => r.json()),
        fetch(`${SERVER_URL}/api/settings`).then(r => r.json()),
      ]);
      setOrder(billRes.order);
      setItems(billRes.order?.items || []);
      setSettings(settingsRes);
    } catch (err) {
      console.error('Load bill error:', err);
    } finally {
      setLoading(false);
    }
  }

  // ── Totals ───────────────────────────────────────────────────
  const subtotal = items
    .filter(i => !i.voided)
    .reduce((sum, i) => {
      let price = i.unit_price * i.quantity;
      if (i.discount_type === 'percent') price *= (1 - (i.discount_value || 0) / 100);
      if (i.discount_type === 'fixed')   price = Math.max(0, price - (i.discount_value || 0));
      return sum + price;
    }, 0);

  const serviceChargeEnabled = settings.service_charge_enabled !== 'false';
  const serviceRate          = parseFloat(settings.service_charge_rate || '12.5') / 100;

  let afterDiscount = subtotal;
  if (order?.discount_value) {
    if (order.discount_type === 'percent') afterDiscount *= (1 - order.discount_value / 100);
    if (order.discount_type === 'fixed')   afterDiscount = Math.max(0, afterDiscount - order.discount_value);
  }

  const [scEnabled, setScEnabled] = useState(true);
  const serviceCharge = scEnabled && serviceChargeEnabled ? afterDiscount * serviceRate : 0;
  const billTotal     = Math.round((afterDiscount + serviceCharge + tip) * 100) / 100;

  // ── Cash numpad ──────────────────────────────────────────────
  const cashAmount = parseFloat(cashInput) || 0;
  const change     = Math.round((cashAmount - billTotal) * 100) / 100;
  const canPay     = cashAmount >= billTotal && cashAmount > 0;

  function numPress(val) {
    setCashInput(prev => {
      if (val === '⌫') return prev.slice(0, -1);
      if (val === 'C') return '';
      if (val === '.' && prev.includes('.')) return prev;
      // Limit to 2 decimal places
      if (prev.includes('.')) {
        const decimals = prev.split('.')[1];
        if (decimals && decimals.length >= 2) return prev;
      }
      return prev + val;
    });
  }

  function quickAmount(amount) {
    setCashInput(amount.toFixed(2));
  }

  // ── Pay ──────────────────────────────────────────────────────
  async function confirmPay(method) {
    setPaying(true);
    try {
      await fetch(`${SERVER_URL}/api/orders/${id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: billTotal, method }),
      });
      setStage('done');
    } catch (err) {
      alert('Payment failed — try again');
    } finally {
      setPaying(false);
    }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontSize: 18, color: '#888' }}>
      Loading bill…
    </div>
  );

  if (!order) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
      Order not found. <button onClick={() => navigate('/tables')}>Back to Tables</button>
    </div>
  );

  // ── DONE ─────────────────────────────────────────────────────
  if (stage === 'done') return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f0fff4', gap: 16 }}>
      <div style={{ fontSize: 72 }}>✅</div>
      <h1 style={{ fontSize: 28, color: '#1a472a', margin: 0 }}>Payment Complete!</h1>
      <p style={{ color: '#555', fontSize: 18 }}>Table {order.table_number} — Order #{order.id}</p>
      <p style={{ color: '#888', fontSize: 16 }}>£{billTotal.toFixed(2)} received</p>
      {change > 0 && (
        <div style={{ background: '#1a472a', color: 'white', borderRadius: 12, padding: '14px 32px', fontSize: 20, fontWeight: 'bold' }}>
          💚 Give change: £{change.toFixed(2)}
        </div>
      )}
      <button onClick={() => navigate('/tables')} style={{
        marginTop: 20, background: '#1a472a', color: 'white',
        border: 'none', borderRadius: 10, padding: '14px 36px',
        fontSize: 18, fontWeight: 'bold', cursor: 'pointer',
      }}>
        Back to Tables
      </button>
    </div>
  );

  // ── CASH PAYMENT ─────────────────────────────────────────────
  if (stage === 'cash') return (
    <div style={{ display: 'flex', height: '100vh', background: '#f5f5f5', fontFamily: 'Arial, sans-serif' }}>

      {/* Left panel */}
      <div style={{ flex: 1, padding: 32, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16, maxWidth: 480 }}>
        <div style={{ fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>Payment method</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>💵 Cash</div>

        <div style={{ background: 'white', borderRadius: 14, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 15, color: '#555' }}>
            <span>Bill total</span>
            <span style={{ fontWeight: 600 }}>£{billTotal.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 15, color: '#555' }}>
            <span>Amount received</span>
            <span style={{ fontWeight: 700, fontSize: 17, color: '#1a1a2e' }}>
              {cashInput ? `£${parseFloat(cashInput).toFixed(2)}` : '—'}
            </span>
          </div>
          {canPay && (
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid #eee', fontSize: 16, fontWeight: 700, color: change > 0 ? '#1a472a' : '#555' }}>
              <span>💚 Change</span>
              <span>£{change.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Quick amounts */}
        <div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>Quick amounts</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => quickAmount(billTotal)}
              style={{
                flex: 1, padding: '14px', borderRadius: 10, border: '2px solid',
                borderColor: cashAmount === billTotal ? '#1a472a' : '#ddd',
                background: cashAmount === billTotal ? '#1a472a' : 'white',
                color: cashAmount === billTotal ? 'white' : '#333',
                fontWeight: 700, fontSize: 15, cursor: 'pointer',
              }}
            >
              £{billTotal.toFixed(2)}
            </button>
            {[Math.ceil(billTotal / 5) * 5, Math.ceil(billTotal / 10) * 10].filter((v, i, a) => v !== billTotal && a.indexOf(v) === i).slice(0, 2).map(amt => (
              <button
                key={amt}
                onClick={() => quickAmount(amt)}
                style={{
                  flex: 1, padding: '14px', borderRadius: 10, border: '2px solid',
                  borderColor: cashAmount === amt ? '#1a472a' : '#ddd',
                  background: cashAmount === amt ? '#1a472a' : 'white',
                  color: cashAmount === amt ? 'white' : '#333',
                  fontWeight: 700, fontSize: 15, cursor: 'pointer',
                }}
              >
                £{amt.toFixed(2)}
              </button>
            ))}
          </div>
        </div>

        {/* Confirm button */}
        <button
          onClick={() => canPay && confirmPay('Cash')}
          disabled={!canPay || paying}
          style={{
            padding: '16px', borderRadius: 12, border: 'none',
            background: canPay ? '#22c55e' : '#e0e0e0',
            color: canPay ? 'white' : '#aaa',
            fontWeight: 800, fontSize: 17,
            cursor: canPay ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s',
          }}
        >
          {paying
            ? 'Processing…'
            : canPay
              ? change > 0
                ? `✓ Confirm — Give change £${change.toFixed(2)}`
                : '✓ Confirm Payment'
              : `Enter amount (min £${billTotal.toFixed(2)})`
          }
        </button>

        <button onClick={() => setStage('method')} style={{
          padding: '12px', borderRadius: 10, border: '1px solid #ddd',
          background: 'white', cursor: 'pointer', fontWeight: 600, color: '#555', fontSize: 14,
        }}>
          ← Back
        </button>
      </div>

      {/* Right panel — numpad */}
      <div style={{ width: 280, background: 'white', padding: 24, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center', boxShadow: '-2px 0 12px rgba(0,0,0,0.06)' }}>
        {/* Display */}
        <div style={{ background: '#1a1a2e', borderRadius: 12, padding: '18px 20px', textAlign: 'right', marginBottom: 8 }}>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>Amount received</div>
          <div style={{ color: 'white', fontSize: 28, fontWeight: 800 }}>
            £{cashInput || '0'}
          </div>
        </div>

        {/* Number grid */}
        {[['7','8','9'],['4','5','6'],['1','2','3'],['.','0','⌫']].map((row, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {row.map(key => (
              <button key={key} onClick={() => numPress(key)} style={{
                padding: '18px 0', borderRadius: 10, border: '1px solid #eee',
                background: key === '⌫' ? '#fee2e2' : '#f8f8f8',
                color: key === '⌫' ? '#dc2626' : '#1a1a2e',
                fontWeight: 700, fontSize: 18, cursor: 'pointer',
                transition: 'background 0.1s',
              }}>
                {key}
              </button>
            ))}
          </div>
        ))}

        <button onClick={() => numPress('C')} style={{
          padding: '14px', borderRadius: 10, border: '1px solid #eee',
          background: '#f0f0f0', color: '#555', fontWeight: 700,
          fontSize: 15, cursor: 'pointer',
        }}>
          Clear
        </button>
      </div>
    </div>
  );

  // ── PAYMENT METHOD ────────────────────────────────────────────
  if (stage === 'method') return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f5f5f5', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ background: 'white', borderRadius: 20, padding: 40, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 22, color: '#1a1a2e' }}>Select Payment Method</h2>
        <p style={{ color: '#888', margin: '0 0 28px', fontSize: 15 }}>Total: <strong style={{ color: '#1a1a2e' }}>£{billTotal.toFixed(2)}</strong></p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button onClick={() => { setCashInput(''); setStage('cash'); }} style={{
            padding: '20px', borderRadius: 12, border: '2px solid #e5e7eb',
            background: 'white', cursor: 'pointer', fontWeight: 700,
            fontSize: 18, color: '#1a1a2e', display: 'flex', alignItems: 'center',
            gap: 12, transition: 'all 0.15s',
          }}
            onMouseOver={e => e.currentTarget.style.borderColor = '#1a472a'}
            onMouseOut={e => e.currentTarget.style.borderColor = '#e5e7eb'}
          >
            <span style={{ fontSize: 28 }}>💵</span> Cash
          </button>

          <button onClick={() => confirmPay('Card')} disabled={paying} style={{
            padding: '20px', borderRadius: 12, border: '2px solid #e5e7eb',
            background: 'white', cursor: 'pointer', fontWeight: 700,
            fontSize: 18, color: '#1a1a2e', display: 'flex', alignItems: 'center',
            gap: 12, transition: 'all 0.15s',
          }}
            onMouseOver={e => e.currentTarget.style.borderColor = '#1a472a'}
            onMouseOut={e => e.currentTarget.style.borderColor = '#e5e7eb'}
          >
            <span style={{ fontSize: 28 }}>💳</span> Card
          </button>

          <button onClick={() => { setCashInput(''); setStage('cash'); }} style={{
            padding: '20px', borderRadius: 12, border: '2px solid #e5e7eb',
            background: 'white', cursor: 'pointer', fontWeight: 700,
            fontSize: 18, color: '#1a1a2e', display: 'flex', alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontSize: 28 }}>🔀</span> Split Bill
          </button>
        </div>

        <button onClick={() => setStage('bill')} style={{
          width: '100%', marginTop: 16, padding: '12px', borderRadius: 10,
          border: '1px solid #ddd', background: 'white', cursor: 'pointer',
          fontWeight: 600, color: '#555', fontSize: 14,
        }}>
          ← Back to Bill
        </button>
      </div>
    </div>
  );

  // ── BILL VIEW ─────────────────────────────────────────────────
  const courses = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRA' };
  const grouped = {};
  items.filter(i => !i.voided).forEach(i => {
    const c = i.course || 1;
    if (!grouped[c]) grouped[c] = [];
    grouped[c].push(i);
  });

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Arial, sans-serif', background: '#f5f5f5' }}>

      {/* Left — Bill detail */}
      <div style={{ flex: 1, padding: 32, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <button onClick={() => navigate(-1)} style={{
            background: '#1a1a2e', color: 'white', border: 'none',
            borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
          }}>← Back</button>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>
              Table {order.table_number} — Order #{order.id}
            </h1>
            <p style={{ margin: 0, color: '#888', fontSize: 14 }}>{order.covers} cover{order.covers > 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* Items by course */}
        {Object.keys(grouped).sort().map(course => (
          <div key={course} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#e94560', letterSpacing: 1.5, marginBottom: 8 }}>
              ● {courses[course] || 'ITEMS'}
            </div>
            {grouped[course].map(item => {
              let linePrice = item.unit_price * item.quantity;
              if (item.discount_type === 'percent') linePrice *= (1 - (item.discount_value || 0) / 100);
              if (item.discount_type === 'fixed')   linePrice = Math.max(0, linePrice - (item.discount_value || 0));
              return (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      {item.quantity}× {item.item_name || item.name || 'Unknown item'}
                    </span>
                    {item.item_note && <div style={{ fontSize: 12, color: '#888' }}>📝 {item.item_note}</div>}
                    {item.discount_value > 0 && (
                      <div style={{ fontSize: 11, color: '#e94560' }}>
                        Disc: {item.discount_type === 'percent' ? `${item.discount_value}%` : `£${item.discount_value}`}
                      </div>
                    )}
                  </div>
                  <span style={{ fontWeight: 700, color: '#1a1a2e' }}>£{linePrice.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        ))}

        {/* Totals */}
        <div style={{ background: 'white', borderRadius: 12, padding: 20, marginTop: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14, color: '#555' }}>
            <span>Subtotal</span>
            <span>£{subtotal.toFixed(2)}</span>
          </div>
          {order.discount_value > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14, color: '#e94560' }}>
              <span>Discount ({order.discount_type === 'percent' ? `${order.discount_value}%` : `£${order.discount_value}`})</span>
              <span>-£{(subtotal - afterDiscount).toFixed(2)}</span>
            </div>
          )}
          {serviceChargeEnabled && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: 14, color: '#555' }}>
              <span>
                Service ({settings.service_charge_rate || 12.5}%)
                <button
                  onClick={() => setScEnabled(v => !v)}
                  style={{
                    marginLeft: 8, padding: '2px 8px', borderRadius: 4, border: 'none',
                    background: scEnabled ? '#fee2e2' : '#d1fae5',
                    color: scEnabled ? '#dc2626' : '#065f46',
                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {scEnabled ? 'Remove' : 'Add'}
                </button>
              </span>
              <span>£{serviceCharge.toFixed(2)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: '2px solid #1a1a2e', fontWeight: 800, fontSize: 20, color: '#1a1a2e' }}>
            <span>Total</span>
            <span>£{billTotal.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Right — Pay button */}
      <div style={{ width: 280, background: 'white', padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', boxShadow: '-2px 0 12px rgba(0,0,0,0.06)' }}>
        <div style={{ background: '#f8f8f8', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'center' }}>
          <div style={{ color: '#888', fontSize: 13 }}>Total due</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: '#1a1a2e' }}>£{billTotal.toFixed(2)}</div>
        </div>
        <button
          onClick={() => setStage('method')}
          style={{
            padding: '18px', borderRadius: 12, border: 'none',
            background: '#e94560', color: 'white',
            fontWeight: 800, fontSize: 17, cursor: 'pointer',
          }}
        >
          View Bill & Pay — £{billTotal.toFixed(2)}
        </button>
      </div>
    </div>
  );
}