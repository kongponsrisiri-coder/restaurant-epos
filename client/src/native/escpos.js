// SEPOS-ANDROID-002 — one ticket/receipt LAYOUT → two renderers:
//   • network printer: raw ESC/POS bytes (renderOpsToBytes) with CP858 + £→0x9C
//     + Thai code-page wrapping (proven on LAN printers).
//   • Sunmi built-in printer: the ops array is sent to the native printText API
//     (sunmiPrinter.sunmiPrintOps), which is UTF-8 so £ and Thai print directly —
//     the Sunmi can't do ESC/POS code pages, which is why raw gave £→blank, Thai→?.
//
// Layout emits abstract ops: {op:'align',v} {op:'size',v:'n'|'t'|'b'|'h'}
// {op:'bold',v} {op:'text',v} {op:'feed',v} {op:'cut'}. Size tokens:
// n=normal · t=tall · b=big · h=huge (table number).

const WIDTH = 32;                 // network printer: 32 chars per 80mm line (Font A)
const SUNMI_BILL_WIDTH = 46;      // Sunmi bill at the small 'r' font: ~46 chars per 80mm
const COURSE = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
// Sunmi printText font sizes. KITCHEN uses the big ones (n/t/b/h). The BILL uses
// 'r' (compact receipt font) and fills the width via more columns, not a bigger
// font — at 40 the bill wrapped and looked oversized.
const SUNMI_SIZE = { r: 24, n: 40, t: 48, b: 54, h: 74 };
const BYTE_SIZE  = { r: 0x00, n: 0x00, t: 0x01, b: 0x11, h: 0x22 };

function money(n) { return '£' + (parseFloat(n || 0)).toFixed(2); }
function rule() { return '-'.repeat(WIDTH); }
function pad(left, right, width = WIDTH) {
  left = String(left); right = String(right);
  const space = Math.max(1, width - right.length);
  if (left.length > space - 1) left = left.slice(0, space - 1);
  return left + ' '.repeat(width - left.length - right.length) + right;
}

function headerOps(ops, order, title) {
  ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: title }, { op: 'size', v: 'n' });
  let label;
  const t = order && order.order_type;
  if (t && t !== 'dine_in') label = t === 'counter' ? 'COUNTER' : 'ONLINE ORDER';
  else label = 'TABLE ' + ((order && (order.table_number ?? order.table_id)) ?? '');
  ops.push({ op: 'size', v: 'h' }, { op: 'text', v: label }, { op: 'size', v: 'n' }, { op: 'bold', v: false }); // big table no.
  if (order && order.id != null) ops.push({ op: 'text', v: 'Order #' + order.id });
  ops.push({ op: 'align', v: 0 }, { op: 'text', v: rule() });
}

function kitchenItemOps(ops, it, bilingual = true) {
  ops.push({ op: 'size', v: 'b' }, { op: 'text', v: `${it.quantity || 1} x ${it.name || it.item_name || ''}` }, { op: 'size', v: 'n' });
  // Second-language line only when the kitchen runs bilingual tickets.
  // kitchen_language='en' → English only (matches the HTML/server path).
  if (bilingual && it.name_alt)  ops.push({ op: 'size', v: 't' }, { op: 'text', v: '  ' + it.name_alt }, { op: 'size', v: 'n' });
  if (it.item_note) ops.push({ op: 'bold', v: true }, { op: 'size', v: 't' }, { op: 'text', v: '  ** ' + it.item_note + ' **' }, { op: 'size', v: 'n' }, { op: 'bold', v: false });
  if (it.notes)     ops.push({ op: 'size', v: 't' }, { op: 'text', v: '  ' + it.notes }, { op: 'size', v: 'n' });
}

// ── Kitchen / bar / fire-notice layout → ops ──────────────────────────────────
export function buildKitchenOps(native) {
  const { order, items, course, kind, bilingual = true } = native || {};
  const ops = [];
  if (kind === 'fire-notice') {
    headerOps(ops, order, 'FIRE');
    ops.push({ op: 'feed', v: 1 }, { op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' },
             { op: 'text', v: COURSE[course] || ('COURSE ' + course) }, { op: 'size', v: 'n' }, { op: 'bold', v: false },
             { op: 'align', v: 0 }, { op: 'feed', v: 2 }, { op: 'cut' });
    return ops;
  }
  if (kind === 'bar') {
    headerOps(ops, order, 'BAR');
    for (const it of (items || []).filter(i => i && !i.voided)) kitchenItemOps(ops, it, bilingual);
    ops.push({ op: 'feed', v: 2 }, { op: 'cut' });
    return ops;
  }
  headerOps(ops, order, 'KITCHEN');
  const list = (items || []).filter(i => i && !i.voided && (course == null || (Number(i.course) || 1) === Number(course)));
  const byCourse = {};
  for (const it of list) { const c = Number(it.course) || 1; (byCourse[c] = byCourse[c] || []).push(it); }
  for (const c of Object.keys(byCourse).map(Number).sort((a, b) => a - b)) {
    ops.push({ op: 'bold', v: true }, { op: 'text', v: COURSE[c] || ('COURSE ' + c) }, { op: 'bold', v: false });
    for (const it of byCourse[c]) kitchenItemOps(ops, it, bilingual);
    ops.push({ op: 'feed', v: 1 });
  }
  ops.push({ op: 'feed', v: 1 }, { op: 'cut' });
  return ops;
}

// ── Customer bill / receipt layout → ops ──────────────────────────────────────
export function buildReceiptOps({ order, items, settings, paymentDetails = {} }) {
  const s = settings || {};
  const name = s.company_name || s.restaurant_name || 'SiamEPOS';
  const addr = s.company_address || s.address || '';
  const phone = s.company_phone || s.phone || '';
  const vat = s.company_vat || '';
  const footer = s.receipt_footer || 'Thank you for dining with us!';
  const scRate = parseFloat(s.service_charge_rate || s.service_charge_percent || 12.5);

  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const subtotal = parseFloat(paymentDetails.subtotal ?? 0);
  const discountAmount = parseFloat(paymentDetails.discountAmount ?? 0);
  const serviceCharge = parseFloat(paymentDetails.serviceCharge ?? 0);
  const tip = parseFloat(paymentDetails.tip ?? 0);
  const billTotal = parseFloat(paymentDetails.billTotal ?? (subtotal - discountAmount + serviceCharge + tip));
  const amountPaid = parseFloat(paymentDetails.amountPaid ?? billTotal);
  const change = parseFloat(paymentDetails.change ?? Math.max(0, amountPaid - billTotal));
  const method = paymentDetails.method || '';

  // Compact receipt font ('r'); rows/rules fill the width via column count.
  const ops = [{ op: 'size', v: 'r' }];
  // Logo (base64 data URL → bare base64) — printed on the Sunmi via printBitmap.
  const logo = s.company_logo || '';
  if (logo) {
    const b64 = logo.includes(',') ? logo.slice(logo.indexOf(',') + 1) : logo;
    // Match the receipt logo-size setting (small/medium/large/full) → dots on the
    // 576-dot (80mm) head, same choice as the HTML receipt.
    const LOGO_W = { small: 160, medium: 300, large: 430, full: 560 };
    const w = LOGO_W[s.receipt_logo_size] || LOGO_W.medium;
    ops.push({ op: 'align', v: 1 }, { op: 'image', v: b64, w }, { op: 'feed', v: 1 });
  }
  ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: name }, { op: 'size', v: 'r' }, { op: 'bold', v: false });
  if (addr)  ops.push({ op: 'text', v: addr });
  if (phone) ops.push({ op: 'text', v: 'Tel: ' + phone });
  if (vat)   ops.push({ op: 'text', v: 'VAT No: ' + vat });
  ops.push({ op: 'align', v: 0 }, { op: 'rule' });

  if (order && order.order_type && order.order_type !== 'dine_in') {
    ops.push({ op: 'row', l: 'Type', r: order.order_type === 'counter' ? 'Counter' : 'Online Order' });
    if (order.customer_name) ops.push({ op: 'row', l: 'Customer', r: order.customer_name });
  } else {
    ops.push({ op: 'row', l: 'Table', r: String((order && (order.table_number ?? order.table_id)) ?? '-') });
    ops.push({ op: 'row', l: 'Covers', r: String((order && order.covers) || '-') });
  }
  ops.push({ op: 'row', l: 'Date', r: date }, { op: 'row', l: 'Time', r: time });
  if (order && order.id != null) ops.push({ op: 'row', l: 'Order #', r: String(order.id) });
  ops.push({ op: 'rule' });

  // Flat item list (no course headers) — matches the network receipt.
  const active = (items || []).filter(i => !i.voided);
  for (const it of active) {
    const itemTotal = (it.quantity || 0) * (it.unit_price || 0);
    let price = itemTotal;
    if (it.discount_type === 'percent') price = itemTotal * (1 - (it.discount_value || 0) / 100);
    if (it.discount_type === 'fixed')   price = Math.max(0, itemTotal - (it.discount_value || 0));
    ops.push({ op: 'row', l: `${it.quantity}x ${it.name || it.item_name || 'Item'}`, r: money(price) });
    if (it.notes) ops.push({ op: 'text', v: '   ' + it.notes });
  }
  ops.push({ op: 'rule' });
  ops.push({ op: 'row', l: 'Subtotal', r: money(subtotal) });
  if (discountAmount > 0) ops.push({ op: 'row', l: 'Discount', r: '-' + money(discountAmount) });
  if (serviceCharge > 0)  ops.push({ op: 'row', l: `Service (${scRate}%)`, r: money(serviceCharge) });
  if (tip > 0)            ops.push({ op: 'row', l: 'Gratuity', r: money(tip) });
  ops.push({ op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: 'TOTAL ' + money(billTotal) }, { op: 'size', v: 'r' }, { op: 'bold', v: false });
  if (method) {
    ops.push({ op: 'row', l: 'Payment', r: method });
    if (method === 'Cash' && amountPaid > 0) {
      ops.push({ op: 'row', l: 'Cash', r: money(amountPaid) });
      ops.push({ op: 'row', l: 'Change', r: money(change) });
    }
  }
  ops.push({ op: 'rule' });
  ops.push({ op: 'align', v: 1 }, { op: 'text', v: footer }, { op: 'text', v: 'ขอบคุณที่มาใช้บริการ' }, { op: 'align', v: 0 }, { op: 'feed', v: 2 }, { op: 'cut' });
  return ops;
}

// Map abstract ops → Sunmi plugin ops: size tokens → px; rows/rules → padded text
// at the Sunmi bill width (fills the 80mm at the compact font).
export function opsForSunmi(ops) {
  const out = [];
  for (const o of ops) {
    if (o.op === 'size') out.push({ op: 'size', v: SUNMI_SIZE[o.v] || SUNMI_SIZE.n });
    else if (o.op === 'row') out.push({ op: 'text', v: pad(o.l, o.r, SUNMI_BILL_WIDTH) });
    else if (o.op === 'rule') out.push({ op: 'text', v: '-'.repeat(SUNMI_BILL_WIDTH) });
    else out.push(o);
  }
  return out;
}

// ── Network renderer: ops → raw ESC/POS base64 (CP858 + £ + Thai code pages) ──
const ESC = 0x1B, GS = 0x1D, LF = 0x0A, BASE_CP = 0x13;
export function renderOpsToBytes(ops, { thaiCp = null } = {}) {
  const cp = (thaiCp == null || thaiCp === '' || isNaN(Number(thaiCp))) ? null : (Number(thaiCp) & 0xFF);
  const b = [ESC, 0x40, ESC, 0x74, BASE_CP];
  const enc = (text) => {
    let inThai = false;
    for (const ch of String(text == null ? '' : text)) {
      const c = ch.codePointAt(0);
      const isThai = c >= 0x0E00 && c <= 0x0E7F;
      if (isThai && cp != null) {
        if (!inThai) { b.push(ESC, 0x74, cp); inThai = true; }
        b.push((c - 0x0E00 + 0xA0) & 0xFF);
      } else {
        if (inThai) { b.push(ESC, 0x74, BASE_CP); inThai = false; }
        if (ch === '£') b.push(0x9C);
        else if (c < 0x80) b.push(c);
        else b.push(0x3F);
      }
    }
    if (inThai) b.push(ESC, 0x74, BASE_CP);
  };
  for (const o of ops) {
    switch (o.op) {
      case 'align': b.push(ESC, 0x61, o.v); break;
      case 'size':  b.push(GS, 0x21, BYTE_SIZE[o.v] ?? 0x00); break;
      case 'bold':  b.push(ESC, 0x45, o.v ? 1 : 0); break;
      case 'text':  enc(o.v); b.push(LF); break;
      case 'row':   enc(pad(o.l, o.r, WIDTH)); b.push(LF); break;
      case 'rule':  enc('-'.repeat(WIDTH)); b.push(LF); break;
      case 'feed':  for (let i = 0; i < (o.v || 1); i++) b.push(LF); break;
      case 'cut':   b.push(GS, 0x56, 0x42, 0x00); break;
    }
  }
  let s = ''; for (const x of b) s += String.fromCharCode(x & 0xFF);
  return btoa(s);
}
