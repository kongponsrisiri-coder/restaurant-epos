import React, { useState, useEffect } from 'react';
import { setTenantUrl, markSetupDone } from '../native/tenant';
import { HOST_MODE_KEY } from '../api';
import { saveHostConfig, startHost } from '../native/nodeHost';
import { isNativeApp } from '../native/printer';
import { CapacitorHttp } from '@capacitor/core';

// SEPOS-ANDROID-001 — first-launch setup for the Android app. Point this device
// at its restaurant/spa by entering (or scanning, later) the cloud address the
// SiamEPOS team provides at onboarding. We verify it reaches a live SiamEPOS
// backend, save it, and reload into the normal login.

const NAVY = 'var(--brand-primary,#0D1B3E)', GOLD = 'var(--brand-accent,#C9A84C)';

export default function SetupScreen({ onConfigured }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  // SEPOS host spike — the "run this device as the host till" path (native only).
  const [name, setName] = useState('');
  const [showHost, setShowHost] = useState(false);
  const nativeApp = isNativeApp();

  // ── Host role: this device runs its own embedded server (no cloud tenant URL).
  // Cloud sync (pull menu/data from a tenant like Baan Siam) is configured LATER
  // in Admin → Settings → Host server. Here we just claim the host role, start
  // the local server, and boot into the app. api.js reads HOST_MODE_KEY at module
  // load, so the one-time reload boots straight into host mode (loopback backend).
  async function startThisTill() {
    const rn = name.trim();
    if (!rn) { setError('Enter your restaurant name.'); return; }
    setBusy(true); setError('');
    try {
      try { localStorage.setItem(HOST_MODE_KEY, '1'); } catch {}
      setTenantUrl('');
      try { await saveHostConfig({ cloud_sync_enabled: false, restaurant_name: rn }); } catch (_) {}
      try { await startHost(); } catch (_) {}
      markSetupDone();
      // Give the foreground service a moment to bind, then boot into the app.
      setTimeout(() => { onConfigured ? onConfigured({ restaurant_name: rn }) : window.location.reload(); }, 1400);
    } catch (e) {
      setError('Could not start this till. Please try again.');
      setBusy(false);
    }
  }

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
    // GOTCHA (v1.4.4 connect bug): the Connect button used to be
    // onClick={connect}, which passed React's click EVENT as `override` →
    // String(event) became "[object Object]" and the URL was garbage. The
    // button is now onClick={() => connect()}; this guard is belt-and-braces
    // so only a real string override (the QR-scan path) is honoured.
    const raw = (typeof override === 'string' && override) ? override : url;
    let u = String(raw).trim().replace(/\/+$/, '');
    if (!u) { setError('Enter your SiamEPOS address.'); return; }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    setBusy(true); setError('');

    const isNative = (() => {
      try {
        return !!(typeof window !== 'undefined' && window.Capacitor &&
          typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
      } catch { return false; }
    })();

    try {
      if (isNative) {
        // On-device: go through the native HTTP stack so the check matches the
        // app's real request path (old Sunmi WebView `fetch` can fail where the
        // native stack succeeds). Surface the REAL error so onboarding isn't a
        // black box.
        let res;
        try {
          res = await CapacitorHttp.get({ url: u + '/api/restaurant', connectTimeout: 12000, readTimeout: 12000 });
        } catch (err) {
          setError(`Couldn't connect — ${err.name || 'Error'}: ${err.message || err}`);
          return;
        }
        if (!res || res.status !== 200) { setError(`Couldn't connect — status ${res ? res.status : '?'}`); return; }
        const data = (res.data && typeof res.data === 'object') ? res.data : {};
        try { localStorage.removeItem(HOST_MODE_KEY); } catch {}  // satellite/cloud role → host mode OFF
        setTenantUrl(u);
        markSetupDone();
        onConfigured ? onConfigured(data) : window.location.reload();
        return;
      }
      // Web / desktop: keep the fetch + AbortController path.
      // AbortController + setTimeout instead of AbortSignal.timeout() — the latter
      // needs a 2022+ browser and throws on older Android WebViews (Sunmi A9),
      // which made setup fail with "couldn't connect" even on a healthy network.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(u + '/api/restaurant', { signal: ctrl.signal });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json().catch(() => ({}));
        try { localStorage.removeItem(HOST_MODE_KEY); } catch {}  // satellite/cloud role → host mode OFF
        setTenantUrl(u);
        markSetupDone();
        onConfigured ? onConfigured(data) : window.location.reload();
      } finally { clearTimeout(timer); }
    } catch (e) {
      setError("Couldn't connect to that address. Check it's correct and the device is online.");
    } finally { setBusy(false); }
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
        <button onClick={() => connect()} disabled={busy || !url}
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

        {/* SEPOS host spike — run THIS device as the host till (native only). Its
            own embedded server; satellites connect by IP. No cloud URL needed. */}
        {nativeApp && (
          <div style={{ marginTop: 22, borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 16 }}>
            {!showHost ? (
              <button onClick={() => { setShowHost(true); setError(''); }} disabled={busy}
                style={{ width: '100%', background: 'transparent', border: 'none', color: 'rgba(201,168,76,0.85)',
                  fontSize: 13.5, fontWeight: 700, cursor: 'pointer', padding: '6px 0' }}>
                Set this device up as the host till? ▾
              </button>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 13, fontWeight: 700 }}>Run this device as the host till</span>
                  <button onClick={() => { setShowHost(false); setError(''); }}
                    style={{ background: 'transparent', border: 'none', color: 'rgba(201,168,76,0.85)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>▴ Hide</button>
                </div>
                <label style={{ color: '#cbd5e1', fontSize: 12.5, display: 'block', marginBottom: 6 }}>Restaurant name</label>
                <input type="text" autoCapitalize="words" autoCorrect="off"
                  value={name} onChange={(e) => { setName(e.target.value); setError(''); }}
                  placeholder="e.g. Baan Siam"
                  style={{ width: '100%', height: 48, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
                    background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 15, padding: '0 16px', outline: 'none' }} />
                <button onClick={startThisTill} disabled={busy || !name.trim()}
                  style={{ width: '100%', height: 50, marginTop: 12, borderRadius: 12, border: 'none',
                    background: (name.trim() && !busy) ? GOLD : 'rgba(255,255,255,0.08)',
                    color: (name.trim() && !busy) ? NAVY : 'rgba(255,255,255,0.3)',
                    fontWeight: 800, fontSize: 15, cursor: (name.trim() && !busy) ? 'pointer' : 'default' }}>
                  {busy ? 'Starting…' : '▶ Start this till'}
                </button>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11.5, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>
                  This till runs its own server — other devices connect to it by IP. Set up cloud sync later in Admin → Settings → Host server.
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 16, textAlign: 'center' }}>
          Not sure? Your SiamEPOS team sent this at setup — or email info@siamepos.co.uk
        </div>
        <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 14, textAlign: 'center', letterSpacing: '0.1em' }}>
          v1.4.5
        </div>
      </div>
    </div>
  );
}
