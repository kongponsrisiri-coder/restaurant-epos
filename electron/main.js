const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEV_URL = 'http://localhost:5173';

let mainWindow = null;
let tray = null;
let serverProcess = null;
let statusPollHandle = null;
let lastStatus = null;

const STATUS_POLL_MS = 5000;
const STATUS_EMOJI = { cloud: '🟢', local: '🟡', syncing: '🔴' };

async function pollSyncStatus() {
  if (!mainWindow) return;
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/sync-status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error(r.statusText);
    const { status, queueSize } = await r.json();
    if (status === lastStatus) return;
    lastStatus = status;
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

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: process.env.PORT || '3001',
      DB_MODE: 'local',
      SQLITE_PATH: sqlitePath,
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
  const iconPath = path.join(__dirname, 'build', 'tray-icon.png');
  const trayImage = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  if (process.platform === 'darwin' && !trayImage.isEmpty()) {
    trayImage.setTemplateImage(true);
  }

  tray = new Tray(trayImage);
  tray.setToolTip('SiamEPOS');
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

app.whenReady().then(() => {
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
