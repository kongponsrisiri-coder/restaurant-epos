const { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEV_URL = 'http://localhost:5173';

// SEPOS-EXIT-001 — single-instance lock. When something looks stuck, staff
// sometimes force-quit and re-open SiamEPOS, ending up with TWO instances both
// running a local Express server against the SAME SQLite DB
// (userData/siamepos-local.db) — lock contention + sync races. Hold the OS
// single-instance lock; a second launch hands control to the first (focus its
// window) and exits immediately. Packaged-only, so a dev `npm start` can still
// run alongside an installed copy on the same machine.
const gotSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Single source of truth for the app icon — the SiamEPOS lotus. Use the
// bundled electron/build/icon.png (shipped via package.json "files": build/**),
// so it resolves in BOTH dev and the packaged app. The old client/public path
// is NOT bundled (only client-dist is), so at runtime the file was missing and
// Windows fell back to the generic Electron icon in the taskbar + window.
const APP_ICON_PATH = path.join(__dirname, 'build', 'icon.png');

// Per-install config — restaurant name, cloud URL, restaurant id. Lives at
// electron/config.json in dev (matches your repo layout) and in userData
// in packaged builds (the .app bundle is read-only there).
function getConfigPath() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'config.json');
  }
  return path.join(__dirname, 'config.json');
}

function loadConfig() {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return null;
    // Strip a UTF-8 BOM — a config.json written by Windows PowerShell's
    // `-Encoding UTF8` starts with ﻿, JSON.parse throws, and the app
    // silently falls back to the first-run wizard even though a valid config
    // exists (Tori Nori install, 18 Aug).
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.warn('[config] load failed:', err.message);
    return null;
  }
}

function saveConfig(data) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// IPC handler registered once at module load — setup window invokes it.
// SEPOS-REMOTE-INSTALL-001 — clipboard read for the wizard's 📋 Paste buttons.
ipcMain.handle('read-clipboard', () => {
  try { return clipboard.readText() || ''; } catch { return ''; }
});

ipcMain.handle('save-config', async (event, data) => {
  if (!data || !data.restaurant_name || !data.cloud_api_url || !data.restaurant_id) {
    return { success: false, error: 'Restaurant name, URL and ID are required.' };
  }
  try { new URL(data.cloud_api_url); }
  catch { return { success: false, error: 'Cloud API URL is not a valid URL.' }; }
  if (!/^[a-z0-9-]+$/i.test(data.restaurant_id)) {
    return { success: false, error: 'Restaurant ID can only contain letters, numbers and dashes.' };
  }
  // sync_secret is optional — without it the closed-orders pull stays
  // disabled but everything else (menu / staff / settings) still syncs.
  const payload = { ...data, configured_at: new Date().toISOString() };
  if (!payload.sync_secret) delete payload.sync_secret;
  saveConfig(payload);
  return { success: true };
});

// SEPOS-RESET-001 — reset this install so it can be handed to a different
// client. Deletes config.json + the local SQLite DB, then relaunches into the
// first-run setup wizard. Safe: all real data lives on the client's cloud.
ipcMain.handle('reset-config', async () => {
  try {
    const cfg = getConfigPath();
    if (fs.existsSync(cfg)) fs.unlinkSync(cfg);
    const dbBase = path.join(app.getPath('userData'), 'siamepos-local.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbBase + suffix;
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn('[reset] db unlink failed:', f, e.message); }
    }
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (err) {
    console.error('[reset] failed:', err);
    return { success: false, error: err.message };
  }
});

// ── Printing (SEPOS-025 receipts / SEPOS-026 kitchen tickets) ────────
// The renderer enumerates the OS printers and prints HTML silently —
// no print dialog — to a chosen device. Printing goes through the
// installed macOS/Windows driver, so it works with any thermal printer
// (cnfujun 80.E-Z04-AA and other 80mm ESC/POS units alike).
ipcMain.handle('list-printers', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status,
    }));
  } catch (err) {
    console.error('[siamepos] list-printers failed:', err.message);
    return [];
  }
});

ipcMain.handle('print-html', async (event, opts) => {
  const { html, deviceName, copies } = opts || {};
  if (!html) return { success: false, error: 'Nothing to print.' };
  return new Promise((resolve) => {
    let settled = false;
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (!printWin.isDestroyed()) printWin.close(); } catch (e) {}
      resolve(result);
    };
    printWin.webContents.once('did-finish-load', () => {
      // Brief pause so an embedded logo / Google-review QR image can
      // load before the page is rasterised for the printer.
      setTimeout(() => {
        if (printWin.isDestroyed()) return finish({ success: false, error: 'Print window closed.' });
        const printOpts = {
          silent: true,
          printBackground: true,
          margins: { marginType: 'none' },
          copies: Math.max(1, Number(copies) || 1),
        };
        if (deviceName) {
          printOpts.deviceName = deviceName;
          // 80mm thermal receipt printers: set explicit page size so Chromium
          // doesn't default to A4 (210×297mm), which most USB thermal drivers
          // silently reject or scale incorrectly.
          // Width: 80mm = 80,000 µm.  Height: 279mm gives a long enough
          // virtual page for any receipt; the cutter / tear-off handles the
          // physical cut so we don't need to match roll length exactly.
          printOpts.pageSize = { width: 80000, height: 279000 };
        }
        console.log('[siamepos] print-html → device:', deviceName || '(default)', 'copies:', printOpts.copies);
        printWin.webContents.print(printOpts, (success, failureReason) => {
          if (success) {
            console.log('[siamepos] print job accepted by', deviceName || '(default)');
          } else {
            console.error('[siamepos] print job FAILED for', deviceName || '(default)', '— reason:', failureReason);
          }
          finish({ success, error: success ? null : (failureReason || 'Print failed.') });
        });
      }, 550);
    });
    printWin.webContents.once('did-fail-load', (e, code, desc) => {
      console.error('[siamepos] print HTML failed to render:', desc);
      finish({ success: false, error: `Could not render print content: ${desc}` });
    });
    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    setTimeout(() => finish({ success: false, error: 'Print timed out.' }), 20000);
  });
});

// Electron BrowserWindows have NO clipboard shortcuts or right-click menu by
// default. On Windows that means Ctrl+V AND paste-by-mouse both silently do
// nothing, which makes the setup card impossible to paste into (e.g. the
// 64-char sync secret on a keyboard-less touchscreen till). Wire both:
//  - a right-click / long-press context menu with Cut/Copy/Paste/Select All
//    (works with touch alone — no keyboard required)
//  - keyboard Ctrl+C/V/X/A on Windows & Linux (macOS already has these via its
//    default application menu, so we skip it there to avoid a double-paste)
function enableClipboardShortcuts(win) {
  const wc = win.webContents;
  wc.on('context-menu', (event, params) => {
    const f = params.editFlags || {};
    Menu.buildFromTemplate([
      { role: 'cut', enabled: !!f.canCut },
      { role: 'copy', enabled: !!f.canCopy },
      { role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    ]).popup({ window: win });
  });
  if (process.platform !== 'darwin') {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const key = (input.key || '').toLowerCase();
      if (key === 'v') { wc.paste(); event.preventDefault(); }
      else if (key === 'c') { wc.copy(); event.preventDefault(); }
      else if (key === 'x') { wc.cut(); event.preventDefault(); }
      else if (key === 'a') { wc.selectAll(); event.preventDefault(); }
    });
  }
}

async function runSetupWizard() {
  return new Promise((resolve) => {
    const setupWin = new BrowserWindow({
      width: 580,
      height: 640,
      title: 'SiamEPOS — First-time Setup',
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#0D1B3E',
      icon: APP_ICON_PATH,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    setupWin.setMenuBarVisibility(false);
    enableClipboardShortcuts(setupWin);

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SiamEPOS — First-time Setup</title>
<style>
  body { margin:0; padding:36px 36px 28px; background:#0D1B3E; color:white;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  h1 { margin:0 0 4px; font-size:24px; color:#C9A84C;
    font-family: Georgia, 'Times New Roman', serif; }
  .subtitle { color:rgba(201,168,76,0.65); font-size:12px;
    letter-spacing:0.08em; text-transform:uppercase; margin-bottom:16px; }
  .intro { font-size:13px; color:rgba(255,255,255,0.7);
    line-height:1.6; margin-bottom:22px; }
  label { display:block; font-size:12px; font-weight:700;
    color:rgba(255,255,255,0.85); margin:14px 0 6px;
    text-transform:uppercase; letter-spacing:0.05em; }
  .fieldrow { display:flex; gap:8px; align-items:stretch; }
  .fieldrow input { flex:1; }
  .pastebtn { flex:none; padding:0 12px; border-radius:10px; cursor:pointer;
    border:1px solid rgba(201,168,76,0.4); background:rgba(201,168,76,0.12);
    color:#C9A84C; font-size:12px; font-weight:700; white-space:nowrap; }
  .pastebtn:active { background:rgba(201,168,76,0.3); }
  input { width:100%; padding:11px 14px; border-radius:10px;
    border:1px solid rgba(201,168,76,0.3); background:rgba(255,255,255,0.05);
    color:white; font-size:15px; box-sizing:border-box;
    font-family:inherit; }
  input:focus { outline:none; border-color:#C9A84C;
    background:rgba(255,255,255,0.08); }
  .hint { font-size:11px; color:rgba(255,255,255,0.45); margin-top:4px; }
  #error { display:none; background:rgba(239,68,68,0.15);
    border:1px solid rgba(239,68,68,0.4); color:#fca5a5;
    padding:10px 14px; border-radius:8px; font-size:13px; margin-top:18px; }
  #error.show { display:block; }
  button { width:100%; margin-top:22px; padding:14px;
    border-radius:10px; border:none; cursor:pointer;
    background:#C9A84C; color:#0D1B3E; font-weight:700; font-size:15px;
    transition:background 0.15s; }
  button:hover:not(:disabled) { background:#d5b85e; }
  button:disabled { background:rgba(201,168,76,0.3);
    color:rgba(13,27,62,0.5); cursor:not-allowed; }
</style></head>
<body>
  <h1>Welcome to SiamEPOS Pro</h1>
  <div class="subtitle">First-time setup</div>
  <div class="intro">
    Tell us about your restaurant. This is saved locally and only needs to be done once per machine.
  </div>

  <label for="name">Restaurant name</label>
  <div class="fieldrow"><input id="name" type="text" placeholder="e.g. Siam Garden" autofocus /><button type="button" class="pastebtn" data-for="name">📋 Paste</button></div>

  <label for="url">Cloud API URL</label>
  <div class="fieldrow"><input id="url" type="url" placeholder="https://your-app.up.railway.app" /><button type="button" class="pastebtn" data-for="url">📋 Paste</button></div>
  <div class="hint">The Railway backend SiamEPOS will sync to.</div>

  <label for="rid">Restaurant ID</label>
  <div class="fieldrow"><input id="rid" type="text" placeholder="siamepos-001" /><button type="button" class="pastebtn" data-for="rid">📋 Paste</button></div>
  <div class="hint">Lowercase letters, numbers and dashes. Identifies this restaurant in the cloud.</div>

  <label for="secret">Sync secret <span style="color:rgba(255,255,255,0.4);text-transform:none;font-weight:400;letter-spacing:0;">(optional)</span></label>
  <div class="fieldrow"><input id="secret" type="text" placeholder="from Railway → Variables → SYNC_SECRET" /><button type="button" class="pastebtn" data-for="secret">📋 Paste</button></div>
  <div class="hint">Required to pull bill history from cloud. Match what's set on Railway.</div>

  <div id="error"></div>

  <button id="save">Save &amp; Launch SiamEPOS</button>

<script>
  const $ = (id) => document.getElementById(id);
  const errEl = $('error');
  const btn   = $('save');

  function showError(msg) { errEl.textContent = msg; errEl.classList.add('show'); }
  function clearError() { errEl.classList.remove('show'); }

  // SEPOS-REMOTE-INSTALL-001 — 📋 Paste per field (TeamViewer-friendly).
  document.querySelectorAll('.pastebtn').forEach((pb) => {
    pb.addEventListener('click', async () => {
      try {
        const t = String(await window.siamepos.readClipboard() || '').trim();
        if (!t) { showError('Clipboard is empty — copy the value first (clipboard sync must be on in your remote tool).'); return; }
        const el = $(pb.dataset.for);
        el.value = t;
        el.focus();
        clearError();
      } catch (e) { showError('Could not read the clipboard: ' + e); }
    });
  });

  btn.addEventListener('click', async () => {
    clearError();
    const data = {
      restaurant_name: $('name').value.trim(),
      cloud_api_url:   $('url').value.trim(),
      restaurant_id:   $('rid').value.trim(),
      sync_secret:     $('secret').value.trim(),
    };
    if (!data.restaurant_name || !data.cloud_api_url || !data.restaurant_id) {
      return showError('Please fill in name, URL and ID.');
    }
    if (!/^https?:\\/\\//i.test(data.cloud_api_url)) {
      return showError('Cloud API URL must start with http:// or https://');
    }
    if (!/^[a-z0-9-]+$/i.test(data.restaurant_id)) {
      return showError('Restaurant ID can only contain letters, numbers and dashes.');
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const result = await window.siamepos.saveConfig(data);
      if (result && result.success) {
        window.close();
      } else {
        showError((result && result.error) || 'Failed to save config.');
        btn.disabled = false;
        btn.textContent = 'Save & Launch SiamEPOS';
      }
    } catch (e) {
      showError(String(e));
      btn.disabled = false;
      btn.textContent = 'Save & Launch SiamEPOS';
    }
  });
<\/script>
</body></html>`;

    setupWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    setupWin.on('closed', () => {
      // Re-read config — non-null means setup completed successfully.
      resolve(loadConfig());
    });
  });
}

let mainWindow = null;
let setupWindow = null;
let tray = null;
let serverProcess = null;
let statusPollHandle = null;
let lastStatus = null;

// ── Local network detection ─────────────────────────────────────────
// Prefer private LAN ranges (RFC 1918) and skip VPN/tunnel interfaces so
// a Tailscale or corporate VPN address doesn't get advertised by mistake.
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (/^(tun|utun|tap|ipsec|vpn|wg|zt)/i.test(name)) continue;
    for (const iface of (ifaces[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(iface.address)) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getServerUrl() {
  return `http://${getLocalIP()}:${process.env.PORT || 3001}`;
}

// Small branded window showing the LAN URL + a scannable QR code —
// operators point kitchen / bar tablets here during setup.
async function showSetupWindow() {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  const url = getServerUrl();

  // QR code rendered locally as a data URL — no network call, brand colours.
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(url, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0D1B3E', light: '#FFFFFF' },
    });
  } catch (err) {
    console.warn('[setup] QR generation failed:', err.message);
  }

  setupWindow = new BrowserWindow({
    width: 760,
    height: 520,
    title: 'SiamEPOS — Network Setup',
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0D1B3E',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  setupWindow.setMenuBarVisibility(false);
  enableClipboardShortcuts(setupWindow);

  const safeUrl = url.replace(/"/g, '&quot;');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SiamEPOS — Network Setup</title>
<style>
  body { margin:0; padding:32px; background:#0D1B3E; color:white;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  h1 { margin:0 0 6px; font-size:22px; color:#C9A84C;
    font-family: Georgia, 'Times New Roman', serif; }
  .subtitle { color:rgba(201,168,76,0.65); font-size:13px; margin-bottom:22px;
    letter-spacing:0.05em; text-transform:uppercase; }
  .row { display:flex; gap:28px; align-items:stretch; }
  .col-info { flex:1; min-width:0; display:flex; flex-direction:column; }
  .col-qr { flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .qr-frame { background:white; border-radius:14px; padding:14px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
  .qr-frame img { display:block; width:240px; height:240px; }
  .qr-label { margin-top:10px; text-align:center; font-size:11px;
    color:rgba(201,168,76,0.65); letter-spacing:0.08em; text-transform:uppercase; }
  .url-box { background:rgba(255,255,255,0.05);
    border:1px solid rgba(201,168,76,0.4); border-radius:14px;
    padding:18px 20px; text-align:center; font-size:20px; font-weight:800;
    font-family: 'SF Mono', Menlo, Consolas, monospace; letter-spacing:0.3px;
    user-select:text; margin-bottom:14px; word-break:break-all; }
  .help { font-size:13px; color:rgba(255,255,255,0.7); line-height:1.55;
    margin-bottom:18px; flex:1; }
  .help strong { color:#C9A84C; font-weight:700; }
  .help ol { padding-left:20px; margin:6px 0 0; }
  .help li { margin-bottom:4px; }
  .buttons { display:flex; gap:10px; }
  button { flex:1; padding:12px 16px; border-radius:10px; border:none;
    cursor:pointer; font-weight:700; font-size:14px; transition: background 0.15s; }
  .primary { background:#C9A84C; color:#0D1B3E; }
  .primary:hover { background:#d5b85e; }
  .secondary { background:rgba(255,255,255,0.08); color:white; }
  .secondary:hover { background:rgba(255,255,255,0.14); }
  .copied { background:#22c55e !important; color:white !important; }
</style></head>
<body>
  <h1>Network setup</h1>
  <div class="subtitle">Connect kitchen and bar tablets</div>
  <div class="row">
    <div class="col-info">
      <div class="url-box" id="url">${safeUrl}</div>
      <div class="help">
        <strong>To connect a tablet:</strong>
        <ol>
          <li>Make sure it's on the same Wi-Fi as this machine.</li>
          <li>Open the camera and point it at the QR code →</li>
          <li>Tap the SiamEPOS notification to open in Safari.</li>
          <li>Share → <strong>Add to Home Screen</strong> for one-tap access.</li>
        </ol>
      </div>
      <div class="buttons">
        <button class="primary" id="copy">Copy URL</button>
        <button class="secondary" onclick="window.close()">Close</button>
      </div>
    </div>
    <div class="col-qr">
      <div>
        <div class="qr-frame">${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR code linking to ${safeUrl}" />` : '<div style="width:240px;height:240px;display:flex;align-items:center;justify-content:center;color:#888;font-family:monospace;">QR unavailable</div>'}</div>
        <div class="qr-label">Scan with iPad camera</div>
      </div>
    </div>
  </div>
<script>
  const btn = document.getElementById('copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(${JSON.stringify(url)});
      const t = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = t; btn.classList.remove('copied'); }, 1500);
    } catch (e) { console.error(e); }
  });
<\/script>
</body></html>`;

  setupWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setupWindow.on('closed', () => { setupWindow = null; });
}

const STATUS_POLL_MS = 5000;
// 🔵 for active syncing (was 🔴 — read as "broken" even though it's just
// "busy"). Red is now reserved for actual stuck/error states, surfaced
// via the SyncHealthBanner inside the app rather than the title bar.
const STATUS_EMOJI = { cloud: '🟢', local: '🟡', syncing: '🔵', 'initial-sync': '🔄' };

function showInitialSyncOverlay() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`(() => {
    if (document.getElementById('siamepos-initial-sync')) return;
    const o = document.createElement('div');
    o.id = 'siamepos-initial-sync';
    o.style.cssText = 'position:fixed;inset:0;background:#0D1B3E;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;animation:siameposFade .3s';
    o.innerHTML = '<style>@keyframes siameposFade{from{opacity:0}to{opacity:1}}@keyframes siameposSpin{to{transform:rotate(360deg)}}</style>' +
      '<div style="font-size:48px;margin-bottom:24px;display:inline-block;animation:siameposSpin 1.4s linear infinite">🔄</div>' +
      '<div style="font-size:20px;font-weight:600;margin-bottom:8px">Syncing menu from cloud…</div>' +
      '<div style="font-size:13px;color:rgba(201,168,76,0.7);letter-spacing:.05em">Setting up your offline data</div>';
    document.body.appendChild(o);
  })();`, true).catch(() => {});
}

function hideInitialSyncOverlay() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(
    `document.getElementById('siamepos-initial-sync')?.remove();`,
    true
  ).catch(() => {});
}

async function pollSyncStatus() {
  if (!mainWindow) return;
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/sync-status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error(r.statusText);
    const { status, queueSize } = await r.json();
    if (status === lastStatus) return;

    const prev = lastStatus;
    lastStatus = status;

    if (status === 'initial-sync') {
      showInitialSyncOverlay();
    } else if (prev === 'initial-sync') {
      // Just finished the first-launch sync — reload so React refetches
      // against the now-populated local server, then drop the overlay.
      hideInitialSyncOverlay();
      mainWindow.webContents.reload();
    }

    const emoji = STATUS_EMOJI[status] || '⚪';
    const suffix = queueSize > 0 ? ` (${queueSize} queued)` : '';
    mainWindow.setTitle(`${emoji} SiamEPOS${suffix}`);
  } catch {
    // Server not up yet, or transient — leave the existing title alone.
  }
}

function startStatusPoll() {
  if (statusPollHandle) return;
  statusPollHandle = setInterval(pollSyncStatus, STATUS_POLL_MS);
  pollSyncStatus();
}

function stopStatusPoll() {
  if (statusPollHandle) {
    clearInterval(statusPollHandle);
    statusPollHandle = null;
  }
}

function resolveClientIndex() {
  // Packaged: client/dist is in extraResources under "client-dist"
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'client-dist', 'index.html');
    if (fs.existsSync(packaged)) return packaged;
  }
  // Dev build: client/dist/index.html in repo
  const local = path.join(PROJECT_ROOT, 'client', 'dist', 'index.html');
  if (fs.existsSync(local)) return local;
  return null;
}

function startLocalServer() {
  if (serverProcess) return;

  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'src', 'server.js')
    : path.join(PROJECT_ROOT, 'src', 'server.js');

  if (!fs.existsSync(serverEntry)) {
    console.warn('[siamepos] server entry not found, skipping spawn:', serverEntry);
    return;
  }

  // ELECTRON_RUN_AS_NODE makes the Electron binary execute the script as plain Node —
  // so production installs don't require a separately installed Node runtime.
  // DB_MODE=local + SQLITE_PATH route the server through src/db/dbAdapter to SQLite.
  const sqlitePath = path.join(app.getPath('userData'), 'siamepos-local.db');

  // Where the React bundle lives — different in dev vs packaged builds.
  // Passed to the spawned server so it can serve the bundle to LAN tablets.
  const clientDist = app.isPackaged
    ? path.join(process.resourcesPath, 'client-dist')
    : path.join(PROJECT_ROOT, 'client', 'dist');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: process.env.PORT || '3001',
      DB_MODE: 'local',
      SQLITE_PATH: sqlitePath,
      CLIENT_DIST_PATH: clientDist,
      // SEPOS-PRO-009 — so the till heartbeat reports the installed version to ops.
      APP_VERSION: app.getVersion(),
      // CLOUD_API_URL controls the Phase 3 sync target. Pass it through from
      // the launching shell if set; otherwise the queue accumulates with no push.
      ...(process.env.CLOUD_API_URL ? { CLOUD_API_URL: process.env.CLOUD_API_URL } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    console.log(`[siamepos] server exited (code=${code}, signal=${signal})`);
    serverProcess = null;
  });
}

function stopLocalServer() {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // SEPOS-PRO-007 — launch the till in true fullscreen so it presents like a
    // dedicated POS terminal. width/height stay as the restored size if staff
    // leave fullscreen (Mac: Ctrl+Cmd+F · Windows: F11 · Esc).
    fullscreen: true,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    title: 'SiamEPOS',
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Paste was only wired to the first-run setup wizard (a7ce698), so the main
  // till/admin had no right-click/long-press paste (critical on keyboard-less
  // touchscreen tills) and no reliable Ctrl+V on Windows (autoHideMenuBar hides
  // the default Edit menu). Give the main window the same clipboard shortcuts.
  enableClipboardShortcuts(mainWindow);

  const forceDev = process.env.ELECTRON_DEV === '1';
  const indexFile = resolveClientIndex();

  if (forceDev || (!indexFile && !app.isPackaged)) {
    mainWindow.loadURL(DEV_URL).catch((err) => {
      console.error('[siamepos] failed to load dev URL — is `npm run dev` running in client/?', err.message);
    });
  } else if (indexFile) {
    mainWindow.loadFile(indexFile);
  } else {
    console.error('[siamepos] no client build found. Run `cd client && npm run build` first.');
  }

  // Two kinds of window.open() calls need different treatment:
  //   1. Receipt / Z-report popups — ReceiptPrinter does
  //      `window.open('', '_blank', …)` then document.write() the HTML
  //      and trigger window.print(). These have an empty URL (or
  //      about:blank) and must open as a real child window inside the
  //      app so the script keeps access to it.
  //   2. External http(s) links — open in the OS browser instead of
  //      a sandboxed Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank' || url.startsWith('data:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 420,
          height: 720,
          backgroundColor: 'white',
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  // Use the same lotus icon as the dock, downscaled for the menu bar.
  // (Note: this means the tray icon is a coloured image rather than a
  // monochrome template — it won't tint with dark/light menu bar mode,
  // but it matches the dock and is what the operator recognises.)
  const trayImage = fs.existsSync(APP_ICON_PATH)
    ? nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 22, height: 22 })
    : nativeImage.createEmpty();

  tray = new Tray(trayImage);
  tray.setToolTip('SiamEPOS');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const url = getServerUrl();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show SiamEPOS',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    { label: `Server: ${url}`, enabled: false },
    { label: 'Copy server URL', click: () => clipboard.writeText(url) },
    { label: 'Show network setup…', click: showSetupWindow },
    { type: 'separator' },
    { label: 'Quit SiamEPOS', click: () => app.quit() },
  ]));
}

// SEPOS-PRO-005 — module-scope handle so the renderer's "Check for updates"
// button (Settings → App & Updates) can drive the same autoUpdater instance.
let autoUpdater = null;

function setupAutoUpdater() {
  // electron-updater is wired but inert until a publish feed is configured
  // in electron/package.json -> build.publish (GitHub Releases recommended).
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;

    // SEPOS-PRO-006 — persist updater logs to a file so failures are
    // diagnosable on a real till (electron-updater otherwise only logs to a
    // console nobody captures on a packaged app). One line per event in
    // ~/Library/Logs/<app>/updater.log (macOS) / %APPDATA%\..\logs (Win).
    try {
      const logDir = app.getPath('logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'updater.log');
      const write = (level, ...args) => {
        const line = `[${new Date().toISOString()}] ${level} ${args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
        try { fs.appendFileSync(logFile, line); } catch (_) {}
      };
      autoUpdater.logger = {
        info:  (...a) => { write('INFO', ...a); console.log('[updater]', ...a); },
        warn:  (...a) => { write('WARN', ...a); console.warn('[updater]', ...a); },
        error: (...a) => { write('ERROR', ...a); console.error('[updater]', ...a); },
        debug: (...a) => write('DEBUG', ...a),
      };
    } catch (e) { console.warn('[updater] file logger not set:', e?.message || e); }

    // SEPOS-PRO-005 — push every lifecycle state to the renderer so the
    // Settings → App & Updates card can show live status (not just the
    // "ready to restart" banner). Payload state ∈
    // checking | available | not-available | downloading | downloaded | error.
    const sendStatus = (payload) => {
      try { if (mainWindow) mainWindow.webContents.send('siamepos:update-status', payload); }
      catch (_) { /* window gone */ }
    };

    autoUpdater.on('checking-for-update', () => sendStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => {
      console.log('[updater] update available — downloading');
      sendStatus({ state: 'available', version: info?.version });
    });
    autoUpdater.on('update-not-available', () => sendStatus({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => {
      sendStatus({ state: 'downloading', percent: Math.round(p?.percent || 0) });
    });
    autoUpdater.on('error', (err) => {
      console.error('[updater]', err?.message || err);
      sendStatus({ state: 'error', message: err?.message || String(err) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] update downloaded — will install on next restart');
      sendStatus({ state: 'downloaded', version: info?.version });
      // Keep the original channel too so the existing restart banner still fires.
      if (mainWindow) mainWindow.webContents.send('siamepos:update-ready');
    });

    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[updater] check skipped:', err?.message || err);
    });
  } catch (err) {
    console.warn('[updater] not initialised:', err?.message || err);
  }
}

// SEPOS-PRO-004 — renderer "Restart to update" button applies the downloaded
// update immediately (quit + relaunch onto the new version).
ipcMain.handle('siamepos:restart-to-update', () => {
  try { autoUpdater && autoUpdater.quitAndInstall(); }
  catch (e) { console.warn('[updater] quitAndInstall failed:', e?.message || e); }
});

// SEPOS-PRO-005 — current app version for the Settings card. Works in dev too
// (returns the electron/package.json version) so the card always shows a build.
ipcMain.handle('siamepos:get-version', () => {
  try { return app.getVersion(); } catch (_) { return null; }
});

// SEPOS-PRO-005 — manual "Check for updates" from Settings. Only meaningful in a
// packaged install (autoUpdater is null in dev); returns a small status object so
// the renderer can show "Updates only run in the installed app" when unpackaged.
ipcMain.handle('siamepos:check-for-updates', async () => {
  if (!autoUpdater) return { ok: false, reason: 'not-packaged' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version || null };
  } catch (e) {
    return { ok: false, reason: 'error', message: e?.message || String(e) };
  }
});

// SEPOS-EXIT-001 — quit cleanly from the login screen's Exit button. Goes
// through before-quit (which stops the local server child) so nothing is left
// holding the SQLite DB.
ipcMain.handle('quit-app', () => {
  app.quit();
});

app.whenReady().then(async () => {
  // SEPOS-EXIT-001 — a second instance that failed to get the lock is already
  // quitting; don't spawn a server or create a window from it.
  if (!gotSingleInstanceLock) return;

  // Windows: bind the app + its taskbar icon to a stable AppUserModelID (the
  // installer appId). Without this, Windows shows the generic Electron icon in
  // the taskbar and won't group the app's windows under one icon.
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('uk.co.siamepos.pro'); } catch (err) {
      console.warn('[win] setAppUserModelId failed:', err.message);
    }
  }

  // Dock icon (macOS only — Linux/Windows ignore this).
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON_PATH)) {
    try { app.dock.setIcon(APP_ICON_PATH); } catch (err) {
      console.warn('[dock] setIcon failed:', err.message);
    }
  }

  // First-time setup — block until the operator fills in the wizard.
  // If they close it without saving, config stays null → exit cleanly.
  let config = loadConfig();
  let justSetUp = false;
  if (!config) {
    config = await runSetupWizard();
    if (!config) {
      console.log('[setup] cancelled — quitting');
      app.quit();
      return;
    }
    justSetUp = true;
    console.log('[setup] complete:', config.restaurant_name, '→', config.cloud_api_url);
  }

  // Packaged installs only: register the .app as a login item so the kitchen
  // PC auto-launches SiamEPOS at boot. Done once just after first setup —
  // afterwards the operator can toggle it in System Settings if they want.
  if (justSetUp && app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
    try {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
    } catch (err) {
      console.warn('[setup] login-item registration failed:', err.message);
    }
  }

  // Config supplies CLOUD_API_URL unless the launching shell already set it
  // (env wins so start-siamepos.sh / ad-hoc testing can override). The
  // spawned server reads process.env, so writing here is sufficient.
  if (config.cloud_api_url && !process.env.CLOUD_API_URL) {
    process.env.CLOUD_API_URL = config.cloud_api_url;
  }
  if (config.restaurant_id && !process.env.RESTAURANT_ID) {
    process.env.RESTAURANT_ID = config.restaurant_id;
  }
  // SYNC_SECRET enables the auth-gated /api/sync/closed-orders pull.
  // Same env-wins-over-config precedence so devs can override.
  if (config.sync_secret && !process.env.SYNC_SECRET) {
    process.env.SYNC_SECRET = config.sync_secret;
  }
  // RESTAURANT_NAME / EMAIL / ADDRESS — used as branding in email
  // templates (booking confirmation, voucher gift, takeaway confirm,
  // campaigns). On the desktop install these aren't set in the OS
  // env so the templates were falling back to "SiamEPOS Restaurant" —
  // injecting them from config.json so emails carry the actual
  // restaurant branding even when the cloud relay forwards.
  if (config.restaurant_name && !process.env.RESTAURANT_NAME) {
    process.env.RESTAURANT_NAME = config.restaurant_name;
  }
  if (config.restaurant_email && !process.env.RESTAURANT_EMAIL) {
    process.env.RESTAURANT_EMAIL = config.restaurant_email;
  }
  if (config.restaurant_address && !process.env.RESTAURANT_ADDRESS) {
    process.env.RESTAURANT_ADDRESS = config.restaurant_address;
  }

  startLocalServer();
  createWindow();
  createTray();
  startStatusPoll();
  if (app.isPackaged) setupAutoUpdater();

  // SEPOS-LOCAL-001 Phase 6 — Cloudflare Tunnel for owner remote access.
  // If the install's config.json specifies `cloudflare_tunnel_credentials_path`
  // we spawn `cloudflared` against those creds so the owner can reach
  // `remote.{slug}.siamepos.co.uk` from anywhere. Skipped if no creds.
  if (config.cloudflare_tunnel_credentials_path) {
    try {
      const tunnelService = require('./tunnelService');
      tunnelService.start({
        userDataDir:     app.getPath('userData'),
        credentialsPath: config.cloudflare_tunnel_credentials_path,
        remoteUrl:       config.cloudflare_tunnel_url || '',
      }).then(r => {
        if (r?.skipped) console.log('[tunnel] skipped —', r.reason);
        else if (r?.ok) console.log('[tunnel] started');
        else            console.warn('[tunnel] failed:', r?.error);
      });
    } catch (err) { console.warn('[tunnel] init failed:', err.message); }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopStatusPoll();
  stopLocalServer();
  // SEPOS-LOCAL-001 P6 — stop tunnel cleanly so cloudflared doesn't leak.
  try { require('./tunnelService').stop(); } catch {}
});

// Don't quit on window-close — keep alive in tray (user quits via tray menu).
app.on('window-all-closed', () => {});
