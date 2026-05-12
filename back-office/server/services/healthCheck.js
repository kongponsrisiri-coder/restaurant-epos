// SEPOS-041 — health-check cron. Every 5 minutes, ping each active client's
// /api/health endpoint, record the result, prune rows older than the latest
// 2000 per client (keeps the table bounded as we scale).

const cron = require('node-cron');
const { pool } = require('../db/pool');

const HEALTH_TIMEOUT_MS  = parseInt(process.env.HEALTH_TIMEOUT_MS || '8000', 10);
const HEALTH_KEEP_ROWS   = parseInt(process.env.HEALTH_KEEP_ROWS || '2000', 10);

async function runHealthCheckForClient(clientId) {
  const r = await pool.query('SELECT id, railway_url, status FROM clients WHERE id = $1', [clientId]);
  const client = r.rows[0];
  if (!client) return null;
  return await pingAndRecord(client);
}

async function pingAndRecord(client) {
  if (!client.railway_url) {
    // No URL configured — record offline so it stands out on the dashboard.
    await pool.query(
      `INSERT INTO health_checks (client_id, is_online, response_ms, orders_today, last_order_at)
       VALUES ($1, FALSE, NULL, NULL, NULL)`,
      [client.id]
    );
    await pruneOldRows(client.id);
    return { ran: true, online: false, reason: 'no railway_url' };
  }

  const base = client.railway_url.replace(/\/+$/, '');
  const url  = (base.startsWith('http://') || base.startsWith('https://') ? base : 'https://' + base) + '/api/health';

  const started = Date.now();
  let is_online = false;
  let response_ms = null;
  let orders_today = null;
  let last_order_at = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    response_ms = Date.now() - started;
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      is_online = true;
      orders_today  = Number.isFinite(parseInt(body.orders_today, 10)) ? parseInt(body.orders_today, 10) : null;
      last_order_at = body.last_order_at || null;
    }
  } catch (err) {
    response_ms = Date.now() - started;
  }

  await pool.query(
    `INSERT INTO health_checks (client_id, is_online, response_ms, orders_today, last_order_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [client.id, is_online, response_ms, orders_today, last_order_at]
  );
  await pruneOldRows(client.id);

  return { ran: true, online: is_online, response_ms, orders_today, last_order_at };
}

async function pruneOldRows(clientId) {
  // Keep the most recent N rows per client_id. Cheap because of
  // idx_health_client_time on (client_id, checked_at DESC).
  try {
    await pool.query(
      `DELETE FROM health_checks
       WHERE client_id = $1 AND id NOT IN (
         SELECT id FROM health_checks WHERE client_id = $1
         ORDER BY checked_at DESC LIMIT $2
       )`,
      [clientId, HEALTH_KEEP_ROWS]
    );
  } catch (err) {
    console.warn(`[ops-health] prune client=${clientId} failed:`, err.message);
  }
}

async function tickAllClients() {
  try {
    const r = await pool.query(
      "SELECT id, railway_url, status FROM clients WHERE status IN ('active', 'trial')"
    );
    if (r.rows.length === 0) return;
    // Run in parallel — each ping is independent, AbortController bounds the time.
    await Promise.allSettled(r.rows.map(pingAndRecord));
    console.log(`[ops-health] tick complete — ${r.rows.length} clients pinged`);
  } catch (err) {
    console.error('[ops-health] tick error', err);
  }
}

function start() {
  // Every 5 minutes, plus once on boot so the dashboard isn't blank.
  cron.schedule('*/5 * * * *', tickAllClients);
  setTimeout(tickAllClients, 5000);
  console.log('[ops-health] cron started — every 5 minutes');
}

module.exports = { start, tickAllClients, runHealthCheckForClient };
