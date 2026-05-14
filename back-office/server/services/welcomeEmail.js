// SEPOS-029 — Welcome email for newly onboarded restaurant clients.
//
// Phase 1 ships a stub that logs the payload it WOULD send via Brevo,
// so the rest of the wizard (endpoints, UI, checklist) can land and be
// tested end-to-end before the real Brevo wiring is in.
//
// Chunk 5 will replace `sendWelcomeEmail` with the real call to
// new BrevoApi.TransactionalEmailsApi().sendTransacEmail({...}) and
// attach the Quick-Start PDF as a base64 attachment.

const https = require('https');
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
 * restaurant owner via Brevo's transactional email API.
 *
 * Uses raw HTTPS rather than the @getbrevo/brevo SDK — matches the
 * pattern in src/services/emailService.js (the main EPOS server) so
 * there's one less moving part to debug, and keeps the bundle small.
 *
 * Returns { sent, messageId?, error?, stubbed? }.
 */
async function sendWelcomeEmail(client) {
  if (!client?.email) {
    return { sent: false, error: 'client has no email address' };
  }

  const html = buildWelcomeHtml(client);
  let pdfBuffer;
  try { pdfBuffer = await buildQuickStartPdf(client); }
  catch (err) { console.warn('[welcomeEmail] PDF build skipped:', err.message); }

  if (!process.env.BREVO_API_KEY) {
    console.log(`[welcomeEmail] STUB — BREVO_API_KEY not set; would send to ${client.email} (${html.length} bytes HTML${pdfBuffer ? `, ${pdfBuffer.length} bytes PDF` : ''})`);
    return { sent: false, stubbed: true, reason: 'BREVO_API_KEY not configured on the back-office service' };
  }

  const payload = {
    sender:      { name: FROM.name, email: FROM.email },
    to:          [{ email: client.email, name: client.owner_name || client.restaurant_name }],
    subject:     `Welcome to SiamEPOS — ${client.restaurant_name}`,
    htmlContent: html,
  };
  if (pdfBuffer && pdfBuffer.length > 64) {
    // Brevo expects attachments as { name, content: base64 }.
    payload.attachment = [{
      name:    'SiamEPOS-Quick-Start.pdf',
      content: pdfBuffer.toString('base64'),
    }];
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'api-key':        process.env.BREVO_API_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          console.log(`[welcomeEmail] ✅ sent to ${client.email} (messageId=${parsed.messageId || 'n/a'})`);
          resolve({ sent: true, messageId: parsed.messageId });
        } else {
          console.error(`[welcomeEmail] ❌ Brevo ${res.statusCode}:`, data);
          resolve({ sent: false, error: `Brevo ${res.statusCode}: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on('error', (err) => {
      console.error('[welcomeEmail] ❌ request error:', err.message);
      resolve({ sent: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { sendWelcomeEmail, buildWelcomeHtml };
