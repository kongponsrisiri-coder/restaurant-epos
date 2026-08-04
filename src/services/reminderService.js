// SEPOS-REMINDER-001 — day-before booking reminder emails.
//
// The "⏰ your booking is tomorrow" email (emailService.sendReminderEmail) and
// its dedupe table (reservation_reminders) were built with SEPOS-027 but the
// scheduler was NEVER wired — the email had never fired once (found 2026-08-04
// when marketing claimed automatic reminders and Korakot fact-checked it).
//
// Hourly: find tomorrow's live reservations with an email address, skip any
// already reminded (reservation_reminders type='day_before'), send + record.
// Cloud-only: bookings sync to the cloud and BREVO_API_KEY lives there; running
// on local tills too would race the dedupe across machines for no benefit.

const { pool } = require('../db/dbAdapter');
const emailService = require('./emailService');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as makeWebhooks
let timer = null;

// Europe/London "tomorrow" — Railway containers run UTC, and a naive
// toISOString() rolls the date over at 00:00 UTC = 01:00 BST (the same gotcha
// reports.today() guards against).
function londonTomorrow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(Date.now() + 24 * 60 * 60 * 1000)); // YYYY-MM-DD
}

async function runReminderCheck() {
  const tomorrow = londonTomorrow();
  const due = await pool.query(
    `SELECT r.* FROM reservations r
     WHERE r.reservation_date::date = $1::date
       AND r.status IN ('pending', 'confirmed')
       AND r.customer_email IS NOT NULL AND r.customer_email <> ''
       AND NOT EXISTS (
         SELECT 1 FROM reservation_reminders rr
         WHERE rr.reservation_id = r.id AND rr.type = 'day_before'
       )`,
    [tomorrow],
  );
  let sent = 0;
  for (const r of due.rows) {
    try {
      await emailService.sendReminderEmail(r);
      await pool.query(
        `INSERT INTO reservation_reminders (reservation_id, type) VALUES ($1, 'day_before')`,
        [r.id],
      );
      sent++;
    } catch (err) {
      // Don't record a fire that didn't send — the next hourly tick retries.
      console.warn(`[reminders] reservation #${r.id} failed: ${err.message}`);
    }
  }
  if (sent > 0) console.log(`[reminders] day_before: ${sent} sent for ${tomorrow}`);
  return { date: tomorrow, candidates: due.rows.length, sent };
}

function start() {
  // Cloud-only (see header). isLocalInstall = DB_MODE=local (desktop till).
  try {
    const archiveService = require('./archiveService');
    if (archiveService.isLocalInstall()) {
      console.log('[reminders] local install — reminder cron stays on the cloud');
      return;
    }
  } catch { /* archiveService unavailable → treat as cloud */ }
  if (timer) return;
  // First pass shortly after boot, then hourly.
  setTimeout(() => runReminderCheck().catch((e) => console.warn('[reminders]', e.message)), 30 * 1000);
  timer = setInterval(() => runReminderCheck().catch((e) => console.warn('[reminders]', e.message)), CHECK_INTERVAL_MS);
  console.log('[reminders] day-before booking reminders armed (hourly)');
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, runReminderCheck };
