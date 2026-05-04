const https = require('https');

const restaurantName  = process.env.RESTAURANT_NAME  || 'SiamEPOS Restaurant';
const restaurantEmail = process.env.RESTAURANT_EMAIL || null;

function formatDate(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch { return dateStr; }
}

function formatTime(timeStr) {
  return timeStr ? String(timeStr).slice(0, 5) : '';
}

function sendResendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    if (!process.env.RESEND_API_KEY) {
      console.log('ℹ️  RESEND_API_KEY not set — skipping email');
      return resolve();
    }

    const body = JSON.stringify({
      from:    `${restaurantName} <onboarding@resend.dev>`,
      to:      [to],
      subject: subject,
      html:    html,
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Email sent to ${to}`);
          resolve();
        } else {
          console.error(`❌ Resend error ${res.statusCode}:`, data);
          resolve();
        }
      });
    });

    req.on('error', err => {
      console.error('❌ Email request error:', err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

async function sendBookingConfirmation(reservation) {
  if (!reservation.customer_email) return;

  // Email 1 — Customer confirmation
  await sendResendEmail(
    reservation.customer_email,
    `Booking Confirmed — ${restaurantName}`,
    `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
      <div style="background:#1a472a;padding:30px;text-align:center">
        <h1 style="color:white;margin:0;font-size:24px">🎉 Booking Confirmed!</h1>
      </div>
      <div style="padding:30px">
        <p style="font-size:16px;color:#333">Dear <strong>${reservation.customer_name}</strong>,</p>
        <p style="color:#555">Your table has been confirmed at <strong>${restaurantName}</strong>. We look forward to welcoming you!</p>
        <div style="background:#f8fdf9;border:2px solid #1a472a;border-radius:10px;padding:20px;margin:20px 0">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#888;font-size:14px">📅 Date</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatDate(reservation.reservation_date)}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:14px">🕐 Time</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatTime(reservation.reservation_time)}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:14px">👥 Covers</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${reservation.covers} guest${reservation.covers > 1 ? 's' : ''}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:14px">🔖 Ref</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">#${reservation.id}</td></tr>
            ${reservation.notes ? `<tr><td style="padding:8px 0;color:#888;font-size:14px">📝 Notes</td><td style="padding:8px 0;color:#555">${reservation.notes}</td></tr>` : ''}
          </table>
        </div>
        <p style="color:#555">To cancel or make changes please contact us at <a href="mailto:${restaurantEmail || 'info@siamepos.co.uk'}">${restaurantEmail || 'info@siamepos.co.uk'}</a></p>
        <p style="color:#888;font-size:12px;margin-top:30px;border-top:1px solid #eee;padding-top:16px">
          This is an automated confirmation from ${restaurantName}
        </p>
      </div>
    </div>
    `
  );

  // Email 2 — Restaurant notification
  if (restaurantEmail) {
    await sendResendEmail(
      restaurantEmail,
      `New Booking — ${reservation.customer_name} × ${reservation.covers} on ${formatDate(reservation.reservation_date)}`,
      `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a472a">📅 New Booking Received</h2>
        <table style="width:100%;border-collapse:collapse;font-size:15px">
          <tr><td style="padding:8px 0;color:#888;width:120px">👤 Name</td><td style="padding:8px 0;font-weight:bold">${reservation.customer_name}</td></tr>
          <tr><td style="padding:8px 0;color:#888">📞 Phone</td><td style="padding:8px 0">${reservation.customer_phone || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888">📧 Email</td><td style="padding:8px 0">${reservation.customer_email || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888">📅 Date</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatDate(reservation.reservation_date)}</td></tr>
          <tr><td style="padding:8px 0;color:#888">🕐 Time</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatTime(reservation.reservation_time)}</td></tr>
          <tr><td style="padding:8px 0;color:#888">👥 Covers</td><td style="padding:8px 0;font-weight:bold">${reservation.covers}</td></tr>
          <tr><td style="padding:8px 0;color:#888">🌐 Source</td><td style="padding:8px 0">${reservation.source || 'EPOS'}</td></tr>
          <tr><td style="padding:8px 0;color:#888">🔖 Ref</td><td style="padding:8px 0">#${reservation.id}</td></tr>
          ${reservation.notes ? `<tr><td style="padding:8px 0;color:#888">📝 Notes</td><td style="padding:8px 0">${reservation.notes}</td></tr>` : ''}
        </table>
      </div>
      `
    );
  }
}

async function sendReminderEmail(reservation) {
  return sendBookingConfirmation(reservation);
}

async function sendBookingSms() {
  // SMS not configured yet
}

module.exports = { sendBookingConfirmation, sendReminderEmail, sendBookingSms };