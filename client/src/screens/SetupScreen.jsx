import React, { useState, useEffect } from 'react';
import { setTenantUrl, markSetupDone } from '../native/tenant';
import { HOST_MODE_KEY } from '../api';
import { saveHostConfig, startHost } from '../native/nodeHost';

// SEPOS host spike — ONE-TIME setup screen (the only screen the client touches).
//
// Primary path = "One-tap host": enter the restaurant name → "▶ Start this till"
// → this device becomes a STANDALONE HOST (its own embedded server, no cloud).
// We set the host flag, persist the name + standalone config, start the server,
// mark setup done, and reload ONCE into the app. Daily use never reloads and the
// client never digs into settings.
//
// Advanced paths (satellite / cloud) are hidden behind a small "Connecting to
// another till?" link — same camera-scan / URL-entry flow as before, host mode
// OFF. No runtime backend-swapping toggle anywhere.

const NAVY = '#0D1B3E', GOLD = '#C9A84C';

export default function SetupScreen({ onConfigured }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const finish = (data) => { markSetupDone(); onConfigured ? onConfigured(data) : window.location.reload(); };

  // ── PRIMARY: one-tap standalone host ───────────────────────────────────
  // Nothing to validate against the network — just set the flag + start locally.
  async function startThisTill() {
    const rn = name.trim();
    if (!rn) { setError('Enter your restaurant name.'); return; }
    setBusy(true); setError('');
    try {
      // Host mode ON; no cloud tenant URL (standalone). api.js reads HOST_MODE_KEY
      // at module load, so after the one-time reload the app boots in host mode.
      try { localStorage.setItem(HOST_MODE_KEY, '1'); } catch {}
      setTenantUrl('');
      // Persist standalone config + the restaurant name. main.js applies the
      // name to the local settings (company_name) on boot, so the POS shows it.
      try { await saveHostConfig({ cloud_sync_enabled: false, restaurant_name: rn }); } catch (_) {}
      // Start the embedded host now so it's up before the reload. Non-blocking:
      // startHost() launches the foreground service / node off the main thread.
      try { await startHost(); } catch (_) {}
      // Give the foreground service a moment to bind, then reload into the app.
      setTimeout(() => finish({ restaurant_name: rn }), 1400);
    } catch (e) {
      setError('Could not start this till. Please try again.');
      setBusy(false);
    }
  }

  // ── ADVANCED: join another till (LAN QR) ───────────────────────────────
  // SEPOS-028 — scan the QR shown on a configured host (Admin → Settings) to
  // point this device at it as a satellite. Camera scanner is dynamic-imported.
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

  // ── ADVANCED: connect to a host or cloud (validate the URL) ────────────
  async function connect(override) {
    let u = String(override ?? url).trim().replace(/\/+$/, '');
    if (!u) { setError('Enter the address to connect to.'); return; }
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
      // Satellite / cloud role: host mode OFF, tenant URL set.
      try { localStorage.removeItem(HOST_MODE_KEY); } catch {}
      setTenantUrl(u);
      finish(data);
    } catch (e) {
      setError("Couldn't connect to that address. Check it's correct and the device is online.");
    } finally { clearTimeout(timer); setBusy(false); }
  }

  const inputStyle = {
    width: '100%', height: 52, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 16, padding: '0 16px', outline: 'none',
  };

  return (
    <div style={{ minHeight: '100dvh', background: NAVY, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px 18px',
      fontFamily: 'system-ui, -apple-system, sans-serif' }}
      onKeyDown={(e) => e.key === 'Enter' && !busy && !showAdvanced && startThisTill()}>
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
        textTransform: 'uppercase', marginTop: 6, marginBottom: 28 }}>Set up this till</div>

      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* ── PRIMARY: one-tap host ─────────────────────────────────────── */}
        <label style={{ color: '#cbd5e1', fontSize: 13, display: 'block', marginBottom: 8 }}>
          Restaurant name
        </label>
        <input
          type="text" autoCapitalize="words" autoCorrect="off" autoFocus
          value={name} onChange={(e) => { setName(e.target.value); setError(''); }}
          placeholder="e.g. Baan Siam"
          style={inputStyle} />

        {error && !showAdvanced && (
          <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5', borderRadius: 8, padding: '9px 14px', fontSize: 13, textAlign: 'center' }}>{error}</div>
        )}

        <button onClick={startThisTill} disabled={busy || !name.trim()}
          style={{ width: '100%', height: 54, marginTop: 16, borderRadius: 12, border: 'none',
            background: (name.trim() && !busy) ? GOLD : 'rgba(255,255,255,0.08)',
            color: (name.trim() && !busy) ? NAVY : 'rgba(255,255,255,0.3)',
            fontWeight: 800, fontSize: 17, cursor: (name.trim() && !busy) ? 'pointer' : 'default' }}>
          {busy ? 'Starting…' : '▶ Start this till'}
        </button>
        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>
          This till runs on its own — no internet needed. You can add your menu &amp; staff from the Admin tab.
        </div>

        {/* ── ADVANCED: connect to another till (hidden by default) ──────── */}
        <div style={{ marginTop: 24, borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 14 }}>
          {!showAdvanced ? (
            <button onClick={() => { setShowAdvanced(true); setError(''); }} disabled={busy}
              style={{ width: '100%', background: 'transparent', border: 'none', color: 'rgba(201,168,76,0.85)',
                fontSize: 13.5, fontWeight: 700, cursor: 'pointer', padding: '6px 0' }}>
              Connecting to another till? ▾
            </button>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ color: '#cbd5e1', fontSize: 13, fontWeight: 700 }}>Connect to a host or cloud</span>
                <button onClick={() => { setShowAdvanced(false); setScanning(false); setError(''); }}
                  style={{ background: 'transparent', border: 'none', color: 'rgba(201,168,76,0.85)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  ▴ Hide
                </button>
              </div>

              <label style={{ color: '#cbd5e1', fontSize: 12.5, display: 'block', marginBottom: 6 }}>
                Address of your host till or SiamEPOS cloud
              </label>
              <input
                type="url" inputMode="url" autoCapitalize="none" autoCorrect="off"
                value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }}
                placeholder="e.g. 192.168.1.20:3001 or baan-siam.siamepos.co.uk"
                style={{ ...inputStyle, height: 48, fontSize: 15 }} />

              {error && showAdvanced && (
                <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)',
                  color: '#fca5a5', borderRadius: 8, padding: '9px 14px', fontSize: 13, textAlign: 'center' }}>{error}</div>
              )}

              <button onClick={() => connect()} disabled={busy || !url}
                style={{ width: '100%', height: 48, marginTop: 12, borderRadius: 12, border: 'none',
                  background: (url && !busy) ? GOLD : 'rgba(255,255,255,0.08)',
                  color: (url && !busy) ? NAVY : 'rgba(255,255,255,0.3)',
                  fontWeight: 800, fontSize: 15, cursor: (url && !busy) ? 'pointer' : 'default' }}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>

              {!scanning ? (
                <button onClick={() => { setError(''); setScanning(true); }} disabled={busy}
                  style={{ width: '100%', height: 46, marginTop: 10, borderRadius: 12,
                    border: '1px solid rgba(201,168,76,0.5)', background: 'transparent', color: GOLD,
                    fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                  📷 Scan QR code (join a till)
                </button>
              ) : (
                <div style={{ marginTop: 10 }}>
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
            </div>
          )}
        </div>

        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11.5, marginTop: 18, textAlign: 'center', lineHeight: 1.5 }}>
          Need help? Email info@siamepos.co.uk
        </div>
      </div>
    </div>
  );
}
