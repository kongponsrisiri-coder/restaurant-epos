const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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

async function sendBookingConfirmation(reservation) {
  if (!reservation.customer_email) return;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('ℹ️  Email not configured — skipping confirmation');
    return;
  }
  try {
    await transporter.sendMail({
      from:    `${restaurantName} <${process.env.EMAIL_USER}>`,
      to:      reservation.customer_email,
      subject: `Booking Confirmed — ${restaurantName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
          <div style="background:#1a472a;padding:30px;text-align:center">
            <h1 style="color:white;margin:0;font-size:24px">🎉 Booking Confirmed!</h1>
          </div>
          <div style="padding:30px">
            <p style="font-size:16px;color:#333">Dear <strong>${reservation.customer_name}</strong>,</p>
            <p style="color:#555">Your table has been confirmed at <strong>${restaurantName}</strong>.</p>
            <div style="background:#f8fdf9;border:2px solid #1a472a;border-radius:10px;padding:20px;margin:20px 0">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;color:#888;font-size:14px">📅 Date</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatDate(reservation.reservation_date)}</td></tr>
                <tr><td style="padding:8px 0;color:#888;font-size:14px">🕐 Time</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${formatTime(reservation.reservation_time)}</td></tr>
                <tr><td style="padding:8px 0;color:#888;font-size:14px">👥 Covers</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">${reservation.covers} guest${reservation.covers > 1 ? 's' : ''}</td></tr>
                <tr><td style="padding:8px 0;color:#888;font-size:14px">🔖 Ref</td><td style="padding:8px 0;font-weight:bold;color:#1a472a">#${reservation.id}</td></tr>
                ${reservation.notes ? `<tr><td style="padding:8px 0;color:#888;font-size:14px">📝 Notes</td><td style="padding:8px 0;color:#555">${reservation.notes}</td></tr>` : ''}
              </table>
            </div>
            <p style="color:#555">To cancel or make changes please contact us at <a href="mailto:${restaurantEmail || process.env.EMAIL_USER}">${restaurantEmail || process.env.EMAIL_USER}</a></p>
            <p style="color:#888;font-size:12px;margin-top:30px;border-top:1px solid #eee;padding-top:16px">
              This is an automated confirmation from ${restaurantName}
            </p>
          </div>
        </div>
      `,
    });
    console.log(`✅ Confirmation email sent to ${reservation.customer_email}`);

    // Also notify the restaurant
    if (restaurantEmail) {
      await transporter.sendMail({
        from:    `${restaurantName} <${process.env.EMAIL_USER}>`,
        to:      restaurantEmail,
        subject: `New Booking — ${reservation.customer_name} × ${reservation.covers} on ${formatDate(reservation.reservation_date)}`,
        html: `
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
        `,
      });
      console.log(`✅ Restaurant notification sent to ${restaurantEmail}`);
    }

  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

async function sendReminderEmail(reservation) {
  // Placeholder for 24hr reminder
  return sendBookingConfirmation(reservation);
}

module.exports = { sendBookingConfirmation, sendReminderEmail };