// SEPOS-TICKET-FONT-001 — kitchen tickets rendered with a REAL typeface.
//
// The thermal printer's built-in fonts are the blocky "typewriter" look
// Korakot photographed; the smooth ticket he wants (11 Aug photo) is made by
// rendering the ticket as an IMAGE with proper fonts and sending the bitmap.
// This module does that: pureimage (pure JS — no native deps, safe next to
// better-sqlite3) + Noto Sans (SIL OFL, bundled) → 576px-wide bitmap →
// ESC/POS GS v 0 raster.
//
// ON by default since v1.9.5. Per-venue opt-out with settings.kitchen_ticket_style =
// 'rendered' — classic path untouched otherwise.

'use strict';

const path = require('path');
const PImage = require('pureimage');

const W = 576; // POS80 printable width @ 203dpi
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fontsReady = null;
// SEPOS-TA-LABEL-001 (Baanrai, 25 Aug) — ONE resolver for every ticket heading.
// A takeaway-slot order must never read as a dine-in table: the floor brands
// those slots "Takeaway", but a slot ROW named 'Table 2' (names are freeform)
// printed as TABLE 2 — and the chef walked to the dine-in twin. If the order's
// table carries is_takeaway and the label doesn't already say so, prefix it.
function ticketTableLabel(order) {
  const raw = order && order.table_label && String(order.table_label).trim();
  const takeawaySlot = order && Number(order.table_is_takeaway ?? 0) === 1;
  let label = raw ? raw.toUpperCase() : `TABLE ${order && order.table_number != null ? order.table_number : '\u2014'}`;
  if (takeawaySlot && !/TAKE\s*AWAY/i.test(label)) {
    label = `TAKEAWAY ${raw ? raw.toUpperCase() : (order && order.table_number != null ? order.table_number : '')}`.trim();
  }
  return label;
}

function loadFonts() {
  if (!fontsReady) {
    const reg = PImage.registerFont(path.join(FONT_DIR, 'NotoSans-Regular.ttf'), 'TicketSans');
    const bold = PImage.registerFont(path.join(FONT_DIR, 'NotoSans-Bold.ttf'), 'TicketSansBold');
    // SEPOS-THAI-TICKET-001 — Thai faces (Sarabun, SIL OFL: full Thai + full
    // Latin in one face, so a mixed Thai/English line renders whole). Lines
    // containing any Thai switch family wholesale; pure-Latin lines keep the
    // original Noto Sans look.
    const thai = PImage.registerFont(path.join(FONT_DIR, 'Sarabun-Regular.ttf'), 'TicketThai');
    const thaiBold = PImage.registerFont(path.join(FONT_DIR, 'Sarabun-Bold.ttf'), 'TicketThaiBold');
    fontsReady = Promise.all([reg, bold, thai, thaiBold].map((f) => (f.load ? f.load() : f)));
  }
  return fontsReady;
}

// Greedy word-boundary wrap (hard-break a single over-wide word). The caller
// must have set scratch.font already. Returns the text as 1+ segments.
function wrapText(scratch, text, maxW) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const segs = [];
  let cur = '';
  const flush = () => { if (cur) { segs.push(cur); cur = ''; } };
  for (const word of words) {
    const cand = cur ? cur + ' ' + word : word;
    if (scratch.measureText(cand).width <= maxW) { cur = cand; continue; }
    flush();
    if (scratch.measureText(word).width <= maxW) { cur = word; continue; }
    // single word wider than the paper — hard-break it
    let piece = '';
    for (const ch of word) {
      if (scratch.measureText(piece + ch).width > maxW) { segs.push(piece); piece = ch; }
      else piece += ch;
    }
    cur = piece;
  }
  flush();
  return segs.length ? segs : [''];
}

// lines: [{ text, size, bold, center, gap, rule, heavy, indent, right }]
//   right — SEPOS-RECEIPT-FONT-001: two-column line (label/name left, value/
//   price right-aligned at the paper edge). Long left text wraps UNDER itself
//   with the right value pinned to the first line, so an item name can never
//   collide with its price.
//   heavy — thicker rule (the classic receipt's '=' divider around TOTAL).
async function renderLines(lines) {
  await loadFonts();
  const PAD = 8, LH = 1.35, COL_GAP = 16;
  // SEPOS-THAI-TICKET-001 — pick the family per line: any Thai character puts
  // the whole line (and its right column) on the Thai face.
  const famFor = (l) => {
    const t = `${l.text || ''} ${l.right != null ? l.right : ''}`;
    const thai = /[\u0E00-\u0E7F]/.test(t);
    return l.bold ? (thai ? 'TicketThaiBold' : 'TicketSansBold') : (thai ? 'TicketThai' : 'TicketSans');
  };

  // Measure pass — wrap long text so nothing clips off the paper's right
  // edge. Uses a 1×1 scratch context for measureText.
  const scratch = PImage.make(1, 1).getContext('2d');
  const wrapped = [];
  for (const l of lines) {
    if (l.rule) { wrapped.push(l); continue; }
    const size = l.size || 30;
    scratch.font = `${size}pt ${famFor(l)}`;
    const right = l.right != null && String(l.right) !== '' ? String(l.right) : null;
    const rightW = right ? scratch.measureText(right).width : 0;
    const maxW = W - PAD * 2 - (l.indent || 0) - (right ? rightW + COL_GAP : 0);
    const segs = wrapText(scratch, l.text, maxW);
    segs.forEach((s, i) => wrapped.push({
      ...l,
      text: s,
      right: i === 0 ? right : null,           // value pins to the first line
      // continuation lines of a two-col item tuck under the name, not the
      // margin, so a wrapped dish name reads as one item on the bill
      indent: (l.indent || 0) + (right && i > 0 ? Math.round(size * 1.1) : 0),
      gap: i === segs.length - 1 ? (l.gap || 0) : 0,
    }));
  }

  let h = 24;
  for (const l of wrapped) h += l.rule ? (l.heavy ? 22 : 18) : Math.ceil((l.size || 30) * LH) + (l.gap || 0);
  h += 30;
  const img = PImage.make(W, h);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = '#000000';
  let y = 24;
  for (const l of wrapped) {
    if (l.rule) {
      ctx.fillRect(PAD, y + 6, W - PAD * 2, l.heavy ? 5 : 3); y += l.heavy ? 22 : 18; continue;
    }
    const size = l.size || 30;
    ctx.font = `${size}pt ${famFor(l)}`;
    const tw = ctx.measureText(l.text).width;
    const x = l.center ? Math.max(PAD, (W - tw) / 2) : PAD + (l.indent || 0);
    y += Math.ceil(size * LH);
    const baseline = y - Math.ceil(size * 0.28);
    ctx.fillText(l.text, x, baseline);
    if (l.right != null) {
      const rw = ctx.measureText(String(l.right)).width;
      ctx.fillText(String(l.right), W - PAD - rw, baseline);
    }
    y += (l.gap || 0);
  }
  return img;
}

// The bundled font covers Latin — text outside it (Thai, CJK) would render as
// blanks. Callers use this to fall back to the classic codepage path for any
// ticket that carries such text (e.g. a Thai kitchen note on an English menu).
// SEPOS-THAI-TICKET-001 — Thai left this list (bundled Noto Sans Thai covers it).
const NON_LATIN = /[一-鿿぀-ヿ가-힯]/;
// extra — SEPOS-RECEIPT-FONT-001: receipt callers pass venue strings too
// (company name / address / footer), which kitchen tickets never print.
function hasUnrenderableText(order, items, extra = []) {
  const parts = [order?.table_label, order?.notes, order?.customer_note,
    order?.customer_name, order?.customer_phone, order?.delivery_address, ...extra];
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
// SEPOS-TICKET-SIZE-001 — one rendered font, operator-chosen SIZE. The whole
// ticket is spec'd in px on the 576px canvas, so scaling every size/gap/indent
// by one factor resizes cleanly and the measured word-wrap adapts by itself.
const SIZE_SCALES = { standard: 1.0, large: 1.15, xl: 1.3, xxl: 1.5 };
function applyScale(lines, sizeKey) {
  const k = SIZE_SCALES[sizeKey] || 1.0;
  if (k === 1.0) return lines;
  return lines.map((l) => l.rule ? l : {
    ...l,
    size:   l.size   ? Math.round(l.size * k)   : l.size,
    gap:    l.gap    ? Math.round(l.gap * k)    : l.gap,
    indent: l.indent ? Math.round(l.indent * k) : l.indent,
  });
}

async function kitchenTicketRaster(order, items, opts = {}) {
  const tz = 'Europe/London';
  const now = new Date();
  const label = (order.table_label && String(order.table_label).trim())
    ? String(order.table_label).trim().toUpperCase()
    : (order.order_type === 'takeaway'
        ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}`
           : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`))
        : ticketTableLabel(order));
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
    // SEPOS-THAI-TICKET-001 — classic-builder parity: the Thai name line the
    // chef actually reads (classic prints name_alt when bilingual, default on).
    const nameAlt = it.name_alt || it.name_th || '';
    if (nameAlt) lines.push({ text: String(nameAlt), size: 28, indent: 34, gap: 2 });
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
  const img = await renderLines(applyScale(lines, opts.size));
  return Buffer.concat([toRaster(img), Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00])]); // feed + cut
}

// Debug/preview — same render to a PNG file so the look can be approved
// before any printer sees it.
async function previewPNG(order, items, outPath, opts = {}) {
  const tzLines = await (async () => null)();
  const img = await renderLines(applyScale(await _linesFor(order, items, opts), opts.size));
  await PImage.encodePNGToStream(img, require('fs').createWriteStream(outPath));
  return outPath;
}
async function _linesFor(order, items, opts) {
  // shared with kitchenTicketRaster — rebuilt small to avoid refactor risk
  const now = new Date();
  const label = ticketTableLabel(order);
  const lines = [
    { text: now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), size: 22, center: true, gap: 4 },
    { rule: true },
    { text: label, size: 44, bold: true, center: true, gap: 6 },
    { rule: true },
  ];
  for (const it of items || []) {
    lines.push({ text: `${it.quantity} × ${it.name}`, size: 32, gap: 2 });
    const alt = it.name_alt || it.name_th || '';   // SEPOS-THAI-TICKET-001 — preview matches the real ticket
    if (alt) lines.push({ text: String(alt), size: 28, indent: 34, gap: 2 });
    if (it.item_note) lines.push({ text: `** ${it.item_note} **`, size: 26, bold: true, indent: 34, gap: 2 });
    if (it.notes) lines.push({ text: it.notes, size: 26, bold: true, indent: 34, gap: 4 });
  }
  lines.push({ rule: true });
  lines.push({ text: `Order #${order.id}`, size: 22, center: true });
  return lines;
}

// ── SEPOS-RECEIPT-FONT-001 — customer bill / settled receipt in the rendered
// typeface. The MONEY MATH lives in printService.computeReceiptModel (shared
// with the classic builder, so the two paths can never disagree on a total) —
// this function only turns that model into line specs. Layout mirrors the
// classic receipt: header → order info → items (name left / price right) →
// totals → payment → footer. The logo bitmap + review QR are ESC/POS blocks
// emitted by printService around this raster, not drawn here.
function receiptLines(order, m, opts = {}) {
  const L = [];
  if (m.name) L.push({ text: m.name, size: m.name.length <= 16 ? 42 : 32, bold: true, center: true, gap: 6 });
  if (m.addr)  L.push({ text: m.addr, size: 21, center: true, gap: 2 });
  if (m.phone) L.push({ text: 'Tel: ' + m.phone, size: 21, center: true, gap: 2 });
  if (m.vatNo) L.push({ text: 'VAT: ' + m.vatNo, size: 21, center: true, gap: 2 });
  if (L.length) L[L.length - 1] = { ...L[L.length - 1], gap: 10 };
  L.push({ rule: true });

  // Order header — same fields as classic, label-left / value-right
  if (order.order_type === 'takeaway') {
    L.push({ text: 'Type', right: order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`), size: 23, gap: 2 });
    if (order.customer_name) L.push({ text: 'Customer', right: String(order.customer_name), size: 23, gap: 2 });
    if (order.pickup_time)   L.push({ text: 'Pickup', right: new Date(order.pickup_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), size: 23, gap: 2 });
  } else {
    const label = (order.table_label && String(order.table_label).trim())
      ? String(order.table_label).trim().toUpperCase()
      : ticketTableLabel(order);
    L.push({ text: label, size: 38, bold: true, center: true, gap: 4 });
    L.push({ text: 'Covers', right: String(order.covers || '—'), size: 23, gap: 2 });
  }
  // No standalone Order # row — Korakot 16 Aug: "i dont want order number on
  // the bill". (Takeaway keeps the id inside its Type line — staff match the
  // docket to the customer by it.)
  L.push({ text: 'Date',    right: m.date, size: 23, gap: 2 });
  L.push({ text: 'Time',    right: m.time, size: 23, gap: 4 });
  L.push({ rule: true });

  // Items by course, no course headers (classic parity). Options print inline
  // — the renderer wraps rather than truncates, so a long name+option just
  // continues on the next line with the price pinned to the first.
  for (const course of Object.keys(m.byCourse).sort()) {
    for (const item of m.byCourse[course]) {
      const p   = item.unit_price * item.quantity;
      const d   = item._discountAmt != null
        ? item._discountAmt
        : (item.discount_value > 0
            ? (item.discount_type === 'percent' ? p * item.discount_value / 100 : Math.min(item.discount_value, p))
            : 0);
      const net = p - d;
      const opt = item.notes ? String(item.notes).trim() : '';
      const name = item.name || item.item_name || ('Item #' + item.menu_item_id);
      L.push({ text: `${item.quantity}x ${name}${opt ? ` (${opt})` : ''}`, right: '£' + net.toFixed(2), size: 27, bold: true, gap: 4 });
    }
  }
  L.push({ rule: true });

  // Totals
  L.push({ text: 'Subtotal', right: '£' + m.subtotal.toFixed(2), size: 24, gap: 2 });
  if (m.discountAmt > 0)   L.push({ text: 'Discount' + (m.discountLabel || ''), right: '-£' + m.discountAmt.toFixed(2), size: 24, gap: 2 });
  if (m.serviceCharge > 0) L.push({ text: `Service (${m.scRate}%)`, right: '£' + m.serviceCharge.toFixed(2), size: 24, gap: 2 });
  if (m.tip > 0)           L.push({ text: 'Gratuity', right: '£' + m.tip.toFixed(2), size: 24, gap: 2 });
  L.push({ rule: true, heavy: true });
  L.push({ text: 'TOTAL', right: '£' + m.billTotal.toFixed(2), size: 38, bold: true, gap: 2 });
  L.push({ rule: true, heavy: true });

  // SEPOS-DEPOSIT-PRINT — deposit already paid + balance due
  if (m.depositPaid > 0) {
    L.push({ text: 'Deposit paid', right: '-£' + m.depositPaid.toFixed(2), size: 24, gap: 2 });
    L.push({ text: 'Balance due', right: '£' + Math.max(0, m.billTotal - m.depositPaid).toFixed(2), size: 26, bold: true, gap: 2 });
    L.push({ rule: true, heavy: true });
  }

  // Payment
  if (m.method) {
    L.push({ text: 'Payment', right: m.method, size: 24, gap: 2 });
    if (m.tenders.length > 1) {
      m.tenders.forEach((t, i) => L.push({
        text: `${i + 1}. ${t.method || ''}`, right: '£' + Number(t.amount || 0).toFixed(2), size: 22, indent: 20, gap: 2,
      }));
    }
    if (m.method === 'Cash' && m.amountPaid > 0) {
      L.push({ text: 'Cash tendered', right: '£' + m.amountPaid.toFixed(2), size: 24, gap: 2 });
      L.push({ text: 'Change', right: '£' + m.change.toFixed(2), size: 26, bold: true, gap: 2 });
    }
    L.push({ rule: true });
  }

  // Footer. (The classic builder also emits a hardcoded Thai thank-you line,
  // but txt() strips non-Latin so it has never actually printed — dropped.)
  // Korakot 2026-08-23: the footer often carries money-relevant notices
  // ("Service is not included.") — print it bigger and bold so it reads.
  L.push({ text: m.footer, size: 28, bold: true, center: true, gap: 4 });
  return L;
}

// Raster only — no feed/cut. printService wraps this with the logo block
// before and (customer bill only) the review QR + cut after.
// ONE fixed size by design — Korakot 16 Aug: "i want the bill have only one
// size, but order ticket is able to customise". Size options (SIZE_SCALES)
// apply to kitchen/bar tickets only; deliberately no applyScale here.
async function receiptRaster(order, model, opts = {}) {
  const img = await renderLines(receiptLines(order, model, opts));
  return toRaster(img);
}

// Preview for approval — same lines, PNG instead of printer bytes.
async function previewReceiptPNG(order, model, outPath, opts = {}) {
  const img = await renderLines(receiptLines(order, model, opts));
  await PImage.encodePNGToStream(img, require('fs').createWriteStream(outPath));
  return outPath;
}

module.exports = {
  ticketTableLabel, kitchenTicketRaster, receiptRaster, previewPNG, previewReceiptPNG, hasUnrenderableText, SIZE_SCALES };
