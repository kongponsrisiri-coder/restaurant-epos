// SEPOS-DELIVEROO-001 — Deliveroo Partner Platform integration.
// Receives incoming Deliveroo orders via webhook, auto-accepts them,
// and allows the kitchen to mark them ready for collection.
//
// Credentials from Railway env:
//   DELIVEROO_CLIENT_ID, DELIVEROO_CLIENT_SECRET
//   DELIVEROO_ENV — 'sandbox' (default) or 'production'
const https = require('https');

const ENV = (process.env.DELIVEROO_ENV || 'sandbox').toLowerCase();
const API_HOST = 'api.developers.deliveroo.com';

const PROVIDER = 'Deliveroo';

function isConfigured() {
  return !!(process.env.DELIVEROO_CLIENT_ID && process.env.DELIVEROO_CLIENT_SECRET);
}

// Low-level HTTPS request.
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: API_HOST, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const msg = (parsed && (parsed.message || parsed.error || parsed.detail)) || ('HTTP ' + res.statusCode);
          reject(new Error('Deliveroo API ' + res.statusCode + ': ' + msg));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('Deliveroo API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// OAuth client-credentials token, cached until just before expiry.
let _token = null;
let _tokenExpiry = 0;
async function getToken() {
  if (!isConfigured()) {
    throw new Error('Deliveroo not configured — DELIVEROO_CLIENT_ID / DELIVEROO_CLIENT_SECRET missing');
  }
  if (_token && Date.now() < _tokenExpiry) return _token;
  const form = new URLSearchParams({
    client_id: process.env.DELIVEROO_CLIENT_ID,
    client_secret: process.env.DELIVEROO_CLIENT_SECRET,
    grant_type: 'client_credentials',
  }).toString();
  // Token endpoint uses form encoding
  const res = await new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(form),
    };
    const req = https.request({ hostname: API_HOST, path: '/oauth2/token', method: 'POST', headers }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad token response: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(form);
    req.end();
  });
  if (!res.access_token) throw new Error('Deliveroo token response missing access_token: ' + JSON.stringify(res));
  _token = res.access_token;
  _tokenExpiry = Date.now() + (((res.expires_in || 3600) - 60) * 1000);
  return _token;
}

// Accept an incoming order — must be called within ~10 minutes of receipt.
async function acceptOrder(deliverooOrderId) {
  const token = await getToken();
  await request('POST', `/order/v1/orders/${deliverooOrderId}/accept`, { token, body: '{}' });
  console.log(`✅ Deliveroo order ${deliverooOrderId} accepted`);
}

// Mark order ready for collection (kitchen has finished cooking).
async function markReady(deliverooOrderId) {
  const token = await getToken();
  await request('POST', `/order/v1/orders/${deliverooOrderId}/ready_for_collection`, { token, body: '{}' });
  console.log(`✅ Deliveroo order ${deliverooOrderId} marked ready`);
}

// Normalise a Deliveroo webhook payload into the fields SiamEPOS needs.
// Deliveroo wraps orders under payload.order or payload.data.order.
function parseWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const order = payload.order || (payload.data && payload.data.order) || payload;
  if (!order || !order.id) return null;

  const items = (order.items || []).map(i => ({
    name: i.name || i.item_name || 'Item',
    quantity: i.quantity || 1,
    unit_price: typeof i.unit_price === 'number' ? i.unit_price / 100 : 0, // Deliveroo prices are in pence
    notes: (i.modifiers || []).map(m => m.name).filter(Boolean).join(', '),
  }));

  const customer = order.customer || {};
  return {
    deliverooOrderId: String(order.id),
    displayId: order.display_id || order.id,
    customerName: customer.name || customer.first_name || 'Deliveroo Customer',
    customerPhone: customer.phone || '',
    customerNotes: order.notes || order.customer_notes || '',
    pickupTime: order.estimated_pickup_time || order.pickup_time || null,
    totalPrice: typeof order.total_price === 'number' ? order.total_price / 100 : null,
    siteId: order.site_id || null,
    items,
  };
}

module.exports = {
  PROVIDER,
  isConfigured,
  getToken,
  acceptOrder,
  markReady,
  parseWebhook,
};
