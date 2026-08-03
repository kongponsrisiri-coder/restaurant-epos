import { useState, useEffect, useRef } from 'react';
import { loginStaff, clockToggle, emailLogin, storePinSession, getStaff, getRestaurant, getSettings, changeStaffPin } from '../api';
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

// SEPOS-BRAND-001 — per-client login/header logo size (Admin → Settings →
// "App logo size"). Maps each preset to desktop/mobile pixel heights.
const LOGO_PX = {
  small:  { desktop: 150, mobile: 56 },
  medium: { desktop: 200, mobile: 74 },
  large:  { desktop: 250, mobile: 90 },
  xl:     { desktop: 330, mobile: 116 },
};

// SEPOS-BRAND-001 — show the client's uploaded brand logo if set, else the
// default lotus mark. (This is the on-screen logo, separate from the receipt
// logo — it can be light/colour since it never gets thermal-printed.)
function BrandMark({ size = 120, logo }) {
  if (logo) return <img src={logo} alt="" style={{ height: size, maxWidth: Math.min(size * 2.4, 440), objectFit: 'contain', display: 'block' }} />;
  return <Lotus size={size} />;
}

// Gold ring spinner for the cold-start loading state. Self-contained (keyframes
// travel with it) so it can be dropped anywhere without a global stylesheet.
function Spinner({ size = 30 }) {
  return (
    <>
      <style>{`@keyframes sepos-spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{ display: 'inline-block', width: size, height: size, border: `3px solid ${GOLD_TINT}`, borderTopColor: GOLD, borderRadius: '50%', animation: 'sepos-spin 0.8s linear infinite' }} />
    </>
  );
}

const initials = (name) => String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const isManagerRole = (role) => role === 'admin' || role === 'manager';

export default function LoginScreen({ onLogin }) {
  const [pin, setPin]         = useState('');
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  // True from mount until the first data-load either succeeds or exhausts its
  // retries — so a cold-starting desktop till shows "Loading…" instead of the
  // alarming "Staff list unavailable / no restaurant" flash. Web resolves on
  // the first try, so this is visible only for the ~1s the local server boots.
  const [booting, setBooting] = useState(true);
  const [mode, setMode]         = useState('pin');   // 'pin' | 'email'
  // SEPOS-CLOCK-002 — "clock mode": tap Clock in/out FIRST, then enter your
  // code. (The old flow — type PIN then tap Clock — was unreachable because a
  // 4-digit PIN auto-logs-in.) In clock mode the same numpad clocks you in or
  // out (server toggles based on your last event) and returns to the login
  // screen without entering the till.
  const [clockMode, setClockMode] = useState(false);
  const [clockDone, setClockDone] = useState(null);  // { name, kind: 'in'|'out', time }
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [staffList, setStaffList]         = useState([]);
  const [selectedStaff, setSelectedStaff] = useState(null);
  // SEPOS-SEC-LOGIN — forced PIN change off the default 1234.
  const [mustChange, setMustChange] = useState(false);
  const [pendingStaff, setPendingStaff] = useState(null);
  const [np1, setNp1] = useState('');
  const [np2, setNp2] = useState('');
  const [changeErr, setChangeErr] = useState('');
  const [restaurantName, setRestaurantName] = useState('');
  const [brandLogo, setBrandLogo] = useState(''); // SEPOS-BRAND-001
  const [logoSize, setLogoSize] = useState('large'); // SEPOS-BRAND-001 — app logo size preset
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
    let cancelled = false;
    let attempts = 0;
    const load = async () => {
      const [list, r, settings] = await Promise.all([
        getStaff().catch(() => null),
        getRestaurant().catch(() => null),
        getSettings().catch(() => null),
      ]);
      if (cancelled) return;
      // Cold-start race — on the desktop the LOCAL server can still be booting
      // when the login first renders, so all three calls fail and the page
      // sticks on an empty restaurant name + no staff ("no restaurant id").
      // Retry (0.8s apart, up to ~10s) until the server answers, then populate.
      // Web: the server is always up so this succeeds on the first try.
      if (!list && !r && !settings && attempts < 12) { attempts++; setTimeout(load, 800); return; }
      setBooting(false); // server answered (or we've exhausted retries) — stop showing the loader
      if (Array.isArray(list)) setStaffList(list.filter(s => s.is_active !== 0));
      const generic = (n) => !n || /^siamepos$/i.test(String(n).trim());
      // Name priority — the OWNER-EDITABLE name wins over the onboarding
      // `restaurants.name` "tag" (company_name first, matching receipts/reports);
      // `restaurant_id` is the last-resort label.
      const name = (settings && !generic(settings.company_name) && settings.company_name)
        || (settings && !generic(settings.restaurant_name) && settings.restaurant_name)
        || (r && r.name)
        || (r && r.restaurant_id) || '';
      setRestaurantName(String(name || '').trim());
      if (settings && settings.brand_logo) setBrandLogo(settings.brand_logo); // SEPOS-BRAND-001
      if (settings && settings.brand_logo_size) setLogoSize(settings.brand_logo_size); // SEPOS-BRAND-001
    };
    load();
    return () => { cancelled = true; };
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
        // SEPOS-SEC-LOGIN — an operator still on a weak/default PIN must set a
        // real one before the till opens (the public default can't persist).
        if (staff.must_change_pin) { setPendingStaff(staff); setMustChange(true); setPin(''); setLoading(false); return; }
        onLogin(staff);
      }
    } catch {
      setError('Connection error. Check your network.'); setPin('');
    } finally { setLoading(false); }
  }

  // SEPOS-SEC-LOGIN — submit the mandatory new PIN, then enter the till.
  async function submitNewPin() {
    setChangeErr('');
    if (!/^\d{4,6}$/.test(np1)) { setChangeErr('PIN must be 4–6 digits'); return; }
    if (np1 !== np2) { setChangeErr('The two PINs don’t match'); return; }
    setLoading(true);
    try {
      const r = await changeStaffPin(np1);
      if (r && r.error) { setChangeErr(r.error); return; }
      onLogin(pendingStaff);
    } catch { setChangeErr('Could not set PIN — check your connection'); }
    finally { setLoading(false); }
  }

  // SEPOS-CLOCK-002 — one code entry clocks you IN or OUT automatically
  // (the server records the opposite of your last event).
  async function handleClockToggle(pinToUse) {
    const p = pinToUse ?? pin;
    if (!p) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const r = await clockToggle(p);
      if (r?.error || !r?.name) {
        setError(r?.error || 'Clock action failed.'); setPin('');
      } else {
        const t = new Date(r.event_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        setPin('');
        setClockDone({ name: r.name, kind: r.event_type, time: t });
        // auto-return to the login screen after the confirmation
        setTimeout(() => { setClockDone(null); setClockMode(false); }, 3500);
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
    // 4-digit PINs auto-submit (✓ key for longer). In clock mode the same
    // entry clocks in/out instead of signing in (SEPOS-CLOCK-002).
    if (next.length === 4) (clockMode ? handleClockToggle(next) : handleLogin(next));
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
      <BrandMark size={(LOGO_PX[logoSize] || LOGO_PX.large).mobile} logo={brandLogo} />
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
      <BrandMark size={(LOGO_PX[logoSize] || LOGO_PX.large).desktop} logo={brandLogo} />
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
  if (mustChange) {
    // SEPOS-SEC-LOGIN — mandatory PIN change after signing in with the default.
    panelContent = (
      <div style={{ maxWidth: 340, margin: '0 auto', width: '100%', textAlign: 'center' }}>
        <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: INK }}>Set your PIN</div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 8, marginBottom: 20, lineHeight: 1.5 }}>
          You’re on the default PIN. Choose a private 4–6 digit PIN before you continue.
        </div>
        <input type="password" inputMode="numeric" autoFocus maxLength={6} value={np1}
          onChange={e => setNp1(e.target.value.replace(/\D/g, ''))} placeholder="New PIN"
          style={{ ...inputStyle, textAlign: 'center', letterSpacing: 6 }} />
        <input type="password" inputMode="numeric" maxLength={6} value={np2}
          onChange={e => setNp2(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && submitNewPin()}
          placeholder="Confirm PIN" style={{ ...inputStyle, textAlign: 'center', letterSpacing: 6, marginTop: 12 }} />
        {changeErr && <div style={{ color: RED || '#b3261e', fontSize: 13, marginTop: 12 }}>{changeErr}</div>}
        <button onClick={submitNewPin} disabled={loading || !np1 || !np2} style={{ ...primaryBtn, marginTop: 18 }}>
          {loading ? 'Saving…' : 'Set PIN & continue'}
        </button>
      </div>
    );
  } else if (mode === 'email') {
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
  } else if (clockMode) {
    // SEPOS-CLOCK-002 — clock in/out mode: same numpad, different job.
    panelContent = (
      <div style={{ display: 'flex', gap: isMobile ? 20 : 48, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
        {/* identity panel — clock themed */}
        <div style={{ width: isMobile ? '100%' : 240, maxWidth: 280 }}>
          <button onClick={() => { setClockMode(false); setPin(''); setError(''); }} style={linkBtn}>‹ Back to sign in</button>
          <div style={{ width: 84, height: 84, borderRadius: '50%', marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: NAVY, fontSize: 38 }}>🕐</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: INK, marginTop: 14 }}>Clock in / out</div>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
            Enter your code — you'll be clocked in or out automatically. You won't be signed in to the till.
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
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
          <button onClick={() => handleClockToggle()} disabled={loading || !pin}
            style={{ ...(isMobile ? mobileNumKey : numKey), background: GREEN, color: '#fff', opacity: (loading || !pin) ? 0.5 : 1 }}>✓</button>
        </div>
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
          booting ? (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 15, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '28px 0' }}>
              <Spinner />
              <div>Loading your restaurant…</div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 14 }}>
              Staff list unavailable — <button onClick={() => setSelectedStaff({ name: 'Staff', role: '' })} style={{ ...linkBtn, display: 'inline' }}>enter PIN directly ›</button>
            </div>
          )
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

  // SEPOS-CLOCK-002 — one "Clock in / out" entry point on every PIN-side view
  // (tap it FIRST, then enter your code). Hidden while already in clock mode.
  const enterClockMode = () => { setClockMode(true); setSelectedStaff(null); setPin(''); setError(''); setSuccess(''); };
  const footer = mode === 'email' ? null : clockMode ? null : (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: selectedStaff ? 26 : 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <button onClick={enterClockMode} disabled={loading} style={{ ...outlineBtn, color: GREEN, borderColor: '#BFE6D2' }}>🕐 Clock in / out</button>
      <button onClick={() => { setMode('email'); setError(''); }} style={linkBtn}>Sign in with email →</button>
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

      {/* SEPOS-EXIT-001 — clean Exit, desktop only. Staff sometimes force-quit +
          re-open when something looks stuck, which used to spawn a second
          instance fighting over the same local DB. A visible, confirmed Exit on
          the login screen gives them the safe way out. Web / tablet PWA never
          exposes window.siamepos, so this button simply isn't rendered there. */}
      {typeof window !== 'undefined' && window.siamepos?.isElectron && window.siamepos?.quitApp && (
        <button
          onClick={() => {
            if (window.confirm('Close SiamEPOS?\n\nThe till will shut down. You can re-open it any time from the desktop icon.')) {
              try { window.siamepos.quitApp(); } catch { /* no-op */ }
            }
          }}
          style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 2500,
            background: 'rgba(255,255,255,0.10)', color: '#fff', border: '1px solid rgba(255,255,255,0.28)',
            borderRadius: 10, padding: '10px 16px', fontSize: 14, fontWeight: 700, fontFamily: UI_FONT,
            cursor: 'pointer', backdropFilter: 'blur(2px)' }}
        >⏻ Exit</button>
      )}

      {/* SEPOS-CLOCK-002 — big clock confirmation; auto-dismisses, tap to skip */}
      {clockDone && (
        <div onClick={() => { setClockDone(null); setClockMode(false); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3200, padding: 16, cursor: 'pointer' }}>
          <div style={{ background: '#fff', borderRadius: 22, padding: '38px 44px', textAlign: 'center', maxWidth: '92vw', fontFamily: UI_FONT }}>
            <div style={{ fontSize: 56, lineHeight: 1 }}>{clockDone.kind === 'in' ? '✅' : '👋'}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)', marginTop: 14 }}>{clockDone.name}</div>
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 8, color: clockDone.kind === 'in' ? GREEN : MUTED }}>
              {clockDone.kind === 'in' ? `Clocked IN at ${clockDone.time}` : `Clocked OUT at ${clockDone.time}`}
            </div>
            <div style={{ fontSize: 13.5, color: MUTED, marginTop: 10 }}>
              {clockDone.kind === 'in' ? 'Have a great shift!' : 'See you next time!'}
            </div>
          </div>
        </div>
      )}

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
