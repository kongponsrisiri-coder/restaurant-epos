// SEPOS-TICKET-FONT-001 — kitchen tickets rendered with a REAL typeface.
//
// The thermal printer's built-in fonts are the blocky "typewriter" look
// Korakot photographed; the smooth ticket he wants (11 Aug photo) is made by
// rendering the ticket as an IMAGE with proper fonts and sending the bitmap.
// This module does that: pureimage (pure JS — no native deps, safe next to
// better-sqlite3) + Noto Sans (SIL OFL, bundled) → 576px-wide bitmap →
// ESC/POS GS v 0 raster.
//
// Off by default. Turns on per-venue with settings.kitchen_ticket_style =
// 'rendered' — classic path untouched otherwise.

'use strict';

const path = require('path');
const PImage = require('pureimage');

const W = 576; // POS80 printable width @ 203dpi
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fontsReady = null;
function loadFonts() {
  if (!fontsReady) {
    const reg = PImage.registerFont(path.join(FONT_DIR, 'NotoSans-Regular.ttf'), 'TicketSans');
    const bold = PImage.registerFont(path.join(FONT_DIR, 'NotoSans-Bold.ttf'), 'TicketSansBold');
    fontsReady = Promise.all([reg.load ? reg.load() : reg, bold.load ? bold.load() : bold]);
  }
  return fontsReady;
}

// lines: [{ text, size, bold, center, gap, rule }]
async function renderLines(lines) {
  await loadFonts();
  const PAD = 8, LH = 1.35;
  let h = 24;
  for (const l of lines) h += l.rule ? 18 : Math.ceil((l.size || 30) * LH) + (l.gap || 0);
  h += 30;
  const img = PImage.make(W, h);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = '#000000';
  let y = 24;
  for (const l of lines) {
    if (l.rule) {
      ctx.fillRect(PAD, y + 6, W - PAD * 2, 3); y += 18; continue;
    }
    const size = l.size || 30;
    ctx.font = `${size}pt ${l.bold ? 'TicketSansBold' : 'TicketSans'}`;
    const tw = ctx.measureText(l.text).width;
    const x = l.center ? Math.max(PAD, (W - tw) / 2) : PAD + (l.indent || 0);
    y += Math.ceil(size * LH);
    ctx.fillText(l.text, x, y - Math.ceil(size * 0.28));
    y += (l.gap || 0);
  }
  return img;
}

// 1-bit pack → ESC/POS GS v 0 raster
function toRaster(img) {
  const w = img.width, h = img.height, bpr = w >> 3;
  const data = Buffer.alloc(bpr * h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const px = img.getPixelRGBA(xx, yy);
      const lum = ((px >>> 24) * 0.3 + ((px >>> 16) & 0xff) * 0.59 + ((px >>> 8) & 0xff) * 0.11);
      if (lum < 140) data[yy * bpr + (xx >> 3)] |= (0x80 >> (xx & 7));
    }
  }
  return Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, bpr & 0xff, bpr >> 8, h & 0xff, h >> 8]),
    data,
  ]);
}

// Build the standard kitchen ticket as lines, render, return ESC/POS buffer.
async function kitchenTicketRaster(order, items, opts = {}) {
  const tz = 'Europe/London';
  const now = new Date();
  const label = (order.table_label && String(order.table_label).trim())
    ? String(order.table_label).trim().toUpperCase()
    : (order.order_type === 'takeaway' ? `TAKEAWAY ${order.table_number ?? ''}`.trim() : `TABLE ${order.table_number ?? ''}`.trim());
  const lines = [
    { text: now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }), size: 22, center: true, gap: 4 },
    { rule: true },
    { text: label, size: 44, bold: true, center: true, gap: 6 },
    ...(order.notes ? [{ text: String(order.notes), size: 24, bold: true, gap: 4 }] : []),
    { rule: true },
  ];
  for (const it of items || []) {
    lines.push({ text: `${it.quantity} × ${it.name || it.item_name || ''}`, size: 32, gap: 2 });
    if (it.notes) lines.push({ text: it.notes, size: 26, bold: true, indent: 34, gap: 4 });
  }
  lines.push({ rule: true });
  lines.push({ text: `Order #${order.id}${opts.course ? ' · ' + opts.course : ''}`, size: 22, center: true });
  const img = await renderLines(lines);
  return Buffer.concat([toRaster(img), Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00])]); // feed + cut
}

// Debug/preview — same render to a PNG file so the look can be approved
// before any printer sees it.
async function previewPNG(order, items, outPath, opts = {}) {
  const tzLines = await (async () => null)();
  const img = await renderLines(await _linesFor(order, items, opts));
  await PImage.encodePNGToStream(img, require('fs').createWriteStream(outPath));
  return outPath;
}
async function _linesFor(order, items, opts) {
  // shared with kitchenTicketRaster — rebuilt small to avoid refactor risk
  const now = new Date();
  const label = (order.table_label && String(order.table_label).trim()) ? String(order.table_label).trim().toUpperCase() : `TABLE ${order.table_number ?? ''}`;
  const lines = [
    { text: now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), size: 22, center: true, gap: 4 },
    { rule: true },
    { text: label, size: 44, bold: true, center: true, gap: 6 },
    { rule: true },
  ];
  for (const it of items || []) {
    lines.push({ text: `${it.quantity} × ${it.name}`, size: 32, gap: 2 });
    if (it.notes) lines.push({ text: it.notes, size: 26, bold: true, indent: 34, gap: 4 });
  }
  lines.push({ rule: true });
  lines.push({ text: `Order #${order.id}`, size: 22, center: true });
  return lines;
}

module.exports = { kitchenTicketRaster, previewPNG };
