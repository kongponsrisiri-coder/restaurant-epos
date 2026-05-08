const nodemailer = require('nodemailer');

const RESTAURANT_NAME    = process.env.RESTAURANT_NAME  || 'SiamEPOS Restaurant';
const RESTAURANT_EMAIL   = process.env.RESTAURANT_EMAIL || 'info@siamepos.co.uk';
const RESTAURANT_PHONE   = '07700 000000';
const RESTAURANT_ADDRESS = '123 Test Street, London, E1 1AA';

const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   587,
  secure: false,
  family: 4,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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

async function sendGmailEmail(to, subject, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('ℹ️  EMAIL_USER or EMAIL_PASS not set — skipping email to ' + to);
    return;
  }
  try {
    const info = await transporter.sendMail({
      from:    `"${RESTAURANT_NAME}" <${process.env.EMAIL_USER}>`,
      to:      to,
      subject: subject,
      html:    html,
    });
    console.log('✅ Email sent to ' + to + ' — ' + info.messageId);
  } catch (err) {
    console.error('❌ Email error:', err.message);
    throw err;
  }
}

async function sendBookingConfirmation(reservation) {
  console.log('📧 Sending confirmation email for booking #' + reservation.id);

  if (!reservation.customer_email) {
    console.log('ℹ️  No customer email — skipping');
    return;
  }

  const date   = formatDate(reservation.reservation_date);
  const time   = formatTime(reservation.reservation_time);
  const name   = reservation.customer_name;
  const covers = reservation.covers;
  const notes  = reservation.notes || '—';
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

  await sendGmailEmail(
    reservation.customer_email,
    `Booking Confirmed ✅ — ${RESTAURANT_NAME}`,
    html
  );
}

async function sendReminderEmail(reservation) {
  if (!reservation.customer_email) return;

  const date   = formatDate(reservation.reservation_date);
  const time   = formatTime(reservation.reservation_time);
  const name   = reservation.customer_name;
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

  await sendGmailEmail(
    reservation.customer_email,
    `Reminder: Your booking tomorrow at ${RESTAURANT_NAME} ⏰`,
    html
  );
}

async function sendBookingSms() {
  // SMS not configured
}

module.exports = { sendBookingConfirmation, sendReminderEmail, sendBookingSms };