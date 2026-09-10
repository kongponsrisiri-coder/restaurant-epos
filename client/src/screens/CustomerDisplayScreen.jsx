// SEPOS-CFD-001 — Customer-Facing Display.
// Runs on the second (customer-facing) screen: open <till-url>/#display in a
// browser on the POS's second monitor, or on a separate tablet. It POLLS the
// server relay (/api/cfd/state) which the cashier's till PUSHES to, and shows
// either idle branding or the live order + running total. Big type, read from
// across the counter. No inputs, no PII — display only.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { getCfdState } from '../api';
import { NAVY, GOLD } from '../theme';

const SERIF = "Georgia, 'Times New Roman', serif";
const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;

function Lotus({ size = 150 }) {
  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size }} aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" stroke={GOLD} strokeWidth="1.5" opacity="0.9" />
      <g transform="translate(50,50)">
        {[0, 72, 144, 216, 288].map((r, i) => (
          <path key={r} d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD}
            opacity={i % 2 ? 0.7 : 0.92} transform={`rotate(${r})`} />
        ))}
        <circle cx="0" cy="0" r="9" fill={NAVY} /><circle cx="0" cy="0" r="5" fill={GOLD} />
      </g>
    </svg>
  );
}

export default function CustomerDisplayScreen() {
  const station = (String(window.location.hash).match(/station=([\w-]+)/) || [])[1] || 'main';
  const [state, setState] = useState({ mode: 'idle' });
  const [qrImg, setQrImg] = useState('');
  const seenRef = useRef(new Set());

  // Poll the relay. 1.2s feels live without hammering the server.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const s = await getCfdState(station); if (alive && s) setState(s); } catch { /* keep last */ }
    };
    tick();
    const iv = setInterval(tick, 1200);
    return () => { alive = false; clearInterval(iv); };
  }, [station]);

  // Render the idle QR (menu / review link) only when the link changes.
  useEffect(() => {
    const url = state.mode === 'idle' && state.qr && state.qr.url;
    if (!url) { setQrImg(''); return; }
    QRCode.toDataURL(url, { width: 340, margin: 1, color: { dark: '#0D1B3E', light: '#ffffff' } })
      .then(setQrImg).catch(() => setQrImg(''));
  }, [state.mode, state.qr && state.qr.url]);

  const name = state.restaurant_name || 'SiamEPOS';
  // SEPOS-CFD-002 — the display wears the RESTAURANT's colours when the state
  // carries them (server injects settings.brand_primary/brand_accent); the
  // SiamEPOS navy/gold stays as the fallback for unbranded installs.
  const navy = (typeof state.brand_primary === 'string' && state.brand_primary) || NAVY;
  const gold = (typeof state.brand_accent === 'string' && state.brand_accent) || GOLD;
  const wrap = { position: 'fixed', inset: 0, background: navy, color: '#fff', fontFamily: SERIF, overflow: 'hidden' };

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (state.mode !== 'order') {
    return (
      <div style={{ ...wrap, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 30 }}>
        {state.logo
          ? <img src={state.logo} alt="" style={{ maxWidth: '46vw', maxHeight: '34vh', objectFit: 'contain' }} />
          : <Lotus size={170} />}
        <div style={{ fontSize: 'clamp(40px, 7vw, 92px)', fontWeight: 700, letterSpacing: '-1px', lineHeight: 1.02, padding: '0 24px' }}>{name}</div>
        <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 'clamp(15px,1.8vw,22px)', color: gold, letterSpacing: '.28em', textTransform: 'uppercase' }}>Welcome</div>
        {qrImg && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <img src={qrImg} alt="" style={{ width: 'clamp(150px,15vw,220px)', borderRadius: 14, background: '#fff', padding: 10 }} />
            <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 'clamp(13px,1.4vw,18px)', color: 'rgba(255,255,255,.85)' }}>
              {(state.qr && state.qr.caption) || 'Scan for our menu'}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── LIVE ORDER ────────────────────────────────────────────────────────────
  const o = state.order || {};
  const items = Array.isArray(o.items) ? o.items : [];
  return (
    <div style={{ ...wrap, display: 'grid', gridTemplateColumns: 'minmax(220px, 26vw) 1fr' }}>
      {/* brand rail */}
      <div style={{ background: 'rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 24, textAlign: 'center' }}>
        {state.logo
          ? <img src={state.logo} alt="" style={{ maxWidth: '20vw', maxHeight: '26vh', objectFit: 'contain' }} />
          : <Lotus size={120} />}
        <div style={{ fontSize: 'clamp(22px,2.4vw,40px)', fontWeight: 700, lineHeight: 1.05 }}>{name}</div>
        {o.table && <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 'clamp(14px,1.6vw,22px)', color: gold, letterSpacing: '.14em', textTransform: 'uppercase' }}>{o.table}</div>}
      </div>

      {/* order + totals */}
      <div style={{ background: '#F4F1EA', color: '#1a1a2e', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 'clamp(20px,3vw,44px)' }}>
          <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 'clamp(12px,1.3vw,16px)', letterSpacing: '.24em', textTransform: 'uppercase', color: '#9A7B1F', marginBottom: 18 }}>Your order</div>
          {items.length === 0 && (
            <div style={{ color: '#7C766A', fontSize: 'clamp(18px,2vw,28px)', marginTop: 40 }}>Adding your items…</div>
          )}
          {items.map((it, i) => {
            const key = `${it.name}|${i}`;
            const isNew = !seenRef.current.has(key);
            seenRef.current.add(key);
            return (
              <div key={key} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 18,
                padding: 'clamp(8px,1.1vw,15px) 0', borderBottom: '1px solid #E7E2D6',
                animation: isNew ? 'cfd-in .35s ease' : 'none',
              }}>
                <span style={{ fontSize: 'clamp(19px,2.1vw,30px)', fontWeight: 600 }}>
                  <span style={{ color: gold, fontWeight: 800 }}>{it.qty || 1}×</span>&nbsp; {it.name}
                </span>
                <span style={{ fontSize: 'clamp(18px,2vw,28px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {money((it.price || 0) * (it.qty || 1))}
                </span>
              </div>
            );
          })}
        </div>
        {/* totals */}
        <div style={{ background: navy, color: '#fff', padding: 'clamp(16px,2.4vw,34px) clamp(20px,3vw,44px)' }}>
          {o.subtotal != null && (
            <Row label="Subtotal" value={money(o.subtotal)} sub />
          )}
          {o.service ? <Row label={o.service_label || 'Service'} value={money(o.service)} sub /> : null}
          {o.discount ? <Row label="Discount" value={`−${money(o.discount)}`} sub /> : null}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 }}>
            <span style={{ fontSize: 'clamp(24px,3vw,44px)', fontWeight: 800 }}>TOTAL</span>
            <span style={{ fontSize: 'clamp(30px,4.4vw,64px)', fontWeight: 800, color: gold, fontVariantNumeric: 'tabular-nums' }}>{money(o.total)}</span>
          </div>
        </div>
      </div>
      <style>{`@keyframes cfd-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

function Row({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'system-ui, sans-serif',
      fontSize: 'clamp(15px,1.7vw,24px)', color: sub ? 'rgba(255,255,255,.8)' : '#fff', padding: '3px 0' }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
