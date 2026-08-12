// SEPOS-AMOUNT-PAD-001 — every money box carries its OWN tap numpad.
//
// Why: the on-screen keyboard deliberately skips numeric fields ("they have
// their own pads") but the amount boxes (mixed payment, deposit, voucher)
// never had one — on a touch till they were simply untypeable, which is why
// Korakot ended up buying a physical keyboard (12 Aug). Tapping the box now
// opens the same ATM/penny-style numpad staff already know from the cash
// screen; a physical keyboard still types on top (digits = penny entry,
// a typed "." switches to literal decimal so both habits work).

import { useState } from 'react';

const fmtDigits = (d) => (d ? (parseInt(d, 10) / 100).toFixed(2) : '');

export default function AmountInput({ value, onChange, placeholder, style, autoFocus }) {
  const [pad, setPad] = useState(null); // digit buffer while the pad is open; null = closed

  const openPad = () => setPad(String(value || '').replace(/\D/g, '').replace(/^0+/, ''));
  const tapKey = (k) => setPad((p) => {
    let d = p || '';
    if (k === 'back') d = d.slice(0, -1);
    else d = (d + k);
    return d.replace(/^0+/, '').slice(0, 7);
  });
  const done = () => { onChange(fmtDigits(pad)); setPad(null); };

  // Physical keyboard path — penny entry, unless a "." makes it literal.
  const typed = (raw) => {
    if (raw.includes('.')) {
      const m = String(raw).replace(/[^\d.]/g, '').match(/^(\d{0,5})(?:\.(\d{0,2}))?/);
      onChange(m ? `${m[1] || '0'}.${m[2] ?? ''}` : '');
    } else {
      onChange(fmtDigits(String(raw).replace(/\D/g, '').slice(0, 7)));
    }
  };

  const keyStyle = { flex: 1, height: 54, borderRadius: 10, border: '1px solid #ddd', background: '#fff', fontSize: 20, fontWeight: 800, cursor: 'pointer', color: '#1a1a2e' };
  return (
    <>
      <input type="text" inputMode="none" value={value} autoFocus={autoFocus}
        onChange={(e) => typed(e.target.value)} onFocus={openPad}
        placeholder={placeholder} style={style} />
      {pad !== null && (
        <div onClick={done} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 18, width: 300, maxWidth: '90vw', boxShadow: '0 16px 50px rgba(0,0,0,.3)' }}>
            <div style={{ textAlign: 'center', fontSize: 32, fontWeight: 900, marginBottom: 12, color: '#1a1a2e', fontVariantNumeric: 'tabular-nums' }}>£{fmtDigits(pad) || '0.00'}</div>
            {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['00', '0', 'back']].map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {row.map((k) => (
                  <button key={k} onClick={() => tapKey(k)} style={keyStyle}>{k === 'back' ? '⌫' : k}</button>
                ))}
              </div>
            ))}
            <button onClick={done} style={{ width: '100%', height: 54, borderRadius: 10, border: 'none', background: '#22c55e', color: '#fff', fontSize: 18, fontWeight: 800, cursor: 'pointer' }}>✓ Done</button>
          </div>
        </div>
      )}
    </>
  );
}
