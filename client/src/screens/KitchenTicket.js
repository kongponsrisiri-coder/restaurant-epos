/**
 * SiamEPOS Kitchen Ticket — SEPOS-026
 * Prints an 80mm kitchen ticket silently to the kitchen printer when a
 * course is fired. Desktop app only — a kitchen printer must be chosen
 * in Admin → Settings → Printer and auto-print left on.
 */

const COURSE_LABELS = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRA' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function printKitchenTicket({ order, items, course }) {
  // Per-device config (the printer is wired to THIS machine).
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_printer_name')) || '';
  const autoOn = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  if (!deviceName || !autoOn) return;
  if (!(window.siamepos && window.siamepos.isElectron && window.siamepos.printHtml)) return;

  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) return;

  const html = buildKitchenTicketHTML({ order, items: active, course });
  window.siamepos.printHtml({ html, deviceName })
    .then(r => { if (!r || !r.success) console.error('[kitchen-ticket] print failed:', r && r.error); })
    .catch(e => console.error('[kitchen-ticket] print error:', e));
}

function buildKitchenTicketHTML({ order, items, course }) {
  const heading = order && order.order_type === 'takeaway'
    ? (order.order_subtype === 'delivery' ? `DELIVERY #${order.id}` : `TAKEAWAY #${order.id}`)
    : `TABLE ${order && order.table_number != null ? order.table_number : '—'}`;
  const courseLabel = COURSE_LABELS[course] || 'ITEMS';
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const customer = order && order.customer_name
    ? `<div class="sub">${esc(order.customer_name)}</div>` : '';

  const itemRows = items.map(i => `
    <div class="item">
      <span class="qty">${Number(i.quantity) || 1}×</span>
      <span class="name">${esc(i.name || i.item_name || 'Item')}</span>
    </div>
    ${i.notes ? `<div class="note">▸ ${esc(i.notes)}</div>` : ''}
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    *    { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; width:80mm; padding:4mm 3mm; }
    @media print { @page { margin:0; size:80mm auto; } body { padding:3mm 2mm; } }
    .head   { text-align:center; font-size:24px; font-weight:900; letter-spacing:1px; }
    .course { text-align:center; font-size:16px; font-weight:700; margin-top:2px; }
    .sub    { text-align:center; font-size:13px; margin-top:2px; }
    .rule   { border-top:2px dashed #000; margin:8px 0; }
    .item   { display:flex; gap:8px; align-items:baseline; margin:7px 0; }
    .qty    { font-size:22px; font-weight:900; min-width:42px; }
    .name   { font-size:20px; font-weight:800; line-height:1.2; }
    .note   { font-size:14px; font-weight:700; margin:-2px 0 6px 50px; }
    .foot   { text-align:center; font-size:13px; font-weight:700; margin-top:6px; }
  </style>
</head>
<body>
  <div class="head">${esc(heading)}</div>
  <div class="course">${courseLabel}</div>
  ${customer}
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  <div class="foot">${now} &middot; Order #${order && order.id != null ? order.id : '—'}</div>
  <div style="height:12mm;"></div>
</body>
</html>`;
}
