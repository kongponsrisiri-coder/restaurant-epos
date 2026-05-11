const { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEV_URL = 'http://localhost:5173';

// Single source of truth for the app icon — same lotus the PWA uses.
const APP_ICON_PATH = path.join(PROJECT_ROOT, 'client', 'public', 'icon-512.png');

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
    return JSON.parse(fs.readFileSync(p, 'utf8'));
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
ipcMain.handle('save-config', async (event, data) => {
  if (!data || !data.restaurant_name || !data.cloud_api_url || !data.restaurant_id) {
    return { success: false, error: 'All three fields are required.' };
  }
  try { new URL(data.cloud_api_url); }
  catch { return { success: false, error: 'Cloud API URL is not a valid URL.' }; }
  if (!/^[a-z0-9-]+$/i.test(data.restaurant_id)) {
    return { success: false, error: 'Restaurant ID can only contain letters, numbers and dashes.' };
  }
  saveConfig({ ...data, configured_at: new Date().toISOString() });
  return { success: true };
});

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
  <input id="name" type="text" placeholder="e.g. Siam Garden" autofocus />

  <label for="url">Cloud API URL</label>
  <input id="url" type="url" placeholder="https://your-app.up.railway.app" />
  <div class="hint">The Railway backend SiamEPOS will sync to.</div>

  <label for="rid">Restaurant ID</label>
  <input id="rid" type="text" placeholder="siamepos-001" />
  <div class="hint">Lowercase letters, numbers and dashes. Identifies this restaurant in the cloud.</div>

  <div id="error"></div>

  <button id="save">Save &amp; Launch SiamEPOS</button>

<script>
  const $ = (id) => document.getElementById(id);
  const errEl = $('error');
  const btn   = $('save');

  function showError(msg) { errEl.textContent = msg; errEl.classList.add('show'); }
  function clearError() { errEl.classList.remove('show'); }

  btn.addEventListener('click', async () => {
    clearError();
    const data = {
      restaurant_name: $('name').value.trim(),
      cloud_api_url:   $('url').value.trim(),
      restaurant_id:   $('rid').value.trim(),
    };
    if (!data.restaurant_name || !data.cloud_api_url || !data.restaurant_id) {
      return showError('Please fill in all three fields.');
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
const STATUS_EMOJI = { cloud: '🟢', local: '🟡', syncing: '🔴', 'initial-sync': '🔄' };

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
    ? path.join(process.resourcesPath, 'server-src', 'server.js')
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

  // Open external links in the OS browser, not inside the Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
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

function setupAutoUpdater() {
  // electron-updater is wired but inert until a publish feed is configured
  // in electron/package.json -> build.publish (GitHub Releases recommended).
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('error', (err) => console.error('[updater]', err?.message || err));
    autoUpdater.on('update-available', () => console.log('[updater] update available — downloading'));
    autoUpdater.on('update-downloaded', () => {
      console.log('[updater] update downloaded — will install on next restart');
      if (mainWindow) mainWindow.webContents.send('siamepos:update-ready');
    });
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[updater] check skipped:', err?.message || err);
    });
  } catch (err) {
    console.warn('[updater] not initialised:', err?.message || err);
  }
}

app.whenReady().then(async () => {
  // Dock icon (macOS only — Linux/Windows ignore this).
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON_PATH)) {
    try { app.dock.setIcon(APP_ICON_PATH); } catch (err) {
      console.warn('[dock] setIcon failed:', err.message);
    }
  }

  // First-time setup — block until the operator fills in the wizard.
  // If they close it without saving, config stays null → exit cleanly.
  let config = loadConfig();
  if (!config) {
    config = await runSetupWizard();
    if (!config) {
      console.log('[setup] cancelled — quitting');
      app.quit();
      return;
    }
    console.log('[setup] complete:', config.restaurant_name, '→', config.cloud_api_url);
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

  startLocalServer();
  createWindow();
  createTray();
  startStatusPoll();
  if (app.isPackaged) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopStatusPoll();
  stopLocalServer();
});

// Don't quit on window-close — keep alive in tray (user quits via tray menu).
app.on('window-all-closed', () => {});
