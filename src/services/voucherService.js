// SEPOS-VOUCHER-001 — gift voucher service.
//
// Code generation, expiry math, Stripe payment intent helpers (with a
// mock-pay fallback when STRIPE_SECRET_KEY isn't configured — keeps
// the demo + non-Stripe restaurants working), and the branded Brevo
// gift email. Used by /api/widget/voucher/* + /api/vouchers/* routes
// in server.js.

const { sendBrevoEmail } = require('./emailService');

// ── Config ────────────────────────────────────────────────────────
// Mirrors the policy Korakot picked: £10 min, £500 cap, 24-month expiry.
const VOUCHER_MIN_AMOUNT     = Number(process.env.VOUCHER_MIN_AMOUNT     || 10);
const VOUCHER_MAX_AMOUNT     = Number(process.env.VOUCHER_MAX_AMOUNT     || 500);
const VOUCHER_EXPIRY_MONTHS  = Number(process.env.VOUCHER_EXPIRY_MONTHS  || 24);

// Public-facing site for the recipient — used in the gift email so they
// can land on a real-looking restaurant page from the message.
const RESTAURANT_NAME    = process.env.RESTAURANT_NAME    || 'SiamEPOS Restaurant';
const RESTAURANT_EMAIL   = process.env.RESTAURANT_EMAIL   || 'info@siamepos.co.uk';
const RESTAURANT_ADDRESS = process.env.RESTAURANT_ADDRESS || '';
const RESTAURANT_SITE    = process.env.RESTAURANT_SITE    || ''; // optional
// SEPOS-WALLET-001 — absolute base URL for the .pkpass download link
// included in the gift email's "Add to Apple Wallet" CTA. Resolution order:
//   1. options.baseUrl passed in by the caller (req-derived — always correct)
//   2. PUBLIC_API_URL env var (override for custom domains / CDNs)
//   3. The main Railway production host (last-resort default)
// The first option means the email link always points back to whichever
// backend actually processed the purchase, so the cert that signed the
// .pkpass is also the cert at the URL — no domain mismatch possible.
const PUBLIC_API_URL_DEFAULT = (process.env.PUBLIC_API_URL || 'https://restaurant-epos-production.up.railway.app').replace(/\/$/, '');

// ── Code generation ───────────────────────────────────────────────
// 8 chars, no I/O/0/1 ambiguity. Prefix GIFT- so codes are scannable
// from a printed gift card without typo-prone "is that an O or a 0?".
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let body = '';
  for (let i = 0; i < 8; i++) body += chars[Math.floor(Math.random() * chars.length)];
  return 'GIFT-' + body;
}

// ── Expiry helpers ────────────────────────────────────────────────
// expires_at is a DATE column (no time component). Voucher is valid
// through the END of that day in UK time — `new Date('2026-05-25') <
// new Date()` would otherwise flip the voucher to expired at 01:00 BST
// on the morning it was supposed to still be valid for.
function defaultExpiryDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + VOUCHER_EXPIRY_MONTHS);
  return d.toISOString().slice(0, 10);
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  const [y, mo, d] = dateStr.split('-').map(Number);
  // End of day London = next day's 00:00 UTC (close enough — daylight
  // saving shifts the cutoff by an hour at the edges, which we accept).
  const next = Date.UTC(y, mo - 1, d + 1);
  return Date.now() >= next;
}

// ── Validation ────────────────────────────────────────────────────
function validateAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Amount required' };
  if (n < VOUCHER_MIN_AMOUNT) return { ok: false, error: `Minimum voucher £${VOUCHER_MIN_AMOUNT}` };
  if (n > VOUCHER_MAX_AMOUNT) return { ok: false, error: `Maximum voucher £${VOUCHER_MAX_AMOUNT}` };
  // round to pennies, no fractional pence
  return { ok: true, amount: Math.round(n * 100) / 100 };
}

// ── Stripe payment intent (with mock fallback) ────────────────────
// If STRIPE_SECRET_KEY isn't set, we hand back a fake PI shape so the
// widget can still demo end-to-end on Baan Siam. The created voucher
// is tagged payment_method='mock' so reports + admin can distinguish.
async function createPaymentIntent(amountGbp) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      mode: 'mock',
      payment_intent_id: 'mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client_secret: 'mock_secret_no_real_payment',
      publishable_key: null,
    };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(Number(amountGbp) * 100),
    currency: 'gbp',
    automatic_payment_methods: { enabled: true },
    metadata: { product: 'siamepos_gift_voucher' },
  });
  return {
    mode: 'stripe',
    payment_intent_id: intent.id,
    client_secret: intent.client_secret,
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
  };
}

// Server-side verify — never trust the client's "I paid" claim alone.
// For mock PIs we accept by prefix; for real PIs we re-fetch from Stripe
// and check status. Returns the actual amount paid (defends against
// client tampering with the amount field).
async function verifyPaymentIntent(piId, expectedAmountGbp) {
  if (!piId) return { ok: false, error: 'No payment_intent_id' };
  if (String(piId).startsWith('mock_')) {
    return { ok: true, mode: 'mock', amount_paid: Number(expectedAmountGbp) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, error: 'Stripe not configured but real PI submitted' };
  }
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(piId);
    if (pi.status !== 'succeeded') return { ok: false, error: `Payment not completed (${pi.status})` };
    return { ok: true, mode: 'stripe', amount_paid: (pi.amount_received || 0) / 100 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Gift email (Brevo) ────────────────────────────────────────────
// Branded navy/gold layout matching booking confirmation. Sent on the
// delivery_date if it's in the future (scheduling is handled by the
// caller; this function just composes + dispatches). Returns the
// Brevo result; caller is responsible for stamping email_sent_at.
// SEPOS-WALLET-002 — the Add-to-Wallet link is emailed to the customer and
// opened on THEIR phone, so it must be a public URL. A voucher sold on the
// DESKTOP app hits the local server, so the caller-derived host is
// `localhost:3001` (or a LAN IP) — unreachable off the till. Reject any
// local/private host and fall back to the tenant cloud this install syncs to
// (CLOUD_API_URL), then the PUBLIC_API_URL env, then the main Railway.
function isLocalHost(u) {
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.))/i.test(u || '');
}
function resolveWalletBase(baseUrl) {
  if (baseUrl && !isLocalHost(baseUrl)) return baseUrl.replace(/\/$/, '');
  const cloud = process.env.CLOUD_API_URL;
  if (cloud && !isLocalHost(cloud)) return cloud.replace(/\/$/, '');
  return PUBLIC_API_URL_DEFAULT;
}

async function sendVoucherGiftEmail(voucher, options = {}) {
  if (!voucher.recipient_email) return { skipped: true, reason: 'no recipient' };
  // SEPOS-WALLET-001/002 — public base for the Add-to-Wallet link (never local).
  const PUBLIC_API_URL = resolveWalletBase(options.baseUrl);
  const code      = voucher.code;
  const amount    = Number(voucher.original_amount || 0).toFixed(2);
  const fromName  = voucher.sender_name    || 'A friend';
  const toName    = voucher.recipient_name || 'you';
  const message   = voucher.message        || '';
  const expiry    = voucher.expires_at
    ? new Date(String(voucher.expires_at).slice(0, 10) + 'T12:00:00')
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e3da">
      <div style="background:#1e3a6e;padding:36px 24px;text-align:center">
        <div style="color:#C9A84C;font-size:13px;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px">A Gift For You</div>
        <h1 style="color:white;margin:0;font-size:30px;font-weight:400">${RESTAURANT_NAME}</h1>
      </div>

      <div style="padding:32px 28px;text-align:center">
        <p style="font-size:16px;color:#444;margin:0 0 4px">Dear <strong>${escapeHtml(toName)}</strong>,</p>
        <p style="font-size:15px;color:#666;margin:0 0 22px"><strong>${escapeHtml(fromName)}</strong> has sent you a gift voucher.</p>

        ${message ? `<div style="background:#fdf6ec;border-left:4px solid #C9A84C;padding:14px 18px;margin:0 0 24px;text-align:left;font-style:italic;color:#5b4a2a;font-size:14px">"${escapeHtml(message)}"</div>` : ''}

        <div style="background:linear-gradient(135deg,#1e3a6e,#2a4d8a);border-radius:12px;padding:28px 20px;margin:18px 0">
          <div style="color:#C9A84C;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Voucher Value</div>
          <div style="color:white;font-size:48px;font-weight:700;letter-spacing:-1px">£${amount}</div>
          <div style="margin-top:18px;background:rgba(255,255,255,0.1);border:1px dashed rgba(255,255,255,0.3);border-radius:8px;padding:12px 16px;font-family:Menlo,Consolas,monospace;color:white;font-size:22px;letter-spacing:3px;font-weight:700">${code}</div>
          <div style="color:rgba(255,255,255,0.7);font-size:11px;margin-top:10px">Quote this code when paying your bill</div>
        </div>

        <p style="color:#888;font-size:13px;margin:24px 0 4px">Valid until <strong>${expiry}</strong></p>

        <p style="margin:18px 0 0">
          <a href="${PUBLIC_API_URL}/api/widget/voucher/${encodeURIComponent(code)}/wallet-pass"
             style="display:inline-block;padding:12px 22px;background:#000000;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0.2px">
            &#127968;&nbsp; Add to Apple Wallet
          </a>
        </p>
        <p style="color:#aaa;font-size:11px;margin:8px 0 0">Open this email on your iPhone to save the voucher to Wallet</p>

        ${RESTAURANT_SITE ? `<p style="margin:18px 0 0"><a href="${RESTAURANT_SITE}" style="display:inline-block;padding:11px 24px;background:#C9A84C;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:0.5px">Book a table →</a></p>` : ''}
      </div>

      <div style="background:#fafaf7;padding:18px 24px;text-align:center;border-top:1px solid #eee;color:#888;font-size:11px">
        ${RESTAURANT_NAME}${RESTAURANT_ADDRESS ? ' · ' + escapeHtml(RESTAURANT_ADDRESS) : ''}${RESTAURANT_EMAIL ? ' · ' + escapeHtml(RESTAURANT_EMAIL) : ''}<br>
        Powered by SiamEPOS
      </div>
    </div>
  `;

  try {
    await sendBrevoEmail(
      voucher.recipient_email,
      `🎁 ${fromName} has sent you a £${amount} gift voucher`,
      html,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

module.exports = {
  VOUCHER_MIN_AMOUNT,
  VOUCHER_MAX_AMOUNT,
  VOUCHER_EXPIRY_MONTHS,
  generateCode,
  defaultExpiryDate,
  isExpired,
  validateAmount,
  createPaymentIntent,
  verifyPaymentIntent,
  sendVoucherGiftEmail,
};
