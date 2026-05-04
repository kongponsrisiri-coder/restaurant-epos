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
  return new Promise((resolve) => {
    if (!process.env.RESEND_API_KEY) {
      console.log('ℹ️  RESEND_API_KEY not set — skipping email to ' + to);
      return resolve();
    }

    const body = JSON.stringify({
      from:    'SiamEPOS <onboarding@resend.dev>',
      to:      [to],
      subject: subject,
      html:    html,
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('✅ Email sent to ' + to);
        } else {
          console.error('❌ Resend error ' + res.statusCode + ':', data);
        }
        resolve();
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
  console.log('📧 Sending confirmation email for booking #' + reservation.id);

  if (!reservation.customer_email) {
    console.log('ℹ️  No customer email — skipping');
    return;
  }

  const date = formatDate(reservation.reservation_date);
  const time = formatTime(reservation.reservation_time);

  // Customer confirmation
  await sendResendEmail(
    reservation.customer_email,
    'Booking Confirmed — ' + restaurantName,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
      <div style="background:#1a472a;padding:30px;text-align:center">
        <h1 style="color:white;margin:0;font-size:24px">Booking Confirmed!</h1>
      </div>
      <div style="padding:30px">
        <p style="font-size:16px;color:#333">Dear <strong>${reservation.customer_name}</strong>,</p>
        <p style="color:#555">Your table is confirmed at <strong>${restaurantName}</strong>.</p>
        <div style="background:#f8fdf9;border:2px solid #1a472a;border-radius:10px;padding:20px;margin:20px 0">
          <p><strong>Date:</strong> ${date}</p>
          <p><strong>Time:</strong> ${time}</p>
          <p><strong>Covers:</strong> ${reservation.covers} guest${reservation.covers > 1 ? 's' : ''}</p>
          <p><strong>Ref:</strong> #${reservation.id}</p>
          ${reservation.notes ? '<p><strong>Notes:</strong> ' + reservation.notes + '</p>' : ''}
        </div>
        <p style="color:#555">To cancel please contact us at ${restaurantEmail || 'info@siamepos.co.uk'}</p>
      </div>
    </div>`
  );

  // Restaurant notification
  if (restaurantEmail) {
    await sendResendEmail(
      restaurantEmail,
      'New Booking — ' + reservation.customer_name + ' x' + reservation.covers + ' on ' + date,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a472a">New Booking Received</h2>
        <p><strong>Name:</strong> ${reservation.customer_name}</p>
        <p><strong>Phone:</strong> ${reservation.customer_phone || '—'}</p>
        <p><strong>Email:</strong> ${reservation.customer_email || '—'}</p>
        <p><strong>Date:</strong> ${date}</p>
        <p><strong>Time:</strong> ${time}</p>
        <p><strong>Covers:</strong> ${reservation.covers}</p>
        <p><strong>Source:</strong> ${reservation.source || 'EPOS'}</p>
        <p><strong>Ref:</strong> #${reservation.id}</p>
        ${reservation.notes ? '<p><strong>Notes:</strong> ' + reservation.notes + '</p>' : ''}
      </div>`
    );
  }
}


async function sendReminderEmail(reservation) {
  return sendBookingConfirmation(reservation);
}

async function sendBookingSms() {
  // SMS not configured
}

module.exports = { sendBookingConfirmation, sendReminderEmail, sendBookingSms };