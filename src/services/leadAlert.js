// SEPOS-LEAD-ALERT-001 — text Korakot the moment Tara captures contact
// details (Nick's ask, 13 Aug: a lead sat unnoticed for 19 hours).
//
// Called fire-and-forget on every INBOUND sales-chat message (website widget
// + Facebook Messenger). When a message contains an email or a phone number,
// the session is atomically claimed (lead_notified_at guards double-sends —
// one alert per conversation, ever) and an SMS goes to LEAD_ALERT_SMS_TO via
// the same Twilio creds the booking-confirmation SMS uses. Dormant without
// the env. LINE/email deliberately NOT used — Korakot chose SMS.

const { pool } = require('../db/dbAdapter');
const { sendSms } = require('./emailService');

// Email, or a UK-ish phone (07…, +44…, 0044…) with 10+ digits once
// separators are stripped — enough digits that order numbers and prices
// don't false-positive.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?44|0044|0)[\s\-()]*(?:\d[\s\-()]*){9,10}/;

function detectContact(text) {
  const t = String(text || '');
  const email = t.match(EMAIL_RE);
  if (email) return email[0];
  const phone = t.match(PHONE_RE);
  if (phone) {
    const digits = phone[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) return phone[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// Scan one inbound message; alert once per session. Never throws.
async function scan(sessionId, channel, text) {
  try {
    const to = process.env.LEAD_ALERT_SMS_TO;
    if (!to) return;
    const contact = detectContact(text);
    if (!contact) return;
    // Atomic claim — only the FIRST capturing message in a session sends.
    const claimed = await pool.query(
      `UPDATE sales_chats SET lead_contact = $2, lead_notified_at = NOW()
        WHERE session_id = $1 AND lead_notified_at IS NULL
        RETURNING session_id`,
      [sessionId, String(contact).slice(0, 120)]
    );
    if (!claimed.rows[0]) return;
    const snippet = String(text || '').slice(0, 120);
    await sendSms(to,
      `🔥 SiamEPOS LEAD (${channel})\n${contact}\n"${snippet}"\nReply now: Control Room → 💬 Web Chat`);
    console.log(`[lead-alert] SMS sent — ${channel} session ${sessionId}`);
  } catch (e) {
    console.warn('[lead-alert]', e.message);
  }
}

module.exports = { scan, detectContact };
