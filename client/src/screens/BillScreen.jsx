import { useState, useEffect } from 'react';
import { getBill, markBillPrinted } from '../api';

export default function BillScreen({ orderId, onClose, onPay }) {
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paymentInput, setPaymentInput] = useState('');
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [stage, setStage] = useState('bill');

  useEffect(() => {
  getBill(orderId).then(data => {
    setBill(data);
    setLoading(false);
    markBillPrinted(orderId);
  });
}, [orderId]);

  if (loading) return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ color: 'white', fontSize: 18 }}>Loading bill...</div>
    </div>
  );

  if (!bill || !bill.order) return null;

  const { order, settings } = bill;
  const subtotal = order.items?.reduce((sum, i) => sum + i.unit_price * i.quantity, 0) || 0;
  const discountAmount = order.discount_value > 0
    ? order.discount_type === 'percent' ? subtotal * (order.discount_value / 100) : order.discount_value
    : 0;
  const afterDiscount = subtotal - discountAmount;
  const serviceCharge = settings.service_charge_enabled === '1'
    ? afterDiscount * (parseFloat(settings.service_charge_percent || 12.5) / 100)
    : 0;
  const billTotal = afterDiscount + serviceCharge;
  const amountPaid = parseFloat(paymentInput) || 0;
  const change = amountPaid - billTotal;
  const actualTip = selectedMethod !== 'Cash' ? Math.max(0, amountPaid - billTotal) : 0;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

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

  const overlay = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999, padding: 16
  };

  const card = {
    background: 'white', borderRadius: 20,
    width: '100%',
    maxWidth: stage === 'amount' ? 820 : 420,
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
                {order.items?.map(item => (
                  <div key={item.id} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                      <span>{item.quantity}× {item.name}</span>
                      <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                    </div>
                    {item.notes && <div style={{ fontSize: 11, color: '#888', marginLeft: 16 }}>{item.notes}</div>}
                    {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>}
                  </div>
                ))}
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
                {serviceCharge > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6, color: '#555' }}>
                    <span>Service charge ({settings.service_charge_percent}%)</span>
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
                background: '#e94560', color: 'white', fontSize: 20, fontWeight: 800, cursor: 'pointer'
              }}>
                💳 Take Payment — £{billTotal.toFixed(2)}
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

        {/* ─── METHOD SELECTION ─── */}
        {stage === 'method' && (
          <div style={{ padding: 32 }}>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Bill total</div>
              <div style={{ fontSize: 42, fontWeight: 800, color: '#1a1a2e' }}>£{billTotal.toFixed(2)}</div>
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
            }}>
              ← Back to Bill
            </button>
          </div>
        )}

        {/* ─── AMOUNT + NUMPAD ─── */}
        {stage === 'amount' && (
          <div style={{ display: 'flex' }}>

            {/* Left */}
            <div style={{ flex: 1, padding: 28, borderRight: '1px solid #eee' }}>
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

              {/* Quick amounts */}
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
                      border: `2px solid ${paymentInput === amount.toFixed(2) ? '#e94560' : '#1a1a2e'}`,
                      background: paymentInput === amount.toFixed(2) ? '#e94560' : 'white',
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
              }}>
                ← Back
              </button>
            </div>

            {/* Right — numpad */}
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
                  }}>
                    {btn}
                  </button>
                ))}
              </div>

              <button onClick={() => handleNumpad('C')} style={{
                padding: '16px', borderRadius: 12, border: 'none',
                background: '#f0f0f0', color: '#555',
                fontSize: 16, fontWeight: 700, cursor: 'pointer'
              }}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}