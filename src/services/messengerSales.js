// SEPOS-SALESCHAT-002 — Facebook Messenger doorway for the Tara sales concierge.
//
// The SiamEPOS Facebook page gets DMs from prospects; this pipes them into the
// SAME sales_chats store + Tara brain as the marketing-site chat, so the
// Control Room's 💬 Web Chat panel shows Messenger threads alongside web ones
// and the human-takeover flow works identically (an operator reply on an fb-
// thread is pushed back out through the Graph API by the admin reply route).
//
// Wiring (main cloud ONLY — inert on tenants without the env vars):
//   MESSENGER_VERIFY_TOKEN    — webhook handshake string (any random value;
//                               must match what's typed in the Meta dashboard)
//   MESSENGER_APP_SECRET      — Meta app secret, for X-Hub-Signature-256
//   MESSENGER_PAGE_ACCESS_TOKEN — page token for the SiamEPOS page
//
// Adapted from the proven Siam-Shop messengerService (same contract).

'use strict';

const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';

function isConfigured() {
  return Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN);
}

// GET webhook — Meta's subscription handshake.
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.MESSENGER_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// POST webhook — HMAC check so only Meta can feed us events.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.MESSENGER_APP_SECRET;
  if (!secret) {
    // Without the secret we cannot authenticate the sender — refuse loudly
    // rather than process unverified traffic.
    console.warn('[messenger-sales] MESSENGER_APP_SECRET unset — rejecting webhook');
    return false;
  }
  if (!signatureHeader || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch { return false; }
}

// Pull plain text messages out of a page webhook payload. Skips echoes (our
// own page's outbound messages come back as events with is_echo) and
// non-text attachments (we reply asking for text via the caller if needed).
function extractMessages(payload) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const ev of entry.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue;
      const senderId = ev.sender && ev.sender.id;
      const text = (ev.message.text || '').trim();
      if (!senderId || !text) continue;
      out.push({ senderId, text });
    }
  }
  return out;
}

// Send a text reply to a PSID. Messenger caps ~2000 chars per message —
// chunk on paragraph boundaries if Tara runs long.
async function sendText(psid, text) {
  const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  if (!token) { console.warn('[messenger-sales] no page token — would reply:', String(text).slice(0, 80)); return false; }
  const chunks = [];
  let rest = String(text || '').trim();
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf('\n', 1900);
    if (cut < 500) cut = 1900;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  for (const chunk of chunks) {
    const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: chunk } }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[messenger-sales] send failed', r.status, body.slice(0, 200));
      return false;
    }
  }
  return true;
}

module.exports = { isConfigured, verifyWebhook, verifySignature, extractMessages, sendText };
