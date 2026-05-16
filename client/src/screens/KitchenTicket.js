/**
 * SiamEPOS Kitchen Ticket — SEPOS-026
 * Prints an 80mm kitchen ticket when a course is fired.
 *
 * Print priority:
 *  1. Server-side ESC/POS (SEPOS-025/026) — works from iPad, browser,
 *     any device. Requires printer_kitchen_ip set in Admin → Settings.
 *  2. Electron silent print — desktop app only, chosen in Settings.
 * Supports 1–3 copies (controlled server-side via printer_kitchen_copies
 * setting, or client-side via localStorage `kitchen_print_copies`).
 */

import { serverPrintKitchen, getSettings } from '../api';

const COURSE_LABELS = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRA' };

// Cached settings so we don't hit /api/settings on every course fire
let _settingsCache = null;
let _settingsFetched = false;
async function getCachedSettings() {
  if (_settingsFetched) return _settingsCache;
  try { _settingsCache = await getSettings(); } catch {}
  _settingsFetched = true;
  // Re-fetch after 60s in case IP changes
  setTimeout(() => { _settingsFetched = false; }, 60000);
  return _settingsCache;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function printKitchenTicket({ order, items, course }) {
  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) return;

  // ── 1. Try server-side network print first ───────────────────────────────
  try {
    const settings = await getCachedSettings();
    if (settings && settings.printer_kitchen_ip) {
      const r = await serverPrintKitchen(order.id, active, course);
      if (r && r.success) return; // done — printed via TCP
      console.warn('[kitchen-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[kitchen-ticket] server print error, falling back:', e);
  }

  // ── 2. Electron silent print (desktop app) ───────────────────────────────
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_printer_name')) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  if (!deviceName || !autoOn) return;
  if (!(window.siamepos && window.siamepos.isElectron && window.siamepos.printHtml)) return;

  const copies = Math.max(1, Math.min(5,
    parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_print_copies')) || '1', 10) || 1
  ));
  const html = buildKitchenTicketHTML({ order, items: active, course, copies });
  window.siamepos.printHtml({ html, deviceName })
    .then(r => { if (!r || !r.success) console.error('[kitchen-ticket] print failed:', r && r.error); })
    .catch(e => console.error('[kitchen-ticket] print error:', e));
}

function buildTicketBody({ order, items, course }) {
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

  return `
  <div class="head">${esc(heading)}</div>
  <div class="course">${courseLabel}</div>
  ${customer}
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  <div class="foot">${now} &middot; Order #${order && order.id != null ? order.id : '—'}</div>
  `;
}

function buildKitchenTicketHTML({ order, items, course, copies = 1 }) {
  const body = buildTicketBody({ order, items, course });

  // Each copy separated by a page break so they print on separate tickets.
  const pages = Array.from({ length: copies }, (_, i) => `
    <div class="page${i < copies - 1 ? ' break' : ''}">
      ${body}
      <div style="height:12mm;"></div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    *    { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; width:80mm; padding:4mm 3mm; }
    @media print { @page { margin:0; size:80mm auto; } body { padding:3mm 2mm; } }
    .page       { }
    .break      { page-break-after:always; }
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
  ${pages}
</body>
</html>`;
}
