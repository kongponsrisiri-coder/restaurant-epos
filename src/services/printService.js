/**
 * SiamEPOS Print Service — SEPOS-025/026
 * Sends raw ESC/POS commands over a TCP socket to a network-attached
 * thermal printer (e.g. Epson TM, Star TSP) connected via a USB print
 * server (e.g. WAVLINK) or a printer with a built-in LAN port.
 *
 * Works for any device (iPad, browser, Electron) on the same Wi-Fi —
 * because printing happens server-side, not client-side.
 *
 * Port 9100 is the standard RAW print port for most thermal printers.
 */

'use strict';

const net = require('net');
const fs  = require('fs').promises;
const os  = require('os');
const path = require('path');
const { exec, execFile } = require('child_process');

// ── ESC/POS command bytes ─────────────────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;

const CAN = Buffer.from([0x18]);   // Cancel — discards any buffered data since last LF

const CMD = {
  // INIT = ESC @ (reset to defaults), then ESC t 19 (select codepage CP858 —
  // Western European with £ at byte 0x9C and € at 0xD5). Without this the
  // printer defaults to CP437 / CP1252 / whatever, which renders the £ in
  // strings like '£40.95' as garbage (was showing as 'Тú40.95' on the
  // cnfujun POS80). With CP858 active, txt() pre-maps £ → byte 0x9C and
  // the printer renders a proper £.
  //
  // Extra cancellations after the reset because cnfujun POS80 sometimes
  // boots with sticky state (user-defined characters from a prior session,
  // italic/double-strike modes) that ESC @ doesn't always clear. Without
  // these, kitchen tickets printed in a stylised italic font that's hard
  // to read ("Summer Rolls" rendered as "Summer Ro11s" — confusable l/1).
  //   ESC % 0 — cancel user-defined character set (back to internal ROM)
  //   ESC ! 0 — cancel all print modes (bold, double-height, italic …)
  //   ESC M 0 — select Font A (12×24 dot, the readable monospace one)
  //   ESC G 0 — cancel double-strike (some firmwares default it ON)
  INIT:         Buffer.from([
    ESC, 0x40,         // reset
    ESC, 0x74, 0x13,   // CP858 codepage
    ESC, 0x25, 0x00,   // ESC % 0 — disable user-defined characters
    ESC, 0x21, 0x00,   // ESC ! 0 — cancel print modes
    ESC, 0x4D, 0x00,   // ESC M 0 — Font A
    ESC, 0x47, 0x00,   // ESC G 0 — cancel double-strike
  ]),
  ALIGN_LEFT:   Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT:  Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON:      Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF:     Buffer.from([ESC, 0x45, 0x00]),
  // Double-strike — prints each dot row twice for heavier/thicker strokes
  // (stacks with bold). Kitchen/bar tickets turn it on so orders read thicker
  // across the pass. INIT cancels it (ESC G 0) so receipts stay normal weight.
  DSTRIKE_ON:   Buffer.from([ESC, 0x47, 0x01]),
  DSTRIKE_OFF:  Buffer.from([ESC, 0x47, 0x00]),
  SIZE_NORMAL:  Buffer.from([GS,  0x21, 0x00]),   // 1× width, 1× height
  SIZE_TALL:    Buffer.from([GS,  0x21, 0x01]),   // 1× width, 2× height
  SIZE_WIDE:    Buffer.from([GS,  0x21, 0x10]),   // 2× width, 1× height
  SIZE_BIG:     Buffer.from([GS,  0x21, 0x11]),   // 2× width, 2× height
  SIZE_XL:      Buffer.from([GS,  0x21, 0x22]),   // 3× width, 3× height (SEPOS-PRINT-FONT-001)
  CUT:          Buffer.from([GS,  0x56, 0x41, 0x05]), // Partial cut + 5mm feed
  DRAWER_KICK:  Buffer.from([ESC, 0x70, 0x00, 0x19, 0xFA]), // ESC p 0 25 250 — open cash drawer (pin 2)
  LF:           Buffer.from([0x0a]),
};

const LINE_WIDTH = 42;  // characters at normal size on 80mm paper

// SEPOS-PRINT-FONT-001 / SEPOS-PRINT-FONT-002 — per-role configurable print
// font size. ESC/POS `GS ! n` scales character WIDTH and HEIGHT independently
// (1–8× each; n = (w-1)<<4 | (h-1)), so a scale can be any "WxH" token like
// '1x2' (tall, full line width) or '2x1' (wide). Legacy word tokens map to
// their historical combos so existing settings keep printing identically:
//   normal=1x1 · medium/tall=1x2 · large=2x2 (kitchen/bar default) · xlarge=3x3
// Width divisor = W (a 2×-wide char halves the characters per line).
function parseScale(scale) {
  const m = /^([1-4])x([1-4])$/.exec(String(scale || ''));
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  const LEGACY = { normal: [1, 1], medium: [1, 2], tall: [1, 2], wide: [2, 1], large: [2, 2], xlarge: [3, 3] };
  const [w, h] = LEGACY[scale] || [2, 2]; // unknown/default = 'large' behaviour
  return { w, h };
}
function scaleCmd(scale) {
  const { w, h } = parseScale(scale);
  return Buffer.from([GS, 0x21, ((w - 1) << 4) | (h - 1)]);
}
function scaleWidthDivisor(scale) {
  return parseScale(scale).w;
}

// ── Bilingual course labels ───────────────────────────────────────────────────
const COURSES_EN = { 1:'STARTERS', 2:'MAINS', 3:'DESSERTS', 4:'EXTRAS' };
const COURSES_TH = { 1:'กับแกล้ม', 2:'อาหารหลัก', 3:'ของหวาน', 4:'เพิ่มเติม' };

// ── Buffer helpers ────────────────────────────────────────────────────────────

// Transform strings before sending to the printer. Two passes:
//   1. Remap symbols whose Unicode codepoint doesn't match the active
//      printer codepage (CP858, set by CMD.INIT). £ in JS is U+00A3 but
//      in CP858 it's byte 0x9C — remap so latin1 encoding produces the
//      right byte. Em / en dash collapse to ASCII '-' for the same reason.
//   2. Strip any codepoint > 0xFF (Thai / CJK / emoji) — CP858 has no
//      glyphs for those, so they'd render as garbage on a UK thermal
//      printer.
// Then encode with 'latin1' (one codepoint → one byte) so the printer
// sees what we intended.
const stripUnsupported = (s) => String(s ?? '')
  .replace(/£/g, '\x9C')     // CP858 £ byte
  .replace(/€/g, '\xD5')     // CP858 € byte
  .replace(/[—–]/g, '-')     // em / en dash → ASCII dash
  .replace(/[‘’]/g, "'")     // smart single quotes → ASCII
  .replace(/[“”]/g, '"')     // smart double quotes → ASCII
  .replace(/[^\x00-\xFF]/g, '');
const txt  = (s)       => Buffer.from(stripUnsupported(s), 'latin1');
const lf   = (n = 1)   => Buffer.alloc(n, 0x0a);
const rule = (c = '-') => txt(c.repeat(LINE_WIDTH));

// ── Thai (CP874 / TIS-620) support — wraps a Thai string in codepage
// switch commands so the printer renders Thai glyphs for that segment,
// then switches back to CP858 so subsequent English text + £ keep
// working. Thai code points U+0E01..U+0E5B map to TIS-620 bytes
// 0xA1..0xFB (the table-wide offset is U+0D60).
//
// CP874 is usually codepage ID 30 on Epson TM, Star TSP, and most
// Chinese clones (cnfujun POS80 confirmed). If the operator's printer
// happens to use a different ID for Thai, override per-install via
// settings.kitchen_thai_codepage. Falls back to ID 30 silently.
const THAI_OFFSET = 0x0D60;
function txtTh(s, cpid = 30) {
  if (!s) return Buffer.alloc(0);
  const switchOn  = Buffer.from([ESC, 0x74, cpid]);
  const switchOff = Buffer.from([ESC, 0x74, 0x13]);    // back to CP858
  const mapped = String(s).replace(/[ก-๛]/g,
    c => String.fromCharCode(c.charCodeAt(0) - THAI_OFFSET))
    .replace(/[^\x00-\xFF]/g, '');
  const bytes = Buffer.from(mapped, 'latin1');
  return Buffer.concat([switchOn, bytes, switchOff]);
}

function pad(str, len, align = 'left') {
  const s = String(str ?? '').slice(0, len);
  const spaces = ' '.repeat(len - s.length);
  return align === 'right' ? spaces + s : s + spaces;
}

function col2(label, value, width = LINE_WIDTH) {
  const v = String(value ?? '');
  const l = String(label ?? '');
  const maxL = width - v.length - 1;
  return txt(pad(l.slice(0, maxL), maxL) + ' ' + v);
}

function flatten(parts) {
  return Buffer.concat(
    parts.flat(Infinity).filter(b => Buffer.isBuffer(b))
  );
}

// ── Native ESC/POS QR (GS ( k, model 2). Used for the Google-review QR on the
// receipt, which previously only rendered on the browser/HTML receipt — so
// network thermal tills (POS80) never printed it. Supported by POS80-class and
// Epson/Star ESC/POS printers. ec: 48=L 49=M 50=Q 51=H.
function qrCode(data, { size = 6, ec = 49 } = {}) {
  const bytes = Buffer.from(String(data || ''), 'latin1');
  const store = bytes.length + 3;
  return Buffer.concat([
    Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),                 // model 2
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size & 0xff]),                // module size
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ec & 0xff]),                  // error correction
    Buffer.from([0x1d, 0x28, 0x6b, store & 0xff, (store >> 8) & 0xff, 0x31, 0x50, 0x30]), bytes, // store data
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),                       // print
  ]);
}

// ── Receipt formatter ─────────────────────────────────────────────────────────

function buildReceipt({ order, items, settings, paymentDetails = {} }) {
  const name    = settings.company_name    || settings.restaurant_name || 'SiamEPOS';
  const addr    = settings.company_address || '';
  const phone   = settings.company_phone   || '';
  const vatNo   = settings.company_vat     || '';
  const footer  = settings.receipt_footer  || 'Thank you for dining with us!';
  const scRate  = parseFloat(settings.service_charge_rate || 12.5);
  // SEPOS-PRINT-FONT-001 — receipt body text size. Default 'normal' = today's
  // output (SIZE_NORMAL, full 42-char columns). Larger scales shrink the
  // effective column width so the name/price columns still align.
  const receiptSize  = scaleCmd(settings.receipt_font_scale || 'normal');
  const receiptWidth = Math.floor(LINE_WIDTH / scaleWidthDivisor(settings.receipt_font_scale || 'normal'));

  const now  = new Date();
  const date = now.toLocaleDateString('en-GB',  { day:'2-digit', month:'short', year:'numeric' });
  const time = now.toLocaleTimeString('en-GB',  { hour:'2-digit', minute:'2-digit' });

  const subtotal      = parseFloat(paymentDetails.subtotal       ?? 0);
  const discountAmt   = parseFloat(paymentDetails.discountAmount ?? 0);
  const serviceCharge = parseFloat(paymentDetails.serviceCharge  ?? 0);
  const billTotal     = parseFloat(paymentDetails.billTotal      ?? 0);
  const amountPaid    = parseFloat(paymentDetails.amountPaid     ?? billTotal);
  const change        = parseFloat(paymentDetails.change         ?? Math.max(0, amountPaid - billTotal));
  const tip           = parseFloat(paymentDetails.tip            ?? 0);
  const method        = paymentDetails.method || '';

  const activeItems = (items || []).filter(i => !i.voided);
  // Group identical lines into one — if the same menu item was added 3
  // times as 3 rows (each quantity=1), the receipt shows "3x Pad Thai"
  // not three separate "1x Pad Thai" lines. Two rows merge when their
  // menu_item_id + notes + discount + unit_price all match (different
  // notes / modifiers / mid-shift price changes keep them separate so
  // the receipt remains accurate). Kitchen tickets still print line by
  // line because the chef needs to see each customisation.
  // The chosen OPTIONS (item.notes — modifier picks like "Prawn", "Large") ARE
  // in the key, so different picks stay on their own line and print on the bill.
  // The free-text kitchen note (item_note, e.g. "extra spicy") is NOT keyed and
  // is omitted from the receipt — it stays on the kitchen ticket for the chef.
  const groupKey = (i) => [
    i.menu_item_id ?? i.id,
    i.notes || '',   // chosen OPTIONS (modifier picks) — keep different picks on
                     // separate lines so each shows on the bill. Free-text
                     // item_note is NOT keyed, so it still merges + stays off the bill.
    i.discount_type || '',
    Number(i.discount_value || 0),
    Number(i.unit_price || 0),
    i.course || 1,
  ].join('|');
  // SEPOS-047j — accumulate each ORIGINAL row's discount while merging.
  // A 'fixed' discount is per row (the order total does
  // quantity*unit_price - discount_value per row), so merging two rows that
  // each carry a £5 fixed discount must deduct £10, not £5. The old code
  // recomputed the discount from the MERGED quantity (min(value, merged_p)),
  // which deducted it once — so the printed line total didn't match the
  // amount actually charged. Summing per-row discounts is correct for both
  // 'fixed' and 'percent'.
  const rowDiscount = (i) => {
    const rowP = Number(i.unit_price || 0) * Number(i.quantity || 0);
    if (!(Number(i.discount_value) > 0)) return 0;
    return i.discount_type === 'percent'
      ? rowP * Number(i.discount_value) / 100
      : Math.min(Number(i.discount_value), rowP);
  };
  const groups = new Map();
  for (const it of activeItems) {
    const k = groupKey(it);
    if (groups.has(k)) {
      const g = groups.get(k);
      g.quantity = Number(g.quantity || 0) + Number(it.quantity || 0);
      g._discountAmt = (g._discountAmt || 0) + rowDiscount(it);
    } else {
      groups.set(k, { ...it, quantity: Number(it.quantity || 0), _discountAmt: rowDiscount(it) });
    }
  }
  const groupedItems = Array.from(groups.values());

  const byCourse    = {};
  groupedItems.forEach(i => {
    const c = i.course || 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(i);
  });

  // Restaurant name: large if short, tall if long
  const nameSize = name.length <= 14 ? [CMD.SIZE_BIG] : [CMD.SIZE_TALL];

  // Optional logo — client-side converts the upload to a monochrome
  // bitmap (1 bit per dot, MSB-first) and stores it in 3 settings:
  //   company_logo_bitmap         — base64 of the raw bytes
  //   company_logo_bitmap_width   — width in BYTES (= dots / 8)
  //   company_logo_bitmap_height  — height in DOTS
  // We wrap the bytes in ESC/POS `GS v 0` (raster image) and emit at
  // the top of the receipt. If any of the three settings is missing
  // or sizes don't match, we skip silently — no error, no blank space.
  let logoBlock = [];
  if (settings.company_logo_bitmap && settings.company_logo_bitmap_width && settings.company_logo_bitmap_height) {
    try {
      const data   = Buffer.from(String(settings.company_logo_bitmap), 'base64');
      const wBytes = parseInt(settings.company_logo_bitmap_width, 10);
      const hDots  = parseInt(settings.company_logo_bitmap_height, 10);
      if (data.length === wBytes * hDots) {
        // Send the whole logo as a single GS v 0 command. ESC/POS spec
        // allows up to 65535 dots tall via the 2-byte yL/yH field;
        // cnfujun POS80 happily renders ~300 dots in one go. Chunking
        // was an earlier defensive measure but produced PARTIAL prints
        // (some chunks dropped). Single command is more reliable.
        logoBlock.push(CMD.ALIGN_CENTER);
        const header = Buffer.from([
          GS, 0x76, 0x30, 0x00,
          wBytes & 0xFF, (wBytes >> 8) & 0xFF,
          hDots  & 0xFF, (hDots  >> 8) & 0xFF,
        ]);
        logoBlock.push(header, data, lf());
      } else {
        console.warn(`[print] logo bitmap size mismatch — expected ${wBytes * hDots} bytes, got ${data.length} (skipping)`);
      }
    } catch (err) {
      console.warn('[print] logo emit failed (skipping):', err.message);
    }
  }

  const parts = [
    CMD.INIT,
    ...logoBlock,
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, ...nameSize, txt(name), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    addr   ? [txt(addr),            lf()] : [],
    phone  ? [txt('Tel: ' + phone), lf()] : [],
    vatNo  ? [txt('VAT: ' + vatNo), lf()] : [],
    lf(),
    // Keep the rest of the receipt centered too — at LINE_WIDTH=42 on an
    // 80mm printer (~48 native cols), left-align leaves a visibly bigger
    // margin on the right than the left. ALIGN_CENTER puts the same gap
    // on both sides so the whole receipt sits visually centered on the
    // paper. col2 lines still have their label-on-left / value-on-right
    // shape — just the whole 42-char block is centered within the
    // printable area.
    CMD.ALIGN_CENTER,
    rule(), lf(),

    // Order header
    ...(order.order_type === 'takeaway' ? [
      col2('Type', order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`)), lf(),
      order.customer_name ? [col2('Customer', order.customer_name), lf()] : [],
      order.pickup_time   ? [col2('Pickup', new Date(order.pickup_time).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/London' })), lf()] : [],
    ] : [
      // Table number BIG + bold + centred so it's obvious at a glance.
      CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.SIZE_BIG, txt((order.table_label && String(order.table_label).trim()) ? String(order.table_label).trim().toUpperCase() : `TABLE ${order.table_number || '—'}`), CMD.SIZE_NORMAL, CMD.BOLD_OFF, CMD.ALIGN_CENTER, lf(),
      col2('Covers', String(order.covers       || '—')), lf(),
    ]),
    col2('Date',    date),  lf(),
    col2('Time',    time),  lf(),
    col2('Order #', String(order.id)), lf(),
    rule(), lf(),

    // Items sorted by course (starters → mains → desserts → extras)
    // but no course headers — the customer doesn't need food-category
    // labels on their bill, just the items + prices.
    ...Object.keys(byCourse).sort().flatMap(course => [
      ...byCourse[course].flatMap(item => {
        const p   = item.unit_price * item.quantity;
        // SEPOS-047j — use the per-row discount summed during the merge above
        // (correct for merged fixed-discount lines), not a recompute from the
        // merged quantity. Fall back to a single-row recompute if absent.
        const d   = item._discountAmt != null
          ? item._discountAmt
          : (item.discount_value > 0
              ? (item.discount_type === 'percent' ? p * item.discount_value / 100 : Math.min(item.discount_value, p))
              : 0);
        const net = p - d;
        // Chosen OPTIONS (modifier picks like "Prawn", "Large"). Put them INLINE
        // after the name — "1x Massaman Curry (Chicken)" — when the whole line
        // (name + option + price) fits; otherwise drop the option to its own
        // indented sub-line so a long name+option never truncates. Free-text
        // kitchen notes (item_note) stay off the customer's bill.
        const priceStr   = '£' + net.toFixed(2);
        const baseLabel  = `${item.quantity}x ${item.name || item.item_name || ('Item #' + item.menu_item_id)}`;
        const opt        = item.notes ? String(item.notes).trim() : '';
        const inlineLabel = opt ? `${baseLabel} (${opt})` : baseLabel;
        const labelBudget = receiptWidth - priceStr.length - 1; // col2's room for the label before it truncates
        const fitsInline  = !opt || inlineLabel.length <= labelBudget;
        return [
          CMD.BOLD_ON, receiptSize, col2(fitsInline ? inlineLabel : baseLabel, priceStr, receiptWidth), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
          // Didn't fit inline → own indented sub-line, padded to the block width
          // so it left-aligns under the item name (not floating in the centre).
          (opt && !fitsInline) ? [receiptSize, col2('   ' + opt, '', receiptWidth), CMD.SIZE_NORMAL, lf()] : [],
        ];
      }),
    ]),
    rule(), lf(),

    // Totals — scaled by receipt_font_scale so the whole receipt body matches
    // the item lines (SEPOS-PRINT-FONT-001 parity; default 'normal' = unchanged).
    receiptSize, col2('Subtotal', '£' + subtotal.toFixed(2), receiptWidth), CMD.SIZE_NORMAL, lf(),
    discountAmt   > 0 ? [receiptSize, col2('Discount',            '-£' + discountAmt.toFixed(2),   receiptWidth), CMD.SIZE_NORMAL, lf()] : [],
    serviceCharge > 0 ? [receiptSize, col2(`Service (${scRate}%)`, '£' + serviceCharge.toFixed(2), receiptWidth), CMD.SIZE_NORMAL, lf()] : [],
    tip           > 0 ? [receiptSize, col2('Gratuity',             '£' + tip.toFixed(2),            receiptWidth), CMD.SIZE_NORMAL, lf()] : [],
    rule('='), lf(),
    CMD.BOLD_ON, CMD.SIZE_BIG, col2('TOTAL', '£' + billTotal.toFixed(2), LINE_WIDTH / 2),
    CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),

    // Payment
    method ? [
      receiptSize, col2('Payment', method, receiptWidth), CMD.SIZE_NORMAL, lf(),
      method === 'Cash' && amountPaid > 0 ? [
        receiptSize, col2('Cash tendered', '£' + amountPaid.toFixed(2), receiptWidth), CMD.SIZE_NORMAL, lf(),
        CMD.BOLD_ON, receiptSize, col2('Change', '£' + change.toFixed(2), receiptWidth), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
      ] : [],
      rule(), lf(),
    ] : [],

    // Footer
    lf(),
    CMD.ALIGN_CENTER,
    txt(footer),                       lf(),
    txt('ขอบคุณที่มาใช้บริการ'), lf(3),

    // SEPOS-REVIEW-QR — Google-review QR on the thermal receipt (was browser-
    // receipt-only, so POS80 network tills never printed it). Prints only when
    // a review link is set in Settings.
    settings.google_review_url ? [
      CMD.ALIGN_CENTER,
      qrCode(settings.google_review_url),
      lf(),
      txt('Scan to leave us a review'), lf(3),
    ] : [],

    CMD.CUT,
  ];

  return flatten(parts);
}

// ── Course fire notice (TABLE X — FIRE MAINS — no item list) ─────────────────
// Called when chef fires a specific course. Just a loud call card, no item detail.

// SEPOS-QR-ORDER-001 — a table can carry a NAME ("Bar 3") whose internal
// number is something else entirely (Bar 3 = table_number 9 → the kitchen
// got "TABLE 9" and looked at the wrong side of the room). When the caller
// passes order.table_label, the heading uses it verbatim; otherwise the
// numeric fallback is byte-identical to the old behaviour.
function tableHeading(order) {
  const label = order && order.table_label && String(order.table_label).trim();
  if (label) return label.toUpperCase();
  return `TABLE ${order && order.table_number != null ? order.table_number : '?'}`;
}

function buildFireNotice({ order, course, bilingual = true }) {
  const heading  = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`))
    : tableHeading(order);
  const courseEN = COURSES_EN[course] || 'ITEMS';
  // Korakot 2026-06-02: no Thai on the category — English label only.
  const now      = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  const parts = [
    CAN, CMD.INIT, lf(),
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('FIRE'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(courseEN), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    CMD.ALIGN_CENTER,
    txt(`${now}  ·  Order #${order.id}`), lf(2),
    CMD.CUT,
  ];

  return flatten(parts);
}

// ── Kitchen ticket formatter (single course, full item list) ──────────────────
// Used for Send-to-Bar and any other case where a full item list is needed.

function buildKitchenTicket({ order, items, course, bilingual = true, thaiCodepage = 30, fontScale = 'large' }) {
  const itemSize = scaleCmd(fontScale); // SEPOS-PRINT-FONT-001 — per-role text size
  const heading = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`))
    : tableHeading(order);
  const courseEN = COURSES_EN[course] || 'ITEMS';
  // Korakot 2026-06-02: don't print Thai on the category (course)
  // header — STARTERS/MAINS in English is enough. Thai stays only on
  // the item name_alt line where it actually helps the chef.
  const now = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  const parts = [
    // Head room to match the Sunmi (4 lines) so the TABLE header clears a
    // ticket-rail clip when the ticket is hung (ports escpos.js headerOps feed:4).
    CAN, CMD.INIT, CMD.DSTRIKE_ON, lf(4),
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(courseEN), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    order.customer_name ? [txt(order.customer_name), lf()] : [],
    rule('='), lf(),
    CMD.ALIGN_LEFT,
    ...items.flatMap(item => {
      const nameAlt = bilingual ? (item.name_alt || item.name_th || '') : '';
      return [
        // Item line — SIZE_BIG (2× width, 2× height) so the chef
        // reads names from across the kitchen. Bumped from SIZE_TALL
        // 2026-06-02 per Korakot's request: "letters need to be a
        // little bit wider".
        // Item line — sized by the tenant's kitchen_font_scale (default 'large'
        // = SIZE_BIG, i.e. today's output). Korakot 2026-06-02: "letters need
        // to be a little bit wider" — now operator-configurable per SEPOS-PRINT-FONT-001.
        CMD.BOLD_ON, itemSize,
        txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}${item.notes ? ' / ' + item.notes : ''}`),
        CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
        // Thai item name — same scale as the English line above.
        nameAlt    ? [CMD.BOLD_ON, itemSize, txtTh('  ' + nameAlt, thaiCodepage), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf()] : [],
        // Modifier / option choice now prints INLINE on the item-name line above
        // ("…name / option") per operator request — no separate line.
        // SEPOS-024b — the free-text special request (item_note, e.g. "Mild",
        // "no peanuts") prints boldly so it stands out from the modifier line.
        item.item_note ? [CMD.BOLD_ON, itemSize, txt('  ** ' + item.item_note + ' **'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf()] : [],
      ];
    }),
    rule('='), lf(),
    CMD.ALIGN_CENTER,
    txt(`${now}  ·  Order #${order.id}`), lf(2),
    CMD.CUT,
  ];

  return flatten(parts);
}

// ── Full order ticket (all courses combined) ──────────────────────────────────

function buildFullKitchenTicket({ order, items, bilingual = true, thaiCodepage = 30, fontScale = 'large' }) {
  const itemSize = scaleCmd(fontScale); // SEPOS-PRINT-FONT-001 — per-role text size
  const heading = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : (order.table_number != null ? `TAKEAWAY ${order.table_number}` : `TAKEAWAY #${order.id}`))
    : tableHeading(order);
  const now = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  // Group items by course
  const byCourse = {};
  items.forEach(i => {
    const c = i.course || 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(i);
  });

  const courseBlocks = Object.keys(byCourse).sort().flatMap((course, idx, arr) => [
    // English course header only. Korakot 2026-06-02: don't print
    // Thai on the category — STARTERS / MAINS in English is enough.
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(COURSES_EN[course] || 'ITEMS'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('-'), lf(),
    ...byCourse[course].flatMap(item => {
      const nameAlt = bilingual ? (item.name_alt || item.name_th || '') : '';
      return [
        // Item line — sized by the tenant's kitchen/bar font scale (default
        // 'large' = SIZE_BIG = today's output). SEPOS-PRINT-FONT-001.
        CMD.BOLD_ON, itemSize,
        txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}${item.notes ? ' / ' + item.notes : ''}`),
        CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
        // Thai item name — same scale as the English line above.
        nameAlt    ? [CMD.BOLD_ON, itemSize, txtTh('  ' + nameAlt, thaiCodepage), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf()] : [],
        // Modifier / option choice now prints INLINE on the item-name line above
        // ("…name / option") per operator request — no separate line.
        // SEPOS-024b — the free-text special request prints boldly so it stands
        // out from the modifier line above.
        item.item_note ? [CMD.BOLD_ON, itemSize, txt('  ** ' + item.item_note + ' **'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf()] : [],
      ];
    }),
    idx < arr.length - 1 ? [rule('-'), lf()] : [],
  ]);

  const parts = [
    CAN, CMD.INIT, CMD.DSTRIKE_ON, lf(4),    // CAN discards leftover bytes; 4-line head room (matches Sunmi) + clean start
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    order.customer_name ? [txt(order.customer_name), lf()] : [],
    order.customer_phone ? [txt(order.customer_phone), lf()] : [],
    // SEPOS-046c — delivery orders carry the customer address so the
    // driver (or chef bagging the order) sees where it's going. Wrap
    // long addresses across multiple lines so they don't overflow the
    // 80mm roll.
    order.order_subtype === 'delivery' && order.delivery_address
      ? wrapDeliveryAddress(order.delivery_address)
      : [],
    // SEPOS-046d/g — customer's order-level note ("no peanut",
    // "allergies", "extra spicy") in big bold text so the chef can't
    // miss it. Reads `notes` (from real-time socket payload at order
    // submission) or `customer_note` (from DB on later reprints).
    (order.notes || order.customer_note) ? [
      lf(),
      CMD.BOLD_ON, CMD.SIZE_TALL, txt('** ' + String(order.notes || order.customer_note).slice(0, 80) + ' **'),
      CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    ] : [],
    rule('='), lf(),
    CMD.ALIGN_LEFT,
    ...courseBlocks,
    rule('='), lf(),
    CMD.ALIGN_CENTER,
    txt(`${now}  ·  Order #${order.id}`), lf(2),
    CMD.CUT,
  ];

  return flatten(parts);
}

// Wrap a delivery address onto the receipt roll. Bold, normal size,
// each comma-separated line on its own row so the driver can scan it
// without squinting.
function wrapDeliveryAddress(address) {
  const lines = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  return [
    lf(),
    CMD.BOLD_ON, txt('-- DELIVERY --'), CMD.BOLD_OFF, lf(),
    ...lines.flatMap(line => [CMD.BOLD_ON, txt(line), CMD.BOLD_OFF, lf()]),
  ];
}

// ── Test page ─────────────────────────────────────────────────────────────────

// ── SEPOS-KITCHEN-MSG-001 — kitchen message ticket ──────────────────
// Distinctive layout (📢 banner, large heading, big-text message body)
// so the chef notices immediately. Different from a regular kitchen
// ticket — no items, no course header, just the waiter's message.
function buildKitchenMessage({ order_id, table_number, order_type, customer_name, message, waiter_name }) {
  const heading = table_number ? `TABLE ${table_number}`
                : order_type === 'takeaway' ? `TAKEAWAY${order_id ? ' #' + order_id : ''}`
                : 'KITCHEN MESSAGE';
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // Wrap long messages onto multiple lines without breaking words.
  const wrapped = String(message || '').split(/\s+/).reduce((acc, w) => {
    if (!acc.length) return [w];
    const last = acc[acc.length - 1];
    // Big-text consumes ~2x width, so wrap at half LINE_WIDTH.
    if ((last + ' ' + w).length > Math.floor(LINE_WIDTH / 2)) acc.push(w);
    else acc[acc.length - 1] = last + ' ' + w;
    return acc;
  }, []);

  const parts = [
    CAN, CMD.INIT, lf(),
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('** MESSAGE **'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    customer_name ? [txt(customer_name), lf()] : [],
    rule('-'), lf(),
    CMD.ALIGN_CENTER,
    // Kitchen-message body — SIZE_BIG so the chef reads "no peanut",
    // "allergy: shellfish", etc. at the same size as the item names on
    // a regular ticket. The wrap calc above already uses LINE_WIDTH/2
    // for double-width characters, so no extra adjustment needed.
    CMD.BOLD_ON, CMD.SIZE_BIG,
    ...wrapped.flatMap(line => [txt(line), lf()]),
    CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    txt(`${now}${waiter_name ? '  ·  ' + waiter_name : ''}${order_id ? '  ·  Order #' + order_id : ''}`), lf(2),
    CMD.CUT,
  ];
  return flatten(parts);
}

// Sends a kitchen message to the kitchen printer (and skips silently if
// no kitchen printer configured — the KDS banner still shows it).
async function printKitchenMessage(settings, payload) {
  const ip          = settings.printer_kitchen_ip;
  const port        = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const lprQueue    = settings.printer_kitchen_lpr_queue || 'lp';
  if (!ip && !printerName) return; // no printer — KDS handles it
  await sendRaw(ip, port, buildKitchenMessage(payload), { printerName, lprQueue });
}

function buildTestPage() {
  const now = new Date().toLocaleString('en-GB');
  return flatten([
    CMD.INIT,
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('SiamEPOS'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule(), lf(),
    CMD.BOLD_ON, txt('Printer test OK'), CMD.BOLD_OFF, lf(),
    txt(now), lf(),
    rule(), lf(2),
    CMD.CUT,
  ]);
}

// ── TCP sender (with CUPS fallback) ───────────────────────────────────────────
// Strategy:
//   1. If `ip` is configured → try direct TCP socket to port 9100 first.
//      Works for any ESC/POS printer with a built-in LAN port (Epson TM-T20,
//      Star TSP, cnfujun 80mm, etc.) and most USB-to-LAN print servers.
//   2. If TCP fails AND `printerName` is configured → fall back to shelling
//      out to `lpr -P <name> -o raw` (CUPS). This is the fix for the WAVLINK
//      USB print server which silently swallows direct TCP 9100 writes
//      (data received but never relayed to the USB printer), while CUPS raw
//      mode reaches it correctly.
//   3. If only `printerName` is configured (no IP) → skip TCP, go straight
//      to CUPS. Useful for printers attached directly to the same Mac that
//      runs the EPOS server.
//
// CUPS fallback only works on macOS / Linux where the printer is installed
// in the OS print queue. On Windows this branch will fail; rely on TCP there.
//
// USB print servers (e.g. WAVLINK) also have an internal buffer that can mix
// bytes from back-to-back TCP connections — we serialise all jobs through a
// queue and wait 1.5 s after each write so the server can flush.

let _printQueue = Promise.resolve();

// 2s timeout: a printer on the same LAN answers in milliseconds, so a
// longer wait only delays the LPR fallback when the device is LPR-only
// or the connect packet is dropped.
function _sendTcp(ip, port, buf, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      setTimeout(() => err ? reject(err) : resolve(), 1500);
    };
    sock.setTimeout(timeoutMs);
    sock.connect(parseInt(port, 10) || 9100, ip, () => {
      sock.write(buf, (err) => { if (err) return done(err); });
      sock.once('drain', () => setTimeout(() => done(null), 600));
      setTimeout(() => done(null), 800);
    });
    sock.on('error',   (e) => done(e));
    sock.on('timeout', ()  => done(new Error(`Printer at ${ip} timed out`)));
  });
}

// LPR / LPD (RFC 1179) — port 515.
//
// Older USB print servers (WAVLINK, TP-Link TL-PS110U, many no-brand
// units) only expose port 515 because the LPR/LPD spec predates the
// RAW 9100 convention by ~15 years. Same idea but with a tiny ack-based
// handshake: client says "receive job", server acks 0x00; client says
// "receive control file (size N, name cf...)", sends body + terminator,
// server acks; same for the data file ("df..."), then close.
//
// Default queue name is 'lp' — the de facto LPR default. WAVLINK USB
// print servers typically accept 'lp' OR 'p1'. If 'lp' is wrong on a
// given device, set `printer_*_lpr_queue` in settings.
function _sendLpr(ip, port, buf, queueName = 'lp', timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let stage = 0;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      setTimeout(() => err ? reject(err) : resolve(), 1500);
    };

    const host = 'siamepos';
    const user = 'siamepos';
    const job  = 'SiamEPOS print';
    const stamp = String(Date.now()).slice(-3);
    const dfn  = `dfA${stamp}${host}`;
    const cfn  = `cfA${stamp}${host}`;
    // Control file — RFC 1179 §7.2. Order matters on some firmwares.
    //   H = host name           P = user name           J = job name
    //   l = print data file     U = unlink after print  N = source name
    const ctrl = `H${host}\nP${user}\nJ${job}\nl${dfn}\nU${dfn}\nN${dfn}\n`;

    sock.setTimeout(timeoutMs);
    sock.on('error',   (e) => done(e));
    sock.on('timeout', ()  => done(new Error(`LPR timeout to ${ip}:${port}`)));

    sock.connect(parseInt(port, 10) || 515, ip, () => {
      // Stage 0 → 1: 0x02 <queueName> \n  — "receive job for this queue"
      sock.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${queueName}\n`)]));
    });

    sock.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte !== 0x00) {
          return done(new Error(`LPR rejected at stage ${stage} (byte 0x${byte.toString(16).padStart(2, '0')}) — queue '${queueName}' may be wrong`));
        }
        stage += 1;
        if (stage === 1) {
          // Stage 1 → 2: 0x02 <ctrl-len> <space> <cfname> \n
          sock.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${ctrl.length} ${cfn}\n`)]));
        } else if (stage === 2) {
          // Stage 2 → 3: control file body + 0x00 terminator
          sock.write(Buffer.concat([Buffer.from(ctrl), Buffer.from([0x00])]));
        } else if (stage === 3) {
          // Stage 3 → 4: 0x03 <data-len> <space> <dfname> \n
          sock.write(Buffer.concat([Buffer.from([0x03]), Buffer.from(`${buf.length} ${dfn}\n`)]));
        } else if (stage === 4) {
          // Stage 4 → 5: data body + 0x00 terminator
          sock.write(Buffer.concat([buf, Buffer.from([0x00])]));
        } else if (stage === 5) {
          // All five acks received — print job accepted by server.
          done(null);
        }
      }
    });
  });
}

// Auto-discovery: shell out to `lpstat -v` and find the macOS print
// queue whose device URI matches the printer's IP. Means operators
// never have to type the queue name (which macOS auto-generates from
// the IP, e.g. _192_168_68_57 for a printer at 192.168.68.57).
// Returns the queue name, or null if no match.
async function findCupsQueueForIp(ip) {
  if (!ip) return null;
  return new Promise((resolve) => {
    exec('lpstat -v', { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Lines look like: `device for QUEUENAME: lpd://1.2.3.4/`
      //                  `device for OTHER:     socket://1.2.3.4:9100`
      const lines = String(stdout).split('\n');
      for (const line of lines) {
        const m = line.match(/device for (\S+):\s+\S+:\/\/([0-9.]+)/);
        if (m && m[2] === ip) return resolve(m[1]);
      }
      resolve(null);
    });
  });
}

// Module-level cache so we only run lpstat once per (ip) per process.
const _cupsQueueCache = new Map();
async function getOrAutoDetectCupsQueue(ip, explicitName) {
  if (explicitName) return explicitName;
  if (_cupsQueueCache.has(ip)) return _cupsQueueCache.get(ip);
  const detected = await findCupsQueueForIp(ip);
  _cupsQueueCache.set(ip, detected);
  if (detected) console.log(`[print] auto-detected CUPS queue '${detected}' for IP ${ip}`);
  return detected;
}

async function _sendCups(printerName, buf) {
  // Write the raw bytes to a tmp file because `lpr` needs a path. Inline
  // stdin would work too but tmp file is more debuggable.
  const tmp = path.join(os.tmpdir(),
    `siamepos-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  await fs.writeFile(tmp, buf);
  try {
    await new Promise((resolve, reject) => {
      // SEPOS-047j — execFile (NOT exec) so printerName is passed as a
      // literal argv entry, never through a shell. The old exec() only
      // escaped double-quotes, but inside a double-quoted shell arg
      // backticks and $(...) still execute — so a printer name like
      // `$(reboot)` (settable via the unauthenticated settings endpoint on
      // a LAN install) ran on the host. No shell now = no injection.
      execFile('lpr', ['-P', String(printerName), '-o', 'raw', tmp], (err, _stdout, stderr) => {
        if (err) return reject(new Error(`CUPS print failed: ${(stderr || '').trim() || err.message}`));
        resolve();
      });
    });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// SEPOS-058 — raw print to a USB printer on Windows. There is no `lpr` on
// Windows, so a printer configured by NAME (a USB thermal printer installed
// via its Windows driver, no IP) had no working path — the bytes never
// reached it as RAW, so it just fed blank paper. This sends the ESC/POS
// bytes straight to the named printer with the spooler's "RAW" datatype
// (the standard RawPrinterHelper Win32 calls), bypassing the GDI driver —
// driven by PowerShell so there's no native module to rebuild per Electron
// ABI. Printer name is passed as a literal (single-quoted, '' escaped) and
// the whole script goes via -EncodedCommand, so there is no shell injection.
const _WIN_RAW_CSHARP = [
  'using System;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'public class SiamEposRawPrinter {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }',
  '  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] data, int n, out int written);',
  '  public static void Send(string printer, string file) {',
  '    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for printer: " + printer);',
  '    try {',
  '      DOCINFO di = new DOCINFO(); di.pDocName = "SiamEPOS"; di.pDataType = "RAW";',
  '      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");',
  '      StartPagePrinter(h);',
  '      byte[] b = File.ReadAllBytes(file); int w;',
  '      if (!WritePrinter(h, b, b.Length, out w)) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");',
  '      EndPagePrinter(h); EndDocPrinter(h);',
  '    } finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\n');

// Persistent print helper. Spawning PowerShell + compiling the RawPrinter
// type per job cost ~1-2s EACH — the lag before every ticket. Instead keep
// ONE powershell process alive, Add-Type the helper once, and stream jobs to
// it over stdin: first print pays the ~1-2s startup, every print after is
// near-instant (~50ms). Jobs are serialised by _printQueue, so there's only
// one outstanding response at a time. Self-heals: if the process dies or a
// job hangs, it's respawned on the next print.
let _winPrintProc = null;
let _winJobSeq = 0;

function _getWinPrintProc() {
  // C2 fix — only reuse a verifiably-alive helper. A proc that has exited or is
  // mid-close still lingers in _winPrintProc until its 'exit' event fires; a job
  // grabbing it would write to a dead stdin and EPIPE (a silently lost ticket).
  if (_winPrintProc && _winPrintProc.exitCode === null && !_winPrintProc.killed
      && _winPrintProc.stdin && _winPrintProc.stdin.writable) {
    return _winPrintProc;
  }
  if (_winPrintProc) { try { _winPrintProc.kill(); } catch (e) {} _winPrintProc = null; }
  const { spawn } = require('child_process');
  const readline = require('readline');
  // Reads "<id> <base64 printerName> <base64 filepath>" lines; prints each via
  // the RawPrinter helper; replies "<id> OK" or "<id> ERR <msg>". C1 fix — the
  // id lets us match each reply to its exact job (Map lookup) instead of a blind
  // FIFO shift; a timed-out / write-failed job can no longer desync the queue and
  // mis-pair every later reply. base64 avoids quoting/space issues in names/paths.
  const reader = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${_WIN_RAW_CSHARP}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $p = $line.Split(' ')
  $id = $p[0]
  try {
    $name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
    $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))
    [SiamEposRawPrinter]::Send($name, $path)
    [Console]::Out.WriteLine($id + ' OK')
  } catch {
    [Console]::Out.WriteLine($id + ' ERR ' + ($_.Exception.Message -replace '[\\r\\n]',' '))
  }
  [Console]::Out.Flush()
}`;
  const encoded = Buffer.from(reader, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc._jobs = new Map(); // id → { resolve, reject }
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const sp = line.indexOf(' ');
    const id = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    const job = proc._jobs.get(id);
    if (!job) return; // unknown / late reply for an already-settled job — ignore
    proc._jobs.delete(id);
    if (rest.startsWith('OK')) job.resolve();
    else job.reject(new Error(`Windows raw print failed: ${rest.replace(/^ERR /, '')}`));
  });
  proc.stderr.on('data', (d) => console.warn('[winprint]', String(d).trim()));
  const die = (err) => {
    for (const job of proc._jobs.values()) job.reject(err);
    proc._jobs.clear();
    if (_winPrintProc === proc) _winPrintProc = null;
  };
  proc.on('exit', (code) => die(new Error(`print helper exited (${code})`)));
  proc.on('error', (e) => die(e));
  _winPrintProc = proc;
  return proc;
}

function _sendWindowsRaw(printerName, buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(),
      `siamepos-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
    fs.writeFile(tmp, buf).then(() => {
      let proc;
      try { proc = _getWinPrintProc(); } catch (e) { fs.unlink(tmp).catch(() => {}); return reject(e); }
      const id = String(++_winJobSeq);
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc._jobs.delete(id);
        fs.unlink(tmp).catch(() => {});
        fn(arg);
      };
      const timer = setTimeout(() => {
        // Abort a hung Send by respawning; die() rejects every still-pending job
        // (now safe — matched by id, no desync). Drop our slot first.
        proc._jobs.delete(id);
        try { proc.kill(); } catch (e) {}
        finish(reject, new Error('Windows raw print timed out'));
      }, 15000);
      proc._jobs.set(id, { resolve: () => finish(resolve), reject: (e) => finish(reject, e) });
      const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
      try { proc.stdin.write(`${id} ${b64(printerName)} ${b64(tmp)}\n`); }
      catch (e) { finish(reject, e); }
    }).catch(reject);
  });
}

// Send raw bytes to a printer addressed by NAME (no IP), per platform:
// Windows → spooler RAW datatype; Mac/Linux → CUPS `lpr -o raw`.
function _sendToNamedPrinter(printerName, buf) {
  if (process.platform === 'win32') return _sendWindowsRaw(printerName, buf);
  return _sendCups(printerName, buf);
}

// Remembers which transport worked per printer so LPR-only print servers
// (older WAVLINK / TP-Link) don't pay the RAW connect-timeout + error-wait
// on every single ticket. Process-level, like _cupsQueueCache. Self-heals:
// if the cached route fails (printer swapped, queue renamed) the entry is
// dropped and the full RAW → LPR → CUPS chain re-probes.
const _transportCache = new Map(); // `${ip}:${port}` → 'lpr'

function sendRaw(ip, port, buf, options = {}) {
  const explicitName = (options.printerName || '').trim();
  const lprQueue     = (options.lprQueue    || 'lp').trim();
  const hasTcp  = !!ip;

  if (!hasTcp && !explicitName) {
    return Promise.reject(new Error('NO_IP and no printer_name configured'));
  }

  const job = async () => {
    if (hasTcp) {
      const cacheKey = `${ip}:${port}`;

      // 0) Known LPR-only device — skip the doomed RAW attempt.
      if (_transportCache.get(cacheKey) === 'lpr') {
        try { return await _sendLpr(ip, 515, buf, lprQueue); }
        catch (cachedErr) {
          _transportCache.delete(cacheKey);
          console.warn(`[print] cached LPR route to ${ip} failed (${cachedErr.message}) — re-probing full chain`);
        }
      }

      // 1) RAW 9100 — fast path, works for most modern printers.
      try { return await _sendTcp(ip, port, buf); }
      catch (rawErr) {
        // 2) LPR 515 — older WAVLINK / TP-Link / no-brand USB print
        //    servers only expose this. Same data, structured handshake.
        try {
          console.warn(`[print] RAW ${ip}:${port} failed (${rawErr.message}) — trying LPR on 515 (queue '${lprQueue}')`);
          const res = await _sendLpr(ip, 515, buf, lprQueue);
          _transportCache.set(cacheKey, 'lpr');
          return res;
        } catch (lprErr) {
          // 3) CUPS — last resort, requires the printer to be installed
          //    in the local print queue. Only works when the backend is
          //    running on the Mac (Electron mode), not on Railway cloud.
          //
          //    SAFETY (bar-tickets-to-Mac fix): resolve the CUPS queue ONLY
          //    from the IP — findCupsQueueForIp() matches a queue whose CUPS
          //    device URI actually points at THIS ip. We deliberately pass
          //    null (not explicitName) so the operator's free-text printer
          //    NAME is never handed to `lpr -P`: for a network printer that
          //    name is a label (e.g. "POS80"), not a CUPS queue, and lpr
          //    could divert the ticket to the Mac's default / an unrelated
          //    installed printer (this is how a dead bar printer's tickets
          //    were landing on the Mac's system printer). A dead network
          //    printer must fail cleanly, never silently reprint elsewhere.
          //    The USB by-name path (no IP → _sendToNamedPrinter below) is
          //    unaffected, and a legit network CUPS queue is still matched by IP.
          const queueName = await getOrAutoDetectCupsQueue(ip, null);
          if (queueName) {
            console.warn(`[print] LPR ${ip}:515 also failed (${lprErr.message}) — falling back to IP-matched CUPS '${queueName}'`);
            return _sendCups(queueName, buf);
          }
          throw new Error(`All print methods failed for ${ip}. RAW: ${rawErr.message}. LPR: ${lprErr.message}. No IP-matched CUPS queue.`);
        }
      }
    }
    return _sendToNamedPrinter(explicitName, buf);
  };

  _printQueue = _printQueue.catch(() => {}).then(job);
  return _printQueue;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Each public method reads an optional CUPS printer name from settings.
// Operators set these (per-printer) in Admin → Settings → Network Printers
// only when their printer needs the CUPS fallback (e.g. WAVLINK USB server).
// If unset, only TCP is attempted — existing behaviour.
async function printReceipt(settings, order, items, paymentDetails) {
  const ip   = settings.printer_receipt_ip;
  const port = settings.printer_receipt_port || 9100;
  const printerName = settings.printer_receipt_name || '';
  const lprQueue    = settings.printer_receipt_lpr_queue || 'lp';
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, port, buildReceipt({ order, items, settings, paymentDetails }), { printerName, lprQueue });
}

// SEPOS-DRAWER-001 — open the cash drawer via the RECEIPT printer's RJ11 kick
// port. Fires on payment (gated by open_drawer_on_payment at the endpoint).
// Raw ESC/POS only — network / built-in receipt printer, not the browser path.
async function openCashDrawer(settings) {
  const ip   = settings.printer_receipt_ip;
  const port = settings.printer_receipt_port || 9100;
  const printerName = settings.printer_receipt_name || '';
  const lprQueue    = settings.printer_receipt_lpr_queue || 'lp';
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, port, CMD.DRAWER_KICK, { printerName, lprQueue });
}

async function printFireNotice(settings, order, course) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const lprQueue    = settings.printer_kitchen_lpr_queue || 'lp';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const buf = buildFireNotice({ order, course, bilingual });
  if (ip) {
    // Network: send each copy as its own job (back-to-back streams can garble
    // some print servers, and _sendTcp already paces them).
    for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName, lprQueue });
  } else {
    // USB/name (Windows spooler / CUPS): send ALL copies in ONE job with the
    // ticket buffer concatenated. Avoids spawning a PowerShell process per
    // copy — that per-copy spawn was the lag between the 1st and 2nd ticket.
    const payload = copies > 1 ? Buffer.concat(Array.from({ length: copies }, () => buf)) : buf;
    await sendRaw(ip, port, payload, { printerName, lprQueue });
  }
}

async function printKitchenTicket(settings, order, items, course) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const lprQueue    = settings.printer_kitchen_lpr_queue || 'lp';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
  const buf = buildKitchenTicket({ order, items, course, bilingual, thaiCodepage, fontScale: settings.kitchen_font_scale });
  if (ip) {
    // Network: send each copy as its own job (back-to-back streams can garble
    // some print servers, and _sendTcp already paces them).
    for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName, lprQueue });
  } else {
    // USB/name (Windows spooler / CUPS): send ALL copies in ONE job with the
    // ticket buffer concatenated. Avoids spawning a PowerShell process per
    // copy — that per-copy spawn was the lag between the 1st and 2nd ticket.
    const payload = copies > 1 ? Buffer.concat(Array.from({ length: copies }, () => buf)) : buf;
    await sendRaw(ip, port, payload, { printerName, lprQueue });
  }
}

async function printFullKitchenTicket(settings, order, items) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const lprQueue    = settings.printer_kitchen_lpr_queue || 'lp';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
  const buf = buildFullKitchenTicket({ order, items, bilingual, thaiCodepage, fontScale: settings.kitchen_font_scale });
  if (ip) {
    // Network: send each copy as its own job (back-to-back streams can garble
    // some print servers, and _sendTcp already paces them).
    for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName, lprQueue });
  } else {
    // USB/name (Windows spooler / CUPS): send ALL copies in ONE job with the
    // ticket buffer concatenated. Avoids spawning a PowerShell process per
    // copy — that per-copy spawn was the lag between the 1st and 2nd ticket.
    const payload = copies > 1 ? Buffer.concat(Array.from({ length: copies }, () => buf)) : buf;
    await sendRaw(ip, port, payload, { printerName, lprQueue });
  }
}

// SEPOS-STATION-001 — print a full kitchen ticket to an EXPLICIT printer/station
// (ip/port/mac/copies) rather than the fixed settings.printer_kitchen_ip. Used by
// the per-station routing so a category's items go to its assigned station.
async function printKitchenToPrinter(printer, settings, order, items) {
  const ip = printer.ip;
  const port = printer.port || 9100;
  const printerName = printer.name_device || printer.printerName || '';
  const lprQueue = printer.lpr_queue || 'lp';
  const copies = Math.max(1, Math.min(5, parseInt(printer.copies || 1, 10) || 1));
  if (!ip && !printerName) throw new Error('NO_IP');
  const bilingual = settings.kitchen_language === 'en_th';
  const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
  const buf = buildFullKitchenTicket({ order, items, bilingual, thaiCodepage, fontScale: settings.kitchen_font_scale });
  if (ip) {
    for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName, lprQueue });
  } else {
    const payload = copies > 1 ? Buffer.concat(Array.from({ length: copies }, () => buf)) : buf;
    await sendRaw(ip, port, payload, { printerName, lprQueue });
  }
}

async function printBarTicket(settings, order, items) {
  const ip       = settings.printer_bar_ip;
  const port     = settings.printer_bar_port || 9100;
  const printerName = settings.printer_bar_name || '';
  const lprQueue    = settings.printer_bar_lpr_queue || 'lp';
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
  await sendRaw(ip, port, buildKitchenTicket({ order, items, course: 4, bilingual, thaiCodepage, fontScale: settings.bar_font_scale }), { printerName, lprQueue });
}

// testPrint accepts an optional printer_name so the admin Test button can
// validate either path. Body shape: { ip, port, printer_name }.
async function testPrint(ip, port = 9100, printerName = '') {
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, parseInt(port, 10) || 9100, buildTestPage(), { printerName });
}

// ── Thai codepage probe ─────────────────────────────────────────────
// Prints "ทดสอบ" (Thai for "test") under every common ESC/POS Thai
// codepage ID so the operator can visually identify which one their
// specific printer recognises. The cnfujun POS80 + various Chinese
// clones don't always follow the Epson/Star convention of CP874 at
// index 30 — some use 21, some 17, some don't support Thai at all.
//
// Bytes for "ทดสอบ" in CP874 / TIS-620: 0xB7 0xB4 0xCA 0xCD 0xBA.
// We send the same bytes after switching to each codepage; whichever
// row renders the Thai word correctly is the right ID. Operator then
// sets settings.kitchen_thai_codepage to that value.
function buildThaiCodepageTest(customCp = null) {
  // "ทดสอบ" as TIS-620 bytes
  const THAI_BYTES = Buffer.from([0xb7, 0xb4, 0xca, 0xcd, 0xba]);
  // If the operator specified one codepage to focus on, just probe that.
  // Otherwise sweep across known Thai-capable codepage IDs from various
  // vendors: 11-33 (Epson/Star CP874 range), 50-52 (some cnfujun
  // variants), 100/200 (uncommon), 244-255 (high-range slots most
  // Chinese 80mm clones — including the cnfujun POS80 — use for Thai).
  const candidates = customCp != null
    ? [Number(customCp)]
    : [11, 14, 16, 17, 18, 20, 21, 22, 26, 30, 33, 50, 51, 52,
       100, 200, 210, 220, 230, 240, 244, 246, 248, 250, 252, 253, 254, 255];

  const parts = [
    CAN, CMD.INIT, lf(),
    CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.SIZE_TALL,
    txt('THAI CODEPAGE TEST'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    CMD.ALIGN_LEFT,
    txt('Expected: ทดสอบ  ("test" in Thai)'), lf(),
    txt('Whichever line below shows the'), lf(),
    txt('correct Thai word is the codepage'), lf(),
    txt('this printer supports.'), lf(),
    txt('Set kitchen_thai_codepage to that'), lf(),
    txt('number in Admin -> Printers.'), lf(),
    rule('-'), lf(),
  ];

  for (const cp of candidates) {
    parts.push(
      // Pad the label so all rows align: "CP 11:  ", "CP 30:  "
      txt(`CP ${String(cp).padStart(2)}:  `),
      // Switch codepage, write Thai bytes, switch back to CP858
      Buffer.from([ESC, 0x74, cp]),
      THAI_BYTES,
      Buffer.from([ESC, 0x74, 0x13]),
      lf(),
    );
  }

  parts.push(
    rule('='), lf(),
    CMD.ALIGN_CENTER,
    txt(new Date().toLocaleString('en-GB')), lf(2),
    CMD.CUT,
  );
  return flatten(parts);
}

async function printThaiTest(settings, customCp = null) {
  const ip          = settings.printer_kitchen_ip || settings.printer_receipt_ip;
  const port        = settings.printer_kitchen_port || settings.printer_receipt_port || 9100;
  const printerName = settings.printer_kitchen_name || settings.printer_receipt_name || '';
  const lprQueue    = settings.printer_kitchen_lpr_queue || settings.printer_receipt_lpr_queue || 'lp';
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, port, buildThaiCodepageTest(customCp), { printerName, lprQueue });
}

// ── Admin report printer (SEPOS-REPORTS-001) ─────────────────────────────────
// Generic ESC/POS printer for the admin Sales / Items / Z / VAT / Bills
// reports. The client builds a simple line DSL — each line is one of:
//   { kind:'h1', text }                — center, double size, bold
//   { kind:'h2', text }                — center, bold
//   { kind:'small', text }             — center, normal
//   { kind:'div' }                     — dashed rule
//   { kind:'div-solid' }               — solid rule
//   { kind:'row', left, right }        — left + right justified on one line
//   { kind:'total', left, right }      — bold, solid rule above
//   { kind:'space' }                   — single blank line
// We add INIT + CUT around the body so every report is a self-contained job.
function buildReportText({ lines }) {
  // Set ALIGN_CENTER once and never switch. Every row is padded to
  // exactly LINE_WIDTH chars, so the printer auto-centers each line
  // inside its printable area — content sits in the middle of the
  // 80mm paper instead of hugging the left edge.
  const parts = [CMD.INIT, CMD.ALIGN_CENTER];

  const W = LINE_WIDTH;
  const lr = (left, right) => {
    const l = stripUnsupported(left);
    const r = stripUnsupported(right);
    const space = Math.max(1, W - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };
  // For h1/h2/small the printer centers a short string itself; but for
  // rows / dividers we hand it a full-width string so the line is
  // perfectly balanced on the paper.
  for (const line of lines || []) {
    switch (line.kind) {
      case 'h1':
        parts.push(CMD.BOLD_ON, CMD.SIZE_TALL,
                   txt(line.text || ''), CMD.SIZE_NORMAL, CMD.BOLD_OFF,
                   CMD.LF);
        break;
      case 'h2':
        parts.push(CMD.BOLD_ON,
                   txt(line.text || ''), CMD.BOLD_OFF,
                   CMD.LF);
        break;
      case 'small':
        parts.push(txt(line.text || ''), CMD.LF);
        break;
      case 'div':
        parts.push(rule('-'), CMD.LF);
        break;
      case 'div-solid':
        parts.push(rule('='), CMD.LF);
        break;
      case 'row':
        parts.push(txt(lr(line.left, line.right)), CMD.LF);
        break;
      case 'total':
        parts.push(rule('='), CMD.LF, CMD.BOLD_ON,
                   txt(lr(line.left, line.right)),
                   CMD.BOLD_OFF, CMD.LF);
        break;
      case 'space':
        parts.push(CMD.LF);
        break;
      default:
        // Plain text line — no formatting.
        if (line.text) parts.push(txt(line.text), CMD.LF);
    }
  }

  // Trailing feed + cut so the last line clears the cutter blade.
  parts.push(CMD.LF, CMD.LF, CMD.LF, CMD.CUT);
  return Buffer.concat(parts);
}

async function printReportText(settings, lines) {
  const ip   = settings.printer_receipt_ip;
  const port = parseInt(settings.printer_receipt_port || '9100', 10) || 9100;
  const name = settings.printer_receipt_name || '';
  if (!ip && !name) throw new Error('no_receipt_printer_configured');
  const buf = buildReportText({ lines });
  return sendRaw(ip, port, buf, { printerName: name });
}

module.exports = {
  printReceipt,
  openCashDrawer,         // SEPOS-DRAWER-001
  printFireNotice,
  printKitchenTicket,
  printFullKitchenTicket,
  printKitchenToPrinter, // SEPOS-STATION-001
  printBarTicket,
  printKitchenMessage,    // SEPOS-KITCHEN-MSG-001
  printThaiTest,          // SEPOS-PRINT-THAI-PROBE
  testPrint,
  findCupsQueueForIp,
  buildReceipt,           // exported for mock-receipt test print
  buildTestPage,          // SEPOS-ANDROID-001 — buffer endpoints for the native app
  buildKitchenTicket,     // SEPOS-ANDROID-001
  buildFullKitchenTicket, // SEPOS-ANDROID-001
  buildFireNotice,        // SEPOS-ANDROID-001 — native fire-notice buffer
  buildKitchenMessage,    // SEPOS-ANDROID-001 — native kitchen-message buffer
  printReportText,        // SEPOS-REPORTS-001 — admin report ESC/POS
};
