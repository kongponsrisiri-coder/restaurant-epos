import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { getSettings, updateSettings, getDiscountReasons, addDiscountReason, deleteDiscountReason, getCategories, updateCategoryBar, updateCategoryDefaultCourse, getNetworkInfo, getArchiveStatus, openArchiveFolder, runArchive, getMigrationStatus, getStorageStats, getTunnelStatus, getKitchenTemplates, createKitchenTemplate, updateKitchenTemplate, deleteKitchenTemplate, assertOk, SERVER_URL } from '../../api';
import { applyBrandTheme, BRAND_PRESETS, DEFAULT_PRIMARY, DEFAULT_ACCENT } from '../../theme'; // SEPOS-BRAND-001
import DiningDurationSettings from './DiningDurationSettings';
import { confirm } from '../../utils/confirm';
import { getTenantUrl } from '../../native/tenant';
import { isNativeApp } from '../../native/printer';
import StickySaveBar, { SAVE_BAR_CLEARANCE } from '../../components/StickySaveBar';
import AddTillCard from './AddTillCard';
import HostServerCard from './HostServerCard';   // SEPOS host spike — native-only

// QR codes render to a <canvas>, so the qrcode lib needs a REAL hex colour —
// it can't parse a CSS `var(--brand-primary,…)` string (throws → blank QR).
// Resolve the live brand colour to hex, falling back to navy so the QR always
// draws even before the theme vars are set.
function brandQrDark() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
  } catch { /* SSR / no DOM */ }
  return DEFAULT_PRIMARY || '#0D1B3E';
}

// SEPOS-028 — "any device as a till". Extracted to its own file (AddTillCard.jsx,
// host-aware: QRs the LAN address in host mode) so HostServerCard can render it
// too — as a private in-file component the extracted card crashed with
// "AddTillCard is not defined".

// ── SEPOS-KITCHEN-MSG-001 — pre-canned kitchen message templates ────
// Waiter taps a pill in the order screen → one-tap send. Admin manages
// the list here: label (waiter-facing button text), icon emoji,
// message (the full text the kitchen receives), sort order.
function KitchenTemplatesCard({ cardStyle }) {
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing]     = useState(null); // null | { id?, label, icon, message, sort_order }

  const bySort = (a, b) => (Number(a.sort_order) || 100) - (Number(b.sort_order) || 100);
  const refresh = async () => {
    try { setTemplates(await getKitchenTemplates() || []); } catch { setTemplates([]); }
  };
  useEffect(() => { refresh(); }, []);

  const startNew = () => setEditing({ label: '', icon: '', message: '', sort_order: 100 });

  // SEPOS-046y — optimistic save/delete (MenuSection pattern). Modal closes
  // and the list updates instantly; the network call runs in background.
  // No refresh() on success — desktop SQLite lags cloud by up to 5s and a
  // refetch would overwrite fresh state. Refetch only on error rollback.
  const save = async () => {
    if (!editing.label.trim() || !editing.message.trim()) { alert('Label + message required'); return; }
    const draft = { ...editing };
    setEditing(null);
    if (draft.id) {
      setTemplates(prev => prev.map(t => t.id === draft.id ? { ...t, ...draft } : t).sort(bySort));
      try { assertOk(await updateKitchenTemplate(draft.id, draft)); }
      catch (e) { alert(e?.message || 'Save failed'); refresh(); }
    } else {
      const tempId = -Date.now();
      setTemplates(prev => [...prev, { ...draft, id: tempId }].sort(bySort));
      try {
        const res = assertOk(await createKitchenTemplate(draft));
        if (res?.id) setTemplates(prev => prev.map(t => t.id === tempId ? { ...t, id: res.id } : t));
      } catch (e) {
        alert(e?.message || 'Save failed');
        setTemplates(prev => prev.filter(t => t.id !== tempId));
      }
    }
  };

  const remove = async (id) => {
    if (!await confirm('Delete this template?')) return;
    setTemplates(prev => prev.filter(t => t.id !== id));
    try { assertOk(await deleteKitchenTemplate(id)); }
    catch (e) { alert(e?.message || 'Delete failed'); refresh(); }
  };

  return (
    <div style={cardStyle}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', margin:0 }}>📢 Kitchen Message Templates</h2>
        <button onClick={startNew} style={{ padding:'8px 14px', borderRadius:8, border:'1px solid var(--brand-primary,#0D1B3E)', background:'var(--brand-primary,#0D1B3E)', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>+ New</button>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:14, lineHeight:1.5 }}>
        One-tap pills for waiters to send common messages to the kitchen — allergies, holds, VIP, birthdays.
        Waiters can still type free text alongside any template.
      </p>

      <div style={{ background:'white', border:'1px solid #f0f0f0', borderRadius:8 }}>
        {templates.length === 0 && (
          <div style={{ padding:'14px 16px', fontSize:13, color:'#888' }}>No templates yet.</div>
        )}
        {templates.map(t => (
          <div key={t.id} style={{ padding:'10px 14px', borderBottom:'1px solid #f0f0f0', display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:20, width:28, textAlign:'center' }}>{t.icon || '·'}</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:14, fontWeight:700, color:'var(--brand-primary, #1a1a2e)' }}>{t.label}</div>
              <div style={{ fontSize:12, color:'#666', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.message}</div>
            </div>
            <button onClick={() => setEditing({ ...t })} style={{ padding:'6px 10px', borderRadius:6, border:'1px solid #ddd', background:'white', fontSize:12, fontWeight:600, cursor:'pointer' }}>Edit</button>
            <button onClick={() => remove(t.id)} style={{ padding:'6px 10px', borderRadius:6, border:'1px solid #fecaca', background:'white', color:'#dc2626', fontSize:12, fontWeight:600, cursor:'pointer' }}>✕</button>
          </div>
        ))}
      </div>

      {editing && (
        <div style={{ position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:'rgba(0,0,0,0.6)', zIndex:9000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'white', borderRadius:14, maxWidth:480, width:'100%', padding:'20px 22px' }}>
            <h3 style={{ fontSize:17, fontWeight:800, margin:'0 0 14px', color:'var(--brand-primary, #1a1a2e)' }}>{editing.id ? 'Edit template' : 'New template'}</h3>
            <div style={{ display:'grid', gap:12 }}>
              <label style={{ fontSize:12, fontWeight:700, color:'#555' }}>
                Label (waiter sees this)
                <input value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })}
                  placeholder="Allergy: nuts"
                  style={{ marginTop:5, width:'100%', padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:14, boxSizing:'border-box' }} />
              </label>
              <label style={{ fontSize:12, fontWeight:700, color:'#555' }}>
                Icon (emoji, optional)
                <input value={editing.icon || ''} onChange={e => setEditing({ ...editing, icon: e.target.value })}
                  placeholder="⚠️"
                  maxLength={4}
                  style={{ marginTop:5, width:80, padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:18, textAlign:'center', boxSizing:'border-box' }} />
              </label>
              <label style={{ fontSize:12, fontWeight:700, color:'#555' }}>
                Message (kitchen receives this)
                <textarea value={editing.message} onChange={e => setEditing({ ...editing, message: e.target.value })}
                  placeholder="ALLERGY: NUTS — please prepare carefully"
                  rows={3}
                  style={{ marginTop:5, width:'100%', padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:14, fontFamily:'inherit', boxSizing:'border-box', resize:'vertical' }} />
              </label>
              <label style={{ fontSize:12, fontWeight:700, color:'#555' }}>
                Sort order (lower = appears first)
                <input value={editing.sort_order || 100} type="text" inputMode="decimal"
                  onChange={e => setEditing({ ...editing, sort_order: Number(e.target.value) || 100 })}
                  style={{ marginTop:5, width:120, padding:10, borderRadius:8, border:'1px solid #ddd', fontSize:14, boxSizing:'border-box' }} />
              </label>
            </div>
            <div style={{ display:'flex', gap:10, marginTop:18 }}>
              <button onClick={() => setEditing(null)}
                style={{ flex:1, padding:12, borderRadius:8, border:'none', background:'#f0f0f0', fontWeight:700, fontSize:14, cursor:'pointer' }}>Cancel</button>
              <button onClick={save}
                style={{ flex:2, padding:12, borderRadius:8, border:'none', background:'var(--brand-primary,#0D1B3E)', color:'white', fontWeight:800, fontSize:14, cursor:'pointer' }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SEPOS-LOCAL-001 Phase 3 — first-boot migration banner ───────────
// Polls /api/local/migration-status; renders a fixed gold banner across
// the top of Settings while imported < target, and a green "✓ done"
// confirmation for ~10s once finished.
function MigrationBanner() {
  const [state, setState] = useState(null);
  const [hideDone, setHideDone] = useState(false);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try { const s = await getMigrationStatus(); if (!stopped) setState(s); } catch {}
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(iv); };
  }, []);
  if (!state) return null;
  if (state.skipped) return null;
  if (state.status === 'idle') return null;
  if (state.status === 'done' && hideDone) return null;

  const isRunning = state.running || state.status === 'running' || state.status === 'archiving';
  const bg = state.status === 'error' ? '#fee2e2' : state.status === 'done' ? '#dcfce7' : '#fef3c7';
  const fg = state.status === 'error' ? '#991b1b' : state.status === 'done' ? '#15803d' : '#92400e';
  return (
    <div style={{ background:bg, color:fg, padding:'12px 18px', borderRadius:10, marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between', gap:14, flexWrap:'wrap' }}>
      <div style={{ flex:1, minWidth:200 }}>
        <strong style={{ fontSize:13 }}>
          {state.status === 'running'   && `🔄 Importing your history from the cloud… ${state.imported} records done`}
          {state.status === 'archiving' && `📂 Generating HMRC archive for ${state.archived_months || ''} month${state.archived_months === 1 ? '' : 's'}…`}
          {state.status === 'done'      && `✓ History imported (${state.imported} records). Archive complete.`}
          {state.status === 'error'     && `⚠ Migration error: ${state.error || 'unknown'}`}
        </strong>
        <div style={{ fontSize:11, marginTop:3, opacity:0.85 }}>
          {isRunning && 'You can keep using SiamEPOS while this runs. Operations are unaffected.'}
          {state.status === 'done'  && 'This device now holds the full history. Future syncs are incremental.'}
          {state.status === 'error' && 'Migration will retry on next restart. Cloud data is unchanged.'}
        </div>
      </div>
      {state.status === 'done' && (
        <button onClick={() => setHideDone(true)}
          style={{ padding:'7px 13px', borderRadius:7, border:'1px solid #15803d', background:'white', color:'#15803d', fontWeight:700, fontSize:12, cursor:'pointer' }}>
          Dismiss
        </button>
      )}
    </div>
  );
}

// ── SEPOS-LOCAL-001 Phase 5 — Data Storage card ─────────────────────
// Side-by-side counts (local vs cloud) so the operator can verify their
// Mac actually holds the records, plus a mode badge that shows whether
// this restaurant is on device-first (Mac is authoritative + Railway
// trimmed to 30 days) or cloud-first (legacy).
function DataStorageCard({ cardStyle }) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => { try { const s = await getStorageStats(); if (!stopped) setStats(s); } catch {} };
    tick();
    const iv = setInterval(tick, 30000);
    return () => { stopped = true; clearInterval(iv); };
  }, []);
  if (!stats) {
    return (
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>📊 Data Storage</h2>
        <p style={{ fontSize:13, color:'#888' }}>Loading…</p>
      </div>
    );
  }
  const modeLabel = stats.local_install && stats.device_first_mode ? 'Device-first'
                  : stats.local_install                            ? 'Device-first (local storage active)'
                  : stats.device_first_mode                        ? 'Cloud (30-day relay)'
                  :                                                  'Cloud-first (legacy)';
  const modeColor = stats.local_install || stats.device_first_mode ? '#15803d' : '#92400e';
  const row = (label, l, c) => (
    <div key={label} style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr 1fr', alignItems:'center', padding:'8px 12px', borderBottom:'1px solid #f0f0f0', fontSize:13 }}>
      <span style={{ color:'#555' }}>{label}</span>
      <span style={{ color:'var(--brand-primary, #1a1a2e)', fontFamily:'Menlo,Consolas,monospace', textAlign:'right' }}>{l ?? '—'}</span>
      <span style={{ color:'#888',     fontFamily:'Menlo,Consolas,monospace', textAlign:'right' }}>{c ?? '—'}</span>
    </div>
  );
  return (
    <div style={cardStyle}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', margin:0 }}>📊 Data Storage</h2>
        <span style={{ fontSize:11, fontWeight:700, color:modeColor, background:modeColor === '#15803d' ? '#dcfce7' : '#fef3c7', padding:'3px 9px', borderRadius:12 }}>
          {modeLabel}
        </span>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:14, lineHeight:1.5 }}>
        Record counts on this device vs the Railway cloud relay. Side-by-side helps verify your history is genuinely stored locally.
      </p>
      <div style={{ background:'white', border:'1px solid #f0f0f0', borderRadius:8, marginBottom:8 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr 1fr', padding:'8px 12px', borderBottom:'1px solid #e7e3da', fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5 }}>
          <span>Type</span>
          <span style={{ textAlign:'right' }}>This device</span>
          <span style={{ textAlign:'right' }}>Cloud (30d)</span>
        </div>
        {row('Closed orders',  stats.local?.closed_orders, stats.cloud?.closed_orders)}
        {row('Open orders',    stats.local?.open_orders,   stats.cloud?.open_orders)}
        {row('Payments',       stats.local?.payments,      stats.cloud?.payments)}
        {row('Vouchers',       stats.local?.vouchers,      stats.cloud?.vouchers)}
        {row('Reservations',   stats.local?.reservations,  stats.cloud?.reservations)}
      </div>
      {!stats.local_install && (
        <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#0369a1' }}>
          💡 You're viewing this in a browser. The "This device" column is empty because the local SQLite copy only exists inside the SiamEPOS desktop app on the restaurant's till machine.
        </div>
      )}
    </div>
  );
}

// ── SEPOS-PRO-005 — App & Updates card ──────────────────────────────
// Gives the owner a heads-up that the till keeps itself current, rather
// than leaving them to discover updates by accident. Desktop only (the
// web POS / iPads update via the PWA service worker, not electron-updater)
// — on the web build `window.siamepos` is undefined and we render nothing.
function AppUpdatesCard({ cardStyle }) {
  const sep = window.siamepos;            // present only inside the desktop app
  const [version, setVersion] = useState(null);
  // status ∈ idle | checking | available | downloading | downloaded | up-to-date | error
  const [status, setStatus]   = useState('idle');
  const [percent, setPercent] = useState(0);
  const [newVersion, setNewVersion] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);
  const [errMsg, setErrMsg] = useState(null);

  useEffect(() => {
    if (!sep) return;
    if (sep.getVersion) sep.getVersion().then((v) => v && setVersion(v)).catch(() => {});
    if (sep.onUpdateStatus) {
      sep.onUpdateStatus((p) => {
        if (!p || !p.state) return;
        if (p.state === 'checking')        { setStatus('checking'); }
        else if (p.state === 'available')  { setStatus('available'); setNewVersion(p.version || null); }
        else if (p.state === 'not-available') { setStatus('up-to-date'); setLastChecked(new Date()); }
        else if (p.state === 'downloading'){ setStatus('downloading'); setPercent(p.percent || 0); }
        else if (p.state === 'downloaded') { setStatus('downloaded'); setNewVersion(p.version || null); }
        else if (p.state === 'error')      { setStatus('error'); setErrMsg(p.message || null); }
      });
    }
  }, [sep]);

  // Web POS — nothing to show (PWA handles its own updates).
  if (!sep) return null;

  const check = async () => {
    if (!sep.checkForUpdates) return;
    setStatus('checking');
    try {
      const r = await sep.checkForUpdates();
      setLastChecked(new Date());
      if (r && r.ok === false && r.reason === 'not-packaged') setStatus('idle');
      else if (r && r.ok && !r.version) setStatus('up-to-date');
      // 'available'/'downloading'/'downloaded' arrive via onUpdateStatus events.
    } catch { setStatus('error'); }
  };

  const badge = {
    'idle':        { text: `🟢 v${version || '—'}`,        bg:'#f0f0f0', fg:'#555' },
    'checking':    { text: '🔄 Checking…',                 bg:'#eff6ff', fg:'#1d4ed8' },
    'up-to-date':  { text: '✅ Up to date',                bg:'#dcfce7', fg:'#15803d' },
    'available':   { text: '⬇️ Update found — downloading', bg:'#eff6ff', fg:'#1d4ed8' },
    'downloading': { text: `⬇️ Downloading ${percent}%`,   bg:'#eff6ff', fg:'#1d4ed8' },
    'downloaded':  { text: '✨ Update ready',              bg:'#fef9c3', fg:'#854d0e' },
    'error':       { text: '⚠️ Check failed',              bg:'#fee2e2', fg:'#991b1b' },
  }[status] || { text: `🟢 v${version || '—'}`, bg:'#f0f0f0', fg:'#555' };

  const busy = status === 'checking' || status === 'downloading' || status === 'available';

  return (
    <div style={cardStyle}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8, flexWrap:'wrap' }}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', margin:0 }}>⬆️ App &amp; Updates</h2>
        <span style={{ fontSize:11, fontWeight:700, color:badge.fg, background:badge.bg, padding:'3px 9px', borderRadius:12 }}>
          {badge.text}
        </span>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:14, lineHeight:1.5 }}>
        SiamEPOS Pro keeps itself up to date automatically — new versions download quietly in the
        background and apply when you restart. You don't need to do anything; this is just so you
        can see what's running and check on demand.
      </p>

      <div style={{ background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:10, padding:14 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:12, color:'#888' }}>Installed version</div>
            <div style={{ fontSize:18, fontWeight:800, color:'var(--brand-primary, #1a1a2e)' }}>v{version || '—'}</div>
            {lastChecked && (
              <div style={{ fontSize:11, color:'#aaa', marginTop:2 }}>
                Last checked {lastChecked.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
              </div>
            )}
          </div>

          {status === 'downloaded' ? (
            <button onClick={() => sep.restartToUpdate && sep.restartToUpdate()}
              style={{ padding:'10px 18px', borderRadius:8, border:'none', background:'#16a34a', color:'white', fontWeight:800, fontSize:14, cursor:'pointer' }}>
              ✨ Restart to update{newVersion ? ` → v${newVersion}` : ''}
            </button>
          ) : (
            <button onClick={check} disabled={busy}
              style={{ padding:'10px 18px', borderRadius:8, border:'1px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontWeight:700, fontSize:13, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}>
              {status === 'checking' ? 'Checking…' : '🔄 Check for updates'}
            </button>
          )}
        </div>

        {status === 'downloading' && (
          <div style={{ marginTop:12, height:8, background:'#e5e7eb', borderRadius:6, overflow:'hidden' }}>
            <div style={{ width:`${percent}%`, height:'100%', background:'#2563eb', transition:'width 0.3s' }} />
          </div>
        )}
        {status === 'available' && (
          <div style={{ marginTop:10, fontSize:12, color:'#1d4ed8' }}>
            New version{newVersion ? ` v${newVersion}` : ''} found — downloading now. You'll get a “Restart to update” button when it's ready.
          </div>
        )}
        {status === 'error' && (
          <div style={{ marginTop:10, fontSize:12, color:'#991b1b' }}>
            Couldn't complete the update check. The app will try again automatically — check your internet connection.
            {errMsg && (
              <div style={{ marginTop:6, fontFamily:'Menlo,Consolas,monospace', fontSize:11, color:'#b45309', wordBreak:'break-word' }}>
                {errMsg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SEPOS-LOCAL-001 Phase 6 — Remote Access (Cloudflare Tunnel) ─────
function RemoteAccessCard({ cardStyle }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => { try { const s = await getTunnelStatus(); if (!stopped) setInfo(s); } catch { if (!stopped) setInfo({ error: true }); } };
    tick();
    const iv = setInterval(tick, 10000);
    return () => { stopped = true; clearInterval(iv); };
  }, []);
  if (!info) return null;
  const enabled = !!info.enabled;
  const running = info.status === 'running';
  const url     = info.remote_url || '';
  return (
    <div style={cardStyle}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', margin:0 }}>🌐 Remote Access</h2>
        <span style={{ fontSize:11, fontWeight:700, color: running ? '#15803d' : '#888', background: running ? '#dcfce7' : '#f0f0f0', padding:'3px 9px', borderRadius:12 }}>
          {running ? '🟢 Tunnel active' : enabled ? '🟡 Starting…' : '⚫ Disabled'}
        </span>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:14, lineHeight:1.5 }}>
        Owner can log in from anywhere and see live data direct from this device. Protected by a Cloudflare Access email gate — no data leaves the device.
      </p>
      {!enabled && (
        <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'12px 14px', fontSize:13, color:'#0369a1', lineHeight:1.5 }}>
          Remote access is provisioned per-restaurant by SiamEPOS. Contact <strong>info@siamepos.co.uk</strong> to enable it for this install — Korakot will add a Cloudflare Tunnel credentials file to your config and the tunnel will come online on the next launch.
        </div>
      )}
      {enabled && (
        <div style={{ background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:10, padding:14 }}>
          <div style={{ fontSize:12, color:'#888', marginBottom:4 }}>Your remote URL</div>
          <div style={{ fontSize:14, fontFamily:'Menlo,Consolas,monospace', color:'var(--brand-primary, #1a1a2e)', wordBreak:'break-all' }}>{url || '—'}</div>
          {url && (
            <button onClick={() => navigator.clipboard?.writeText(url)}
              style={{ marginTop:10, padding:'8px 14px', borderRadius:8, border:'1px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontWeight:700, fontSize:12, cursor:'pointer' }}>
              🔗 Copy link
            </button>
          )}
          {info.error && <div style={{ fontSize:12, color:'#991b1b', marginTop:8 }}>⚠ {info.error}</div>}
        </div>
      )}
    </div>
  );
}

// ── SEPOS-LOCAL-001 Phase 1 — Local HMRC Archive card ───────────────
// Shows where archive files are saved + last archive timestamp + a
// short list of recent PDFs so the operator can sanity-check that
// records are landing on disk. Three actions: open the folder in
// Finder, re-archive today, re-archive yesterday.
function LocalArchiveCard({ cardStyle }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [toast, setToast]   = useState('');
  // SEPOS-Z-REPLACE — rebuild the saved file for ANY past day (after amending
  // an old bill + re-running its Z, that day's archive file needs a rebuild).
  const [reDate, setReDate] = useState('');

  const refresh = async () => {
    try { setStatus(await getArchiveStatus()); } catch { setStatus({ error: true }); }
  };
  useEffect(() => { refresh(); }, []);

  if (!status) {
    return (
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>🗄️ Local Archive</h2>
        <p style={{ fontSize:13, color:'#888' }}>Checking…</p>
      </div>
    );
  }

  const isLocal = status.local_install;
  const lastIso = status.last_archived ? new Date(status.last_archived) : null;
  const lastStr = lastIso ? lastIso.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No archives yet';

  const doRun = async (label, dateOffset) => {
    setBusy(true); setToast('');
    try {
      const d = new Date(); d.setDate(d.getDate() - dateOffset);
      const date = d.toISOString().slice(0, 10);
      const r = await runArchive(date, true);
      if (r?.ok) setToast(`✓ ${label} archived — ${r.pdf?.path?.split('/').slice(-2).join('/') || ''}`);
      else      setToast(`⚠ ${label} skipped — ${r?.reason || 'unknown'}`);
      await refresh();
    } catch (e) { setToast(`✗ ${label} failed — ${e.message}`); }
    finally { setBusy(false); setTimeout(() => setToast(''), 5000); }
  };

  return (
    <div style={cardStyle}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', margin:0 }}>🗄️ Local Archive</h2>
        <span style={{ fontSize:11, fontWeight:700, color:'#15803d', background:'#dcfce7', padding:'3px 9px', borderRadius:12 }}>
          {isLocal ? 'Auto-archive: ON' : 'Cloud install'}
        </span>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:16, lineHeight:1.5 }}>
        Bills CSV and branded Z-report PDF are saved to this device after every Z-report close + on app startup.
        Keep for <strong>6 years</strong> for HMRC compliance.
      </p>

      {!isLocal ? (
        <div style={{ background:'#fef3c7', color:'#92400e', padding:'10px 14px', borderRadius:8, fontSize:13 }}>
          This install runs against the cloud database, not a local SQLite. Archive is only generated by the SiamEPOS desktop app (Mac or Windows install).
        </div>
      ) : (
        <>
          <div style={{ background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:10, padding:14, marginBottom:14 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
              <span style={{ fontSize:12, color:'#888' }}>Last archived</span>
              <span style={{ fontSize:13, fontWeight:600, color:'var(--brand-primary, #1a1a2e)' }}>{lastStr}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <span style={{ fontSize:12, color:'#888' }}>Folder</span>
              <span style={{ fontSize:12, fontFamily:'Menlo,Consolas,monospace', color:'#555', textAlign:'right', maxWidth:'70%', wordBreak:'break-all' }}>{status.dir}</span>
            </div>
          </div>

          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
            <button onClick={async () => { try { await openArchiveFolder(); } catch {} }}
              style={{ padding:'9px 16px', borderRadius:8, border:'1px solid var(--brand-primary, #1a1a2e)', background:'var(--brand-primary, #1a1a2e)', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              📂 Open Folder
            </button>
            <button onClick={() => doRun('Today', 0)} disabled={busy}
              style={{ padding:'9px 16px', borderRadius:8, border:'1px solid var(--brand-accent,#C9A84C)', background:'white', color:'#5b4a2a', fontWeight:700, fontSize:13, cursor:'pointer', opacity: busy ? 0.5 : 1 }}>
              🗄️ Re-archive Today
            </button>
            <button onClick={() => doRun('Yesterday', 1)} disabled={busy}
              style={{ padding:'9px 16px', borderRadius:8, border:'1px solid #ddd', background:'white', color:'#555', fontWeight:700, fontSize:13, cursor:'pointer', opacity: busy ? 0.5 : 1 }}>
              ↺ Re-archive Yesterday
            </button>
          </div>

          {/* SEPOS-Z-REPLACE — any past day: after correcting an old bill and
              re-running that day's Z, rebuild that day's saved file here. */}
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:12 }}>
            <input type="date" value={reDate} onChange={e => setReDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              style={{ padding:'8px 10px', borderRadius:8, border:'1px solid #ddd', fontSize:13 }} />
            <button
              onClick={async () => {
                if (!reDate) return;
                setBusy(true); setToast('');
                try {
                  const r = await runArchive(reDate, true);
                  if (r?.ok) setToast(`✓ ${reDate.split('-').reverse().join('/')} archived — file rebuilt with current figures`);
                  else       setToast(`⚠ ${reDate.split('-').reverse().join('/')} skipped — ${r?.reason || 'unknown'}`);
                  await refresh();
                } catch (e) { setToast(`✗ Re-archive failed — ${e.message}`); }
                finally { setBusy(false); setTimeout(() => setToast(''), 6000); }
              }}
              disabled={busy || !reDate}
              style={{ padding:'9px 16px', borderRadius:8, border:'1px solid #ddd', background:'white', color:'#555', fontWeight:700, fontSize:13, cursor: (busy || !reDate) ? 'not-allowed' : 'pointer', opacity: (busy || !reDate) ? 0.5 : 1 }}>
              📅 Re-archive that date
            </button>
            <span style={{ fontSize:11, color:'#aaa' }}>Fixed an old bill? Rebuild that day's saved file.</span>
          </div>

          {toast && (
            <div style={{ background:toast.startsWith('✓')?'#dcfce7':toast.startsWith('✗')?'#fee2e2':'#fef3c7',
                          color:toast.startsWith('✓')?'#15803d':toast.startsWith('✗')?'#991b1b':'#92400e',
                          padding:'10px 12px', borderRadius:8, fontSize:13, marginBottom:12 }}>
              {toast}
            </div>
          )}

          {status.recent && status.recent.length > 0 && (
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>Recent files</div>
              <div style={{ background:'white', border:'1px solid #f0f0f0', borderRadius:8 }}>
                {status.recent.slice(0, 6).map((f, i) => (
                  <div key={f.path} style={{ padding:'9px 12px', borderBottom: i < Math.min(status.recent.length, 6) - 1 ? '1px solid #f0f0f0' : 'none', fontSize:13, display:'flex', justifyContent:'space-between' }}>
                    <span style={{ color:'var(--brand-primary, #1a1a2e)', fontFamily:'Menlo,Consolas,monospace' }}>{f.file}</span>
                    <span style={{ color:'#888', fontSize:11 }}>{new Date(f.mtime).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Network setup panel — shows the desktop's LAN URL + a scannable QR so
// kitchen / bar tablets can be pointed at this server without typing.
// Replaces the old auto-popup that used to fire on first Electron launch.
function NetworkSetupCard({ cardStyle }) {
  const [info, setInfo] = useState(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [testState, setTestState] = useState('idle'); // idle | testing | ok | fail

  useEffect(() => {
    let cancelled = false;
    getNetworkInfo()
      .then(async (n) => {
        if (cancelled || !n?.url) return;
        setInfo(n);
        try {
          const dataUrl = await QRCode.toDataURL(n.url, {
            width: 220, margin: 1, errorCorrectionLevel: 'M',
            color: { dark: brandQrDark(), light: '#FFFFFF' },
          });
          if (!cancelled) setQr(dataUrl);
        } catch (err) { console.warn('[network-setup] QR failed:', err); }
      })
      .catch((err) => console.warn('[network-setup] info failed:', err));
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;
  // The cloud (Railway) server reports its datacenter container IP (e.g.
  // 10.x:8080) — a real address, but useless as a LAN host. In the cloud web
  // app there's nothing to point tablets at over the LAN (they just open the
  // same cloud URL), so show the cloud "any device" QR instead of a bogus LAN
  // address. Desktop / Sunmi-host installs report local:true and keep the LAN
  // card. (Old desktop servers send no `local` field → undefined → LAN card,
  // which is correct for them.)
  if (info.local === false) return <AddTillCard cardStyle={cardStyle} />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Probes the LAN URL — confirms the server answers on the same address
  // that's printed in the QR. Doesn't guarantee an iPad on another segment
  // can reach it (firewall / VLAN), but catches typos and stopped servers.
  const testConnection = async () => {
    setTestState('testing');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(info.url + '/api/sync-status', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      setTestState(r.ok ? 'ok' : 'fail');
    } catch {
      setTestState('fail');
    }
    setTimeout(() => setTestState('idle'), 3000);
  };

  const testLabel = testState === 'testing' ? 'Testing…'
                  : testState === 'ok'      ? '✓ Reachable'
                  : testState === 'fail'    ? '✗ No response'
                  : 'Test connection';
  const testBg    = testState === 'ok'   ? '#22c55e'
                  : testState === 'fail' ? '#ef4444'
                  : 'rgba(255,255,255,0)';
  const testColor = testState === 'ok' || testState === 'fail' ? 'white' : 'var(--brand-primary,#0D1B3E)';
  const testBorder = testState === 'ok' || testState === 'fail' ? 'none' : '1px solid var(--brand-primary,#0D1B3E)';

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>📱 Network Setup</h2>
      <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>
        Connect kitchen and bar tablets on the same Wi-Fi.
      </p>
      <div style={{ display:'flex', gap:20, alignItems:'flex-start', flexWrap:'wrap' }}>
        <div style={{ flex:1, minWidth:240 }}>
          <div style={{
            background:'var(--brand-primary,#0D1B3E)', color:'var(--brand-accent,#C9A84C)', padding:'14px 18px',
            borderRadius:10, fontFamily:'Menlo, Consolas, monospace',
            fontSize:16, fontWeight:800, textAlign:'center',
            marginBottom:12, userSelect:'text', wordBreak:'break-all'
          }}>
            {info.url}
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={copy} style={{
              padding:'10px 20px', borderRadius:8, border:'none',
              background: copied ? '#22c55e' : 'var(--brand-accent,#C9A84C)',
              color: copied ? 'white' : 'var(--brand-primary,#0D1B3E)',
              fontWeight:700, cursor:'pointer', fontSize:13
            }}>
              {copied ? '✓ Copied' : 'Copy URL'}
            </button>
            <button onClick={testConnection} disabled={testState==='testing'} style={{
              padding:'10px 20px', borderRadius:8,
              border: testBorder, background: testBg,
              color: testColor, fontWeight:700,
              cursor: testState==='testing' ? 'wait' : 'pointer',
              fontSize:13, transition:'background 0.2s, color 0.2s',
            }}>
              {testLabel}
            </button>
          </div>
          <div style={{ fontSize:12, color:'#888', marginTop:12, lineHeight:1.5 }}>
            On each tablet: open Camera, scan the QR, tap the SiamEPOS link in Safari.
            Then Share → <strong>Add to Home Screen</strong> for one-tap access.
          </div>
        </div>
        {qr && (
          <div style={{ background:'white', padding:10, borderRadius:10, border:'1px solid #eee', flexShrink:0 }}>
            <img src={qr} alt={`QR code for ${info.url}`}
                 style={{ width:200, height:200, display:'block' }} />
          </div>
        )}
      </div>
    </div>
  );
}

function BarCategoryManager() {
  const [categories, setCategories] = useState([]);
  useEffect(() => { getCategories().then(setCategories); }, []);

  // SEPOS-046y — optimistic toggles, refetch only on error rollback
  const toggleBar = async (cat) => {
    const next = cat.is_bar ? 0 : 1;
    setCategories(prev => prev.map(c => c.id === cat.id ? { ...c, is_bar: next } : c));
    try { assertOk(await updateCategoryBar(cat.id, next)); }
    catch { alert('Could not update — check connection.'); getCategories().then(setCategories); }
  };
  const setDefaultCourse = async (cat, course) => {
    setCategories(prev => prev.map(c => c.id === cat.id ? { ...c, default_course: course } : c));
    try { assertOk(await updateCategoryDefaultCourse(cat.id, course)); }
    catch { alert('Could not update — check connection.'); getCategories().then(setCategories); }
  };
  const courseColors = { 1:'#3b82f6', 2:'#e94560', 3:'#8b5cf6', 4:'#22c55e' };
  const courseLabels = { 1:'Starters', 2:'Mains', 3:'Desserts', 4:'Extra' };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ background:'#f8f8f8', borderRadius:10, padding:'12px 16px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:cat.is_bar?0:10 }}>
            <span style={{ fontSize:14, fontWeight:700, color:'var(--brand-primary, #1a1a2e)' }}>{cat.name}</span>
            <button onClick={() => toggleBar(cat)} style={{ padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:600, fontSize:12, background:cat.is_bar?'#dbeafe':'#f0f0f0', color:cat.is_bar?'#1e40af':'#555' }}>{cat.is_bar?'🍹 Bar ✓':'Not bar'}</button>
          </div>
          {!cat.is_bar && (
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:'#888', marginBottom:6, textTransform:'uppercase' }}>Default course when ordering:</div>
              <div style={{ display:'flex', gap:6 }}>
                {[1,2,3,4].map(c => (
                  <button key={c} onClick={() => setDefaultCourse(cat,c)} style={{ padding:'6px 14px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:12, background:(cat.default_course||1)===c?courseColors[c]:'#e0e0e0', color:(cat.default_course||1)===c?'white':'#555' }}>{courseLabels[c]}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}


export default function SettingsSection() {
  const [settings, setSettings] = useState({
    company_name:            '',
    company_address:         '',
    company_phone:           '',
    company_email:           '',
    company_vat:             '',
    company_logo:            '',
    receipt_logo_size:       'medium',   // 'small' | 'medium' | 'large' | 'full'
    google_review_url:       '',
    receipt_footer:          'Thank you for dining with us!',
    service_charge_rate:     '12.5',
    service_charge_enabled:  '1',
    till_send_lock:          '1',   // SEPOS-TILL-LOCK-001 — back to sign-in after sending an order
    login_pin_only:          '0',   // SEPOS-PINONLY-001 — skip the name grid; PIN identifies the staff
    kitchen_bar_as_waiters:  '1',   // SEPOS-KB-WAITER-001 — DEFAULT ON; KDS venues (Fern) untick
    till_idle_minutes:       '2',   // SEPOS-TILL-LOCK-001 — auto sign-out after idle ('0' = off)
    nav_show_reservations:   '1',   // SEPOS-NAV-HIDE-001 — navbar tab visibility, default all shown
    nav_show_kitchen:        '1',
    nav_show_bar:            '1',
    nav_show_tables:         '1',   // home guard: tables + counter can never BOTH be hidden
    nav_show_counter:        '1',
    online_order_chime:      '1',   // SEPOS-ORDER-CHIME-001 — repeat-until-ack arrival sound, default ON
    qr_payment_policy:       'pay_first',   // SEPOS-QR-PAYLATER-001 — QR table ordering: pay_first | pay_later
    takeaway_pay_mode:       '',            // SEPOS-TA-CHOICE-001 — '' auto | 'collection' | 'choice'
    takeaway_discount_min_total: '',        // SEPOS-TA-PROMO-001 — promo spend threshold (£)
    kitchen_print_mode:      'print',   // 'print' | 'kds' | 'both'
    kitchen_language:        'en_th',  // 'en_th' | 'en'
    brand_logo:              '',   // SEPOS-BRAND-001 — on-screen logo (separate from receipt logo)
    brand_logo_size:         'large', // SEPOS-BRAND-001 — login/header logo size: 'small'|'medium'|'large'|'xl'
    brand_primary:           '',   // theme primary colour (blank = default navy)
    brand_accent:            '',   // theme accent colour (blank = default gold)
  });
  const [reasons, setReasons]     = useState([]);
  const [newReason, setNewReason] = useState('');
  const [saved, setSaved]         = useState(false);
  const [logoPreview, setLogoPreview] = useState('');
  // SEPOS-OSK-002 — per-device on-screen-keyboard mode (localStorage, not the
  // tenant settings, because it depends on THIS device's hardware).
  const [oskMode, setOskMode] = useState(() => {
    try {
      const m = localStorage.getItem('onscreen_keyboard_mode');
      if (m === 'off' || m === 'on' || m === 'auto') return m;
      if (localStorage.getItem('onscreen_keyboard') === '0') return 'off';
    } catch {}
    return 'auto';
  });
  // SEPOS-REVIEW-QR — render the ACTUAL review QR in the Receipt Preview (was
  // a placeholder line; the operator couldn't tell what would print). Debounced
  // so it redraws as the link is typed.
  const [reviewQr, setReviewQr] = useState('');
  useEffect(() => {
    let cancelled = false;
    const url = (settings.google_review_url || '').trim();
    if (!url) { setReviewQr(''); return; }
    const id = setTimeout(() => {
      QRCode.toDataURL(url, { width: 120, margin: 0, color: { dark: '#000000', light: '#FFFFFF' } })
        .then(d => { if (!cancelled) setReviewQr(d); })
        .catch(() => { if (!cancelled) setReviewQr(''); });
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [settings.google_review_url]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    getSettings().then(async (s) => {
      // Support both old key (service_charge_percent) and new key (service_charge_rate)
      const rate = s.service_charge_rate || s.service_charge_percent || '12.5';
      setSettings(prev => ({ ...prev, ...s, service_charge_rate: rate }));
      if (s.company_logo) setLogoPreview(s.company_logo);
      // Auto-convert / auto-rebuild:
      //   • If the bitmap is MISSING — first-time backfill from the
      //     stored data-URL.
      //   • If the bitmap is PRESENT but stamped with the OLD threshold
      //     algorithm (v1.6.21 and earlier), rebuild so the new "ink
      //     the faded bottom too" logic takes effect. We mark the new
      //     algorithm by setting company_logo_bitmap_rev='2' on save.
      const isOldRev = s.company_logo_bitmap && s.company_logo_bitmap_rev !== '2';
      const needsRebuild = s.company_logo
        && (!s.company_logo_bitmap || isOldRev);
      if (needsRebuild) {
        try {
          const bmp = await imageToThermalBitmap(s.company_logo, sizeToWidth(s.receipt_logo_size || 'medium'));
          await updateSettings({
            company_logo_bitmap:        bmp.b64,
            company_logo_bitmap_width:  String(bmp.widthBytes),
            company_logo_bitmap_height: String(bmp.height),
            company_logo_bitmap_rev:    '2',
          });
          setSettings(prev => ({
            ...prev,
            company_logo_bitmap:        bmp.b64,
            company_logo_bitmap_width:  String(bmp.widthBytes),
            company_logo_bitmap_height: String(bmp.height),
            company_logo_bitmap_rev:    '2',
          }));
          setBitmapPreview(bmp.previewDataUrl);
          setBitmapInkPct(bmp.inkPct);
          console.log(`[settings] logo bitmap ${isOldRev ? 'rebuilt with v2 threshold algorithm' : 'auto-generated'} (${bmp.inkedDots} inked dots, ${bmp.inkPct.toFixed(1)}%)`);
        } catch (err) {
          console.warn('[settings] logo bitmap auto-generate failed:', err);
        }
      } else if (s.company_logo_bitmap && s.company_logo_bitmap_width && s.company_logo_bitmap_height) {
        // Already-saved bitmap — render preview from the existing bytes
        try {
          const data = atob(s.company_logo_bitmap);
          const wBytes = parseInt(s.company_logo_bitmap_width, 10);
          const hDots  = parseInt(s.company_logo_bitmap_height, 10);
          const dotsW = wBytes * 8;
          const pc = document.createElement('canvas');
          pc.width = dotsW; pc.height = hDots;
          const pctx = pc.getContext('2d');
          const imgData = pctx.createImageData(dotsW, hDots);
          let inked = 0;
          for (let y = 0; y < hDots; y++) {
            for (let x = 0; x < dotsW; x++) {
              const byte = data.charCodeAt(y * wBytes + (x >> 3));
              const black = (byte & (1 << (7 - (x & 7)))) !== 0;
              if (black) inked++;
              const i = (y * dotsW + x) * 4;
              imgData.data[i] = imgData.data[i + 1] = imgData.data[i + 2] = black ? 0 : 255;
              imgData.data[i + 3] = 255;
            }
          }
          pctx.putImageData(imgData, 0, 0);
          setBitmapPreview(pc.toDataURL('image/png'));
          setBitmapInkPct((inked * 100) / (dotsW * hDots));
        } catch (err) { console.warn('[settings] preview render failed:', err); }
      }
    });
    getDiscountReasons().then(setReasons);
  }, []);

  // SEPOS-046y — optimistic save. The form state already IS the desired
  // state, so flip the button to ✓ Saved immediately and let the PUT run
  // in background (SEPOS-050's enqueue-then-push makes it durable on
  // desktop). Surface an alert only if the request fails outright.
  const handleSave = () => {
    setSaved(true);
    applyBrandTheme(settings); // SEPOS-BRAND-001 — repaint the app immediately on save
    setTimeout(() => setSaved(false), 2500);
    updateSettings(settings).then(assertOk).catch(err => {
      setSaved(false);
      alert('Save failed: ' + (err?.message || 'unknown') + ' — please try again.');
    });
  };

  // Convert a colour image data-URL to a monochrome ESC/POS bitmap
  // (1 bit per pixel, MSB-first, packed) centered horizontally on the
  // 384-dot paper width. Returns { b64, widthBytes, height, inkPct,
  // previewDataUrl } for embedding into receipt prints via GS v 0.
  //
  // Robustness measures (after the all-zeros incident on 27 May 2026):
  //   1. await img.decode() instead of img.onload — large data URLs
  //      can fire onload before the pixel buffer is ready, leaving
  //      canvas.drawImage with nothing to read.
  //   2. Threshold escalation: try 180, 200, 220 in turn until at
  //      least 100 dots are inked. Most brand logos render at 180;
  //      pastel / washed-out brands need 200+.
  //   3. Centered padding to full 384 dots so the printed image sits
  //      visually centered on the paper (raster GS v 0 ignores the
  //      ESC a 1 align command on most ESC/POS firmwares).
  //   4. Returns a preview data-URL so the operator can SEE what'll
  //      actually print before saving.
  async function imageToThermalBitmap(dataUrl, contentWidthDots = 288) {
    const PAPER_DOTS = 384;
    const img = new Image();
    img.src = dataUrl;
    // decode() guarantees the pixel buffer is ready (vs onload which
    // can fire prematurely on big data URLs in some browsers).
    if (img.decode) {
      await img.decode();
    } else {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
      });
    }
    const scale = Math.min(1, contentWidthDots / img.width);
    const drawW = Math.floor(img.width  * scale);
    const drawH = Math.floor(img.height * scale);
    const xOffset = Math.floor((PAPER_DOTS - drawW) / 2);
    const canvas = document.createElement('canvas');
    canvas.width  = PAPER_DOTS;
    canvas.height = drawH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, PAPER_DOTS, drawH);
    ctx.drawImage(img, xOffset, 0, drawW, drawH);
    const pixels = ctx.getImageData(0, 0, PAPER_DOTS, drawH).data;
    const widthBytes = PAPER_DOTS / 8;

    // Threshold escalation — try a series of cutoffs and pick the most
    // aggressive one that still keeps the receipt readable. v1.6.22 fix:
    // the old loop stopped at 180 as soon as ≥100 dots were inked, so a
    // logo whose TOP is dark but BOTTOM fades to grey (like Baan Siam's
    // lotus) printed only the top half — the faded lower rows had grey
    // values >180 and were never inked. New rules:
    //   • Keep escalating while the bottom 25% of rows still have less
    //     than ~30% of their rows showing ink.
    //   • Stop early if total ink crosses 45% (we'd flood the paper).
    //   • Cap at 252 (anything above is pure white background).
    let bytes = null, inkedDots = 0;
    let chosenThreshold = 180;
    const bottomStart = Math.floor(drawH * 0.75);
    for (const threshold of [180, 200, 220, 235, 245, 252]) {
      const tryBytes = new Uint8Array(widthBytes * drawH);
      let tryInked = 0;
      let bottomRowsWithInk = 0;
      for (let y = 0; y < drawH; y++) {
        let rowInked = false;
        for (let x = 0; x < PAPER_DOTS; x++) {
          const i = (y * PAPER_DOTS + x) * 4;
          const a = pixels[i + 3];
          const grey = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          if (a >= 128 && grey < threshold) {
            tryBytes[y * widthBytes + (x >> 3)] |= (1 << (7 - (x & 7)));
            tryInked++;
            rowInked = true;
          }
        }
        if (y >= bottomStart && rowInked) bottomRowsWithInk++;
      }
      const tryPct = tryInked / (drawH * PAPER_DOTS);
      // If we'd flood the paper, keep the last good attempt.
      if (tryPct > 0.45 && bytes) break;
      bytes = tryBytes;
      inkedDots = tryInked;
      chosenThreshold = threshold;
      const bottomDenom = Math.max(1, drawH - bottomStart);
      const bottomCoverage = bottomRowsWithInk / bottomDenom;
      // Done when the bottom rows are visibly inked AND we have enough
      // total ink. If the bottom is still blank, escalate.
      if (inkedDots >= 100 && bottomCoverage >= 0.3) break;
    }
    // Fallback safety: if no iteration produced anything (impossible
    // unless the image is fully transparent), zero-out the bitmap.
    if (!bytes) bytes = new Uint8Array(widthBytes * drawH);
    const inkPct = (inkedDots * 100) / (PAPER_DOTS * drawH);

    // Build a preview data-URL (render the 1-bit bitmap back to a
    // canvas at native size so operator sees the actual ink-or-white
    // each pixel will produce on paper).
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width  = PAPER_DOTS;
    previewCanvas.height = drawH;
    const pctx = previewCanvas.getContext('2d');
    const previewImg = pctx.createImageData(PAPER_DOTS, drawH);
    for (let y = 0; y < drawH; y++) {
      for (let x = 0; x < PAPER_DOTS; x++) {
        const black = (bytes[y * widthBytes + (x >> 3)] & (1 << (7 - (x & 7)))) !== 0;
        const i = (y * PAPER_DOTS + x) * 4;
        previewImg.data[i] = previewImg.data[i + 1] = previewImg.data[i + 2] = black ? 0 : 255;
        previewImg.data[i + 3] = 255;
      }
    }
    pctx.putImageData(previewImg, 0, 0);

    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return {
      b64: btoa(bin),
      widthBytes,
      height: drawH,
      inkPct,
      inkedDots,
      previewDataUrl: previewCanvas.toDataURL('image/png'),
    };
  }
  const sizeToWidth = (s) => ({ small: 192, medium: 288, large: 384, full: 384 }[s] || 288);
  const [bitmapPreview, setBitmapPreview] = useState(''); // dataUrl
  const [bitmapInkPct, setBitmapInkPct] = useState(null);

  // SEPOS-046y — optimistic add with the temp-id pattern: chip appears
  // instantly, server id patched in from the POST response, removed on error.
  const handleAddReason = async () => {
    const trimmed = newReason.trim();
    if (!trimmed) return;
    setNewReason('');
    const tempId = -Date.now();
    setReasons(prev => [...prev, { id: tempId, reason: trimmed }]);
    try {
      const res = assertOk(await addDiscountReason(trimmed));
      if (res?.id) setReasons(prev => prev.map(x => x.id === tempId ? { ...x, id: res.id } : x));
    } catch {
      alert('Could not add — check connection.');
      setNewReason(trimmed);
      setReasons(prev => prev.filter(x => x.id !== tempId));
    }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 500000) {
      alert('Logo file is large. For best results use a PNG under 200KB.');
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      setLogoPreview(dataUrl);
      try {
        const bmp = await imageToThermalBitmap(dataUrl, sizeToWidth(settings.receipt_logo_size || 'medium'));
        setSettings(prev => ({
          ...prev,
          company_logo: dataUrl,
          company_logo_bitmap:        bmp.b64,
          company_logo_bitmap_width:  String(bmp.widthBytes),
          company_logo_bitmap_height: String(bmp.height),
        }));
        setBitmapPreview(bmp.previewDataUrl);
        setBitmapInkPct(bmp.inkPct);
        if (bmp.inkedDots < 100) {
          alert(`Logo conversion produced only ${bmp.inkedDots} inked dots — the print will look very faint. Try uploading a higher-contrast version (dark logo on white background).`);
        }
      } catch (err) {
        alert('Could not convert logo for thermal printer: ' + err.message);
        setSettings(prev => ({ ...prev, company_logo: dataUrl }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoPreview('');
    setBitmapPreview('');
    setBitmapInkPct(null);
    setSettings(prev => ({
      ...prev,
      company_logo: '',
      company_logo_bitmap: '',
      company_logo_bitmap_width: '',
      company_logo_bitmap_height: '',
    }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const inputStyle = { width:'100%', padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, boxSizing:'border-box' };
  // SEPOS-BRAND-001 — on-screen brand logo (base64 data URL, no thermal
  // conversion — this one's for the app, not the receipt).
  const handleBrandLogoUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 400 * 1024) alert('That logo is a bit large — a PNG/SVG under ~400KB works best.');
    const reader = new FileReader();
    reader.onload = () => setSettings(prev => ({ ...prev, brand_logo: reader.result }));
    reader.readAsDataURL(file);
  };

  const labelStyle = { fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:6 };
  const cardStyle  = { background:'white', borderRadius:12, padding:24, marginBottom:20, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };

  return (
    <div style={{ padding:24, paddingBottom:SAVE_BAR_CLEARANCE, maxWidth:640 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:24 }}>Settings</h1>

      {/* ── Branding (app appearance) ── SEPOS-BRAND-001 ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>🎨 Branding</h2>
        <div style={{ fontSize:12.5, color:'#888', marginBottom:16 }}>Your logo + colours across the app. This is the <strong>on-screen</strong> logo — separate from the receipt logo further down, so a light or colourful logo here still prints cleanly on bills.</div>

        {/* Brand logo */}
        <label style={labelStyle}>App logo (login &amp; headers)</label>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:20 }}>
          <div style={{ width:80, height:80, borderRadius:12, background: settings.brand_primary || DEFAULT_PRIMARY, display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', flexShrink:0 }}>
            {settings.brand_logo
              ? <img src={settings.brand_logo} alt="" style={{ maxWidth:'86%', maxHeight:'86%', objectFit:'contain' }} />
              : <span style={{ color:'#fff', opacity:0.5, fontSize:11 }}>no logo</span>}
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <label style={{ padding:'8px 16px', borderRadius:8, background:'var(--brand-primary, #1a1a2e)', color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
              📁 Choose logo
              <input type="file" accept="image/*" onChange={handleBrandLogoUpload} style={{ display:'none' }} />
            </label>
            {settings.brand_logo && (
              <button onClick={() => setSettings(prev => ({ ...prev, brand_logo:'' }))} style={{ padding:'6px 14px', borderRadius:8, border:'none', background:'#fee2e2', color:'#ef4444', fontSize:12, fontWeight:700, cursor:'pointer' }}>🗑 Remove</button>
            )}
          </div>
        </div>

        {/* SEPOS-BRAND-001 — on-screen logo size (login + headers). Per-client,
            like the receipt logo size below. */}
        <label style={labelStyle}>App logo size</label>
        <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
          {[['small','Small'],['medium','Medium'],['large','Large'],['xl','Extra Large']].map(([val, lbl]) => (
            <button key={val} onClick={() => setSettings(s => ({ ...s, brand_logo_size: val }))}
              style={{ padding:'7px 15px', borderRadius:8, border:'2px solid', fontSize:13, fontWeight:700, cursor:'pointer',
                borderColor: (settings.brand_logo_size || 'large') === val ? 'var(--brand-primary, #1a1a2e)' : '#ddd',
                background:  (settings.brand_logo_size || 'large') === val ? 'var(--brand-primary, #1a1a2e)' : 'white',
                color:       (settings.brand_logo_size || 'large') === val ? 'white' : '#555' }}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Colour presets */}
        <label style={labelStyle}>Colour theme</label>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
          {BRAND_PRESETS.map(p => {
            const active = (settings.brand_primary || DEFAULT_PRIMARY).toLowerCase() === p.primary.toLowerCase()
              && (settings.brand_accent || DEFAULT_ACCENT).toLowerCase() === p.accent.toLowerCase();
            return (
              <button key={p.name} title={p.name} onClick={() => setSettings(prev => ({ ...prev, brand_primary:p.primary, brand_accent:p.accent }))}
                style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 9px', borderRadius:8, border:`2px solid ${active ? 'var(--brand-primary, #1a1a2e)' : '#e5e5e5'}`, background:'#fff', cursor:'pointer' }}>
                <span style={{ width:15, height:15, borderRadius:4, background:p.primary }} />
                <span style={{ width:15, height:15, borderRadius:4, background:p.accent }} />
              </button>
            );
          })}
        </div>

        {/* Custom colours */}
        <div style={{ display:'flex', gap:20, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={labelStyle}>Primary</label>
            <input type="color" value={settings.brand_primary || DEFAULT_PRIMARY} onChange={e => setSettings(prev => ({ ...prev, brand_primary:e.target.value }))} style={{ width:52, height:40, border:'1px solid #ddd', borderRadius:8, cursor:'pointer', background:'none' }} />
          </div>
          <div>
            <label style={labelStyle}>Accent</label>
            <input type="color" value={settings.brand_accent || DEFAULT_ACCENT} onChange={e => setSettings(prev => ({ ...prev, brand_accent:e.target.value }))} style={{ width:52, height:40, border:'1px solid #ddd', borderRadius:8, cursor:'pointer', background:'none' }} />
          </div>
          <button onClick={() => setSettings(prev => ({ ...prev, brand_primary:'', brand_accent:'' }))} style={{ padding:'8px 14px', borderRadius:8, border:'1px solid #ddd', background:'#fff', fontSize:12, fontWeight:600, cursor:'pointer' }}>Reset to default</button>
        </div>

        {/* Live preview */}
        <div style={{ marginTop:16, borderRadius:12, overflow:'hidden', border:'1px solid #eee' }}>
          <div style={{ background: settings.brand_primary || DEFAULT_PRIMARY, padding:'18px 20px', display:'flex', alignItems:'center', gap:12 }}>
            {settings.brand_logo
              ? <img src={settings.brand_logo} alt="" style={{ height:32, maxWidth:80, objectFit:'contain' }} />
              : <span style={{ width:28, height:28, borderRadius:'50%', background: settings.brand_accent || DEFAULT_ACCENT, display:'inline-block' }} />}
            <span style={{ color:'#fff', fontWeight:800, fontFamily:'Georgia, serif' }}>{settings.company_name || 'Your Restaurant'}</span>
            <span style={{ marginLeft:'auto', background: settings.brand_accent || DEFAULT_ACCENT, color: settings.brand_primary || DEFAULT_PRIMARY, fontWeight:800, fontSize:12, padding:'5px 12px', borderRadius:999 }}>Preview</span>
          </div>
        </div>
        <div style={{ fontSize:11.5, color:'#999', marginTop:8 }}>Hit <strong>Save</strong> (bottom of Settings) to apply. Leave colours unset for the default SiamEPOS look.</div>
      </div>

      {/* ── Business Details ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🏢 Business Details</h2>
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Logo upload */}
          <div>
            <label style={labelStyle}>Restaurant Logo</label>
            <div style={{ display:'flex', alignItems:'flex-start', gap:16 }}>
              {/* Preview box */}
              <div style={{ width:160, height:140, borderRadius:10, border:'2px dashed #ddd', display:'flex', alignItems:'center', justifyContent:'center', background:'#fafafa', flexShrink:0, overflow:'hidden', padding:8 }}>
                {logoPreview
                  ? <img src={logoPreview} alt="Logo" style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }} />
                  : <span style={{ fontSize:36 }}>🏪</span>
                }
              </div>
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={handleLogoUpload}
                  style={{ display:'none' }}
                  id="logo-upload"
                />
                <label htmlFor="logo-upload" style={{ display:'inline-block', padding:'10px 16px', borderRadius:8, border:'2px solid var(--brand-primary, #1a1a2e)', background:'white', color:'var(--brand-primary, #1a1a2e)', fontSize:13, fontWeight:700, cursor:'pointer', textAlign:'center' }}>
                  📁 Choose Logo File
                </label>
                {logoPreview && (
                  <button onClick={handleRemoveLogo} style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#fee2e2', color:'#ef4444', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                    🗑 Remove Logo
                  </button>
                )}
                {bitmapPreview && (
                  <div style={{ marginTop:8, padding:'8px 10px', background:'#f5f5f5', borderRadius:8, border:'1px solid #ddd' }}>
                    <div style={{ fontSize:10, color:'#666', fontWeight:700, marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>
                      🖨 Thermal printer preview {bitmapInkPct != null && `(${bitmapInkPct.toFixed(1)}% inked)`}
                    </div>
                    <img src={bitmapPreview} alt="Logo as it will print" style={{ display:'block', maxWidth:'100%', maxHeight:120, imageRendering:'pixelated', background:'white', border:'1px solid #ccc' }}/>
                    <div style={{ fontSize:10, color:'#888', marginTop:4 }}>
                      {bitmapInkPct == null ? '' :
                       bitmapInkPct < 1 ? '⚠️ very faint — try a darker / higher-contrast logo' :
                       bitmapInkPct < 5 ? 'looks light — that is what will print' :
                       'looks good ✓'}
                    </div>
                  </div>
                )}
                {logoPreview && (
                  <div>
                    <div style={{ fontSize:11, color:'#666', fontWeight:700, marginBottom:5 }}>Logo size on receipt</div>
                    <div style={{ display:'flex', gap:6 }}>
                      {[['small','S'],['medium','M'],['large','L'],['full','Full']].map(([val, label]) => (
                        <button key={val} onClick={async () => {
                          setSettings(s => ({ ...s, receipt_logo_size: val }));
                          // Persist the preset even with no logo image uploaded.
                          if (!settings.company_logo) { updateSettings({ receipt_logo_size: val }).catch(() => {}); return; }
                          try {
                            const bmp = await imageToThermalBitmap(settings.company_logo, sizeToWidth(val));
                            const patch = {
                              receipt_logo_size: val,
                              company_logo_bitmap:        bmp.b64,
                              company_logo_bitmap_width:  String(bmp.widthBytes),
                              company_logo_bitmap_height: String(bmp.height),
                              company_logo_bitmap_rev:    '2',
                            };
                            setSettings(s => ({ ...s, ...patch }));
                            // BUGFIX — persist the regenerated bitmap immediately (like the
                            // upload + auto-rebuild paths do). Previously this only updated
                            // React state, so the resized bitmap never reached the DB and the
                            // printed receipt kept the old logo size regardless of the setting.
                            await updateSettings(patch);
                            setBitmapPreview(bmp.previewDataUrl);
                            setBitmapInkPct(bmp.inkPct);
                          } catch (err) { console.warn('size change conversion failed:', err); }
                        }}
                          style={{ padding:'6px 12px', borderRadius:7, border:'2px solid', cursor:'pointer', fontWeight:700, fontSize:12,
                            borderColor: settings.receipt_logo_size === val ? 'var(--brand-primary, #1a1a2e)' : '#ddd',
                            background:  settings.receipt_logo_size === val ? 'var(--brand-primary, #1a1a2e)' : 'white',
                            color:       settings.receipt_logo_size === val ? 'white'   : '#555',
                          }}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ fontSize:11, color:'#aaa', lineHeight:1.5 }}>
                  PNG, JPG or SVG · Max 500KB<br/>
                  Appears at the top of printed receipts
                </div>
              </div>
            </div>
          </div>

          <div><label style={labelStyle}>Restaurant Name</label><input value={settings.company_name||''} onChange={e => setSettings({...settings, company_name:e.target.value})} placeholder="e.g. The Golden Spoon" style={inputStyle} /></div>
          <div><label style={labelStyle}>Address</label><input value={settings.company_address||''} onChange={e => setSettings({...settings, company_address:e.target.value})} placeholder="123 High Street, London, W1A 1AA" style={inputStyle} /></div>
          <div><label style={labelStyle}>Phone Number</label><input value={settings.company_phone||''} onChange={e => setSettings({...settings, company_phone:e.target.value})} placeholder="+44 20 1234 5678" style={inputStyle} /></div>
          <div><label style={labelStyle}>Email</label><input value={settings.company_email||''} onChange={e => setSettings({...settings, company_email:e.target.value})} placeholder="hello@myrestaurant.co.uk" style={inputStyle} /></div>
          <div><label style={labelStyle}>VAT Number</label><input value={settings.company_vat||''} onChange={e => setSettings({...settings, company_vat:e.target.value})} placeholder="e.g. GB123456789" style={inputStyle} /></div>
          <div>
            <label style={labelStyle}>Receipt Footer Message</label>
            <input value={settings.receipt_footer||''} onChange={e => setSettings({...settings, receipt_footer:e.target.value})} placeholder="Thank you for dining with us!" style={inputStyle} />
            <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>Appears at the bottom of every printed receipt</div>
          </div>
          <div>
            <label style={labelStyle}>Receipt QR Link</label>
            <input value={settings.google_review_url||''} onChange={e => setSettings({...settings, google_review_url:e.target.value})} placeholder="https://g.page/r/your-google-review-link" style={inputStyle} />
            <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>If set, a QR code linking to this URL prints at the bottom of every receipt — your Google review page, a promotion page, your menu, anything</div>
          </div>
          <div>
            <label style={labelStyle}>Receipt QR Caption</label>
            <input value={settings.receipt_qr_caption||''} onChange={e => setSettings({...settings, receipt_qr_caption:e.target.value})} placeholder="Scan to leave us a review" style={inputStyle} />
            <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>The line printed under the QR code — match it to where the link goes</div>
          </div>
        </div>
      </div>

      {/* ── Receipt Preview ── */}
      {(settings.company_name || logoPreview) && (
        <div style={cardStyle}>
          <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🖨️ Receipt Preview</h2>
          <div style={{ background:'white', border:'1px solid #e5e7eb', borderRadius:8, padding:'16px 20px', maxWidth:300, margin:'0 auto', fontFamily:'Courier New, monospace', fontSize:12 }}>
            {logoPreview && (
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <img src={logoPreview} alt="Logo" style={{
                  maxWidth: { small:'80px', medium:'150px', large:'220px', full:'100%' }[settings.receipt_logo_size||'medium'],
                  width: settings.receipt_logo_size === 'full' ? '100%' : undefined,
                  objectFit:'contain', display:'block', margin:'0 auto'
                }} />
              </div>
            )}
            {(settings.company_name||'').trim()
              ? <div style={{ textAlign:'center', fontWeight:900, fontSize:14, marginBottom:2 }}>{settings.company_name}</div>
              : (!logoPreview && <div style={{ textAlign:'center', fontWeight:900, fontSize:14, marginBottom:2 }}>Restaurant Name</div>)}
            {settings.company_address && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:2 }}>{settings.company_address}</div>}
            {settings.company_phone   && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:2 }}>Tel: {settings.company_phone}</div>}
            {settings.company_vat     && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:4 }}>VAT: {settings.company_vat}</div>}
            <div style={{ borderTop:'1px dashed #ccc', margin:'6px 0' }} />
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2 }}><span>1x Pad Thai</span><span>£12.50</span></div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2 }}><span>1x Green Curry</span><span>£13.00</span></div>
            <div style={{ borderTop:'1px dashed #ccc', margin:'6px 0' }} />
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}><span>Subtotal</span><span>£25.50</span></div>
            {settings.service_charge_enabled==='1' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}><span>Service ({settings.service_charge_rate||12.5}%)</span><span>£{(25.50*(parseFloat(settings.service_charge_rate||12.5)/100)).toFixed(2)}</span></div>}
            <div style={{ display:'flex', justifyContent:'space-between', fontWeight:900, fontSize:13, marginTop:4 }}><span>TOTAL</span><span>£{(25.50*(1+(parseFloat(settings.service_charge_enabled==='1'?settings.service_charge_rate||12.5:0)/100))).toFixed(2)}</span></div>
            <div style={{ borderTop:'1px solid #000', margin:'6px 0' }} />
            <div style={{ textAlign:'center', fontSize:10, color:'#555', marginTop:6 }}>{settings.receipt_footer||'Thank you for dining with us!'}</div>
            {settings.google_review_url && (
              <div style={{ textAlign:'center', marginTop:6 }}>
                {reviewQr && <img src={reviewQr} alt="Review QR" style={{ width:64, height:64, imageRendering:'pixelated' }} />}
                <div style={{ fontSize:9, color:'#666', marginTop:3 }}>{settings.receipt_qr_caption||'Scan to leave us a review'}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SEPOS-OSK-002 — on-screen keyboard (per-device) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>⌨️ On-screen keyboard</h2>
        <p style={{ fontSize:13, color:'#777', marginBottom:14 }}>
          Shows a keyboard on screen for typing names, notes, searches and prices when
          this device has no physical keyboard — with English and ไทย layouts (🌐 key),
          and a number pad on price / quantity boxes. On the desktop till app it is
          available out of the box. This setting is for <strong>this device only</strong>.
        </p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {[['auto','Auto (till app / touch screens)'], ['on','Always on'], ['off','Off']].map(([val, lbl]) => (
            <button key={val} onClick={() => { try { localStorage.setItem('onscreen_keyboard_mode', val); } catch {} setOskMode(val); }}
              style={{ padding:'10px 16px', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer',
                border: oskMode===val ? '2px solid var(--brand-primary,#0D1B3E)' : '1px solid #ddd',
                background: oskMode===val ? 'var(--brand-primary,#0D1B3E)' : '#fff',
                color: oskMode===val ? '#fff' : '#333' }}>
              {lbl}
            </button>
          ))}
        </div>
        <p style={{ fontSize:12, color:'#aaa', marginTop:10 }}>
          Tap a text box to try it. It never covers the number pad or PIN entry — those keep their own keypad.
        </p>
      </div>

      {/* ── SEPOS-TILL-LOCK-001 — Till security ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🔒 Till Security</h2>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:14 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
            <input type="checkbox" checked={settings.till_send_lock!=='0'} onChange={e => setSettings({...settings, till_send_lock:e.target.checked?'1':'0'})} />
            Return to the sign-in screen after sending an order
          </label>
        </div>
        {/* SEPOS-PINONLY-001 — skip the staff-name grid; the PIN alone identifies the person. */}
        <div style={{ display:'flex', alignItems:'flex-start', gap:16, marginBottom:14 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
            <input type="checkbox" checked={settings.login_pin_only==='1'} onChange={e => setSettings({...settings, login_pin_only:e.target.checked?'1':'0'})} />
            PIN-only sign-in <span style={{ fontSize:12, color:'#888', fontWeight:400 }}>— skip the name list; staff just type their PIN and the till knows who they are (each PIN must be unique)</span>
          </label>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display:'flex', alignItems:'center', gap:10, fontSize:15, fontWeight:600, cursor:'pointer' }}>
            <input type="checkbox" checked={(settings.kitchen_bar_as_waiters ?? '1') !== '0'} onChange={e => setSettings({...settings, kitchen_bar_as_waiters:e.target.checked?'1':'0'})} />
            Kitchen &amp; bar staff sign in as waiters <span style={{ fontSize:12, color:'#888', fontWeight:400 }}>— for venues without a kitchen/bar display: those roles land on the floor like waiters (Admin stays locked for them). Leave off if you use the Kitchen or Bar screens.</span>
          </label>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:8 }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555' }}>Auto sign-out when idle</label>
          <select value={settings.till_idle_minutes||'2'} onChange={e => setSettings({...settings, till_idle_minutes:e.target.value})}
            style={{ padding:'8px 10px', border:'1px solid #ddd', borderRadius:8, fontSize:14 }}>
            <option value="0">Off</option>
            <option value="1">After 1 minute</option>
            <option value="2">After 2 minutes</option>
            <option value="5">After 5 minutes</option>
            <option value="10">After 10 minutes</option>
          </select>
        </div>
        <div style={{ fontSize:12, color:'#888', lineHeight:1.5 }}>
          Staff sign back in with their PIN in seconds. Unsent basket items are kept on the table.
          Kitchen and Bar displays are never signed out automatically.
        </div>
      </div>

      {/* ── SEPOS-NAV-HIDE-001 — Navigation tabs ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>🧭 Navigation</h2>
        <div style={{ fontSize:12, color:'#888', lineHeight:1.5, marginBottom:14 }}>
          Untick a screen your venue doesn't use to remove its button from the top bar on every till.
          Hiding a screen does NOT switch the feature off — online bookings still arrive with Reservations hidden,
          and kitchen printing/routing carries on with Kitchen hidden. Takes effect from each till's next sign-in.
        </div>
        {[
          ['nav_show_tables',       '🗺️ Tables (floor map)'],
          ['nav_show_counter',      '🛒 Counter'],
          ['nav_show_reservations', '🗓️ Reservations'],
          ['nav_show_kitchen',      '🍳 Kitchen'],
          ['nav_show_bar',          '🍹 Bar'],
        ].map(([key, label]) => (
          <div key={key} style={{ marginBottom:10 }}>
            <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
              <input
                type="checkbox"
                checked={(settings[key] ?? '1') !== '0'}
                onChange={e => {
                  const on = e.target.checked;
                  // Home guard — the till always needs Tables or Counter to land on.
                  if (!on && key === 'nav_show_tables' && (settings.nav_show_counter ?? '1') === '0') {
                    alert('The till needs at least one home screen — show Counter before hiding Tables.'); return;
                  }
                  if (!on && key === 'nav_show_counter' && (settings.nav_show_tables ?? '1') === '0') {
                    alert('The till needs at least one home screen — show Tables before hiding Counter.'); return;
                  }
                  setSettings({ ...settings, [key]: on ? '1' : '0' });
                }}
              />
              {label}
            </label>
          </div>
        ))}
      </div>

      {/* ── SEPOS-QR-PAYLATER-001 — QR table ordering payment policy ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>📱 QR Table Ordering — Payment</h2>
        <div style={{ fontSize:12, color:'#888', lineHeight:1.5, marginBottom:12 }}>
          How customers pay when they order from the QR code at the table. Online takeaway ordering and vouchers are separate and unaffected.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, maxWidth:520 }}>
          {[['pay_first','💳 Pay now','Customer pays on their phone when ordering (card / Apple Pay / Google Pay)'],
            ['pay_later','🧾 Pay at the till','Customer just orders — staff take payment at the table or till, like a normal bill']].map(([val, label, hint]) => (
            <button key={val} onClick={() => setSettings({ ...settings, qr_payment_policy: val })} style={{
              padding:'12px', borderRadius:10, textAlign:'left', cursor:'pointer',
              border:'2px solid ' + (((settings.qr_payment_policy ?? 'pay_first') === val) ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0'),
              background:((settings.qr_payment_policy ?? 'pay_first') === val) ? 'var(--brand-primary, #1a1a2e)' : 'white',
              color:((settings.qr_payment_policy ?? 'pay_first') === val) ? 'white' : '#555',
            }}>
              <div style={{ fontWeight:800, fontSize:14 }}>{label}</div>
              <div style={{ fontSize:11, opacity:0.85, marginTop:4 }}>{hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ── SEPOS-ORDER-CHIME-001 — Online order alert ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>🔔 Online Order Alert</h2>
        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
          <input type="checkbox" checked={(settings.online_order_chime ?? '1') !== '0'} onChange={e => setSettings({...settings, online_order_chime:e.target.checked?'1':'0'})} />
          Play a repeating chime on every till when an online order arrives
          <span style={{ fontSize:12, color:'#888', fontWeight:400 }}>— rings every ~25 seconds until someone taps the alert banner. Covers the ordering widget, QR table orders and Deliveroo. Never plays on the customer display.</span>
        </label>
      </div>

      {/* ── Service Charge ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>💳 Service Charge</h2>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:16 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
            <input type="checkbox" checked={settings.service_charge_enabled==='1'} onChange={e => setSettings({...settings, service_charge_enabled:e.target.checked?'1':'0'})} />
            Enable automatic service charge
          </label>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555' }}>Service charge %</label>
          <input value={settings.service_charge_rate||'12.5'} onChange={e => setSettings({...settings, service_charge_rate:e.target.value})} type="text" inputMode="decimal" step="0.5" min="0" max="30" style={{ width:100, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }} />
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:8 }}>Standard UK rate is 12.5%. This is optional and always shown separately on the bill.</div>
      </div>

      {/* ── VAT treatment (SEPOS-VATMODE-001) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🧾 VAT</h2>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555' }}>How your menu prices are set</label>
          <select value={settings.vat_mode || 'inclusive'} onChange={e => setSettings({...settings, vat_mode:e.target.value})} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}>
            <option value="inclusive">Prices include VAT (net = price ÷ 1.2)</option>
            <option value="exclusive">Prices exclude VAT — add 20% on top (VAT = price × 20%)</option>
          </select>
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:8 }}>Affects the VAT breakdown on bills, receipts, the VAT report and the Z report. Service charge is never VATed. Per-item VAT rate is set on each menu item.</div>
      </div>

      {/* ── Booking deposits (SEPOS-DEPOSIT-001) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🧾 Booking Deposits</h2>
        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
          <input type="checkbox" checked={settings.deposits_enabled==='1'} onChange={e => setSettings({...settings, deposits_enabled:e.target.checked?'1':'0'})} />
          Enable booking deposits
        </label>
        <div style={{ fontSize:12, color:'#aaa', marginTop:8 }}>Take a deposit against a booking (Admin → Vouchers → Take deposit) and redeem it on the day as a <b>prepaid tender</b> in Mixed Payment — the full bill still records for sales + VAT; the deposit only reduces what's owed. Deposits are reported separately from gift vouchers and never count as till cash. When off, none of the deposit UI shows.</div>
      </div>

      {/* Print text size moved to Admin → Printers (SEPOS-PRINT-FONT-001) — it's a printer setting. */}

      {/* ── Delivery (SEPOS-DELIVERY-002) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🚗 Online Delivery</h2>
        <div style={{ fontSize:12, color:'#888', marginBottom:16 }}>
          Set both fields to offer delivery on the takeaway widget. The widget checks each customer's postcode against this radius — anyone outside is offered collection instead. Leave blank to keep takeaway collection-only.
        </div>
        <div style={{ display:'flex', gap:20, flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Restaurant postcode</label>
            <input
              value={settings.restaurant_postcode || ''}
              onChange={e => setSettings({ ...settings, restaurant_postcode: e.target.value.toUpperCase() })}
              placeholder="e.g. SW1A 1AA"
              style={{ width:160, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, textTransform:'uppercase' }}
            />
          </div>
          <div>
            <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Delivery radius (miles)</label>
            <input
              value={settings.delivery_radius_miles || ''}
              onChange={e => setSettings({ ...settings, delivery_radius_miles: e.target.value })}
              type="text" inputMode="decimal" step="0.5" min="0" max="20"
              placeholder="e.g. 3"
              style={{ width:120, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}
            />
          </div>
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:10 }}>
          Distance is straight-line ("as the crow flies"). 3 miles is a sensible starting radius for most UK Thai restaurants.
        </div>
      </div>

      {/* ── Online Order Discount (SEPOS-TAKEAWAY-DISCOUNT) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🎉 Online Order Discount</h2>
        <div style={{ fontSize:12, color:'#888', marginBottom:16 }}>
          Give customers a percentage off when they order through your own online takeaway widget — a direct reward for skipping the commission apps. Shows as a banner on the ordering page and as a discount line at checkout, on the kitchen ticket and in reports. Set 0 to switch it off.
        </div>
        <div>
          <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Discount on online orders (%)</label>
          <input
            value={settings.takeaway_discount_percent || ''}
            onChange={e => setSettings({ ...settings, takeaway_discount_percent: e.target.value })}
            type="text" inputMode="decimal" step="1" min="0" max="50"
            placeholder="e.g. 10"
            style={{ width:120, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}
          />
        </div>
        <div style={{ marginTop:14 }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Only on orders over (£) <span style={{ fontWeight:400, color:'#999' }}>— leave empty for every order</span></label>
          <input
            value={settings.takeaway_discount_min_total || ''}
            onChange={e => setSettings({ ...settings, takeaway_discount_min_total: e.target.value })}
            type="text" inputMode="decimal" step="1" min="0"
            placeholder="e.g. 30"
            style={{ width:120, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}
          />
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:10 }}>
          Applies to online takeaway &amp; delivery orders only — never to dine-in bills. Capped at 50%. The ordering page advertises the offer automatically and the discount is applied at checkout — including inside the card charge.
        </div>
      </div>

      {/* ── SEPOS-TA-CHOICE-001 — Online order payment ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>💳 Online Order Payment</h2>
        <div style={{ fontSize:12, color:'#888', lineHeight:1.5, marginBottom:12 }}>
          How customers pay on your online ordering page and widget. QR table ordering has its own setting above; vouchers always pay online.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, maxWidth:640 }}>
          {[['', '⚙️ Automatic', 'Pay online when card keys are set up, otherwise pay on collection (today\'s behaviour)'],
            ['collection', '🏪 Pay on collection', 'Never ask for a card online — staff take payment at handover'],
            ['choice', '🤝 Customer chooses', 'Checkout shows both: pay now online, or pay at the restaurant']].map(([val, label, hint]) => (
            <button key={val || 'auto'} onClick={() => setSettings({ ...settings, takeaway_pay_mode: val })} style={{
              padding:'12px', borderRadius:10, textAlign:'left', cursor:'pointer',
              border:'2px solid ' + (((settings.takeaway_pay_mode ?? '') === val) ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0'),
              background:((settings.takeaway_pay_mode ?? '') === val) ? 'var(--brand-primary, #1a1a2e)' : 'white',
              color:((settings.takeaway_pay_mode ?? '') === val) ? 'white' : '#555',
            }}>
              <div style={{ fontWeight:800, fontSize:13 }}>{label}</div>
              <div style={{ fontSize:11, opacity:0.85, marginTop:4 }}>{hint}</div>
            </button>
          ))}
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:10 }}>
          Unpaid orders can no-show — choosing "pay on collection" or "customer chooses" accepts that risk. The till blocks closing an unpaid order until staff record the payment.
        </div>
      </div>

      {/* ── Courier Dispatch (SEPOS-DELIVERY-001) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🛵 Courier Dispatch</h2>
        <div style={{ fontSize:12, color:'#888', marginBottom:16 }}>
          When the kitchen marks a delivery order ready, SiamEPOS can automatically book a courier to collect and deliver it — the customer gets a live tracking link. Set up Online Delivery (above) first.
        </div>
        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14, marginBottom:16 }}>
          <input
            type="checkbox"
            checked={settings.courier_dispatch_enabled === '1'}
            onChange={e => setSettings({ ...settings, courier_dispatch_enabled: e.target.checked ? '1' : '0' })}
          />
          Enable automatic courier dispatch
        </label>
        {settings.courier_dispatch_enabled === '1' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div>
              <label style={labelStyle}>Courier provider</label>
              <select
                value={settings.courier_provider || 'stuart'}
                onChange={e => setSettings({ ...settings, courier_provider: e.target.value })}
                style={inputStyle}
              >
                <option value="stuart">Stuart</option>
                <option value="uber_direct">Uber Direct (pending API approval)</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Pickup address (where the courier collects)</label>
              <input
                value={settings.courier_pickup_address || ''}
                onChange={e => setSettings({ ...settings, courier_pickup_address: e.target.value })}
                placeholder="123 High Street, London"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Pickup contact phone</label>
              <input
                value={settings.courier_pickup_phone || ''}
                onChange={e => setSettings({ ...settings, courier_pickup_phone: e.target.value })}
                placeholder="+44 20 1234 5678"
                style={inputStyle}
              />
            </div>
            <div style={{ fontSize:12, color:'#aaa' }}>
              The restaurant postcode from Online Delivery above is appended to the pickup address automatically. Courier API credentials are configured in Railway.
            </div>
          </div>
        )}
      </div>

      {/* Save moved to a sticky bottom bar (StickySaveBar) — this page is long
          and the button was stranded mid-scroll. Korakot 2026-08-08. */}

      {/* ── Discount Reasons ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🏷️ Discount Reasons</h2>
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:16 }}>
          {reasons.map(r => (
            <div key={r.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', background:'#f8f8f8', borderRadius:8 }}>
              <span style={{ fontSize:14 }}>{r.reason}</span>
              <button onClick={async () => {
                setReasons(prev => prev.filter(x => x.id !== r.id));
                try { assertOk(await deleteDiscountReason(r.id)); }
                catch { alert('Could not remove — check connection.'); getDiscountReasons().then(setReasons); }
              }} style={{ background:'#fee2e2', border:'none', borderRadius:6, padding:'4px 10px', cursor:'pointer', color:'#ef4444', fontSize:12, fontWeight:600 }}>Remove</button>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <input value={newReason} onChange={e => setNewReason(e.target.value)} onKeyDown={e => { if(e.key==='Enter') handleAddReason(); }} placeholder="Add new discount reason..." style={{ flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }} />
          <button onClick={handleAddReason} style={{ padding:'10px 20px', borderRadius:8, border:'none', background:'#e94560', color:'white', cursor:'pointer', fontWeight:600 }}>Add</button>
        </div>
      </div>

      {/* ── Bar Categories ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:8 }}>🍹 Bar Categories</h2>
        <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>Select which categories show on the Bar screen</p>
        <BarCategoryManager />
      </div>

      {/* ── Dining Durations ── */}
      <div style={{ marginTop:20 }}>
        <DiningDurationSettings />
      </div>

      {/* SEPOS-LOCAL-001 P3 — first-boot migration banner */}
      <MigrationBanner />

      {/* SEPOS-PRO-005 — version + auto-update status (desktop app only) */}
      <AppUpdatesCard cardStyle={cardStyle} />

      {/* ── Network Setup (QR for iPads) ── */}
      {isNativeApp() ? <AddTillCard cardStyle={cardStyle} /> : <NetworkSetupCard cardStyle={cardStyle} />}
      {isNativeApp() && <HostServerCard cardStyle={cardStyle} />}

      {/* SEPOS-LOCAL-001 P5 — Mac vs cloud record counts */}
      <DataStorageCard cardStyle={cardStyle} />

      {/* SEPOS-LOCAL-001 P1 — HMRC nightly archive on this Mac */}
      <LocalArchiveCard cardStyle={cardStyle} />

      {/* SEPOS-KITCHEN-MSG-001 — admin manages kitchen message templates */}
      <KitchenTemplatesCard cardStyle={cardStyle} />

      {/* SEPOS-LOCAL-001 P6 — Cloudflare Tunnel for owner remote access */}
      <RemoteAccessCard cardStyle={cardStyle} />

      {/* SEPOS-PRINT-TAB-001 — printer config moved to its own admin tab.
          See client/src/screens/admin/PrintersSection.jsx */}

      <StickySaveBar onSave={handleSave} label="💾 Save All Settings" saved={saved} />
    </div>
  );
}
