// SEPOS-029 — Welcome email for newly onboarded restaurant clients.
//
// Phase 1 ships a stub that logs the payload it WOULD send via Brevo,
// so the rest of the wizard (endpoints, UI, checklist) can land and be
// tested end-to-end before the real Brevo wiring is in.
//
// Chunk 5 will replace `sendWelcomeEmail` with the real call to
// new BrevoApi.TransactionalEmailsApi().sendTransacEmail({...}) and
// attach the Quick-Start PDF as a base64 attachment.

const { buildQuickStartPdf } = require('./quickStartPdf');

const FROM = {
  name:  process.env.BREVO_FROM_NAME  || 'SiamEPOS',
  email: process.env.BREVO_FROM_EMAIL || 'info@siamepos.co.uk',
};

function buildWelcomeHtml(client) {
  const m = client.metadata || {};
  const releaseUrl = 'https://github.com/kongponsrisiri-coder/restaurant-epos/releases/latest';
  const supportEmail = FROM.email;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Welcome to SiamEPOS</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f6f7fb; color: #0f172a; line-height: 1.55; }
  .wrap { max-width: 580px; margin: 0 auto; padding: 32px 24px; }
  .card { background: white; border-radius: 14px; padding: 32px 28px; box-shadow: 0 1px 3px rgba(15,23,42,0.06); }
  h1 { font-family: Georgia, serif; font-size: 28px; margin: 0 0 8px; color: #0D1B3E; }
  .gold { color: #C9A84C; }
  .tagline { color: #64748b; margin: 0 0 24px; font-size: 14px; }
  .row { padding: 12px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; font-weight: 700; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; background: #f1f5f9; padding: 2px 7px; border-radius: 4px; font-size: 13px; }
  .cta { display: inline-block; background: #0D1B3E; color: white; padding: 12px 22px; border-radius: 8px; font-weight: 800; text-decoration: none; margin-top: 18px; }
  .secret { background: #fef3c7; padding: 14px 18px; border-radius: 8px; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; border: 1px solid #fbbf24; margin-top: 10px; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 28px; }
</style></head><body>
<div class="wrap">
  <div class="card">
    <h1>Welcome to <span>Siam</span><span class="gold">EPOS</span></h1>
    <p class="tagline">Your restaurant management system is being set up for <strong>${escapeHtml(client.restaurant_name)}</strong>.</p>

    <div class="row"><div class="label">Restaurant</div><div>${escapeHtml(client.restaurant_name)}</div></div>
    ${client.owner_name ? `<div class="row"><div class="label">Owner</div><div>${escapeHtml(client.owner_name)}</div></div>` : ''}
    ${m.owner_pin ? `<div class="row"><div class="label">Owner PIN (manager)</div><div><code>${escapeHtml(m.owner_pin)}</code> &middot; change this on your first login</div></div>` : ''}
    ${client.railway_url ? `<div class="row"><div class="label">Your EPOS backend</div><div><code>${escapeHtml(client.railway_url)}</code></div></div>` : ''}
    ${m.frontend_url ? `<div class="row"><div class="label">Your EPOS web app</div><div><a href="${escapeHtml(m.frontend_url)}">${escapeHtml(m.frontend_url)}</a></div></div>` : ''}

    ${m.sync_secret ? `
    <div class="row">
      <div class="label">Desktop sync key (SYNC_SECRET)</div>
      <div>Used by the SiamEPOS Pro desktop app to sync with the cloud. Paste this into <code>config.json</code> when prompted on first launch.</div>
      <div class="secret">${escapeHtml(m.sync_secret)}</div>
    </div>` : ''}

    <a class="cta" href="${releaseUrl}">Download the desktop app</a>

    <p style="font-size: 13px; color: #64748b; margin-top: 22px;">
      A printable <strong>Owner's Quick Start</strong> is attached to this email. It covers logging in, adding staff, firing your first order, and how to reach support.
    </p>
    <p style="font-size: 13px; color: #64748b;">Questions? Reply to this email or write to <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
  </div>
  <p class="footer">SiamEPOS &middot; restaurant management for Thai restaurants in the UK</p>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/**
 * Send the welcome email + Quick Start PDF attachment to the
 * restaurant owner. Stubbed for Phase 1 chunk 1 — chunk 5 replaces this
 * with the real Brevo SDK call.
 *
 * Returns { sent, messageId?, attached, error? }.
 */
async function sendWelcomeEmail(client) {
  const html = buildWelcomeHtml(client);
  let pdfBuffer;
  try { pdfBuffer = await buildQuickStartPdf(client); }
  catch (err) { console.warn('[welcomeEmail] PDF build skipped:', err.message); }

  const stubbed = !process.env.BREVO_API_KEY;
  if (stubbed) {
    console.log(`[welcomeEmail] STUB — would send to ${client.email || '(no email)'} (${html.length} bytes HTML${pdfBuffer ? `, ${pdfBuffer.length} bytes PDF` : ''})`);
    return { sent: false, stubbed: true, reason: 'BREVO_API_KEY not configured on the back-office service' };
  }

  // Real send lives in chunk 5. Leaving the implementation hook here so
  // the wizard can call this function with no further code changes:
  //
  //   const Brevo = require('@getbrevo/brevo');
  //   const client = new Brevo.TransactionalEmailsApi();
  //   client.authentications.apiKey.apiKey = process.env.BREVO_API_KEY;
  //   const res = await client.sendTransacEmail({ ... });
  //   return { sent: true, messageId: res.messageId };

  console.log('[welcomeEmail] real-send path not yet implemented — falling through as stub');
  return { sent: false, stubbed: true, reason: 'real Brevo send not wired yet (chunk 5)' };
}

module.exports = { sendWelcomeEmail, buildWelcomeHtml };
