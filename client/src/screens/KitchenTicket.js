/**
 * SiamEPOS Kitchen Ticket — SEPOS-026
 * Two exported functions:
 *
 *  printFullOrderTicket({ order, items })
 *    Called on "Send Order" — prints ALL courses on one combined ticket.
 *    Respects kitchen_print_mode: 'print'|'both' → print; 'kds' → skip.
 *
 *  printKitchenTicket({ order, items, course })
 *    Called when a specific course is fired — prints that course only.
 *    Also respects kitchen_print_mode.
 *
 * Print priority (both functions):
 *  1. Server-side ESC/POS via TCP (SEPOS-025/026) — requires printer_kitchen_ip.
 *  2. Electron silent print — desktop app only.
 *  3. Browser popup fallback — Chrome / iPad.
 *
 * kitchen_print_mode setting values:
 *  'print' — hardware printer only  (default)
 *  'kds'   — KDS screen only, no print at all
 *  'both'  — print AND KDS
 */

import { serverPrintKitchen, serverPrintKitchenFull, getSettings } from '../api';

const COURSE_LABELS_EN = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
const COURSE_LABELS_TH = { 1: 'กับแกล้ม', 2: 'อาหารหลัก', 3: 'ของหวาน',  4: 'เพิ่มเติม' };

// ── Settings cache — re-fetched at most every 60 s ────────────────────────────
let _settingsCache   = null;
let _settingsFetched = false;
async function getCachedSettings() {
  if (_settingsFetched) return _settingsCache;
  try { _settingsCache = await getSettings(); } catch {}
  _settingsFetched = true;
  setTimeout(() => { _settingsFetched = false; }, 60000);
  return _settingsCache;
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Should we print? (returns false in KDS-only mode) ─────────────────────────
function shouldPrint(settings) {
  const mode = (settings && settings.kitchen_print_mode) || 'print';
  return mode !== 'kds'; // 'print' or 'both' → yes; 'kds' → no
}

// ── Open browser popup and trigger print dialog ───────────────────────────────
function openPrintPopup(html) {
  const win = window.open('', '_blank', 'width=400,height=600,scrollbars=yes');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => {
    win.focus();
    win.print();
    win.onafterprint = () => win.close();
  }, 300);
}

// ── Core dispatcher — tries server → Electron → popup ────────────────────────
async function dispatchPrint({ settings, serverFn, html }) {
  if (!shouldPrint(settings)) return; // KDS-only mode — do nothing

  // 1. Server-side network print
  try {
    if (settings && settings.printer_kitchen_ip) {
      const r = await serverFn();
      if (r && r.success) return;
      console.warn('[kitchen-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[kitchen-ticket] server print error, falling back:', e);
  }

  // 2. Electron silent print
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_printer_name')) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  if (deviceName && autoOn && window.siamepos?.isElectron && window.siamepos.printHtml) {
    window.siamepos.printHtml({ html, deviceName })
      .then(r => { if (!r || !r.success) console.error('[kitchen-ticket] print failed:', r?.error); })
      .catch(e => console.error('[kitchen-ticket] print error:', e));
    return;
  }

  // 3. Browser popup fallback
  if (!autoOn) return;
  openPrintPopup(html);
}

// ── Public: print ALL courses on one ticket (called on Send Order) ────────────
export async function printFullOrderTicket({ order, items }) {
  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) return;

  const settings = await getCachedSettings();
  const copies   = Math.max(1, Math.min(5,
    parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_print_copies')) || '1', 10) || 1
  ));

  await dispatchPrint({
    settings,
    serverFn: () => serverPrintKitchenFull(order.id, active),
    html:     buildFullOrderTicketHTML({ order, items: active, copies }),
  });
}

// ── Public: print a single course (called when a course is fired) ─────────────
export async function printKitchenTicket({ order, items, course }) {
  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) return;

  const settings = await getCachedSettings();
  const copies   = Math.max(1, Math.min(5,
    parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_print_copies')) || '1', 10) || 1
  ));

  await dispatchPrint({
    settings,
    serverFn: () => serverPrintKitchen(order.id, active, course),
    html:     buildKitchenTicketHTML({ order, items: active, course, copies }),
  });
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function ticketCSS() {
  return `
    *    { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; width:80mm; padding:4mm 3mm; }
    @media print { @page { margin:0; size:80mm auto; } body { padding:3mm 2mm; } }
    .page       { }
    .break      { page-break-after:always; }
    .head   { text-align:center; font-size:24px; font-weight:900; letter-spacing:1px; }
    .sub    { text-align:center; font-size:13px; margin-top:2px; }
    .course-en  { text-align:center; font-size:16px; font-weight:700; margin-top:6px; }
    .course-th  { text-align:center; font-size:14px; font-weight:600; margin-top:1px; color:#333; }
    .rule   { border-top:2px dashed #000; margin:8px 0; }
    .rule-solid { border-top:2px solid #000; margin:8px 0; }
    .item   { display:flex; gap:8px; align-items:baseline; margin:7px 0; }
    .qty    { font-size:22px; font-weight:900; min-width:42px; }
    .name   { font-size:20px; font-weight:800; line-height:1.2; }
    .note   { font-size:14px; font-weight:700; margin:-2px 0 6px 50px; }
    .foot   { text-align:center; font-size:13px; font-weight:700; margin-top:6px; }
  `;
}

function itemsHTML(items) {
  return items.map(i => `
    <div class="item">
      <span class="qty">${Number(i.quantity) || 1}×</span>
      <span class="name">${esc(i.name || i.item_name || 'Item')}</span>
    </div>
    ${i.notes ? `<div class="note">▸ ${esc(i.notes)}</div>` : ''}
  `).join('');
}

// Single-course ticket body
function buildSingleCourseBody({ order, items, course }) {
  const heading     = orderHeading(order);
  const courseEN    = COURSE_LABELS_EN[course] || 'ITEMS';
  const courseTH    = COURSE_LABELS_TH[course] || '';
  const now         = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const customer    = order?.customer_name ? `<div class="sub">${esc(order.customer_name)}</div>` : '';

  return `
    <div class="head">${esc(heading)}</div>
    <div class="course-en">${courseEN}</div>
    ${courseTH ? `<div class="course-th">${courseTH}</div>` : ''}
    ${customer}
    <div class="rule"></div>
    ${itemsHTML(items)}
    <div class="rule"></div>
    <div class="foot">${now} &middot; Order #${order?.id ?? '—'}</div>
  `;
}

// Full-order ticket body (all courses grouped)
function buildFullOrderBody({ order, items }) {
  const heading  = orderHeading(order);
  const now      = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const customer = order?.customer_name ? `<div class="sub">${esc(order.customer_name)}</div>` : '';

  // Group by course
  const byCourse = {};
  items.forEach(i => {
    const c = i.course || 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(i);
  });

  const courseKeys = Object.keys(byCourse).sort();
  const courseBlocks = courseKeys.map((c, idx) => `
    <div class="course-en">${COURSE_LABELS_EN[c] || 'ITEMS'}</div>
    ${COURSE_LABELS_TH[c] ? `<div class="course-th">${COURSE_LABELS_TH[c]}</div>` : ''}
    <div class="rule"></div>
    ${itemsHTML(byCourse[c])}
    ${idx < courseKeys.length - 1 ? '<div class="rule-solid"></div>' : ''}
  `).join('');

  return `
    <div class="head">${esc(heading)}</div>
    ${customer}
    <div class="rule"></div>
    ${courseBlocks}
    <div class="rule"></div>
    <div class="foot">${now} &middot; Order #${order?.id ?? '—'}</div>
  `;
}

function buildKitchenTicketHTML({ order, items, course, copies = 1 }) {
  const body  = buildSingleCourseBody({ order, items, course });
  const pages = multiPage(body, copies);
  return wrapHTML(pages);
}

function buildFullOrderTicketHTML({ order, items, copies = 1 }) {
  const body  = buildFullOrderBody({ order, items });
  const pages = multiPage(body, copies);
  return wrapHTML(pages);
}

function orderHeading(order) {
  if (!order) return 'ORDER';
  if (order.order_type === 'takeaway') {
    return order.order_subtype === 'delivery'
      ? `DELIVERY #${order.id}`
      : `TAKEAWAY #${order.id}`;
  }
  return `TABLE ${order.table_number != null ? order.table_number : '—'}`;
}

function multiPage(body, copies) {
  return Array.from({ length: copies }, (_, i) => `
    <div class="page${i < copies - 1 ? ' break' : ''}">
      ${body}
      <div style="height:12mm;"></div>
    </div>
  `).join('');
}

function wrapHTML(pages) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${ticketCSS()}</style>
</head>
<body>${pages}</body>
</html>`;
}
