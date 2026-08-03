import { useState } from 'react';
import { openSession } from '../api';

// SEPOS-OPENDAY-001 — first-login-of-the-day prompt to OPEN a trading session,
// so today's sales land in a Z report instead of an orphaned NULL session. Shown
// by App.jsx only when the server confirms there is no open session (fail-open:
// any error → no modal, never brick a live floor). A subtle "Skip for now" lets
// staff dismiss it for the current login if they must. Mirrors DeleteOrderModal's
// overlay; no backdrop-click-to-close so a stray floor tap can't dismiss it.
export default function OpenDayModal({ staff, onOpened, onSkip }) {
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = async () => {
    setBusy(true); setErr('');
    try {
      const r = await openSession(staff?.id ?? null, parseFloat(float) || 0);
      // Treat BOTH the 200 success {session,success} AND the 409 duplicate-guard
      // {error,session} (another terminal opened it first) as "opened".
      if (r && r.session) { onOpened?.(); return; }
      setErr((r && r.error) || 'Could not open the day. Please try again.');
    } catch {
      setErr('Could not reach the till server. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,0.55)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100002 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 420, width: '100%',
        boxSizing: 'border-box', boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        fontFamily: "'Archivo', system-ui, -apple-system, sans-serif", color: 'var(--brand-primary, #0D1B3E)' }}>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>☀️ Open the day</div>
        <div style={{ fontSize: 14, color: '#555', lineHeight: 1.6, marginBottom: 18 }}>
          Start a new trading session so today’s sales land in the Z report.
          Enter the opening cash float in the till.
        </div>

        <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          Opening cash float
        </label>
        <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #D9D4C7', borderRadius: 10,
          padding: '0 14px', marginBottom: err ? 8 : 20 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#888', marginRight: 8 }}>£</span>
          <input
            type="number" step="0.01" inputMode="decimal" placeholder="0.00"
            value={float} onChange={(e) => setFloat(e.target.value)}
            autoFocus
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 24, fontWeight: 700,
              padding: '14px 0', background: 'transparent', color: 'var(--brand-primary, #0D1B3E)' }}
          />
        </div>
        {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>{err}</div>}

        <button onClick={open} disabled={busy}
          style={{ width: '100%', border: 'none', borderRadius: 12, padding: '15px 0',
            fontSize: 17, fontWeight: 800, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
            background: 'var(--brand-accent, #C9A84C)', color: 'var(--brand-primary, #0D1B3E)' }}>
          {busy ? 'Opening…' : 'Open Day'}
        </button>

        <button onClick={() => onSkip?.()} disabled={busy}
          style={{ width: '100%', marginTop: 10, background: 'none', border: 'none',
            color: '#888', fontSize: 14, cursor: 'pointer', padding: '6px 0' }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
