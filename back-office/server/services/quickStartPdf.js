// SEPOS-029 — Owner's Quick Start PDF generator.
//
// Renders a 1-page A4 PDF with the four things a brand-new owner needs
// in front of them on day one:
//   1. How to log in (with their owner PIN)
//   2. How to add staff
//   3. How to fire their first order
//   4. How to reach support
//
// Returns a Node Buffer so the welcome email can base64-encode it as an
// attachment, or callers can stream it as a download. Layout uses
// pdfkit primitives — no external fonts, so the PDF generates fast and
// looks clean in any reader.

const PDFDocument = require('pdfkit');

// Brand palette — matches the back-office UI.
const NAVY  = '#0D1B3E';
const GOLD  = '#C9A84C';
const MUTED = '#475569';
const TEXT  = '#0f172a';

async function buildQuickStartPdf(client) {
  const c = client || {};
  const m = c.metadata || {};
  const restaurant = c.restaurant_name || 'Your restaurant';
  const owner      = c.owner_name      || 'Owner';
  const ownerPin   = m.owner_pin       || '9999';
  const frontendUrl = m.frontend_url   || (m.subdomain_slug ? `https://${m.subdomain_slug}.siamepos.co.uk` : 'https://app.siamepos.co.uk');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 48, left: 56, right: 56 },
      info: {
        Title:    `${restaurant} — SiamEPOS Quick Start`,
        Author:   'SiamEPOS',
        Subject:  'Owner Quick Start',
      },
    });

    const chunks = [];
    doc.on('data',  (ch)  => chunks.push(ch));
    doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // ── Header band ──────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 96).fill(NAVY);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(26).text('SiamEPOS', 56, 32);
    doc.fillColor(GOLD).font('Helvetica').fontSize(11).text('OWNER QUICK START', 56, 64, { characterSpacing: 2 });

    // Subtitle
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(20).text(restaurant, 56, 120);
    doc.fillColor(MUTED).font('Helvetica').fontSize(11).text(`Welcome, ${owner}. Everything you need to start using SiamEPOS today.`, 56, 148);

    // Gold rule
    doc.moveTo(56, 174).lineTo(doc.page.width - 56, 174).strokeColor(GOLD).lineWidth(2).stroke();

    // ── Section helper ───────────────────────────────────────────
    let y = 192;
    const section = (num, title, body) => {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(`${num}.  ${title.toUpperCase()}`, 56, y);
      y += 22;
      doc.fillColor(TEXT).font('Helvetica').fontSize(11);
      const bodyLines = body.split('\n');
      for (const line of bodyLines) {
        if (line.startsWith('•')) {
          doc.text(line, 70, y, { width: doc.page.width - 130 });
          y += 16;
        } else if (line.startsWith('CODE:')) {
          const code = line.replace(/^CODE:\s*/, '');
          doc.font('Courier-Bold').fontSize(12).fillColor(NAVY).text(code, 70, y);
          doc.font('Helvetica').fontSize(11).fillColor(TEXT);
          y += 18;
        } else if (line.trim() === '') {
          y += 6;
        } else {
          doc.text(line, 56, y, { width: doc.page.width - 112 });
          y += 16;
        }
      }
      y += 14;
    };

    section('1', 'Logging in',
`Open your EPOS in any browser:
CODE: ${frontendUrl}

Tap any table, then enter your owner PIN to open Admin:
CODE: ${ownerPin}

Change this PIN on first login — Admin → Staff → tap your name → set a new PIN.`
    );

    section('2', 'Adding your staff',
`Admin → Staff → ➕ Add Staff. For each person, enter:
• Their name (real name — appears on receipts + reports)
• A unique 4–6 digit PIN
• Their role: admin, manager, supervisor, waiter, kitchen, or bar

PINs are how staff log in — keep them private and rotate yearly.`
    );

    section('3', 'Taking your first order',
`From the Table Map (home screen):
• Tap an empty table → enter covers → ✓ Open Order
• Pick items from the menu → Send to Kitchen
• When the customer is ready to pay, tap the table → 📋 Open Order → Take Bill
• Choose Cash / Card → Pay → ✓ Done

That's it — the order closes, the table goes free, and it lands in your daily report.`
    );

    section('4', 'Getting support',
`Anything at all — billing, technical, training, new feature requests —
write to: info@siamepos.co.uk

Most replies come back the same day. For genuine outages, mark your
email subject [URGENT] and we'll page someone immediately.

Welcome aboard. — The SiamEPOS team`
    );

    // ── Footer band ──────────────────────────────────────────────
    const footerY = doc.page.height - 48;
    doc.rect(0, footerY, doc.page.width, 48).fill(NAVY);
    doc.fillColor('white').font('Helvetica').fontSize(9).text(
      `SiamEPOS · Restaurant management for Thai restaurants in the UK · info@siamepos.co.uk`,
      0, footerY + 19,
      { width: doc.page.width, align: 'center' }
    );

    doc.end();
  });
}

module.exports = { buildQuickStartPdf };
