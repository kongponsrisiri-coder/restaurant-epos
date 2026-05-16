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

// ── ESC/POS command bytes ─────────────────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;

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

const txt  = (s)       => Buffer.from(String(s ?? ''), 'utf8');
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

// ── Kitchen ticket formatter (single course) ──────────────────────────────────

function buildKitchenTicket({ order, items, course, bilingual = true }) {
  const heading = order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`)
    : `TABLE ${order.table_number != null ? order.table_number : '?'}`;
  const courseEN = COURSES_EN[course] || 'ITEMS';
  const courseTH = bilingual ? (COURSES_TH[course] || '') : '';
  const now = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const headSize = heading.length <= 10 ? CMD.SIZE_BIG : CMD.SIZE_TALL;

  const parts = [
    CMD.INIT, lf(),          // extra LF after INIT clears any residual buffer chars
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON, headSize, txt(heading), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    CMD.BOLD_ON, CMD.SIZE_TALL, txt(courseEN), CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
    courseTH ? [txt(courseTH), lf()] : [],
    order.customer_name ? [txt(order.customer_name), lf()] : [],
    rule('='), lf(),
    CMD.ALIGN_LEFT,
    ...items.flatMap(item => [
      CMD.BOLD_ON, CMD.SIZE_TALL,
      txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}`),
      CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
      item.notes ? [txt('    > ' + item.notes), lf()] : [],
    ]),
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
    ...byCourse[course].flatMap(item => [
      CMD.BOLD_ON, CMD.SIZE_TALL,
      txt(`${item.quantity || 1}x  ${item.name || item.item_name || 'Item'}`),
      CMD.SIZE_NORMAL, CMD.BOLD_OFF, lf(),
      item.notes ? [txt('    > ' + item.notes), lf()] : [],
    ]),
    idx < arr.length - 1 ? [rule('-'), lf()] : [],
  ]);

  const parts = [
    CMD.INIT, lf(),          // extra LF after INIT clears any residual buffer chars
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

// ── TCP sender ────────────────────────────────────────────────────────────────

function sendRaw(ip, port, buf, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(timeoutMs);
    sock.connect(parseInt(port, 10) || 9100, ip, () => {
      sock.write(buf, (err) => {
        if (err) return done(err);
        setTimeout(() => done(null), 400);
      });
    });
    sock.on('error',   (e) => done(e));
    sock.on('timeout', ()  => done(new Error(`Printer at ${ip} did not respond within ${timeoutMs}ms`)));
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function printReceipt(settings, order, items, paymentDetails) {
  const ip   = settings.printer_receipt_ip;
  const port = settings.printer_receipt_port || 9100;
  if (!ip) throw new Error('NO_IP');
  await sendRaw(ip, port, buildReceipt({ order, items, settings, paymentDetails }));
}

async function printKitchenTicket(settings, order, items, course) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  const bilingual = (settings.kitchen_language || 'en_th') === 'en_th';
  if (!ip) throw new Error('NO_IP');
  const buf = buildKitchenTicket({ order, items, course, bilingual });
  for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf);
}

async function printFullKitchenTicket(settings, order, items) {
  const ip       = settings.printer_kitchen_ip;
  const port     = settings.printer_kitchen_port || 9100;
  const copies   = Math.max(1, Math.min(5, parseInt(settings.printer_kitchen_copies || 1, 10) || 1));
  const bilingual = (settings.kitchen_language || 'en_th') === 'en_th';
  if (!ip) throw new Error('NO_IP');
  const buf = buildFullKitchenTicket({ order, items, bilingual });
  for (let i = 0; i < copies; i++) await sendRaw(ip, port, buf);
}

async function printBarTicket(settings, order, items) {
  const ip       = settings.printer_bar_ip;
  const port     = settings.printer_bar_port || 9100;
  const bilingual = (settings.kitchen_language || 'en_th') === 'en_th';
  if (!ip) throw new Error('NO_IP');
  await sendRaw(ip, port, buildKitchenTicket({ order, items, course: 4, bilingual }));
}

async function testPrint(ip, port = 9100) {
  if (!ip) throw new Error('NO_IP');
  await sendRaw(ip, parseInt(port, 10) || 9100, buildTestPage());
}

module.exports = { printReceipt, printKitchenTicket, printFullKitchenTicket, printBarTicket, testPrint };
