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
const SUNMI_BILL_WIDTH = 36;      // Sunmi bill at the 'r' font (30px): ~37 chars per 80mm (bumped bigger per operator feedback)
const SUNMI_KITCHEN_WIDTH = 26;   // Sunmi kitchen at the big 'n' font: ~28 chars fit — 26 stays clear of wrapping (a full 32 wraps to a stray '----')
const COURSE = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
// Sunmi printText font sizes. KITCHEN uses the big ones (n/t/b/h). The BILL uses
// 'r' (compact receipt font) and fills the width via more columns, not a bigger
// font — at 40 the bill wrapped and looked oversized.
const SUNMI_SIZE = { r: 30, n: 40, t: 48, b: 54, h: 74 };  // 'r' bumped 24→30 for a bigger, more legible receipt
const BYTE_SIZE  = { r: 0x00, n: 0x00, t: 0x01, b: 0x11, h: 0x22 };

// SEPOS-PRINT-FONT-001 — per-role font scale. large = TODAY's size (no regression):
// kitchen item lines were 'b', receipt body 'r'. normal = one step smaller (more on
// paper), xlarge = one step bigger. Widths recompute so bigger fonts don't wrap.
const KITCHEN_TOKEN = { normal: 't', large: 'b', xlarge: 'h' };
const KITCHEN_WIDTH = { normal: 30, large: 26, xlarge: 19 };
const BILL_TOKEN    = { normal: 'r', large: 'n', xlarge: 't' };
const BILL_WIDTH    = { normal: 36, large: 27, xlarge: 22 };
// SEPOS-PRINT-FONT-002 — scales can now be "WxH" tokens (see printService).
// The Sunmi printText API takes point sizes, not independent w×h, so map a
// WxH to the nearest point-size step by its dominant multiplier. Legacy words
// (medium/tall/wide) collapse through the same table.
const WH_LEGACY = { normal: [1, 1], medium: [1, 2], tall: [1, 2], wide: [2, 1], large: [2, 2], xlarge: [3, 3] };
const scaleMax = (s) => {
  const m = /^([1-4])x([1-4])$/.exec(String(s || ''));
  const wh = m ? [Number(m[1]), Number(m[2])] : WH_LEGACY[s];
  return wh ? Math.max(wh[0], wh[1]) : null;
};
const kToken = (s) => { const x = scaleMax(s); return x == null ? (KITCHEN_TOKEN[s] || 'b') : (x <= 1 ? 't' : x === 2 ? 'b' : 'h'); };
const kWidth = (s) => { const x = scaleMax(s); return x == null ? (KITCHEN_WIDTH[s] || 26) : (x <= 1 ? 30 : x === 2 ? 26 : 19); };
const bToken = (s) => { const x = scaleMax(s); return x == null ? (BILL_TOKEN[s] || 'r') : (x <= 1 ? 'r' : x === 2 ? 'n' : 't'); };
const bWidth = (s) => { const x = scaleMax(s); return x == null ? (BILL_WIDTH[s] || 36) : (x <= 1 ? 36 : x === 2 ? 27 : 22); };

function money(n) { return '£' + (parseFloat(n || 0)).toFixed(2); }
function rule() { return '-'.repeat(WIDTH); }
function pad(left, right, width = WIDTH) {
  left = String(left); right = String(right);
  const space = Math.max(1, width - right.length);
  if (left.length > space - 1) left = left.slice(0, space - 1);
  return left + ' '.repeat(width - left.length - right.length) + right;
}

function headerOps(ops, order, title, kw = SUNMI_KITCHEN_WIDTH, sentBy = null) {
  // Head room at the top so the KITCHEN/TABLE header clears the ticket-rail
  // clip — otherwise the clip hides the table number when the ticket is hung.
  ops.push({ op: 'feed', v: 4 });
  ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: title }, { op: 'size', v: 'n' });
  let label;
  const t = order && order.order_type;
  if (t && t !== 'dine_in') {
    // SEPOS-ANDROID-004 — an online DELIVERY order prints "DELIVERY"; a walk-in
    // takeaway rung up at the till sits on a takeaway table → "TAKEAWAY N";
    // a website collection with no table → "ONLINE ORDER".
    label = t === 'counter' ? 'COUNTER'
      : (order.order_subtype === 'delivery') ? 'DELIVERY'
      : (t === 'takeaway' && order.table_number != null && order.table_number !== '') ? `TAKEAWAY ${order.table_number}`
      : 'ONLINE ORDER';
  } else {
    // Table NAME wins over the raw number (Bar 2 = table_number 2) — same
    // rule as printService.tableHeading / KitchenTicket.orderHeading.
    const tl = order && order.table_label && String(order.table_label).trim();
    label = tl ? tl.toUpperCase() : 'TABLE ' + ((order && (order.table_number ?? order.table_id)) ?? '');
  }
  ops.push({ op: 'size', v: 'h' }, { op: 'text', v: label }, { op: 'size', v: 'n' }, { op: 'bold', v: false }); // big table no.
  if (order && order.id != null) ops.push({ op: 'text', v: 'Order #' + order.id });
  if (sentBy) ops.push({ op: 'text', v: 'Sent: ' + sentBy }); // SEPOS-SENTBY-001
  // SEPOS-ANDROID-004 — online / takeaway / delivery header: the kitchen needs
  // WHO it's for, WHEN to have it ready, and (delivery) WHERE it's going. Mirrors
  // the desktop takeaway kitchen ticket (printService.printFullKitchenTicket).
  if (order && t && t !== 'dine_in') {
    if (order.customer_name)  ops.push({ op: 'text', v: String(order.customer_name) });
    if (order.customer_phone) ops.push({ op: 'text', v: String(order.customer_phone) });
    if (order.pickup_time)    ops.push({ op: 'bold', v: true }, { op: 'text', v: 'Pickup ' + fmtTime(order.pickup_time) }, { op: 'bold', v: false });
    if (order.order_subtype === 'delivery' && order.delivery_address) {
      ops.push({ op: 'krule', w: Math.min(kw, SUNMI_KITCHEN_WIDTH) });
      ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'text', v: '-- DELIVERY --' }, { op: 'bold', v: false }, { op: 'align', v: 0 });
      for (const line of String(order.delivery_address).split(/\r?\n|,\s*/).map(s => s.trim()).filter(Boolean)) {
        ops.push({ op: 'text', v: line });
      }
    }
  }
  // SEPOS-AUDIT-002 F13 — the order-level ALLERGY / kitchen note was missing
  // from the native ticket entirely, on EVERY order type. A Sunmi-only kitchen
  // was cooking "no peanuts" blind. Kept separate from the ANDROID-004 block
  // above (which is takeaway/delivery-only and stays as it is) because a
  // dine-in order carries allergy notes too.
  if (order) {
    const kitchenNote = order.customer_note || order.notes;
    if (kitchenNote) {
      ops.push({ op: 'bold', v: true }, { op: 'size', v: 'b' },
               { op: 'text', v: '** ' + String(kitchenNote).toUpperCase() + ' **' },
               { op: 'size', v: 'n' }, { op: 'bold', v: false });
    }
  }
  // 'krule' = a rule sized per printer (kitchen font is big, so the Sunmi needs a
  // shorter dash run than the network 32 or it wraps). See renderers below.
  ops.push({ op: 'align', v: 0 }, { op: 'krule', w: Math.min(kw, SUNMI_KITCHEN_WIDTH) });
}

// HH:MM in the DEVICE's local time — the Sunmi sits at the restaurant, so its
// clock is the restaurant's timezone (correct even for a non-UK client).
function fmtTime(t) {
  try { return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  catch { return String(t); }
}

function kitchenItemOps(ops, it, bilingual = true, sz = 'b') {
  // SEPOS-PRINT-FONT-001 — item + option/2nd-lang/note lines all print at the
  // configured kitchen size `sz` (default 'b' = today). Bold for emphasis.
  ops.push({ op: 'bold', v: true }, { op: 'size', v: sz }, { op: 'text', v: `${it.quantity || 1} x ${it.name || it.item_name || ''}` }, { op: 'size', v: 'n' }, { op: 'bold', v: false });
  if (bilingual && it.name_alt)  ops.push({ op: 'size', v: sz }, { op: 'text', v: '  ' + it.name_alt }, { op: 'size', v: 'n' });
  if (it.item_note) ops.push({ op: 'bold', v: true }, { op: 'size', v: sz }, { op: 'text', v: '  ** ' + it.item_note + ' **' }, { op: 'size', v: 'n' }, { op: 'bold', v: false });
  if (it.notes)     ops.push({ op: 'size', v: sz }, { op: 'text', v: '  ' + it.notes }, { op: 'size', v: 'n' });
}

// ── Kitchen / bar / fire-notice layout → ops ──────────────────────────────────
export function buildKitchenOps(native) {
  const { order, items, course, kind, bilingual = true, fontScale } = native || {};
  // SEPOS-PRINT-FONT-001 — kitchen/bar font scale (large = today). Item lines +
  // krule width both derive from it so bigger fonts don't wrap.
  const sz = kToken(fontScale);
  const kw = kWidth(fontScale);
  const sentBy = ((items || []).find(i => i && i.sent_by) || {}).sent_by || null; // SEPOS-SENTBY-001
  const ops = [];
  if (kind === 'fire-notice') {
    headerOps(ops, order, 'FIRE', kw);
    ops.push({ op: 'feed', v: 1 }, { op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' },
             { op: 'text', v: COURSE[course] || ('COURSE ' + course) }, { op: 'size', v: 'n' }, { op: 'bold', v: false },
             { op: 'align', v: 0 }, { op: 'feed', v: 2 }, { op: 'cut' });
    return ops;
  }
  if (kind === 'bar') {
    headerOps(ops, order, 'BAR', kw, sentBy);
    for (const it of (items || []).filter(i => i && !i.voided)) kitchenItemOps(ops, it, bilingual, sz);
    ops.push({ op: 'feed', v: 2 }, { op: 'cut' });
    return ops;
  }
  headerOps(ops, order, 'KITCHEN', kw, sentBy);
  const list = (items || []).filter(i => i && !i.voided && (course == null || (Number(i.course) || 1) === Number(course)));
  const byCourse = {};
  for (const it of list) { const c = Number(it.course) || 1; (byCourse[c] = byCourse[c] || []).push(it); }
  const courseKeys = Object.keys(byCourse).map(Number).sort((a, b) => a - b);
  courseKeys.forEach((c, idx) => {
    // Separator between courses so the chef can eye-scan where one course ends
    // and the next begins (matches the HTML/desktop ticket's rule between courses).
    if (idx > 0) ops.push({ op: 'krule', w: Math.min(kw, SUNMI_KITCHEN_WIDTH) });
    ops.push({ op: 'bold', v: true }, { op: 'text', v: COURSE[c] || ('COURSE ' + c) }, { op: 'bold', v: false });
    for (const it of byCourse[c]) kitchenItemOps(ops, it, bilingual, sz);
    ops.push({ op: 'feed', v: 1 });
  });
  ops.push({ op: 'feed', v: 1 }, { op: 'cut' });
  return ops;
}

// ── 📢 Kitchen message ticket → ops (SEPOS-ANDROID-004) ──────────────────────
// Built on-device so it prints on the built-in printer (UTF-8 → Thai messages
// render). Mirrors the server's distinctive message ticket: MESSAGE header,
// big table number, the text, who sent it.
export function buildKitchenMessageOps({ table_number, customer_name, message, waiter_name } = {}) {
  const ops = [];
  ops.push({ op: 'feed', v: 4 });
  ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: 'MESSAGE' }, { op: 'size', v: 'n' });
  if (table_number != null && table_number !== '') ops.push({ op: 'size', v: 'h' }, { op: 'text', v: 'TABLE ' + table_number }, { op: 'size', v: 'n' });
  else if (customer_name) ops.push({ op: 'size', v: 'b' }, { op: 'text', v: String(customer_name) }, { op: 'size', v: 'n' });
  ops.push({ op: 'bold', v: false }, { op: 'align', v: 0 }, { op: 'krule', w: SUNMI_KITCHEN_WIDTH });
  ops.push({ op: 'bold', v: true }, { op: 'size', v: 'b' }, { op: 'text', v: String(message || '') }, { op: 'size', v: 'n' }, { op: 'bold', v: false });
  if (waiter_name) ops.push({ op: 'feed', v: 1 }, { op: 'text', v: 'from ' + waiter_name });
  ops.push({ op: 'feed', v: 2 }, { op: 'cut' });
  return ops;
}

// ── Customer bill / receipt layout → ops ──────────────────────────────────────
export function buildReceiptOps({ order, items, settings, paymentDetails = {} }) {
  const s = settings || {};
  // company_name is authoritative once set — including blank (logo-only
  // receipts); legacy restaurant_name only covers pre-company_name installs.
  const name = (s.company_name !== undefined && s.company_name !== null)
    ? String(s.company_name).trim()
    : (String(s.restaurant_name || '').trim() || 'SiamEPOS');
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

  // SEPOS-PRINT-FONT-001 — receipt font scale (normal='r' = today, no regression).
  const rsz = bToken(s.receipt_font_scale);
  const rw  = bWidth(s.receipt_font_scale);
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
  ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' });
  if (name) ops.push({ op: 'text', v: name });
  ops.push({ op: 'size', v: 'r' }, { op: 'bold', v: false });
  if (addr)  ops.push({ op: 'text', v: addr });
  if (phone) ops.push({ op: 'text', v: 'Tel: ' + phone });
  if (vat)   ops.push({ op: 'text', v: 'VAT No: ' + vat });
  ops.push({ op: 'align', v: 0 }, { op: 'rule' });

  if (order && order.order_type && order.order_type !== 'dine_in') {
    // A walk-in takeaway rung up at the till sits on a takeaway "table", so it
    // carries a table_number — show "Takeaway N" (not "Online Order", which is
    // for website orders that have no table).
    const typeLabel = order.order_type === 'counter' ? 'Counter'
      : (order.order_type === 'takeaway' && order.table_number != null && order.table_number !== '')
        ? `Takeaway ${order.table_number}`
        : 'Online Order';
    ops.push({ op: 'row', l: 'Type', r: typeLabel });
    if (order.customer_name) ops.push({ op: 'row', l: 'Customer', r: order.customer_name });
  } else {
    // Table number BIG + bold + centred so it's obvious at a glance.
    ops.push({ op: 'align', v: 1 }, { op: 'bold', v: true }, { op: 'size', v: 'b' },
             { op: 'text', v: (order && order.table_label && String(order.table_label).trim()) ? String(order.table_label).trim().toUpperCase() : `TABLE ${(order && (order.table_number ?? order.table_id)) ?? '-'}` },
             { op: 'size', v: 'r' }, { op: 'bold', v: false }, { op: 'align', v: 0 });
    ops.push({ op: 'row', l: 'Covers', r: String((order && order.covers) || '-') });
  }
  ops.push({ op: 'row', l: 'Date', r: date }, { op: 'row', l: 'Time', r: time });
  if (order && order.id != null) ops.push({ op: 'row', l: 'Order #', r: String(order.id) });
  // Bold from here down (items + totals) so the receipt body prints thick.
  ops.push({ op: 'rule' }, { op: 'bold', v: true });

  // Flat item list (no course headers). Merge identical order-items (same dish +
  // options + price, no discount) into one "N x" line — separate sends of the
  // same item must not print as multiple 1x rows.
  const active = (items || []).filter(i => !i.voided);
  const aggMap = new Map(), aggList = [];
  for (const it of active) {
    if (Number(it.discount_value) > 0) { aggList.push({ ...it, quantity: Number(it.quantity) || 0 }); continue; }
    const key = [it.menu_item_id, it.name || it.item_name, it.notes || '', it.item_note || '', it.unit_price].join('|');
    if (aggMap.has(key)) aggMap.get(key).quantity += (Number(it.quantity) || 0);
    else { const e = { ...it, quantity: Number(it.quantity) || 0 }; aggMap.set(key, e); aggList.push(e); }
  }
  for (const it of aggList) {
    const itemTotal = (it.quantity || 0) * (it.unit_price || 0);
    let price = itemTotal;
    if (it.discount_type === 'percent') price = itemTotal * (1 - (it.discount_value || 0) / 100);
    if (it.discount_type === 'fixed')   price = Math.max(0, itemTotal - (it.discount_value || 0));
    ops.push({ op: 'row', l: `${it.quantity}x ${it.name || it.item_name || 'Item'}`, r: money(price) });
    if (it.notes) ops.push({ op: 'text', v: '   ' + it.notes });
  }
  ops.push({ op: 'rule' });
  ops.push({ op: 'row', l: 'Subtotal', r: money(subtotal) });
  if (discountAmount > 0) ops.push({ op: 'row', l: 'Discount' + (paymentDetails.discountLabel || ''), r: '-' + money(discountAmount) });
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
  // SEPOS-PRINT-FONT-001 — apply the receipt scale uniformly: the compact 'r'
  // body font → the scaled token, and rows/rules carry the matching (narrower)
  // width so a bigger font doesn't wrap. normal = no-op (rsz='r', rw=36).
  if (rsz !== 'r' || rw !== SUNMI_BILL_WIDTH) {
    for (const o of ops) {
      if (o.op === 'size' && o.v === 'r') o.v = rsz;
      else if (o.op === 'row' || o.op === 'rule') o.w = rw;
    }
  }
  return ops;
}

// Map abstract ops → Sunmi plugin ops: size tokens → px; rows/rules → padded text
// at the Sunmi bill width (fills the 80mm at the compact font).
export function opsForSunmi(ops) {
  const out = [];
  for (const o of ops) {
    if (o.op === 'size') out.push({ op: 'size', v: SUNMI_SIZE[o.v] || SUNMI_SIZE.n });
    else if (o.op === 'row') out.push({ op: 'text', v: pad(o.l, o.r, o.w || SUNMI_BILL_WIDTH) });
    else if (o.op === 'rule') out.push({ op: 'text', v: '-'.repeat(o.w || SUNMI_BILL_WIDTH) });
    else if (o.op === 'krule') out.push({ op: 'text', v: '-'.repeat(o.w || SUNMI_KITCHEN_WIDTH) });
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
      case 'krule': enc('-'.repeat(WIDTH)); b.push(LF); break;
      case 'feed':  for (let i = 0; i < (o.v || 1); i++) b.push(LF); break;
      case 'cut':   b.push(GS, 0x56, 0x42, 0x00); break;
    }
  }
  let s = ''; for (const x of b) s += String.fromCharCode(x & 0xFF);
  return btoa(s);
}
