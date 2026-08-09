// SEPOS-028 — "Add a till (any device)". Shows the address + QR a new device
// scans to join this restaurant. HOST-AWARE (SEPOS host spike): when this
// device is the LAN host, satellites must point at its LOCAL address
// (http://<lan-ip>:3001), NOT the cloud URL — so in host mode we QR the LAN
// address from the native plugin. Cloud mode is unchanged: QR the tenant URL.
// Extracted from SettingsSection so HostServerCard (its own file since the
// host-mode merge) can render it too — it was a private in-file component and
// the extracted card crashed with "AddTillCard is not defined".
import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { SERVER_URL, isHostMode } from '../../api';
import { getTenantUrl } from '../../native/tenant';
import { getLanIp } from '../../native/nodeHost';

// QR needs a REAL hex — the qrcode lib can't parse a CSS var() string.
function qrDark() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  } catch { /* SSR / no DOM */ }
  return '#0D1B3E';
}

export default function AddTillCard({ cardStyle }) {
  const hostMode = isHostMode();
  const cloudTenant = (getTenantUrl() || SERVER_URL || '').replace(/\/+$/, '');
  const [lan, setLan] = useState(null); // { ip, port } | null
  useEffect(() => {
    if (!hostMode) return;
    let cancelled = false;
    getLanIp().then(r => { if (!cancelled) setLan(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [hostMode]);
  const lanUrl = (hostMode && lan && lan.ip) ? `http://${lan.ip}:${lan.port || 3001}` : '';
  const tenant = hostMode ? lanUrl : cloudTenant;

  const [qr, setQr] = useState('');
  const [testState, setTestState] = useState('idle'); // idle|testing|ok|fail
  useEffect(() => {
    let cancelled = false;
    if (!tenant) return;
    QRCode.toDataURL(tenant, { width: 220, margin: 1, errorCorrectionLevel: 'M', color: { dark: qrDark(), light: '#FFFFFF' } })
      .then(d => { if (!cancelled) setQr(d); }).catch((err) => console.warn('[add-till] QR failed:', err));
    return () => { cancelled = true; };
  }, [tenant]);
  const test = async () => {
    setTestState('testing');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(tenant + '/api/restaurant', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      setTestState(r.ok ? 'ok' : 'fail');
    } catch { setTestState('fail'); }
    setTimeout(() => setTestState('idle'), 3000);
  };
  const label = testState === 'testing' ? 'Testing…' : testState === 'ok' ? '✓ Reachable' : testState === 'fail' ? '✗ No response' : 'Test connection';
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 6 }}>📱 Add a till (any device)</h2>
      {hostMode ? (
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
          This device is the <strong>host till</strong>. Connect another phone or tablet on the <strong>same Wi-Fi / network</strong>: open the SiamEPOS app on it → <strong>Scan QR code</strong> → it joins this host. No internet needed on the satellite.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
          Turn any phone or tablet into a till: open the SiamEPOS app on it → <strong>Scan QR code</strong> → it joins this restaurant.
        </p>
      )}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ background: 'var(--brand-primary,#0D1B3E)', color: 'var(--brand-accent,#C9A84C)', padding: '14px 18px', borderRadius: 10, fontFamily: 'Menlo, Consolas, monospace', fontSize: 15, fontWeight: 800, textAlign: 'center', marginBottom: 12, userSelect: 'text', wordBreak: 'break-all' }}>{tenant || (hostMode ? 'Finding this device’s network address…' : '—')}</div>
          <button onClick={test} disabled={testState === 'testing' || !tenant} style={{ padding: '10px 20px', borderRadius: 8, border: (testState === 'ok' || testState === 'fail') ? 'none' : '1px solid var(--brand-primary,#0D1B3E)', background: testState === 'ok' ? '#22c55e' : testState === 'fail' ? '#ef4444' : 'transparent', color: (testState === 'ok' || testState === 'fail') ? 'white' : 'var(--brand-primary,#0D1B3E)', fontWeight: 700, cursor: testState === 'testing' ? 'wait' : 'pointer', fontSize: 13 }}>{label}</button>
          <div style={{ fontSize: 12, color: '#888', marginTop: 12, lineHeight: 1.5 }}>
            {hostMode
              ? 'The satellite must be on the same Wi-Fi / LAN as this host till. The host server must be running (see below).'
              : 'The new device must be online (any internet — not necessarily the same Wi-Fi).'}
          </div>
        </div>
        {qr && <div style={{ background: 'white', padding: 10, borderRadius: 10, border: '1px solid #eee', flexShrink: 0 }}><img src={qr} alt="Till QR" style={{ width: 200, height: 200, display: 'block' }} /></div>}
      </div>
    </div>
  );
}
