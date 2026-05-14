// SEPOS-029 — Owner's Quick Start PDF generator.
//
// Phase 1 chunk 1: stub returns an empty Buffer so callers don't need
// to special-case missing PDFs. Chunk 5 replaces the body with a real
// pdfkit-rendered 1-page A4 guide covering: logging in with the owner
// PIN, adding staff, firing a first order, contacting support.
//
// Returns a Node Buffer (so callers can either stream it as a download
// or base64-encode it for a Brevo attachment).

/**
 * @param {object} client — row from the clients table, with metadata
 *   already merged. Used for the printed personalisation
 *   ("Welcome, {owner_name}" / restaurant name / PIN).
 * @returns {Promise<Buffer>}
 */
async function buildQuickStartPdf(client) {
  // Stubbed for chunk 1 — chunk 5 implementation sketch:
  //
  //   const PDFDocument = require('pdfkit');
  //   const doc = new PDFDocument({ size: 'A4', margin: 40 });
  //   const chunks = [];
  //   doc.on('data', (c) => chunks.push(c));
  //   doc.fontSize(28).fillColor('#0D1B3E').text('SiamEPOS — Owner Quick Start');
  //   ...render the sections...
  //   doc.end();
  //   return new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const stub = `[Stub PDF placeholder for ${client?.restaurant_name || 'restaurant'}]`;
  return Buffer.from(stub, 'utf8');
}

module.exports = { buildQuickStartPdf };
