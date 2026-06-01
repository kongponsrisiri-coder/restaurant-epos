// SEPOS-LOCAL-001 Phase 6 — Cloudflare Tunnel manager.
//
// Spawns `cloudflared tunnel --config <credentials> run` as a child
// process when the install's config.json sets
// `cloudflare_tunnel_credentials_path`. Cloudflare Tunnel creates a
// secure encrypted bridge from a public URL (e.g.
// `remote.baan-siam.siamepos.co.uk`) → the Mac's local Express server
// on port 3001 — no static IP, no router port-forwarding, works on any
// home broadband. Protected by Cloudflare Access (free email gate) so
// no random visitor can reach the URL.
//
// The cloudflared binary is downloaded on first run (~30 MB) and
// cached in userData/cloudflared, so the repo stays small. Future
// versions can pre-bundle it via electron-builder extraResources if
// auto-download proves unreliable in the field.
//
// Status is written to userData/tunnel-status.json so the spawned
// Node server (src/server.js) can read it for the
// GET /api/local/tunnel-status endpoint without needing IPC into the
// Electron main process.

'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const { spawn } = require('child_process');

let _proc   = null;
let _state  = { enabled: false, status: 'disabled', remote_url: '', last_error: null };

function getStatePath(userDataDir) {
  return path.join(userDataDir, 'tunnel-status.json');
}

function getBinaryPath(userDataDir) {
  return path.join(userDataDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

function writeState(userDataDir, patch = {}) {
  _state = { ..._state, ...patch };
  try {
    fs.writeFileSync(getStatePath(userDataDir), JSON.stringify(_state, null, 2));
  } catch (err) { console.warn('[tunnel] writeState failed:', err.message); }
}

function getState() { return { ..._state }; }

// ── Download cloudflared on first run ──────────────────────────────
// Cloudflare publishes static binaries per platform/arch at
// github.com/cloudflare/cloudflared/releases/latest/download/*.
// Universal Mac binary `cloudflared-darwin-amd64.tgz` runs natively
// on x86 and through Rosetta on arm64 — we ship the arm64 binary
// directly when available for native perf.
function downloadUrlFor() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz';
  }
  if (process.platform === 'win32') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  }
  return null;
}

function followRedirects(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        followRedirects(res.headers.location, dest, depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary(userDataDir) {
  const dest = getBinaryPath(userDataDir);
  if (fs.existsSync(dest)) return dest;
  const url = downloadUrlFor();
  if (!url) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);

  console.log('[tunnel] downloading cloudflared from', url);
  if (url.endsWith('.tgz')) {
    // Mac tarball — fetch + extract via system `tar`.
    const tgz = path.join(userDataDir, 'cloudflared.tgz');
    await followRedirects(url, tgz);
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xzf', tgz, '-C', userDataDir]);
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
      p.on('error', reject);
    });
    try { fs.unlinkSync(tgz); } catch {}
  } else {
    await followRedirects(url, dest);
  }
  try { fs.chmodSync(dest, 0o755); } catch {}
  console.log('[tunnel] cloudflared installed at', dest);
  return dest;
}

// ── Spawn the tunnel ───────────────────────────────────────────────
async function start(opts) {
  const { userDataDir, credentialsPath, remoteUrl } = opts;
  fs.mkdirSync(userDataDir, { recursive: true });

  if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    writeState(userDataDir, { enabled: false, status: 'disabled', remote_url: '', last_error: null });
    return { skipped: true, reason: 'no credentials configured' };
  }

  writeState(userDataDir, { enabled: true, status: 'downloading', remote_url: remoteUrl || '', last_error: null });

  let binary;
  try { binary = await ensureBinary(userDataDir); }
  catch (err) {
    writeState(userDataDir, { status: 'error', last_error: 'cloudflared download failed: ' + err.message });
    return { ok: false, error: err.message };
  }

  writeState(userDataDir, { status: 'starting' });

  // `cloudflared tunnel --no-autoupdate --credentials-file <path> run`
  // Tunnel name is encoded in the credentials JSON; routes are configured
  // Cloudflare-side. We just need to pass the creds and run.
  const args = ['tunnel', '--no-autoupdate', '--credentials-file', credentialsPath, 'run'];
  try {
    _proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    writeState(userDataDir, { status: 'error', last_error: 'spawn failed: ' + err.message });
    return { ok: false, error: err.message };
  }

  _proc.stdout.on('data', (buf) => {
    const line = String(buf).trim();
    if (line) console.log('[tunnel]', line);
    // cloudflared logs include the assigned hostname; surface it if seen.
    const m = line.match(/(https?:\/\/[^\s]+)/);
    if (m && !_state.remote_url) writeState(userDataDir, { remote_url: m[1] });
    // First successful connection log line confirms tunnel is up.
    if (/Registered tunnel connection|Connection.*registered/i.test(line) && _state.status !== 'running') {
      writeState(userDataDir, { status: 'running' });
    }
  });
  _proc.stderr.on('data', (buf) => {
    const line = String(buf).trim();
    if (line) console.warn('[tunnel:err]', line);
  });
  _proc.on('exit', (code, signal) => {
    console.log('[tunnel] exited code=', code, 'signal=', signal);
    _proc = null;
    writeState(userDataDir, {
      status: code === 0 ? 'stopped' : 'error',
      last_error: code === 0 ? null : `cloudflared exited with code ${code}`,
    });
  });

  // Assume "running" after 5s of no exit (handshake usually faster).
  setTimeout(() => {
    if (_proc && _state.status === 'starting') {
      writeState(userDataDir, { status: 'running' });
    }
  }, 5000);

  return { ok: true };
}

function stop() {
  if (_proc) { try { _proc.kill('SIGTERM'); } catch {} _proc = null; }
}

// ── Server-side read of the status file ────────────────────────────
// Helper for src/server.js so it doesn't need to import Electron APIs.
function readStatusFromUserData(userDataDir) {
  try {
    const raw = fs.readFileSync(getStatePath(userDataDir), 'utf8');
    return JSON.parse(raw);
  } catch { return { enabled: false, status: 'disabled', remote_url: '', last_error: null }; }
}

module.exports = {
  start,
  stop,
  getState,
  readStatusFromUserData,
  getStatePath,
};
