// Single API helper for the back-office. Talks to the new Railway service
// (ops-api.siamepos.co.uk). The base URL falls back to localhost:3002 for
// dev. Override at build time with VITE_OPS_API.

const API = import.meta.env.VITE_OPS_API || (
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:3002'
    : window.location.origin.replace('ops.', 'ops-api.')
);

function tokenHeader() {
  const t = localStorage.getItem('ops_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function handle(res) {
  if (res.status === 401) {
    localStorage.removeItem('ops_token');
    localStorage.removeItem('ops_user');
    if (window.location.pathname !== '/login') window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  base: API,

  login: (email, password) =>
    fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(handle),

  me: () => fetch(`${API}/api/auth/me`, { headers: tokenHeader() }).then(handle),

  listClients: () => fetch(`${API}/api/clients`, { headers: tokenHeader() }).then(handle),

  getClient: (id) => fetch(`${API}/api/clients/${id}`, { headers: tokenHeader() }).then(handle),

  createClient: (body) =>
    fetch(`${API}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify(body),
    }).then(handle),

  updateClient: (id, body) =>
    fetch(`${API}/api/clients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify(body),
    }).then(handle),

  runHealth: (clientId) =>
    fetch(`${API}/api/health/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ client_id: clientId }),
    }).then(handle),

  addNote: (clientId, category, note) =>
    fetch(`${API}/api/clients/${clientId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify({ category, note }),
    }).then(handle),

  listTeam: () => fetch(`${API}/api/team`, { headers: tokenHeader() }).then(handle),

  addTeamMember: (body) =>
    fetch(`${API}/api/team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify(body),
    }).then(handle),
};
