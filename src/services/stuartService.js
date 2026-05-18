// SEPOS-DELIVERY-001 — Stuart courier dispatch.
// Stuart is a white-label, zero-commission courier API. This service
// handles OAuth, pricing quotes, job creation and webhook parsing.
//
// Credentials come from Railway env:
//   STUART_CLIENT_ID, STUART_CLIENT_SECRET
//   STUART_ENV — 'sandbox' (default) or 'production'
// Sandbox and production are entirely separate Stuart environments with
// their own credentials and their own API host.
const https = require('https');

const ENV = (process.env.STUART_ENV || 'sandbox').toLowerCase();
const API_HOST = ENV === 'production' ? 'api.stuart.com' : 'api.stuart-sandbox.com';

const PROVIDER = 'Stuart';

function isConfigured() {
  return !!(process.env.STUART_CLIENT_ID && process.env.STUART_CLIENT_SECRET);
}

// Low-level HTTPS request. `body` is an already-encoded string.
function request(method, path, { token, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: API_HOST, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const msg = (parsed && (parsed.message || parsed.error)) || ('HTTP ' + res.statusCode);
          reject(new Error('Stuart API ' + res.statusCode + ': ' + msg));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('Stuart API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// OAuth client-credentials token, cached until just before it expires.
let _token = null;
let _tokenExpiry = 0;
async function getToken() {
  if (!isConfigured()) {
    throw new Error('Stuart not configured — STUART_CLIENT_ID / STUART_CLIENT_SECRET missing');
  }
  if (_token && Date.now() < _tokenExpiry) return _token;
  const form = new URLSearchParams({
    client_id: process.env.STUART_CLIENT_ID,
    client_secret: process.env.STUART_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'api',
  }).toString();
  const res = await request('POST', '/oauth/token', {
    body: form,
    contentType: 'application/x-www-form-urlencoded',
  });
  _token = res.access_token;
  _tokenExpiry = Date.now() + (((res.expires_in || 3600) - 60) * 1000);
  return _token;
}

// Price quote for a pickup → dropoff leg. Addresses are plain strings;
// Stuart geocodes them.
async function getQuote({ pickupAddress, dropoffAddress }) {
  const token = await getToken();
  const body = JSON.stringify({
    job: {
      pickups: [{ address: pickupAddress }],
      dropoffs: [{ package_type: 'small', address: dropoffAddress }],
    },
  });
  const res = await request('POST', '/v2/jobs/pricing', { token, body });
  const amount = res && res.amount;
  let price = null;
  if (typeof amount === 'number') price = amount;
  else if (amount && typeof amount === 'object') {
    price = Number(amount.value != null ? amount.value : amount.tax_included);
  }
  return { price, currency: res.currency || (amount && amount.currency) || 'GBP' };
}

// Create a delivery job. `order` is the SiamEPOS order (with an `items`
// array); `pickup` is the restaurant pickup details from settings.
async function createJob({ order, pickup }) {
  const token = await getToken();
  const itemSummary = (order.items || [])
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ')
    .slice(0, 250) || `Order #${order.id}`;
  const body = JSON.stringify({
    job: {
      pickups: [{
        address: pickup.address,
        comment: `SiamEPOS order #${order.id}`,
        contact: {
          firstname: String(pickup.name || 'Restaurant').slice(0, 100),
          phone: pickup.phone || '',
          company: pickup.name || 'Restaurant',
        },
      }],
      dropoffs: [{
        package_type: 'small',
        package_description: itemSummary,
        client_reference: `sepos-order-${order.id}`,
        address: order.delivery_address,
        comment: order.delivery_notes || '',
        contact: {
          firstname: String(order.customer_name || 'Customer').slice(0, 100),
          phone: order.customer_phone || '',
        },
      }],
    },
  });
  const res = await request('POST', '/v2/jobs', { token, body });
  const delivery = (res.deliveries && res.deliveries[0]) || {};
  return {
    jobId: res.id != null ? String(res.id) : null,
    status: delivery.status || res.status || 'new',
    trackingUrl: delivery.tracking_url || null,
    eta: delivery.eta || res.dropoff_at || null,
  };
}

// Normalise a Stuart webhook payload to the fields the server stores.
// Stuart posts the job (sometimes wrapped under `data`) on status changes.
function parseWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const job = payload.data || payload;
  const delivery = (job.deliveries && job.deliveries[0]) || job;
  return {
    jobId: job.id != null ? String(job.id)
      : (delivery.job_id != null ? String(delivery.job_id) : null),
    status: delivery.status || job.status || null,
    trackingUrl: delivery.tracking_url || null,
    eta: delivery.eta || job.dropoff_at || null,
    clientReference: delivery.client_reference || null,
  };
}

// Stuart delivery statuses that mean the parcel reached the customer.
const DELIVERED_STATUSES = ['delivered'];
const CANCELLED_STATUSES = ['cancelled', 'canceled', 'voided', 'expired'];

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
