const CLOUD_URL = 'https://restaurant-epos-production.up.railway.app';
const LOCAL_IP_KEY = 'siamepos_local_ip';
const LOCAL_PORT_KEY = 'siamepos_local_port';

let _activeServer = CLOUD_URL;
let _status = 'cloud'; // 'cloud' | 'local' | 'offline'
let _listeners = [];

export function getActiveServer() { return _activeServer; }
export function getServerStatus() { return _status; }

export function onStatusChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

function notify() { _listeners.forEach(fn => fn(_status, _activeServer)); }

export function getLocalConfig() {
  return {
    ip:   localStorage.getItem(LOCAL_IP_KEY) || '',
    port: localStorage.getItem(LOCAL_PORT_KEY) || '3001',
  };
}

export function setLocalConfig(ip, port = '3001') {
  localStorage.setItem(LOCAL_IP_KEY, ip.trim());
  localStorage.setItem(LOCAL_PORT_KEY, String(port));
}

async function tryServer(url, ms = 3000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(`${url}/api/settings?_=${Date.now()}`, {
      cache: 'no-store', signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

export async function testLocalConnection(ip, port = '3001') {
  return tryServer(`http://${ip}:${port}`, 3000);
}

export async function detectBestServer() {
  // 1. Try cloud
  if (await tryServer(CLOUD_URL, 3000)) {
    if (_status !== 'cloud') {
      _activeServer = CLOUD_URL;
      _status = 'cloud';
      notify();
    }
    return 'cloud';
  }

  // 2. Try local mini PC
  const { ip, port } = getLocalConfig();
  const localUrl = ip ? `http://${ip}:${port}` : null;
  if (localUrl && await tryServer(localUrl, 2000)) {
    if (_status !== 'local') {
      _activeServer = localUrl;
      _status = 'local';
      notify();
    }
    return 'local';
  }

  // 3. Both failed
  if (_status !== 'offline') {
    _status = 'offline';
    notify();
  }
  return 'offline';
}

export function startMonitoring() {
  detectBestServer();
  setInterval(detectBestServer, 20000);
}