import { useState, useEffect, useRef } from 'react';
import { loginStaff, clockIn, clockOut, emailLogin, storePinSession, getStaff, getRestaurant, getSettings } from '../api';
import { resetDevice, currentTillTarget, canSwitchClient } from '../utils/deviceReset';
import { NAVY, GOLD, RED, GREEN } from '../theme'; // SEPOS-BRAND-001 — per-client brand colours

// SiamEPOS — LoginScreen (redesign per design_handoff_siamepos).
// Split layout: left navy brand panel, right inset Paper panel with the staff
// grid → PIN pad. Brand colours (NAVY/GOLD) come from the per-client theme.
const PAPER = '#F4F1EA', INK = 'var(--brand-primary, #1a1a2e)', MUTED = '#7C766A';
const GOLD_TINT = '#FBF4DF', GOLD_ON_LIGHT = '#9A7B1F', CARD_BORDER = '#E7E2D6';
const UI_FONT = "'Archivo', system-ui, -apple-system, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function Lotus({ size = 120 }) {
  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size, display: 'block' }} aria-label="SiamEPOS logo">
      <circle cx="50" cy="50" r="45" fill="none" stroke={GOLD} strokeWidth="1.8" />
      <circle cx="50" cy="50" r="39" fill="none" stroke={GOLD} strokeWidth="0.6" opacity="0.28" />
      <g transform="translate(50,50)">
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#D8C078" opacity="0.9" transform="rotate(72)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.7" transform="rotate(144)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#D8C078" opacity="0.7" transform="rotate(216)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.85" transform="rotate(288)" />
        <circle cx="0" cy="0" r="9" fill={NAVY} />
        <circle cx="0" cy="0" r="5" fill={GOLD} />
      </g>
    </svg>
  );
}

// SEPOS-BRAND-001 — show the client's uploaded brand logo if set, else the
// default lotus mark. (This is the on-screen logo, separate from the receipt
// logo — it can be light/colour since it never gets thermal-printed.)
function BrandMark({ size = 120, logo }) {
  if (logo) return <img src={logo} alt="" style={{ height: size, maxWidth: size * 2.4, objectFit: 'contain', display: 'block' }} />;
  return <Lotus size={size} />;
}

const initials = (name) => String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const isManagerRole = (role) => role === 'admin' || role === 'manager';

export default function LoginScreen({ onLogin }) {
  const [pin, setPin]         = useState('');
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode]         = useState('pin');   // 'pin' | 'email'
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [staffList, setStaffList]         = useState([]);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [restaurantName, setRestaurantName] = useState('');
  const [brandLogo, setBrandLogo] = useState(''); // SEPOS-BRAND-001
  const [now, setNow] = useState(() => new Date());
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  // SEPOS-RESET-001 — hidden trigger on the top-left corner opens the
  // "reset this till for a new client" dialog. No visible control. Two ways
  // in: long-press ~5s (touch tills), or 5 quick clicks (easier with a mouse
  // on PC/Mac). Both are deliberate, and the dialog still asks to confirm.
  const [showReset, setShowReset] = useState(false);
  const holdTimer = useRef(null);
  const clickCount = useRef(0);
  const lastClick = useRef(0);
  const startHold = () => { holdTimer.current = setTimeout(() => setShowReset(true), 5000); };
  const cancelHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const onHotspotClick = () => {
    const t = Date.now();
    clickCount.current = (t - lastClick.current > 1200) ? 1 : clickCount.current + 1;
    lastClick.current = t;
    if (clickCount.current >= 5) { clickCount.current = 0; setShowReset(true); }
  };

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  useEffect(() => {
    getStaff()
      .then(list => setStaffList(Array.isArray(list) ? list.filter(s => s.is_active !== 0) : []))
      .catch(() => setStaffList([]));
    Promise.all([getRestaurant().catch(() => null), getSettings().catch(() => null)])
      .then(([r, settings]) => {
        const generic = (n) => !n || /^siamepos$/i.test(String(n).trim());
        // Name priority: restaurants.name → settings.restaurant_name →
        // settings.company_name (the owner-editable "Restaurant Name" field in
        // Admin → Settings) → restaurant_id slug as a last resort. company_name
        // is included so a new tenant whose DB name is still null can set its
        // display name in-app without a DB edit.
        const name = (r && r.name)
          || (settings && !generic(settings.restaurant_name) && settings.restaurant_name)
          || (settings && !generic(settings.company_name) && settings.company_name)
          || (r && r.restaurant_id) || '';
        setRestaurantName(String(name || '').trim());
        if (settings && settings.brand_logo) setBrandLogo(settings.brand_logo); // SEPOS-BRAND-001
      })
      .catch(() => {});
  }, []);

  async function handleLogin(pinToUse) {
    const p = pinToUse ?? pin;
    if (!p) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const staff = await loginStaff(p);
      if (staff?.error || !staff?.id) {
        setError('Incorrect PIN. Please try again.'); setPin('');
      } else if (selectedStaff && staff.id !== selectedStaff.id) {
        setError(`That PIN isn't ${selectedStaff.name}'s. Check your name and PIN.`); setPin('');
      } else {
        storePinSession(staff);
        onLogin(staff);
      }
    } catch {
      setError('Connection error. Check your network.'); setPin('');
    } finally { setLoading(false); }
  }

  async function handleClock(kind) {
    if (!pin) { setError('Enter your PIN first.'); return; }
    setLoading(true); setError(''); setSuccess('');
    try {
      const r = await (kind === 'in' ? clockIn(pin) : clockOut(pin));
      if (r?.error || !r?.name) {
        setError(r?.error || 'Clock action failed.'); setPin('');
      } else {
        const t = new Date(r.event_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        setSuccess(`✓ ${r.name} clocked ${kind.toUpperCase()} at ${t}`); setPin('');
        setTimeout(() => setSuccess(''), 4000);
      }
    } catch {
      setError('Connection error. Check your network.'); setPin('');
    } finally { setLoading(false); }
  }

  async function handleEmailLogin() {
    if (!email || !password) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const r = await emailLogin(email.trim(), password);
      if (r?.error || !r?.token || !r?.staff) {
        setError(r?.error || 'Invalid email or password.');
      } else {
        try { localStorage.setItem('siamepos_auth', JSON.stringify({ token: r.token, staff: r.staff, expires_at: r.expires_at })); } catch {}
        onLogin(r.staff);
      }
    } catch {
      setError('Connection error. Check your network.');
    } finally { setLoading(false); }
  }

  function pressDigit(d) {
    if (loading) return;
    setError(''); setSuccess('');
    const next = pin + d;
    setPin(next);
    if (next.length === 4) handleLogin(next);   // 4-digit PINs auto-submit (✓ key for longer)
  }
  function pressDelete() { setPin(p => p.slice(0, -1)); setError(''); }

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // ── shared bits ────────────────────────────────────────────────────────────
  const clock = (
    <div style={{ position: 'absolute', top: 26, right: 30, textAlign: 'right' }}>
      <div style={{ color: GOLD, fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: 24, lineHeight: 1 }}>{time}</div>
      <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>{date}</div>
    </div>
  );

  const msg = (error || success) && (
    <div style={{
      marginTop: 16, padding: '10px 14px', borderRadius: 10, fontSize: 14, fontWeight: 600, textAlign: 'center',
      background: error ? '#FCE8EC' : '#E7F6EE', color: error ? RED : GREEN,
      border: `1px solid ${error ? '#F5C6CF' : '#BFE6D2'}`,
    }}>{error || success}</div>
  );

  // ── left brand panel ───────────────────────────────────────────────────────
  // Mobile: compact full-width header strip above the login panel.
  const brandPanel = isMobile ? (
    <div style={{ width: '100%', flexShrink: 0, position: 'relative', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14, overflow: 'hidden' }}>
      <BrandMark size={60} logo={brandLogo} />
      <div style={{ minWidth: 0 }}>
        {/* Restaurant name is the headline; SiamEPOS sits under it as the platform credit. */}
        <div style={{ fontFamily: SERIF, fontSize: 24, color: '#fff', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1.05, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{restaurantName || 'SiamEPOS'}</div>
        <div style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, marginTop: 3 }}>
          <span style={{ color: 'rgba(255,255,255,0.55)' }}>Powered by </span>
          <span style={{ color: '#fff' }}>Siam</span><span style={{ color: GOLD }}>EPOS</span>
        </div>
      </div>
    </div>
  ) : (
    <div style={{ width: 600, flexShrink: 0, position: 'relative', padding: '0 64px', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', right: -60, bottom: -40, opacity: 0.05, pointerEvents: 'none' }}><Lotus size={420} /></div>
      <BrandMark size={168} logo={brandLogo} />
      {/* Restaurant name is the hero wordmark; wordBreak so a long name wraps rather than overflow. */}
      <div style={{ fontFamily: SERIF, fontSize: 60, color: '#fff', fontWeight: 700, letterSpacing: '-1.5px', lineHeight: 1.05, marginTop: 28, wordBreak: 'break-word' }}>{restaurantName || 'SiamEPOS'}</div>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Point of sale</div>
      <div style={{ width: 64, height: 3, background: GOLD, borderRadius: 2, margin: '22px 0' }} />
      {/* Our platform credit, under the client's name. */}
      <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 5, fontWeight: 600 }}>Powered by</div>
      <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>
        <span style={{ color: '#fff' }}>Siam</span><span style={{ color: GOLD }}>EPOS</span>
      </div>
    </div>
  );

  // ── right content (staff grid / PIN / email) ───────────────────────────────
  let panelContent;
  if (mode === 'email') {
    panelContent = (
      <div style={{ maxWidth: 380, margin: '0 auto', width: '100%' }}>
        <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: INK }}>Owner sign in</div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 22 }}>Sign in with your email and password.</div>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
          style={inputStyle} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleEmailLogin()} style={{ ...inputStyle, marginTop: 12 }} />
        <button onClick={handleEmailLogin} disabled={loading}
          style={{ ...primaryBtn, marginTop: 18 }}>{loading ? 'Signing in…' : 'Sign in'}</button>
        {msg}
        <button onClick={() => { setMode('pin'); setError(''); }} style={linkBtn}>‹ Back to staff PIN</button>
      </div>
    );
  } else if (selectedStaff) {
    const mgr = isManagerRole(selectedStaff.role);
    panelContent = (
      <div style={{ display: 'flex', gap: isMobile ? 20 : 48, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
        {/* identity */}
        <div style={{ width: isMobile ? '100%' : 240, maxWidth: 280 }}>
          <button onClick={() => { setSelectedStaff(null); setPin(''); setError(''); }} style={linkBtn}>‹ Back to staff</button>
          <div style={{ width: 84, height: 84, borderRadius: '50%', marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: mgr ? NAVY : GOLD_TINT, color: mgr ? GOLD : GOLD_ON_LIGHT, fontWeight: 800, fontSize: 30 }}>
            {initials(selectedStaff.name)}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: INK, marginTop: 14 }}>{selectedStaff.name}</div>
          <div style={{ color: MUTED, fontSize: 13, textTransform: 'capitalize' }}>{selectedStaff.role}</div>
          <div style={{ color: MUTED, fontSize: 14, marginTop: 22, fontWeight: 600 }}>Enter your PIN</div>
          <div style={{ display: 'flex', gap: 14, marginTop: 12 }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{ width: 16, height: 16, borderRadius: '50%',
                background: i < pin.length ? GOLD : 'transparent', border: i < pin.length ? `2px solid ${GOLD}` : '2px solid #C9C2B2' }} />
            ))}
          </div>
        </div>
        {/* numpad */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(3, 96px)', gap: 12, width: isMobile ? '100%' : undefined, maxWidth: isMobile ? 320 : undefined }}>
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} onClick={() => pressDigit(d)} style={isMobile ? mobileNumKey : numKey}>{d}</button>
          ))}
          <button onClick={pressDelete} style={{ ...(isMobile ? mobileNumKey : numKey), background: '#EFEAE0', fontSize: 22 }}>⌫</button>
          <button onClick={() => pressDigit('0')} style={isMobile ? mobileNumKey : numKey}>0</button>
          <button onClick={() => handleLogin()} disabled={loading || !pin}
            style={{ ...(isMobile ? mobileNumKey : numKey), background: GREEN, color: '#fff', opacity: (loading || !pin) ? 0.5 : 1 }}>✓</button>
        </div>
      </div>
    );
  } else {
    const sorted = [...staffList];
    panelContent = (
      <div style={{ width: '100%' }}>
        <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: INK, textAlign: 'center' }}>Welcome back</div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 24, textAlign: 'center' }}>Tap your name to sign in</div>
        {sorted.length === 0 ? (
          <div style={{ textAlign: 'center', color: MUTED, fontSize: 14 }}>
            Staff list unavailable — <button onClick={() => setSelectedStaff({ name: 'Staff', role: '' })} style={{ ...linkBtn, display: 'inline' }}>enter PIN directly ›</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 14, maxHeight: 420, overflowY: 'auto', padding: 2 }}>
            {sorted.map(s => {
              const mgr = isManagerRole(s.role);
              return (
                <button key={s.id} onClick={() => { setSelectedStaff(s); setPin(''); setError(''); }}
                  style={{ background: '#fff', border: `1px solid ${CARD_BORDER}`, borderRadius: 14, padding: '18px 12px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer',
                    boxShadow: '0 1px 2px rgba(13,27,62,.05)' }}>
                  <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: mgr ? NAVY : GOLD_TINT, color: mgr ? GOLD : GOLD_ON_LIGHT, fontWeight: 800, fontSize: 20 }}>
                    {initials(s.name)}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, textAlign: 'center', lineHeight: 1.2 }}>{s.name}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase',
                    color: GOLD_ON_LIGHT, background: GOLD_TINT, borderRadius: 20, padding: '3px 10px' }}>{s.role}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // PIN-view footer (clock in/out) vs staff-view footer (email link)
  const footer = mode === 'email' ? null : selectedStaff ? (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 26, alignItems: 'center', flexWrap: 'wrap' }}>
      <button onClick={() => handleClock('in')} disabled={loading} style={{ ...outlineBtn, color: GREEN, borderColor: '#BFE6D2' }}>🕐 Clock In</button>
      <button onClick={() => handleClock('out')} disabled={loading} style={{ ...outlineBtn, color: MUTED, borderColor: CARD_BORDER }}>Clock Out</button>
      <button onClick={() => { setMode('email'); setError(''); }} style={linkBtn}>Sign in with email →</button>
    </div>
  ) : (
    <div style={{ textAlign: 'center', marginTop: 22 }}>
      <button onClick={() => { setMode('email'); setError(''); }} style={linkBtn}>Sign in with email instead →</button>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: isMobile ? 'column' : 'row', background: NAVY, fontFamily: UI_FONT, color: '#fff' }}>
      {brandPanel}
      <div style={{ flex: 1, padding: isMobile ? '0 12px 16px' : 28, display: 'flex', minWidth: 0 }}>
        <div style={{ position: 'relative', flex: 1, background: PAPER, borderRadius: isMobile ? 18 : 24, padding: isMobile ? '24px 16px' : 40,
          boxShadow: '0 20px 50px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflowY: 'auto' }}>
          {/* SEPOS-RESET-001 — invisible long-press hotspot (top-left) → reset dialog */}
          <div
            onPointerDown={startHold} onPointerUp={cancelHold}
            onPointerLeave={cancelHold} onPointerCancel={cancelHold}
            onClick={onHotspotClick}
            aria-hidden="true"
            style={{ position: 'absolute', top: 0, left: 0, width: 60, height: 60, zIndex: 5 }}
          />
          {!isMobile && clock}
          <div style={{ width: '100%', maxWidth: 760, margin: '0 auto' }}>
            {panelContent}
            {mode !== 'email' && msg}
            {footer}
          </div>
        </div>
      </div>

      {/* SEPOS-RESET-001 — reset-for-new-client confirm dialog */}
      {showReset && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000, padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 18, padding: '26px 24px', width: 400, maxWidth: '92vw', color: 'var(--brand-primary, #1a1a2e)', fontFamily: UI_FONT }}>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 10 }}>🔄 Reset this till?</div>
            <div style={{ fontSize: 14, color: '#555', lineHeight: 1.6, marginBottom: 8 }}>
              {canSwitchClient()
                ? <>This disconnects the till from<br /><b style={{ wordBreak: 'break-all' }}>{currentTillTarget()}</b><br />and returns it to first-time setup, ready for a new client.</>
                : <>This logs the till out. A browser till is fixed to its web address, so it can’t be pointed at a different client from here.</>}
            </div>
            <div style={{ fontSize: 12.5, color: '#16a34a', fontWeight: 600, marginBottom: 20 }}>✓ Nothing is lost — all data is saved on the cloud.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowReset(false)} style={{ flex: 1, padding: '13px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => resetDevice()} style={{ flex: 1, padding: '13px', borderRadius: 12, border: 'none', background: RED, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>{canSwitchClient() ? 'Reset till' : 'Log out'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const numKey = {
  width: 96, height: 74, borderRadius: 16, border: 'none', background: '#fff', color: 'var(--brand-primary, #1a1a2e)',
  fontSize: 26, fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 2px rgba(13,27,62,.06)',
  fontVariantNumeric: 'tabular-nums',
};
const mobileNumKey = {
  width: '100%', height: 64, borderRadius: 16, border: 'none', background: '#fff', color: 'var(--brand-primary, #1a1a2e)',
  fontSize: 24, fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 2px rgba(13,27,62,.06)',
  fontVariantNumeric: 'tabular-nums',
};
const inputStyle = {
  width: '100%', padding: '14px 16px', borderRadius: 12, border: `1px solid ${CARD_BORDER}`,
  fontSize: 16, background: '#fff', color: 'var(--brand-primary, #1a1a2e)', boxSizing: 'border-box',
};
const primaryBtn = {
  width: '100%', padding: '15px', borderRadius: 12, border: 'none', background: RED, color: '#fff',
  fontWeight: 700, fontSize: 16, cursor: 'pointer', boxShadow: '0 8px 18px rgba(233,69,96,.28)',
};
const outlineBtn = {
  padding: '11px 18px', borderRadius: 12, border: '1.5px solid', background: 'transparent',
  fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const linkBtn = {
  background: 'none', border: 'none', color: GOLD_ON_LIGHT, fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: 6,
};
