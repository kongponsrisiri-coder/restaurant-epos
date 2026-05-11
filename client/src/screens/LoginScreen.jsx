import { useState } from 'react';
import { loginStaff, clockIn, clockOut } from '../api';

// ── Sandy: LoginScreen — SiamEPOS Brand CI v1.1 ───────────────────
// Deep Navy #0D1B3E background · Thai Gold #C9A84C lotus logo
// Georgia serif wordmark · Action Red #e94560 login button

export default function LoginScreen({ onLogin }) {
  const [pin, setPin]         = useState('');
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(pinToUse) {
    const p = pinToUse ?? pin;
    if (!p) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const staff = await loginStaff(p);
      if (staff?.error || !staff?.id) {
        setError('Incorrect PIN. Please try again.');
        setPin('');
      } else {
        onLogin(staff);
      }
    } catch {
      setError('Connection error. Check your network.');
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  // SEPOS-022 — clock in/out. PIN identifies the staff member; we
  // don't log them into the POS, just record the event.
  async function handleClock(kind) {
    if (!pin) { setError('Enter your PIN first.'); return; }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const r = await (kind === 'in' ? clockIn(pin) : clockOut(pin));
      if (r?.error || !r?.name) {
        setError(r?.error || 'Clock action failed.');
        setPin('');
      } else {
        const t = new Date(r.event_at).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
        setSuccess(`✓ ${r.name} clocked ${kind.toUpperCase()} at ${t}`);
        setPin('');
        setTimeout(() => setSuccess(''), 4000);
      }
    } catch {
      setError('Connection error. Check your network.');
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  function pressDigit(d) {
    if (loading) return;
    setError('');
    setSuccess('');
    const next = pin + d;
    setPin(next);
    // Auto-submit at 6 digits — most PINs are 4-6 digits
    // Staff can also press the Login button for shorter PINs
    if (next.length === 6) {
      handleLogin(next);
    }
  }

  function pressDelete() {
    setPin(p => p.slice(0, -1));
    setError('');
  }

  // Numpad layout: 1-9, blank, 0, ⌫
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0D1B3E',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: 20,
    }}>

      {/* ── Lotus badge + wordmark ─────────────────────────────── */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <svg
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
          style={{ width: 80, height: 80, display: 'block', margin: '0 auto 18px' }}
          aria-label="SiamEPOS logo"
        >
          <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8"/>
          <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" strokeWidth="0.6" opacity="0.28"/>
          <g transform="translate(50,50)">
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
            <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
            <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
          </g>
        </svg>

        <div style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 38, fontWeight: 700, letterSpacing: '-1px', lineHeight: 1,
        }}>
          <span style={{ color: 'white' }}>Siam</span>
          <span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>

        <div style={{ color: 'rgba(201,168,76,0.55)', fontSize: 12, marginTop: 6, letterSpacing: '0.15em', textTransform: 'uppercase' }}>
          Staff Login
        </div>
      </div>

      {/* ── PIN card ───────────────────────────────────────────── */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(201,168,76,0.2)',
        borderRadius: 20,
        padding: '28px 28px 24px',
        width: '100%',
        maxWidth: 320,
      }}>

        {/* PIN dots / placeholder */}
        <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
          {pin.length === 0 ? (
            <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 14, letterSpacing: '0.05em' }}>
              Enter your PIN
            </span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <div key={i} style={{ width: 13, height: 13, borderRadius: '50%', background: '#C9A84C' }} />
            ))
          )}
        </div>

        {/* Error / success message */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.14)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5',
            borderRadius: 8, padding: '9px 14px',
            fontSize: 13, textAlign: 'center', marginBottom: 16, fontWeight: 500,
          }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{
            background: 'rgba(34,197,94,0.16)',
            border: '1px solid rgba(34,197,94,0.4)',
            color: '#86efac',
            borderRadius: 8, padding: '9px 14px',
            fontSize: 13, textAlign: 'center', marginBottom: 16, fontWeight: 600,
          }}>
            {success}
          </div>
        )}

        {/* Numpad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
          {keys.map((k, i) => {
            if (k === '') return <div key={i} />;
            const isDel = k === '⌫';
            return (
              <button
                key={i}
                onClick={() => isDel ? pressDelete() : pressDigit(k)}
                disabled={loading}
                style={{
                  height: 58, borderRadius: 12, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                  background: isDel ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.07)',
                  color: isDel ? '#fca5a5' : 'white',
                  fontSize: isDel ? 20 : 22, fontWeight: 700,
                  transition: 'background 0.1s, transform 0.07s',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
                onMouseDown={e => { if (!loading) e.currentTarget.style.transform = 'scale(0.94)'; }}
                onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {/* Login button */}
        <button
          onClick={() => handleLogin()}
          disabled={loading || pin.length === 0}
          style={{
            width: '100%', height: 52, borderRadius: 12, border: 'none',
            background: loading        ? 'rgba(255,255,255,0.1)'
                      : pin.length > 0 ? '#e94560'
                      : 'rgba(255,255,255,0.07)',
            color: pin.length > 0 && !loading ? 'white' : 'rgba(255,255,255,0.3)',
            fontSize: 16, fontWeight: 800,
            cursor: pin.length > 0 && !loading ? 'pointer' : 'default',
            transition: 'background 0.15s',
            letterSpacing: '0.03em',
          }}
        >
          {loading ? 'Checking…' : 'Log In'}
        </button>

        {/* SEPOS-022 — clock in/out (no app login, just records the event) */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            onClick={() => handleClock('in')}
            disabled={loading || pin.length === 0}
            style={{
              flex: 1, height: 42, borderRadius: 10, border: '1px solid rgba(201,168,76,0.3)',
              background: 'transparent', color: pin.length > 0 ? '#C9A84C' : 'rgba(201,168,76,0.35)',
              fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
              cursor: pin.length > 0 && !loading ? 'pointer' : 'default',
            }}
          >🕐 Clock In</button>
          <button
            onClick={() => handleClock('out')}
            disabled={loading || pin.length === 0}
            style={{
              flex: 1, height: 42, borderRadius: 10, border: '1px solid rgba(201,168,76,0.3)',
              background: 'transparent', color: pin.length > 0 ? '#C9A84C' : 'rgba(201,168,76,0.35)',
              fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
              cursor: pin.length > 0 && !loading ? 'pointer' : 'default',
            }}
          >Clock Out 🕔</button>
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 36, color: 'rgba(201,168,76,0.3)', fontSize: 12, textAlign: 'center', letterSpacing: '0.05em' }}>
        siamepos.co.uk
      </div>
    </div>
  );
}