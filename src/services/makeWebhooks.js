// SEPOS-033 Phase 3 — Make.com webhook triggers.
//
// Once an hour, looks for customers / bookings that have just crossed
// a threshold (lapsed 60d / booking completed yesterday / birthday this
// month) and POSTs to the matching Make.com webhook URL. webhook_fires
// gives us per-entity dedupe so retrying the cron never double-fires.
//
// Skipped entirely on Electron / local installs (no point) and
// silently no-ops if the relevant *_WEBHOOK env var isn't set.

const https = require('https');
const http  = require('http');
const pool  = require('../db/dbAdapter');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
let intervalHandle = null;

function postWebhook(url, payload) {
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === 'http:' ? http : https;
      const body = JSON.stringify(payload);
      const req = client.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(8000, () => { try { req.destroy(); } catch {} resolve(false); });
      req.write(body);
      req.end();
    } catch { resolve(false); }
  });
}

async function alreadyFired(eventType, entityKey) {
  const r = await pool.query(
    'SELECT 1 FROM webhook_fires WHERE event_type=$1 AND entity_key=$2 LIMIT 1',
    [eventType, String(entityKey)]
  );
  return (r.rows || []).length > 0;
}

async function recordFire(eventType, entityKey) {
  await pool.query(
    'INSERT INTO webhook_fires (event_type, entity_key) VALUES ($1, $2)',
    [eventType, String(entityKey)]
  );
}

const isoDate = (d) => d.toISOString().slice(0, 10);

async function runLapsedCheck() {
  const url = process.env.MAKE_LAPSED_WEBHOOK;
  if (!url) return { skipped: true };

  // Threshold computed in JS so the SQL is dialect-agnostic.
  const cutoff = isoDate(new Date(Date.now() - 60 * 86400000));
  const r = await pool.query(`
    SELECT LOWER(TRIM(customer_email)) AS email_key,
           MIN(customer_email) AS customer_email,
           MIN(customer_name)  AS customer_name,
           MIN(customer_phone) AS customer_phone,
           MAX(reservation_date) AS last_visit
    FROM reservations
    WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> ''
      AND unsubscribed_at IS NULL
    GROUP BY LOWER(TRIM(customer_email))
    HAVING MAX(reservation_date) < $1
  `, [cutoff]);

  let fired = 0;
  const today = new Date();
  for (const c of r.rows) {
    if (await alreadyFired('customer_lapsed', c.email_key)) continue;
    const days = Math.floor((today - new Date(c.last_visit)) / 86400000);
    const ok = await postWebhook(url, {
      event: 'customer_lapsed',
      customer: {
        name: c.customer_name, email: c.customer_email,
        phone: c.customer_phone, last_visit: c.last_visit,
        days_since_last_visit: days,
      },
      restaurant_name: process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant',
    });
    if (ok) { await recordFire('customer_lapsed', c.email_key); fired++; }
  }
  if (fired > 0) console.log(`[webhook] customer_lapsed: ${fired} fired`);
  return { fired };
}

async function runBookingCompletedCheck() {
  const url = process.env.MAKE_BOOKING_COMPLETED_WEBHOOK;
  if (!url) return { skipped: true };

  const yesterday = isoDate(new Date(Date.now() - 86400000));
  const r = await pool.query(`
    SELECT id, customer_name, customer_email, customer_phone, covers,
           reservation_date, reservation_time, table_id, status
    FROM reservations
    WHERE reservation_date = $1
      AND status NOT IN ('cancelled', 'no-show')
  `, [yesterday]);

  let fired = 0;
  for (const res of r.rows) {
    const key = `res_${res.id}`;
    if (await alreadyFired('booking_completed', key)) continue;
    const ok = await postWebhook(url, {
      event: 'booking_completed',
      reservation: {
        id: res.id, customer_name: res.customer_name,
        customer_email: res.customer_email, customer_phone: res.customer_phone,
        covers: res.covers,
        reservation_date: String(res.reservation_date).slice(0, 10),
        reservation_time: String(res.reservation_time).slice(0, 5),
        table_id: res.table_id, status: res.status,
      },
      restaurant_name: process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant',
    });
    if (ok) { await recordFire('booking_completed', key); fired++; }
  }
  if (fired > 0) console.log(`[webhook] booking_completed: ${fired} fired`);
  return { fired };
}

async function runBirthdayCheck() {
  const url = process.env.MAKE_BIRTHDAY_WEBHOOK;
  if (!url) return { skipped: true };
  // DOB isn't collected anywhere yet (not on the booking widget). Once
  // a reservations.customer_birthday TEXT column lands ('MM-DD' format),
  // this fires once per customer per year for birthdays in the current
  // month. For now, no-op so the cron stays harmless.
  return { skipped: true, reason: 'no DOB capture yet' };
}

async function runAll() {
  const results = {};
  try { results.lapsed   = await runLapsedCheck(); }            catch (e) { results.lapsed   = { error: e.message }; }
  try { results.booking  = await runBookingCompletedCheck(); }  catch (e) { results.booking  = { error: e.message }; }
  try { results.birthday = await runBirthdayCheck(); }          catch (e) { results.birthday = { error: e.message }; }
  return results;
}

function start() {
  if ((process.env.DB_MODE || 'cloud').toLowerCase() === 'local') {
    console.log('[webhook] local mode — Make.com cron skipped');
    return;
  }
  const anyConfigured =
    !!process.env.MAKE_LAPSED_WEBHOOK ||
    !!process.env.MAKE_BOOKING_COMPLETED_WEBHOOK ||
    !!process.env.MAKE_BIRTHDAY_WEBHOOK;
  if (!anyConfigured) {
    console.log('[webhook] no MAKE_*_WEBHOOK envs set — cron not started');
    return;
  }
  console.log('[webhook] hourly Make.com cron started');
  intervalHandle = setInterval(() => {
    runAll().catch((err) => console.error('[webhook] runAll error:', err.message));
  }, CHECK_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = { start, stop, runAll, runLapsedCheck, runBookingCompletedCheck, runBirthdayCheck };
