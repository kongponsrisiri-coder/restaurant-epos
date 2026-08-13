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

// lines: [{ text, size, bold, center, gap, rule, indent }]
async function renderLines(lines) {
  await loadFonts();
  const PAD = 8, LH = 1.35;

  // Measure pass — WRAP long text (greedy, word-boundary; hard-break a single
  // over-wide word) so "Stir-Fried Cashew Nut with Jasmine Rice" never clips
  // off the paper's right edge. Uses a 1×1 scratch context for measureText.
  const scratch = PImage.make(1, 1).getContext('2d');
  const wrapped = [];
  for (const l of lines) {
    if (l.rule) { wrapped.push(l); continue; }
    const size = l.size || 30;
    scratch.font = `${size}pt ${l.bold ? 'TicketSansBold' : 'TicketSans'}`;
    const maxW = W - PAD * 2 - (l.indent || 0);
    const words = String(l.text ?? '').split(/\s+/).filter(Boolean);
    if (!words.length) { wrapped.push({ ...l, text: '' }); continue; }
    let cur = '';
    const flush = () => { if (cur) { wrapped.push({ ...l, text: cur, gap: 0 }); cur = ''; } };
    for (const word of words) {
      const cand = cur ? cur + ' ' + word : word;
      if (scratch.measureText(cand).width <= maxW) { cur = cand; continue; }
      flush();
      if (scratch.measureText(word).width <= maxW) { cur = word; continue; }
      // single word wider than the paper — hard-break it
      let piece = '';
      for (const ch of word) {
        if (scratch.measureText(piece + ch).width > maxW) { wrapped.push({ ...l, text: piece, gap: 0 }); piece = ch; }
        else piece += ch;
      }
      cur = piece;
    }
    flush();
    // the last wrapped segment keeps the original gap
    if (wrapped.length && !wrapped[wrapped.length - 1].rule) wrapped[wrapped.length - 1] = { ...wrapped[wrapped.length - 1], gap: l.gap || 0 };
  }

  let h = 24;
  for (const l of wrapped) h += l.rule ? 18 : Math.ceil((l.size || 30) * LH) + (l.gap || 0);
  h += 30;
  const img = PImage.make(W, h);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = '#000000';
  let y = 24;
  for (const l of wrapped) {
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

// The bundled font covers Latin — text outside it (Thai, CJK) would render as
// blanks. Callers use this to fall back to the classic codepage path for any
// ticket that carries such text (e.g. a Thai kitchen note on an English menu).
const NON_LATIN = /[฀-๿一-鿿぀-ヿ가-힯]/;
function hasUnrenderableText(order, items) {
  const parts = [order?.table_label, order?.notes, order?.customer_note,
    order?.customer_name, order?.customer_phone, order?.delivery_address];
  for (const it of items || []) parts.push(it?.name, it?.item_name, it?.notes, it?.item_note);
  return NON_LATIN.test(parts.filter(Boolean).join(' '));
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
// Review C2 — content PARITY with the classic builder: item_note (allergy /
// special requests), customer name+phone, the delivery address block, the
// order-level note, and course headers all print. Anything the classic ticket
// says, this one says.
const COURSES_EN = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
async function kitchenTicketRaster(order, items, opts = {}) {
  const tz = 'Europe/London';
  const now = new Date();
  const label = (order.table_label && String(order.table_label).trim())
    ? String(order.table_label).trim().toUpperCase()
    : (order.order_type === 'takeaway'
        ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}`
           : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`))
        : `TABLE ${order.table_number ?? ''}`.trim());
  const lines = [
    { text: now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }), size: 22, center: true, gap: 4 },
    { rule: true },
    { text: label, size: 44, bold: true, center: true, gap: 6 },
  ];
  // Course-fired ticket: the course is the headline, not a footnote.
  const courseLabel = opts.course != null ? (COURSES_EN[opts.course] || String(opts.course).toUpperCase()) : null;
  if (courseLabel) lines.push({ text: courseLabel, size: 34, bold: true, center: true, gap: 6 });
  if (order.customer_name)  lines.push({ text: String(order.customer_name), size: 26, gap: 2 });
  if (order.customer_phone) lines.push({ text: String(order.customer_phone), size: 26, gap: 2 });
  if (order.order_subtype === 'delivery' && order.delivery_address) {
    lines.push({ text: '-- DELIVERY --', size: 28, bold: true, center: true, gap: 2 });
    lines.push({ text: String(order.delivery_address), size: 28, bold: true, gap: 4 });
  }
  const orderNote = order.notes || order.customer_note;
  if (orderNote) lines.push({ text: String(orderNote), size: 24, bold: true, gap: 4 });
  // SEPOS-SENTBY-001 — who pressed Send for this round (classic-builder parity)
  const sentBy = (items.find(i => i && i.sent_by) || {}).sent_by;
  if (sentBy) lines.push({ text: 'Sent: ' + String(sentBy), size: 22, center: true, gap: 4 });
  lines.push({ rule: true });

  const pushItem = (it) => {
    lines.push({ text: `${it.quantity || 1} × ${it.name || it.item_name || ''}`, size: 32, gap: 2 });
    // SEPOS-024b parity — the free-text special request ("Mild", "ALLERGY — no
    // peanuts") is the line a kitchen must never miss.
    if (it.item_note) lines.push({ text: `** ${it.item_note} **`, size: 26, bold: true, indent: 34, gap: 2 });
    if (it.notes) lines.push({ text: String(it.notes), size: 26, bold: true, indent: 34, gap: 4 });
  };
  if (courseLabel) {
    for (const it of items || []) pushItem(it);
  } else {
    // Full ticket — group by course with headers, classic-style.
    const byCourse = {};
    for (const it of items || []) { const c = it.course || 1; (byCourse[c] = byCourse[c] || []).push(it); }
    const courses = Object.keys(byCourse).sort((a, b) => Number(a) - Number(b));
    for (const c of courses) {
      if (courses.length > 1) lines.push({ text: COURSES_EN[c] || 'ITEMS', size: 28, bold: true, gap: 2 });
      for (const it of byCourse[c]) pushItem(it);
    }
  }
  lines.push({ rule: true });
  lines.push({ text: `Order #${order.id}${courseLabel ? ' · ' + courseLabel : ''}`, size: 22, center: true });
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

module.exports = { kitchenTicketRaster, previewPNG, hasUnrenderableText };
