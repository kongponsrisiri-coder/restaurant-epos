const https = require('https');

const RESTAURANT_NAME    = process.env.RESTAURANT_NAME  || 'SiamEPOS Restaurant';
const RESTAURANT_EMAIL   = process.env.RESTAURANT_EMAIL || 'info@siamepos.co.uk';
const RESTAURANT_PHONE   = '07700 000000';
const RESTAURANT_ADDRESS = '123 Test Street, London, E1 1AA';
const FROM_EMAIL         = 'noreply@siamepos.co.uk';

// SEPOS-047j — escape customer-supplied fields (name, notes) before they go
// into email HTML. They originate from the public booking widget, so an
// unescaped value could inject markup/links into the confirmation + reminder
// emails. Low impact (recipient is the customer's own inbox) but free to fix.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  try {
    const str   = dateStr instanceof Date ? dateStr.toISOString() : String(dateStr);
    const clean = str.split('T')[0];
    return new Date(clean + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch { return String(dateStr); }
}

function formatTime(timeStr) {
  return timeStr ? String(timeStr).slice(0, 5) : '';
}

// Cloud-relay path used by Mac / Windows desktop installs that don't
// hold BREVO_API_KEY locally. Forwards { to, subject, html } to the
// Railway backend's `/api/local/send-email` endpoint, which signs with
// SYNC_SECRET and actually calls Brevo with the cloud-side key.
function _relayEmailViaCloud(to, subject, html) {
  return new Promise((resolve, reject) => {
    const cloudUrl = process.env.CLOUD_API_URL;
    const secret   = process.env.SYNC_SECRET;
    if (!cloudUrl || !secret) {
      console.log('ℹ️  BREVO_API_KEY not set and no cloud relay configured — skipping email to ' + to);
      return resolve();
    }
    const u = new URL('/api/local/send-email', cloudUrl);
    const body = JSON.stringify({ to, subject, html });
    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-sync-secret':  secret,
      },
    };
    const transport = u.protocol === 'https:' ? https : require('http');
    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('✅ Email relayed via cloud to ' + to);
          resolve();
        } else {
          console.error('❌ Cloud email relay error ' + res.statusCode + ':', data);
          reject(new Error('Cloud relay error: ' + data));
        }
      });
    });
    req.on('error', err => {
      console.error('❌ Cloud relay request error:', err.message);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function sendBrevoEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    if (!process.env.BREVO_API_KEY) {
      // No local key — try the cloud relay (desktop installs in
      // cloud-relay mode). If that's not configured either, the relay
      // logs + resolves silently (same behaviour as before).
      return _relayEmailViaCloud(to, subject, html).then(resolve, reject);
    }

    const body = JSON.stringify({
      sender:  { name: RESTAURANT_NAME, email: FROM_EMAIL },
      to:      [{ email: to }],
      subject: subject,
      htmlContent: html,
    });

    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'api-key':        process.env.BREVO_API_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('✅ Email sent to ' + to);
          resolve();
        } else {
          console.error('❌ Brevo error ' + res.statusCode + ':', data);
          reject(new Error('Brevo error: ' + data));
        }
      });
    });

    req.on('error', err => {
      console.error('❌ Email request error:', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

async function sendBookingConfirmation(reservation) {
  console.log('📧 Sending confirmation email for booking #' + reservation.id);

  if (!reservation.customer_email) {
    console.log('ℹ️  No customer email — skipping');
    return;
  }

  const date   = formatDate(reservation.reservation_date);
  const time   = formatTime(reservation.reservation_time);
  const name   = escapeHtml(reservation.customer_name);
  const covers = reservation.covers;
  const notes  = escapeHtml(reservation.notes || '—');
  const ref    = reservation.id;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">

      <div style="background:#1a472a;padding:32px;text-align:center">
        <h1 style="color:white;margin:0;font-size:26px">✅ Booking Confirmed!</h1>
        <p style="color:#a8d5b5;margin:8px 0 0;font-size:15px">${RESTAURANT_NAME}</p>
      </div>

      <div style="padding:32px">
        <p style="font-size:16px;color:#333">Dear <strong>${name}</strong>,</p>
        <p style="color:#555;font-size:15px">Thank you for your reservation at <strong>${RESTAURANT_NAME}</strong>. Your booking has been confirmed!</p>

        <div style="background:#f8fdf9;border:2px solid #1a472a;border-radius:10px;padding:24px;margin:24px 0">
          <h3 style="margin:0 0 16px;color:#1a472a;font-size:16px">📋 BOOKING DETAILS</h3>
          <p style="margin:8px 0;font-size:15px">📅 <strong>Date:</strong> ${date}</p>
          <p style="margin:8px 0;font-size:15px">⏰ <strong>Time:</strong> ${time}</p>
          <p style="margin:8px 0;font-size:15px">👥 <strong>Guests:</strong> ${covers}</p>
          <p style="margin:8px 0;font-size:15px">📝 <strong>Notes:</strong> ${notes}</p>
          <p style="margin:8px 0;font-size:13px;color:#888">Ref: #${ref}</p>
        </div>

        <p style="color:#555;font-size:15px">We look forward to welcoming you!</p>
        <p style="color:#555;font-size:14px">
          To cancel or amend your booking please contact us:<br><br>
          📞 <strong>${RESTAURANT_PHONE}</strong><br>
          📧 <strong>${RESTAURANT_EMAIL}</strong><br>
          📍 ${RESTAURANT_ADDRESS}
        </p>
      </div>

      <div style="background:#f5f5f5;padding:16px;text-align:center">
        <p style="margin:0;font-size:12px;color:#aaa">Powered by SiamEPOS</p>
      </div>

    </div>
  `;

  await sendBrevoEmail(
    reservation.customer_email,
    `Booking Confirmed ✅ — ${RESTAURANT_NAME}`,
    html
  );
}

async function sendReminderEmail(reservation) {
  if (!reservation.customer_email) return;

  const date   = formatDate(reservation.reservation_date);
  const time   = formatTime(reservation.reservation_time);
  const name   = escapeHtml(reservation.customer_name);
  const covers = reservation.covers;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">

      <div style="background:#1a472a;padding:32px;text-align:center">
        <h1 style="color:white;margin:0;font-size:24px">⏰ Reminder: Your booking is tomorrow!</h1>
        <p style="color:#a8d5b5;margin:8px 0 0">${RESTAURANT_NAME}</p>
      </div>

      <div style="padding:32px">
        <p style="font-size:16px;color:#333">Dear <strong>${name}</strong>,</p>
        <p style="color:#555;font-size:15px">This is a reminder that you have a reservation <strong>tomorrow</strong> at <strong>${RESTAURANT_NAME}</strong>.</p>

        <div style="background:#f8fdf9;border:2px solid #1a472a;border-radius:10px;padding:24px;margin:24px 0">
          <p style="margin:8px 0;font-size:15px">📅 <strong>Date:</strong> ${date}</p>
          <p style="margin:8px 0;font-size:15px">⏰ <strong>Time:</strong> ${time}</p>
          <p style="margin:8px 0;font-size:15px">👥 <strong>Guests:</strong> ${covers}</p>
        </div>

        <p style="color:#555;font-size:14px">
          Need to cancel or amend? Please contact us:<br><br>
          📞 <strong>${RESTAURANT_PHONE}</strong><br>
          📧 <strong>${RESTAURANT_EMAIL}</strong>
        </p>
      </div>

      <div style="background:#f5f5f5;padding:16px;text-align:center">
        <p style="margin:0;font-size:12px;color:#aaa">Powered by SiamEPOS</p>
      </div>

    </div>
  `;

  await sendBrevoEmail(
    reservation.customer_email,
    `Reminder: Your booking tomorrow at ${RESTAURANT_NAME} ⏰`,
    html
  );
}

async function sendBookingSms() {}

module.exports = { sendBookingConfirmation, sendReminderEmail, sendBookingSms, sendBrevoEmail };