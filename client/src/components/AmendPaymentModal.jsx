// SEPOS-PAY-AMEND-001 — admin modal to change a closed bill's payment
// method. Reachable from Admin → Bills → 🔄 Change method per row.
//
// Defended client-side by requiring a method pick + PIN + (optional)
// reason; the backend re-validates the PIN against staff with role
// admin / manager / supervisor, blocks voucher amendments, and writes
// an immutable payment_amendments audit row before flipping the
// payments.method column.

import { useState } from 'react';
import { amendBillMethod } from '../api';
import { dineTableLabel } from '../utils/orderLabel';

const METHODS = [
  { value: 'Cash',   label: '💵 Cash' },
  { value: 'Card',   label: '💳 Card' },
  { value: 'Other',  label: '🔄 Other' },
  { value: 'Stripe', label: '🌐 Stripe' },
];

export default function AmendPaymentModal({ bill, onClose, onDone }) {
  const currentMethod = bill?.method || '';
  const [newMethod, setNewMethod] = useState('');
  const [reason, setReason]       = useState('');
  const [pin, setPin]             = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const handleSave = async () => {
    if (!newMethod) { setError('Pick the new method'); return; }
    if (newMethod === currentMethod) { setError('That is already the method on this bill'); return; }
    if (!pin)       { setError('Manager PIN required'); return; }
    setSaving(true); setError('');
    try {
      const r = await amendBillMethod(bill.id, {
        new_method: newMethod,
        reason:     reason.trim(),
        pin:        pin.trim(),
      });
      if (r?.error) { setError(r.error); setSaving(false); return; }
      onDone?.({ from: r.from_method, to: r.to_method, by: r.amended_by });
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:'rgba(0,0,0,0.6)', zIndex:9000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'white', borderRadius:14, maxWidth:480, width:'100%', overflow:'hidden' }}>
        <div style={{ background:'var(--brand-primary,#0D1B3E)', color:'white', padding:'16px 20px' }}>
          <div style={{ fontSize:18, fontWeight:800 }}>🔄 Change Payment Method</div>
          {/* Korakot 2026-06-02: identify by Table + date, not Bill # —
              "i dont need bill number, as we can check it on daily and
              table number as the reference". */}
          <div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', marginTop:2 }}>
            {dineTableLabel(bill)} · {bill.closed_at ? new Date(bill.closed_at).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'} · £{Number(bill.paid_amount || bill.total || 0).toFixed(2)}
          </div>
        </div>

        <div style={{ padding:'18px 20px' }}>
          <div style={{ background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:13 }}>
            <span style={{ color:'#888' }}>Currently:</span>{' '}
            <strong style={{ color:'var(--brand-primary, #1a1a2e)' }}>{currentMethod}</strong>
          </div>

          <div style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>Change to</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:16 }}>
            {METHODS.filter(m => m.value !== currentMethod).map(m => (
              <button key={m.value}
                onClick={() => setNewMethod(m.value)}
                style={{
                  padding:'10px 14px', borderRadius:8, border: newMethod === m.value ? '2px solid var(--brand-primary,#0D1B3E)' : '1px solid #ddd',
                  background: newMethod === m.value ? 'var(--brand-primary,#0D1B3E)' : 'white',
                  color: newMethod === m.value ? 'white' : 'var(--brand-primary, #1a1a2e)',
                  fontWeight:700, fontSize:14, cursor:'pointer',
                }}>
                {m.label}
              </button>
            ))}
          </div>

          <label style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, display:'block', marginBottom:6 }}>
            Reason <span style={{ fontWeight:400, color:'#bbb', textTransform:'none' }}>(optional)</span>
          </label>
          <input value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. cashier picked Cash by mistake"
            style={{ width:'100%', padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:14, boxSizing:'border-box', marginBottom:14 }} />

          <label style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, display:'block', marginBottom:6 }}>
            Manager PIN
          </label>
          <input value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            type="password" inputMode="numeric" maxLength={8} autoFocus
            placeholder="••••"
            style={{ width:160, padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:18, letterSpacing:4, fontFamily:'Menlo,Consolas,monospace', textAlign:'center' }} />

          {error && (
            <div style={{ background:'#fee2e2', color:'#991b1b', padding:'10px 12px', borderRadius:8, fontSize:13, marginTop:12 }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        <div style={{ padding:'12px 20px 18px', display:'flex', gap:10, borderTop:'1px solid #f0f0f0' }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex:1, padding:12, borderRadius:8, border:'none', background:'#f0f0f0', fontWeight:700, fontSize:14, cursor:'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !newMethod || !pin}
            style={{ flex:2, padding:12, borderRadius:8, border:'none', background:'var(--brand-primary,#0D1B3E)', color:'white', fontWeight:800, fontSize:14, cursor:'pointer', opacity: (saving || !newMethod || !pin) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save change'}
          </button>
        </div>
      </div>
    </div>
  );
}
