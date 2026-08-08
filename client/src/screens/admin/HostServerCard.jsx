// SEPOS host spike — 'Host server' admin card (native-only). Enables/turns off
// host mode, starts/stops the embedded Node server, shows LAN IP + a satellite
// join QR, and configures cloud sync (pull menu/data from a tenant e.g. Baan
// Siam). Extracted from the host build's SettingsSection into the main client so
// one codebase carries host mode; rendered only when isNativeApp().
import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { isHostMode } from '../../api';
import { clearRole, getTenantUrl } from '../../native/tenant';
import { isNativeApp } from '../../native/printer';
import AddTillCard from './AddTillCard';
import { getHostStatus, startHost, stopHost, requestIgnoreBatteryOptimizations, saveHostConfig, getHostConfig, syncNow, getLanIp, reloadHostConfig } from '../../native/nodeHost';

export default function HostServerCard({ cardStyle }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Role is fixed for the session (set once at the one-time setup screen). No
  // runtime toggle — changing it requires a deliberate "Re-set up this device".
  const hostMode = isHostMode();
  const tenantUrl = getTenantUrl();
  const roleLabel = hostMode ? 'Host till' : (tenantUrl ? 'Satellite / Cloud till' : 'Not set up');
  const [showDebug, setShowDebug] = useState(false);

  // ── Cloud sync config — OPT-IN (v1.13-standalone) ───────────────────
  // STANDALONE IS THE DEFAULT. The till runs pure local SQLite; the operator
  // builds the menu/staff on the device. Cloud sync is an explicit opt-in: the
  // "Connect to a cloud" toggle is OFF by default. When ON, the operator enters
  // a cloud URL (and optional secret) and the host pulls from it (pull-only).
  const [cfg, setCfg] = useState({ cloud_sync_enabled: false, cloud_api_url: '', restaurant_id: '', sync_secret: '' });
  const [hasSecret, setHasSecret] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(false);
  const [cfgApplied, setCfgApplied] = useState(null); // null | 'applying' | { secret_present }
  const [savingCfg, setSavingCfg] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null); // { ok, menuCount, at } | { ok:false, error }

  // ── Owner remote view (read-only) ───────────────────────────────────
  const [lan, setLan] = useState(null); // { ip, port } | null
  const [ownerQr, setOwnerQr] = useState('');
  const [ownerCopied, setOwnerCopied] = useState(false);
  const ownerUrl = (lan && lan.ip) ? `http://${lan.ip}:${lan.port || 3001}/owner` : '';

  const loadCfg = async () => {
    try {
      const c = await getHostConfig();
      setCfg(prev => ({
        ...prev,
        cloud_sync_enabled: !!(c && c.cloud_sync_enabled),
        cloud_api_url: (c && c.cloud_api_url) ? c.cloud_api_url : '',
        restaurant_id: (c && c.restaurant_id) ? c.restaurant_id : '',
        sync_secret: '', // never round-tripped in cleartext
      }));
      setHasSecret(!!(c && c.has_sync_secret));
    } catch (_) { /* leave defaults */ }
  };

  const saveCfg = async () => {
    setSavingCfg(true); setCfgSaved(false); setCfgApplied(null);
    try {
      const r = await saveHostConfig(cfg);
      if (r && r.saved) {
        setCfgSaved(true);
        setHasSecret(!!(cfg.sync_secret && cfg.sync_secret.trim()) || hasSecret);
        setCfg(prev => ({ ...prev, sync_secret: '' }));
        setTimeout(() => setCfgSaved(false), 4000);
        // Apply LIVE — tell the running host to re-read host-config.json and
        // fire a tick now, so the new secret/URL takes effect in seconds with
        // NO app restart (the host's embedded Node can't restart in-process).
        if (status && status.started) {
          setCfgApplied('applying');
          try {
            const port = (status && status.port) || 3001;
            const ar = await reloadHostConfig(port);
            setCfgApplied(ar && ar.ok ? { secret_present: ar.secret_present } : null);
            if (!ar || !ar.ok) {
              setSyncResult({ ok: false, error: (ar && ar.error) || 'Live apply failed — Stop/Start the host to apply' });
            }
            // Refresh the breadcrumb log so "config reloaded" + "sync: staff N" show.
            setTimeout(refresh, 1000);
            setTimeout(() => setCfgApplied(null), 5000);
          } catch (_) { setCfgApplied(null); }
        }
      } else {
        setSyncResult({ ok: false, error: (r && r.error) || 'Save failed' });
      }
    } finally { setSavingCfg(false); }
  };

  const doSyncNow = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const port = (status && status.port) || 3001;
      const r = await syncNow(port);
      setSyncResult({ ...r, at: new Date().toLocaleTimeString() });
      // Refresh the breadcrumb log so "sync: menu N items" shows up.
      setTimeout(refresh, 800);
    } finally { setSyncing(false); }
  };

  const refresh = async () => {
    setLoading(true);
    try { setStatus(await getHostStatus()); }
    catch (e) { setStatus({ error: 'getHostStatus threw: ' + (e && e.message ? e.message : String(e)) }); }
    finally { setLoading(false); }
  };

  const start = async () => {
    setStarting(true);
    try {
      await startHost();          // launches the foreground service; may abort
      // Foreground service + Node take a moment to bind; poll a couple of times.
      await refresh();
      setTimeout(refresh, 2500);
    } catch (e) {
      setStatus(s => ({ ...(s || {}), error: 'startHost threw: ' + (e && e.message ? e.message : String(e)) }));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await stopHost();           // stops the foreground service + notification
      await refresh();
    } catch (e) {
      setStatus(s => ({ ...(s || {}), error: 'stopHost threw: ' + (e && e.message ? e.message : String(e)) }));
    } finally {
      setStopping(false);
    }
  };

  const exemptBattery = async () => {
    try { await requestIgnoreBatteryOptimizations(); }
    catch (_) { /* opens a system dialog; nothing to surface here */ }
  };

  // Role is a ONE-TIME setup-screen choice now — no runtime backend-swap toggle
  // (that caused the reload/log-out + cloud↔local swap mid-session). The ONLY
  // way to change role is a DELIBERATE "Re-set up this device": stop the host,
  // clear the role/flags/tenant, and return to SetupScreen.
  const reSetupDevice = async () => {
    const go = await confirm(
      'Re-set up this device? It will return to the first-time setup screen so you can choose how this till runs (its own host, or connect to another till / cloud). Connected tills will lose this server while you set up again. This till’s local data (menu, staff, orders, bills) is kept.',
      { okLabel: 'Re-set up', cancelLabel: 'Cancel', danger: true }
    );
    if (!go) return;
    try { await stopHost(); } catch (_) {}
    clearRole();                 // host flag + tenant URL + setup-done flag
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 400);
  };

  useEffect(() => { refresh(); loadCfg(); }, []);

  // Owner remote view needs this device's LAN address — only meaningful in host
  // mode (this device IS the server). Build a QR for the read-only /owner page.
  useEffect(() => {
    if (!hostMode) return;
    let cancelled = false;
    getLanIp().then(r => { if (!cancelled) setLan(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [hostMode]);
  useEffect(() => {
    let cancelled = false;
    if (!ownerUrl) { setOwnerQr(''); return; }
    QRCode.toDataURL(ownerUrl, { width: 180, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0D1B3E', light: '#FFFFFF' } })
      .then(d => { if (!cancelled) setOwnerQr(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [ownerUrl]);

  // PRIMARY running signal = native `started` (service running + node thread up).
  // The loopback /api/settings confirm (`pinged`) is a nice-to-have: the Android
  // WebView can sandbox loopback fetches on some OEM builds, so a failed ping
  // does NOT mean the host is down. Treat `started` as running; show a softer
  // "running (confirm pending)" when we couldn't confirm over loopback.
  const running = !!(status && status.started);
  const badge = (running && status.pinged)
    ? { text: '🟢 Running', bg:'#dcfce7', fg:'#15803d' }
    : running
      ? { text: '🟢 Running (confirm pending)', bg:'#dcfce7', fg:'#15803d' }
      : { text: '🔴 Not running', bg:'#fee2e2', fg:'#991b1b' };

  const Row = ({ label, value, mono }) => (
    <div style={{ display:'grid', gridTemplateColumns:'140px 1fr', padding:'7px 12px', borderBottom:'1px solid #f0f0f0', fontSize:13 }}>
      <span style={{ color:'#888', fontWeight:600 }}>{label}</span>
      <span style={{ color:'#1a1a2e', fontFamily: mono ? 'monospace' : 'inherit', wordBreak:'break-word' }}>
        {value === null || value === undefined || value === '' ? '—' : String(value)}
      </span>
    </div>
  );

  const sectionBox = { marginTop:14, padding:'14px 16px', background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:12 };
  const sectionTitle = { fontSize:13.5, fontWeight:800, color:'#1a1a2e', marginBottom:6 };

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:18, fontWeight:800, color:'#1a1a2e', margin:'0 0 4px' }}>🖥️ This device (Host)</h2>
      <p style={{ fontSize:12.5, color:'#64748b', margin:'0 0 14px', lineHeight:1.5 }}>
        Run the SiamEPOS server on this device itself. It works <b>without internet</b> by default (standalone), serves the POS to other tills on your local network, and can optionally connect to a cloud.
      </p>

      {/* ── 1) This device's role (read-only) + deliberate re-setup ───────────
          No runtime toggle: the role was chosen once at the setup screen. The
          ONLY way to change it is "Re-set up this device", which is deliberate
          (confirm) — never a casual mid-session backend swap. */}
      <div style={{ marginBottom:6, padding:'14px 16px', borderRadius:12, border:`2px solid ${hostMode ? '#16a34a' : '#cbd5e1'}`, background: hostMode ? '#f0fdf4' : '#f8fafc' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div style={{ flex:1, minWidth:220 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'#64748b' }}>This device</div>
            <div style={{ fontSize:16, fontWeight:800, color: hostMode ? '#15803d' : '#1a1a2e', marginTop:2 }}>
              {roleLabel}
            </div>
            <div style={{ fontSize:12.5, color:'#64748b', marginTop:4, lineHeight:1.5 }}>
              {hostMode
                ? 'This till runs its own SiamEPOS server. Other tills can join it over your local network. It started automatically when the app opened.'
                : (tenantUrl
                    ? 'This till connects to another SiamEPOS server (a host till or the cloud).'
                    : 'This device has not been set up yet.')}
            </div>
          </div>
          <button
            onClick={reSetupDevice}
            style={{ fontSize:13, fontWeight:800, padding:'9px 16px', borderRadius:10, border:'1px solid #cbd5e1',
              background:'white', color:'#475569', cursor:'pointer', whiteSpace:'nowrap' }}
          >
            ↺ Re-set up this device
          </button>
        </div>
        {hostMode && (
          <div style={{ fontSize:11.5, fontWeight:700, color:'#15803d', marginTop:10 }}>
            ✓ Host till — this app talks to its own server at http://127.0.0.1:3001
          </div>
        )}
      </div>

      {/* ── 2) Server controls (Start / Stop / status) ───────────────────── */}
      <div style={sectionBox}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8, flexWrap:'wrap' }}>
          <div style={sectionTitle}>Server</div>
          <span style={{ fontSize:11, fontWeight:700, color:badge.fg, background:badge.bg, padding:'3px 9px', borderRadius:12 }}>
            {badge.text}
          </span>
          {(status && status.started) ? (
            <button
              onClick={stop}
              disabled={stopping || loading}
              style={{ marginLeft:'auto', fontSize:13, fontWeight:700, padding:'6px 14px', borderRadius:8, border:'1px solid #991b1b', background: (stopping||loading) ? '#fecaca' : '#dc2626', color:'white', cursor:(stopping||loading) ? 'default' : 'pointer' }}
            >
              {stopping ? 'Stopping…' : '⏹ Stop server'}
            </button>
          ) : (
            <button
              onClick={start}
              disabled={starting || loading}
              style={{ marginLeft:'auto', fontSize:13, fontWeight:700, padding:'6px 14px', borderRadius:8, border:'1px solid #15803d', background: (starting||loading) ? '#bbf7d0' : '#16a34a', color:'white', cursor:(starting||loading) ? 'default' : 'pointer' }}
            >
              {starting ? 'Starting…' : '▶ Start server'}
            </button>
          )}
          <button
            onClick={refresh}
            disabled={loading || starting || stopping}
            style={{ fontSize:13, fontWeight:600, padding:'6px 14px', borderRadius:8, border:'1px solid #d1d5db', background: loading ? '#f3f4f6' : 'white', color:'#374151', cursor: loading ? 'default' : 'pointer' }}
          >
            {loading ? 'Refreshing…' : '🔄 Refresh'}
          </button>
        </div>
        <p style={{ fontSize:12, color:'#888', margin:'0 0 10px', lineHeight:1.5 }}>
          Embedded server anchored to an Android <b>foreground service</b> so it keeps serving connected tills even when this device is backgrounded or the screen is off. A persistent "SiamEPOS — host running" notification appears while it is up.
        </p>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <button
            onClick={exemptBattery}
            style={{ fontSize:12, fontWeight:600, padding:'5px 12px', borderRadius:8, border:'1px solid #d97706', background:'#fffbeb', color:'#92400e', cursor:'pointer' }}
          >
            🔋 Exempt from battery optimisation
          </button>
          <span style={{ fontSize:11, color:'#888', lineHeight:1.4 }}>
            Recommended for a host till — stops Android dozing the server when idle.
          </span>
        </div>
        {status && status.nativeCrash && (
          <div style={{ background:'#fef2f2', border:'2px solid #dc2626', borderRadius:8, padding:'10px 12px', marginTop:12 }}>
            <div style={{ fontSize:13, fontWeight:800, color:'#991b1b', marginBottom:6 }}>
              ⚠️ The server crashed on last start
            </div>
            <pre style={{ margin:0, fontSize:11, lineHeight:1.4, color:'#7f1d1d', fontFamily:'monospace', whiteSpace:'pre-wrap', wordBreak:'break-word', maxHeight:200, overflow:'auto' }}>
              {status.nativeCrash}
            </pre>
          </div>
        )}
      </div>

      {/* ── 3) Add a till (LAN QR) ───────────────────────────────────────── */}
      <AddTillCard cardStyle={sectionBox} embedded />

      {/* ── 4) Cloud sync — OPT-IN (default OFF = standalone) ─────────────── */}
      <div style={sectionBox}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:12, flexWrap:'wrap' }}>
          <div style={{ flex:1, minWidth:220 }}>
            <div style={sectionTitle}>☁️ Connect to a cloud <span style={{ fontWeight:600, color:'#94a3b8' }}>(optional)</span></div>
            <p style={{ fontSize:12, color:'#64748b', margin:0, lineHeight:1.5 }}>
              {cfg.cloud_sync_enabled
                ? 'This till pulls its menu, staff, settings, orders and bills from the cloud below. Pull-only — nothing is ever sent back. Changes apply live when you tap Save while the server is running.'
                : 'This till runs standalone (local-only). Turn this on only if you want it to mirror a SiamEPOS cloud.'}
            </p>
          </div>
          <button
            onClick={() => setCfg(c => ({ ...c, cloud_sync_enabled: !c.cloud_sync_enabled }))}
            style={{ fontSize:13, fontWeight:800, padding:'8px 14px', borderRadius:999, border:'none',
              background: cfg.cloud_sync_enabled ? '#16a34a' : '#cbd5e1', color: cfg.cloud_sync_enabled ? 'white' : '#475569', cursor:'pointer', whiteSpace:'nowrap' }}
          >
            {cfg.cloud_sync_enabled ? 'ON' : 'OFF'}
          </button>
        </div>

        {!cfg.cloud_sync_enabled && (
          <div style={{ marginTop:10, fontSize:12, fontWeight:700, color:'#15803d', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:8, padding:'8px 11px' }}>
            ✓ Standalone — this till runs entirely on its own. Add your menu &amp; staff from the Admin tabs on this device.
          </div>
        )}

        {cfg.cloud_sync_enabled && (
          <>
            <div style={{ display:'grid', gap:8, marginTop:12 }}>
              <label style={{ fontSize:11, fontWeight:700, color:'#475569' }}>
                Cloud API URL
                <input
                  type="url" value={cfg.cloud_api_url}
                  onChange={e => setCfg(c => ({ ...c, cloud_api_url: e.target.value }))}
                  placeholder="https://your-restaurant.siamepos.co.uk"
                  style={{ width:'100%', marginTop:4, padding:'9px 11px', borderRadius:8, border:'1px solid #cbd5e1', fontSize:13, fontFamily:'monospace', boxSizing:'border-box' }}
                />
              </label>
              <label style={{ fontSize:11, fontWeight:700, color:'#475569' }}>
                Restaurant ID <span style={{ fontWeight:400, color:'#94a3b8' }}>(optional for single-tenant cloud)</span>
                <input
                  type="text" value={cfg.restaurant_id}
                  onChange={e => setCfg(c => ({ ...c, restaurant_id: e.target.value }))}
                  placeholder="your-restaurant"
                  style={{ width:'100%', marginTop:4, padding:'9px 11px', borderRadius:8, border:'1px solid #cbd5e1', fontSize:13, boxSizing:'border-box' }}
                />
              </label>
              <label style={{ fontSize:11, fontWeight:700, color:'#475569' }}>
                Sync secret <span style={{ fontWeight:400, color:'#94a3b8' }}>(optional — for order sync; {hasSecret ? 'currently set' : 'not set'})</span>
                <input
                  type="password" value={cfg.sync_secret}
                  onChange={e => setCfg(c => ({ ...c, sync_secret: e.target.value }))}
                  placeholder={hasSecret ? '•••••••• (leave blank to keep)' : 'paste SYNC_SECRET'}
                  autoComplete="off"
                  style={{ width:'100%', marginTop:4, padding:'9px 11px', borderRadius:8, border:'1px solid #cbd5e1', fontSize:13, fontFamily:'monospace', boxSizing:'border-box' }}
                />
              </label>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:10, flexWrap:'wrap' }}>
              <button
                onClick={doSyncNow} disabled={syncing || !(status && status.started)}
                title={status && status.started ? '' : 'Start the server first'}
                style={{ fontSize:13, fontWeight:700, padding:'7px 14px', borderRadius:8, border:'1px solid #15803d', background: (syncing || !(status && status.started)) ? '#bbf7d0' : '#16a34a', color:'white', cursor: (syncing || !(status && status.started)) ? 'default' : 'pointer' }}
              >
                {syncing ? 'Syncing…' : '⬇ Sync now'}
              </button>
              {syncResult && (
                <span style={{ fontSize:12, fontWeight:600, color: syncResult.ok ? '#15803d' : '#991b1b' }}>
                  {syncResult.ok
                    ? `✓ Pulled${syncResult.menuCount != null ? ` — ${syncResult.menuCount} menu items` : ''}${syncResult.at ? ` (${syncResult.at})` : ''}`
                    : `✗ ${syncResult.error || 'Sync failed'}`}
                </span>
              )}
            </div>
          </>
        )}

        {/* Save applies whether sync is on or off (off = persist standalone). */}
        <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:12, flexWrap:'wrap' }}>
          <button
            onClick={saveCfg} disabled={savingCfg}
            style={{ fontSize:13, fontWeight:700, padding:'7px 14px', borderRadius:8, border:'1px solid #2563eb', background: savingCfg ? '#bfdbfe' : '#3b82f6', color:'white', cursor: savingCfg ? 'default' : 'pointer' }}
          >
            {savingCfg ? 'Saving…' : '💾 Save'}
          </button>
          {cfgApplied === 'applying' && <span style={{ fontSize:12, fontWeight:700, color:'#2563eb' }}>✓ Saved — applying…</span>}
          {cfgApplied && cfgApplied !== 'applying' && (
            <span style={{ fontSize:12, fontWeight:700, color:'#15803d' }}>
              ✓ Applied live{cfgApplied.secret_present ? ' (secret active — staff, orders & bills syncing)' : ''}
            </span>
          )}
          {cfgSaved && !cfgApplied && <span style={{ fontSize:12, fontWeight:700, color:'#15803d' }}>✓ Saved{status && status.started ? '' : ' — Start the server to apply'}</span>}
        </div>
      </div>

      {/* ── 5) Owner remote view (read-only) ─────────────────────────────── */}
      <div style={sectionBox}>
        <div style={sectionTitle}>👁️ Owner remote view <span style={{ fontWeight:600, color:'#94a3b8' }}>(read-only)</span></div>
        <p style={{ fontSize:12, color:'#64748b', margin:'0 0 10px', lineHeight:1.5 }}>
          A read-only dashboard — today's sales, covers, open orders and table occupancy. No buttons, nothing can be changed. Open it from any device on the <b>same Wi-Fi / network</b> as this till. The till must be switched on and the server running.
        </p>
        {ownerUrl ? (
          <div style={{ display:'flex', gap:16, alignItems:'flex-start', flexWrap:'wrap' }}>
            <div style={{ flex:1, minWidth:220 }}>
              <div style={{ background:'#0D1B3E', color:'#C9A84C', padding:'12px 14px', borderRadius:10, fontFamily:'Menlo, Consolas, monospace', fontSize:14, fontWeight:800, wordBreak:'break-all', userSelect:'text' }}>{ownerUrl}</div>
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(ownerUrl); setOwnerCopied(true); setTimeout(() => setOwnerCopied(false), 2000); } catch (_) {} }}
                style={{ marginTop:10, fontSize:13, fontWeight:700, padding:'7px 14px', borderRadius:8, border:'1px solid #0D1B3E', background:'white', color:'#0D1B3E', cursor:'pointer' }}
              >
                {ownerCopied ? '✓ Copied' : '📋 Copy link'}
              </button>
              <div style={{ fontSize:11, color:'#94a3b8', marginTop:10, lineHeight:1.5 }}>
                Remote-over-the-internet viewing (a secure public link) is coming in a future update. Today this link works on your local network only.
              </div>
            </div>
            {ownerQr && <div style={{ background:'white', padding:10, borderRadius:10, border:'1px solid #eee', flexShrink:0 }}><img src={ownerQr} alt="Owner view QR" style={{ width:160, height:160, display:'block' }} /></div>}
          </div>
        ) : (
          <div style={{ fontSize:12, color:'#94a3b8' }}>{hostMode ? 'Finding this device’s network address…' : 'Turn on host mode to expose the owner view.'}</div>
        )}
      </div>

      {/* ── 6) Debug (collapsed by default) ──────────────────────────────── */}
      <div style={{ ...sectionBox, background:'#fbfbfd' }}>
        <button
          onClick={() => setShowDebug(d => !d)}
          style={{ display:'flex', alignItems:'center', gap:8, width:'100%', background:'none', border:'none', padding:0, cursor:'pointer', textAlign:'left' }}
        >
          <span style={{ ...sectionTitle, marginBottom:0 }}>🧪 Debug</span>
          <span style={{ fontSize:12, color:'#94a3b8', marginLeft:'auto' }}>{showDebug ? '▲ Hide' : '▼ Show'}</span>
        </button>
        {showDebug && (
          <div style={{ marginTop:12 }}>
            {status ? (
              <div style={{ background:'white', border:'1px solid #f0f0f0', borderRadius:8 }}>
                <Row label="Started"      value={status.started ? 'yes' : 'no'} />
                <Row label="Ping OK"      value={status.pinged ? 'yes' : 'no'} />
                <Row label="Port"         value={status.port} />
                <Row label="Device ABI"   value={status.abi} mono />
                <Row label="Native ready" value={status.nativeReady ? 'yes' : 'no'} />
                <Row label="Node version" value={status.node} mono />
                <Row label="SQLite"       value={status.sqlite ? 'OK' : 'no'} />
                <div style={{ display:'grid', gridTemplateColumns:'140px 1fr', padding:'7px 12px', fontSize:13 }}>
                  <span style={{ color:'#888', fontWeight:600 }}>Error</span>
                  <span style={{ color: status.error ? '#991b1b' : '#15803d', fontFamily:'monospace', wordBreak:'break-word' }}>
                    {status.error || 'none'}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize:13, color:'#888' }}>Loading…</div>
            )}
            {status && status.nodeLog && (
              <div style={{ marginTop:12 }}>
                <div style={{ fontSize:12, fontWeight:800, color:'#374151', marginBottom:6 }}>
                  📜 Node breadcrumb log
                </div>
                <pre style={{ margin:0, fontSize:11, lineHeight:1.4, color:'#e5e7eb', background:'#1a1a2e', borderRadius:8, padding:'10px 12px', fontFamily:'monospace', whiteSpace:'pre-wrap', wordBreak:'break-word', maxHeight:300, overflow:'auto' }}>
                  {status.nodeLog}
                </pre>
                <div style={{ fontSize:11, color:'#888', marginTop:6 }}>
                  Also viewable from another device on the same Wi-Fi at <b>http://&lt;till-ip&gt;:{status.port || 3001}/api/log</b> while the server is up.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


