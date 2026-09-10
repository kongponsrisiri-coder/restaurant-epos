// SEPOS-REPRINT-TABLE-001 (Korakot, 29 Aug) — re-print a closed bill straight
// from the floor screen. "The bill reprint function, can you put it on the
// table screen" — staff kept walking a manager to Admin → Bills for a simple
// "can I have the receipt again?". Design: a 🖨 Bills button on the floor's
// top bar opens TODAY's closed bills (newest first, dine-in + takeaway); one
// tap prints through the exact pipeline Admin → Bills uses.
import { useEffect, useState } from 'react';
import { getBills, getBillItems, getSettings } from '../api';
import { printReceipt } from '../screens/ReceiptPrinter';
import { dineTableLabel } from '../utils/orderLabel';

export default function ReprintBillsModal({ onClose }) {
  const [bills, setBills]       = useState(null);   // null = loading
  const [settings, setSettings] = useState({});
  const [busyId, setBusyId]     = useState(null);
  const [toast, setToast]       = useState('');

  useEffect(() => {
    const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
    getBills(today, today, 'all')
      .then((d) => setBills(Array.isArray(d) ? d : []))
      .catch(() => setBills([]));
    getSettings().then((s) => setSettings(s || {})).catch(() => {});
  }, []);

  // Same maths + payload as Admin → Bills' doReprintReceipt, so the paper is
  // identical whichever door staff come through.
  const doPrint = async (bill) => {
    if (busyId) return;
    setBusyId(bill.id);
    try {
      const items = await getBillItems(bill.id);
      if (!Array.isArray(items) || !items.length) { alert('Could not load this bill’s items — try Admin → Bills.'); return; }
      const subtotal      = Number(bill.total || 0);
      const paid          = Number(bill.paid_amount || bill.total || 0);
      const serviceCharge = Math.max(0, paid - subtotal);
      const discountAmount = bill.discount_value > 0
        ? (bill.discount_type === 'percent' ? subtotal * (bill.discount_value / 100) : Number(bill.discount_value))
        : 0;
      printReceipt({
        order: bill, items, settings,
        paymentDetails: {
          subtotal, discountAmount, serviceCharge,
          billTotal: paid, amountPaid: paid, change: 0,
          method: bill.method || '', tip: 0,
          tenders: Array.isArray(bill.tenders) ? bill.tenders : [],
        },
      });
      setToast(`🖨 Printing ${dineTableLabel(bill)} — £${paid.toFixed(2)}`);
      setTimeout(() => setToast(''), 2500);
    } catch (e) {
      alert(`Could not re-print: ${e?.message || 'please try again'}`);
    } finally { setBusyId(null); }
  };

  const fmtTime = (dt) => dt ? new Date(dt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--brand-primary, #1a1a2e)' }}>🖨 Re-print a bill — today</div>
          <button onClick={onClose} style={{ border: 'none', background: '#f0f0f0', borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: 'pointer', fontWeight: 700 }}>✕</button>
        </div>
        {toast && <div style={{ background: '#e3f2e6', color: '#256b34', fontWeight: 700, fontSize: 13.5, padding: '9px 20px' }}>{toast}</div>}
        <div style={{ overflowY: 'auto', padding: '6px 12px 14px' }}>
          {bills === null && <div style={{ textAlign: 'center', color: '#888', padding: 30 }}>Loading today’s bills…</div>}
          {bills !== null && !bills.length && <div style={{ textAlign: 'center', color: '#888', padding: 30 }}>No closed bills yet today.</div>}
          {(bills || []).map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 8px', borderBottom: '1px solid #f2f0ea' }}>
              <div style={{ width: 52, fontWeight: 700, color: '#555', fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(b.closed_at)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--brand-primary, #1a1a2e)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {dineTableLabel(b)}{b.customer_name ? ` · ${b.customer_name}` : ''}
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>{b.method || '—'}{b.covers ? ` · ${b.covers} covers` : ''}</div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 14.5, fontVariantNumeric: 'tabular-nums' }}>£{Number(b.paid_amount || b.total || 0).toFixed(2)}</div>
              <button onClick={() => doPrint(b)} disabled={busyId === b.id}
                style={{ border: 'none', borderRadius: 10, padding: '10px 14px', fontWeight: 800, fontSize: 13.5, cursor: 'pointer', background: busyId === b.id ? '#eee' : 'var(--brand-primary, #1a1a2e)', color: busyId === b.id ? '#999' : 'white' }}>
                {busyId === b.id ? '…' : '🖨 Print'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
