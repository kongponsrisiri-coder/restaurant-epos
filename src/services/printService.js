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
const { exec } = require('child_process');

// ── ESC/POS command bytes ─────────────────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;

const CAN = Buffer.from([0x18]);   // Cancel — discards any buffered data since last LF

const CMD = {
  INIT:         Buffer.from([ESC, 0x40]),
  ALIGN_LEFT:   Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT:  Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON:      Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF:     Buffer.from([ESC, 0x45, 0x00]),
  SIZE_NORMAL:  Buffer.from([GS,  0x21, 0x00]),   // 1× width, 1× height
  SIZE_TALL:    Buffer.from([GS,  0x21, 0x01]),   // 1× width, 2× height
  SIZE_WIDE:    Buffer.from([GS,  0x21, 0x10]),   // 2× width, 1× height
  SIZE_BIG:     Buffer.from([GS,  0x21, 0x11]),   // 2× width, 2× height
  CUT:          Buffer.from([GS,  0x56, 0x41, 0x05]), // Partial cut + 5mm feed
  LF:           Buffer.from([0x0a]),
};

const LINE_WIDTH = 42;  // characters at normal size on 80mm paper

// ── Bilingual course labels ───────────────────────────────────────────────────
const COURSES_EN = { 1:'STARTERS', 2:'MAINS', 3:'DESSERTS', 4:'EXTRAS' };
const COURSES_TH = { 1:'กับแกล้ม', 2:'อาหารหลัก', 3:'ของหวาน', 4:'เพิ่มเติม' };

// ── Buffer helpers ────────────────────────────────────────────────────────────

// Strip any codepoint > 0xFF before sending to the printer. Most UK thermal
// printers ship without Thai / CJK glyphs, so multi-byte UTF-8 sequences
// render as garbage (e.g. "ดูดัดดูดัน" instead of the intended Thai name).
// Keeping Latin-1 preserves £, é, ñ, etc. — drops everything beyond that.
const stripUnsupported = (s) => String(s ?? '').replace(/[^\x00-\xFF]/g, '');
const txt  = (s)       => Buffer.from(stripUnsupported(s), 'utf8');
const lf   = (n = 1)   => Buffer.alloc(n, 0x0a);
const rule = (c = '-') => txt(c.repeat(LINE_WIDTH));

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

// ── Receipt formatter ─────────────────────────────────────────────────────────

function buildReceipt({ order, items, settings, paymentDetails = {} }) {
  const name    = settings.company_name    || settings.restaurant_name || 'SiamEPOS';
  const addr    = settings.company_address || '';
  const phone   = settings.company_phone   || '';
  const vatNo   = settings.company_vat     || '';
  const footer  = settings.receipt_footer  || 'Thank you for dining with us!';
  const scRate  = parseFloat(settings.service_charge_rate || 12.5);

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
  const byCourse    = {};
  activeItems.forEach(i => {
    const c = i.course || 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(i);
  });

  // Restaurant name: large if short, tall if long
  const nameSize = name.length <= 14 ? [CMD.SIZE_BIG] : [CMD.SIZE_TALL];

  const parts = [
    CMD.INIT,
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, ...nameSize, txt(name), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    addr   ? [txt(addr),            lf()] : [],
    phone  ? [txt('Tel: ' + phone), lf()] : [],
    vatNo  ? [txt('VAT: ' + vatNo), lf()] : [],
    lf(),
    CMD.ALIGN_LEFT,
    rule(), lf(),

    // Order header
    ...(order.order_type === 'takeaway' ? [
      col2('Type', order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`), lf(),
      order.customer_name ? [col2('Customer', order.customer_name), lf()] : [],
      order.pickup_time   ? [col2('Pickup', new Date(order.pickup_time).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/London' })), lf()] : [],
    ] : [
      col2('Table',  String(order.table_number || '—')), lf(),
      col2('Covers', String(order.covers       || '—')), lf(),
    ]),
    col2('Date',    date),  lf(),
    col2('Time',    time),  lf(),
    col2('Order #', String(order.id)), lf(),
    rule(), lf(),

    // Items grouped by course — slightly larger for readability
    ...Object.keys(byCourse).sort().flatMap(course => [
      CMD.BOLD_ON, CMD.SIZE_WIDE, txt(COURSES_EN[course] || 'ITEMS'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
      ...byCourse[course].flatMap(item => {
        const p   = item.unit_price * item.quantity;
        const d   = item.discount_value > 0
          ? item.discount_type === 'percent' ? p * item.discount_value / 100 : Math.min(item.discount_value, p)
          : 0;
        const net = p - d;
        return [
          CMD.BOLD_ON, col2(`${item.quantity}x ${item.name}`, '£' + net.toFixed(2)), CMD.BOLD_OFF, lf(),
          item.notes ? [txt('  > ' + item.notes), lf()] : [],
        ];
      }),
    ]),
    rule(), lf(),

    // Totals — bolder and more spaced
    col2('Subtotal', '£' + subtotal.toFixed(2)), lf(),
    discountAmt   > 0 ? [col2('Discount',              '-£' + discountAmt.toFixed(2)),     lf()] : [],
    serviceCharge > 0 ? [col2(`Service (${scRate}%)`,   '£' + serviceCharge.toFixed(2)),   lf()] : [],
    tip           > 0 ? [col2('Gratuity',               '£' + tip.toFixed(2)),              lf()] : [],
    rule('='), lf(),
    CMD.BOLD_ON, CMD.SIZE_BIG, col2('TOTAL', '£' + billTotal.toFixed(2), LINE_WIDTH / 2),
    CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),

    // Payment
    method ? [
      col2('Payment', method), lf(),
      method === 'Cash' && amountPaid > 0 ? [
        col2('Cash tendered', '£' + amountPaid.toFixed(2)), lf(),
        CMD.BOLD_ON, col2('Change', '£' + change.toFixed(2)), CMD.BOLD_OFF, lf(),
      ] : [],
      rule(), lf(),
    ] : [],

    // Footer
    lf(),
    CMD.ALIGN_CENTER,
    txt(footer),                       lf(),
    txt('ขอบคุณที่มาใช้บริการ'), lf(3),

    CMD.CUT,
  ];

  return flatten(parts);
}

// ── Course fire notice (TABLE X — FIRE MAINS — no item list) ─────────────────
// Called when chef fires a specific course. Just a loud call card, no item detail.

function buildFireNotice({ order, course, bilingual = true }) {
  const heading  = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`)
    : `TABLE ${order.table_number != null ? order.table_number : '?'}`;
  const courseEN = COURSES_EN[course] || 'ITEMS';
  const courseTH = bilingual ? (COURSES_TH[course] || '') : '';
  const now      = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  const parts = [
    CAN, CMD.INIT, lf(),
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    rule('='), lf(),
    CMD.BOLD_ON, CMD.SIZE_BIG, txt('FIRE'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(courseEN), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    courseTH ? [txt(courseTH), lf()] : [],
    rule('='), lf(),
    CMD.ALIGN_CENTER,
    txt(`${now}  ·  Order #${order.id}`), lf(2),
    CMD.CUT,
  ];

  return flatten(parts);
}

// ── Kitchen ticket formatter (single course, full item list) ──────────────────
// Used for Send-to-Bar and any other case where a full item list is needed.

function buildKitchenTicket({ order, items, course, bilingual = true }) {
  const heading = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`)
    : `TABLE ${order.table_number != null ? order.table_number : '?'}`;
  const courseEN = COURSES_EN[course] || 'ITEMS';
  const courseTH = bilingual ? (COURSES_TH[course] || '') : '';
  const now = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  const parts = [
    CAN, CMD.INIT, lf(),
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(courseEN), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    courseTH ? [txt(courseTH), lf()] : [],
    order.customer_name ? [txt(order.customer_name), lf()] : [],
    rule('='), lf(),
    CMD.ALIGN_LEFT,
    ...items.flatMap(item => {
      const nameAlt = bilingual ? (item.name_alt || item.name_th || '') : '';
      return [
        CMD.BOLD_ON, CMD.SIZE_TALL,
        txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}`),
        CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
        nameAlt   ? [txt('    ' + nameAlt), lf()] : [],
        item.notes ? [txt('    > ' + item.notes), lf()] : [],
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

function buildFullKitchenTicket({ order, items, bilingual = true }) {
  const heading = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`)
    : `TABLE ${order.table_number != null ? order.table_number : '?'}`;
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
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(COURSES_EN[course] || 'ITEMS'), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    bilingual && COURSES_TH[course] ? [txt(COURSES_TH[course]), lf()] : [],
    rule('-'), lf(),
    ...byCourse[course].flatMap(item => {
      const nameAlt = bilingual ? (item.name_alt || item.name_th || '') : '';
      return [
        CMD.BOLD_ON, CMD.SIZE_TALL,
        txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}`),
        CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
        nameAlt    ? [txt('    ' + nameAlt), lf()] : [],
        item.notes ? [txt('    > ' + item.notes), lf()] : [],
      ];
    }),
    idx < arr.length - 1 ? [rule('-'), lf()] : [],
  ]);

  const parts = [
    CAN, CMD.INIT, lf(),     // CAN discards leftover bytes; LF after INIT ensures clean start
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    order.customer_name ? [txt(order.customer_name), lf()] : [],
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

// ── Test page ─────────────────────────────────────────────────────────────────

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

function _sendTcp(ip, port, buf, timeoutMs = 6000) {
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

async function _sendCups(printerName, buf) {
  // Write the raw bytes to a tmp file because `lpr` needs a path. Inline
  // stdin would work too but tmp file is more debuggable.
  const tmp = path.join(os.tmpdir(),
    `siamepos-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  await fs.writeFile(tmp, buf);
  try {
    await new Promise((resolve, reject) => {
      // Quote-escape the printer name to defend against shell injection in
      // case anyone ever puts a hostile string in the settings table.
      const safeName = String(printerName).replace(/"/g, '\\"');
      exec(`lpr -P "${safeName}" -o raw "${tmp}"`, (err, _stdout, stderr) => {
        if (err) return reject(new Error(`CUPS print failed: ${(stderr || '').trim() || err.message}`));
        resolve();
      });
    });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

function sendRaw(ip, port, buf, options = {}) {
  const printerName = (options.printerName || '').trim();
  const hasTcp  = !!ip;
  const hasCups = !!printerName;

  if (!hasTcp && !hasCups) {
    return Promise.reject(new Error('NO_IP and no printer_name configured'));
  }

  const job = async () => {
    if (hasTcp) {
      try { return await _sendTcp(ip, port, buf); }
      catch (err) {
        if (hasCups) {
          console.warn(`[print] TCP ${ip}:${port} failed (${err.message}) — falling back to CUPS '${printerName}'`);
          return _sendCups(printerName, buf);
        }
        throw err;
      }
    }
    return _sendCups(printerName, buf);
  };

  // Enqueue — jobs run sequentially, never concurrently
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
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, port, buildReceipt({ order, items, settings, paymentDetails }), { printerName });
}

async function printFireNotice(settings, order, course) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const buf = buildFireNotice({ order, course, bilingual });
  for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName });
}

async function printKitchenTicket(settings, order, items, course) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const buf = buildKitchenTicket({ order, items, course, bilingual });
  for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName });
}

async function printFullKitchenTicket(settings, order, items) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const printerName = settings.printer_kitchen_name || '';
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  const buf = buildFullKitchenTicket({ order, items, bilingual });
  for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf, { printerName });
}

async function printBarTicket(settings, order, items) {
  const ip       = settings.printer_bar_ip;
  const port     = settings.printer_bar_port || 9100;
  const printerName = settings.printer_bar_name || '';
  // Opt-in: bilingual Thai labels only print if the operator explicitly
  // sets kitchen_language='en_th' AND has a Thai-capable printer. Default
  // is English-only, since most UK thermal printers can't render Thai
  // glyphs and the bilingual line just renders as garbage.
  const bilingual = settings.kitchen_language === 'en_th';
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, port, buildKitchenTicket({ order, items, course: 4, bilingual }), { printerName });
}

// testPrint accepts an optional printer_name so the admin Test button can
// validate either path. Body shape: { ip, port, printer_name }.
async function testPrint(ip, port = 9100, printerName = '') {
  if (!ip && !printerName) throw new Error('NO_IP');
  await sendRaw(ip, parseInt(port, 10) || 9100, buildTestPage(), { printerName });
}

module.exports = { printReceipt, printFireNotice, printKitchenTicket, printFullKitchenTicket, printBarTicket, testPrint };
