// SEPOS-DELIVERY-001 — Uber Direct courier dispatch (SCAFFOLD).
//
// Uber Direct is Uber's white-label courier API (zero commission, flat
// fee) — distinct from the Uber Eats marketplace. API access has been
// applied for (info@siamepos.co.uk) and is pending review; until the
// credentials land this module is INERT — isConfigured() returns false,
// so the dispatcher never routes to it. The implementation is wired up
// so that once the three env vars below are set it works without code
// changes:
//   UBER_DIRECT_CLIENT_ID, UBER_DIRECT_CLIENT_SECRET, UBER_DIRECT_CUSTOMER_ID
const https = require('https');

const TOKEN_HOST = 'login.uber.com';
const API_HOST = 'api.uber.com';
const PROVIDER = 'Uber Direct';

function isConfigured() {
  return !!(
    process.env.UBER_DIRECT_CLIENT_ID &&
    process.env.UBER_DIRECT_CLIENT_SECRET &&
    process.env.UBER_DIRECT_CUSTOMER_ID
  );
}

function request(host, method, path, { token, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: host, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const msg = (parsed && (parsed.message || parsed.error)) || ('HTTP ' + res.statusCode);
          reject(new Error('Uber Direct API ' + res.statusCode + ': ' + msg));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('Uber Direct API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

let _token = null;
let _tokenExpiry = 0;
async function getToken() {
  if (!isConfigured()) {
    throw new Error('Uber Direct not enabled — API access pending approval');
  }
  if (_token && Date.now() < _tokenExpiry) return _token;
  const form = new URLSearchParams({
    client_id: process.env.UBER_DIRECT_CLIENT_ID,
    client_secret: process.env.UBER_DIRECT_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'eats.deliveries',
  }).toString();
  const res = await request(TOKEN_HOST, 'POST', '/oauth/v2/token', {
    body: form,
    contentType: 'application/x-www-form-urlencoded',
  });
  _token = res.access_token;
  _tokenExpiry = Date.now() + (((res.expires_in || 2592000) - 60) * 1000);
  return _token;
}

async function getQuote({ pickupAddress, dropoffAddress }) {
  const token = await getToken();
  const cid = process.env.UBER_DIRECT_CUSTOMER_ID;
  const body = JSON.stringify({ pickup_address: pickupAddress, dropoff_address: dropoffAddress });
  const res = await request(API_HOST, 'POST', `/v1/customers/${cid}/delivery_quotes`, { token, body });
  return {
    price: res.fee != null ? Number(res.fee) / 100 : null, // Uber returns minor units
    currency: res.currency || 'GBP',
  };
}

async function createJob({ order, pickup }) {
  const token = await getToken();
  const cid = process.env.UBER_DIRECT_CUSTOMER_ID;
  const manifest = (order.items || []).map((i) => ({
    name: String(i.name || 'Item').slice(0, 100),
    quantity: Number(i.quantity) || 1,
    size: 'small',
  }));
  const body = JSON.stringify({
    pickup_address: pickup.address,
    pickup_name: String(pickup.name || 'Restaurant').slice(0, 100),
    pickup_phone_number: pickup.phone || '',
    dropoff_address: order.delivery_address,
    dropoff_name: String(order.customer_name || 'Customer').slice(0, 100),
    dropoff_phone_number: order.customer_phone || '',
    dropoff_notes: order.delivery_notes || '',
    manifest_reference: `sepos-order-${order.id}`,
    manifest_items: manifest.length ? manifest : [{ name: `Order #${order.id}`, quantity: 1, size: 'small' }],
  });
  const res = await request(API_HOST, 'POST', `/v1/customers/${cid}/deliveries`, { token, body });
  return {
    jobId: res.id != null ? String(res.id) : null,
    status: res.status || 'pending',
    trackingUrl: res.tracking_url || null,
    eta: res.dropoff_eta || null,
  };
}

function parseWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const d = payload.data || payload;
  return {
    jobId: d.id != null ? String(d.id) : null,
    status: d.status || null,
    trackingUrl: d.tracking_url || null,
    eta: d.dropoff_eta || null,
    clientReference: d.manifest_reference || null,
  };
}

const DELIVERED_STATUSES = ['delivered'];
const CANCELLED_STATUSES = ['canceled', 'cancelled', 'returned'];

module.exports = {
  PROVIDER,
  isConfigured,
  getToken,
  getQuote,
  createJob,
  parseWebhook,
  DELIVERED_STATUSES,
  CANCELLED_STATUSES,
};
