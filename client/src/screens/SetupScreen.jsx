import React, { useState, useEffect } from 'react';
import { setTenantUrl } from '../native/tenant';

// SEPOS-ANDROID-001 — first-launch setup for the Android app. Point this device
// at its restaurant/spa by entering (or scanning, later) the cloud address the
// SiamEPOS team provides at onboarding. We verify it reaches a live SiamEPOS
// backend, save it, and reload into the normal login.

const NAVY = '#0D1B3E', GOLD = '#C9A84C';

export default function SetupScreen({ onConfigured }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);

  // SEPOS-028 — "any device as a till": scan the QR shown on a configured
  // device (Admin → Settings) to point this one at the same till. Camera scanner
  // (html5-qrcode), dynamic-imported so it's out of the main bundle.
  useEffect(() => {
    if (!scanning) return;
    let scanner; let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        await new Promise(r => setTimeout(r, 60));
        if (cancelled) return;
        scanner = new Html5Qrcode('setup-qr-reader');
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 230, height: 230 } },
          async (decoded) => {
            try { await scanner.stop(); } catch {}
            const v = String(decoded || '').trim();
            if (!v) return;
            setScanning(false);
            setUrl(v);
            connect(v);   // auto-connect with the scanned address
          },
          () => { /* ignore per-frame decode errors */ }
        );
      } catch (e) {
        if (!cancelled) { setError('Camera unavailable — type the address instead.'); setScanning(false); }
      }
    })();
    return () => { cancelled = true; if (scanner) { try { scanner.stop().catch(() => {}); } catch {} } };
  }, [scanning]);

  async function connect(override) {
    let u = String(override ?? url).trim().replace(/\/+$/, '');
    if (!u) { setError('Enter your SiamEPOS address.'); return; }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    setBusy(true); setError('');
    // AbortController + setTimeout instead of AbortSignal.timeout() — the latter
    // needs a 2022+ browser and throws on older Android WebViews (Sunmi A9),
    // which made setup fail with "couldn't connect" even on a healthy network.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(u + '/api/restaurant', { signal: ctrl.signal });
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json().catch(() => ({}));
      setTenantUrl(u);
      onConfigured ? onConfigured(data) : window.location.reload();
    } catch (e) {
      setError("Couldn't connect to that address. Check it's correct and the device is online.");
    } finally { clearTimeout(timer); setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100dvh', background: NAVY, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px 18px',
      fontFamily: 'system-ui, -apple-system, sans-serif' }}
      onKeyDown={(e) => e.key === 'Enter' && !busy && connect()}>
      <svg viewBox="0 0 100 100" style={{ width: 72, height: 72, marginBottom: 14 }} aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="none" stroke={GOLD} strokeWidth="2" />
        <g transform="translate(50,50)">
          {[0, 72, 144, 216, 288].map((r, i) => (
            <path key={r} d="M 0,6 C -11,-9 -9,-38 0,-44 C 9,-38 11,-9 0,6 Z" fill={GOLD}
              opacity={[1, .82, .62, .62, .82][i]} transform={`rotate(${r})`} />
          ))}
          <circle r="10" fill={NAVY} /><circle r="5" fill={GOLD} />
        </g>
      </svg>
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 32, fontWeight: 700 }}>
        <span style={{ color: '#fff' }}>Siam</span><span style={{ color: GOLD }}>EPOS</span>
      </div>
      <div style={{ color: 'rgba(201,168,76,0.8)', fontSize: 12, letterSpacing: '0.22em',
        textTransform: 'uppercase', marginTop: 6, marginBottom: 28 }}>Set up this device</div>

      <div style={{ width: '100%', maxWidth: 380 }}>
        <label style={{ color: '#cbd5e1', fontSize: 13, display: 'block', marginBottom: 8 }}>
          Your SiamEPOS address (from your setup email)
        </label>
        <input
          type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" autoFocus
          value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }}
          placeholder="e.g. baan-siam.siamepos.co.uk"
          style={{ width: '100%', height: 52, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
            background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 16, padding: '0 16px', outline: 'none' }} />
        {error && (
          <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5', borderRadius: 8, padding: '9px 14px', fontSize: 13, textAlign: 'center' }}>{error}</div>
        )}
        <button onClick={connect} disabled={busy || !url}
          style={{ width: '100%', height: 52, marginTop: 16, borderRadius: 12, border: 'none',
            background: (url && !busy) ? GOLD : 'rgba(255,255,255,0.08)',
            color: (url && !busy) ? NAVY : 'rgba(255,255,255,0.3)',
            fontWeight: 800, fontSize: 16, cursor: (url && !busy) ? 'pointer' : 'default' }}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>

        {/* Scan QR — "any device as a till": scan the code on a set-up device */}
        {!scanning ? (
          <button onClick={() => { setError(''); setScanning(true); }} disabled={busy}
            style={{ width: '100%', height: 50, marginTop: 12, borderRadius: 12,
              border: '1px solid rgba(201,168,76,0.5)', background: 'transparent', color: GOLD,
              fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            📷 Scan QR code
          </button>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div id="setup-qr-reader" style={{ width: '100%', borderRadius: 12, overflow: 'hidden' }} />
            <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, textAlign: 'center', marginTop: 8 }}>
              Point at the QR on a set-up till (Admin → Settings)
            </div>
            <button onClick={() => setScanning(false)}
              style={{ width: '100%', height: 44, marginTop: 10, borderRadius: 10, border: 'none',
                background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        )}

        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 16, textAlign: 'center' }}>
          Not sure? Your SiamEPOS team sent this at setup — or email info@siamepos.co.uk
        </div>
      </div>
    </div>
  );
}
