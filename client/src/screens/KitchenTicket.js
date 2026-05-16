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

import { serverPrintKitchen, serverPrintKitchenFull, serverPrintBar, serverPrintFireNotice, getSettings } from '../api';

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

// ── Is bilingual mode on? ─────────────────────────────────────────────────────
function isBilingual(settings) {
  return (settings && settings.kitchen_language) !== 'en'; // default en_th
}

// ── Open browser popup and trigger print dialog ──────────────────────────────
// Accepts an optional pre-opened window (opened before async work to keep
// the browser's user-gesture context, preventing popup blocking).
function openPrintPopup(html, preWin = null) {
  const win = preWin || window.open('', '_blank', 'width=400,height=600,scrollbars=yes');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => {
    win.focus();
    win.print();
    win.onafterprint = () => win.close();
  }, 300);
}

function closeWin(win) { try { if (win && !win.closed) win.close(); } catch {} }

// ── Core dispatcher — tries server → Electron → popup ────────────────────────
// popupWin: a pre-opened window (opened synchronously before any awaits in
// the calling code). Closed when server/Electron handles print; used for popup
// fallback so the window.open() bypass is preserved.
async function dispatchPrint({ settings, serverFn, html, popupWin = null }) {
  if (!shouldPrint(settings)) { closeWin(popupWin); return; }

  // 1. Server-side network print
  try {
    if (settings && settings.printer_kitchen_ip) {
      const r = await serverFn();
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[kitchen-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[kitchen-ticket] server print error, falling back:', e);
  }

  // 2. Electron silent print
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_printer_name')) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  if (deviceName && autoOn && window.siamepos?.isElectron && window.siamepos.printHtml) {
    closeWin(popupWin); // Electron prints — no popup needed
    window.siamepos.printHtml({ html, deviceName })
      .then(r => { if (!r || !r.success) console.error('[kitchen-ticket] print failed:', r?.error); })
      .catch(e => console.error('[kitchen-ticket] print error:', e));
    return;
  }

  // 3. Browser popup fallback — use pre-opened window if available
  if (!autoOn) { closeWin(popupWin); return; }
  openPrintPopup(html, popupWin);
}

// ── Public: print ALL courses on one ticket (called on Send Order) ────────────
// popupWin: pre-opened window from the calling code (to beat popup blocker).
export async function printFullOrderTicket({ order, items, popupWin = null }) {
  const active = (items || []).filter(i => i && !i.voided && !i.is_bar);
  if (active.length === 0) { closeWin(popupWin); return; }

  const settings = await getCachedSettings();
  const copies   = Math.max(1, Math.min(5,
    parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_print_copies')) || '1', 10) || 1
  ));
  const bilingual = isBilingual(settings);

  await dispatchPrint({
    settings,
    serverFn: () => serverPrintKitchenFull(order.id, active),
    html:     buildFullOrderTicketHTML({ order, items: active, copies, bilingual }),
    popupWin,
  });
}

// ── Public: print a single course (called when a course is fired) ─────────────
// popupWin must be pre-opened by the caller before any awaits.
export async function printKitchenTicket({ order, items, course, popupWin = null }) {
  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) { closeWin(popupWin); return; }

  const settings = await getCachedSettings();
  const copies   = Math.max(1, Math.min(5,
    parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_print_copies')) || '1', 10) || 1
  ));
  const bilingual = isBilingual(settings);

  await dispatchPrint({
    settings,
    serverFn: () => serverPrintKitchen(order.id, active, course),
    html:     buildKitchenTicketHTML({ order, items: active, course, copies, bilingual }),
    popupWin,
  });
}

// ── Public: fire notice — "TABLE X / FIRE MAINS" call card, no item list ──────
// Called when chef fires a course. Server prints via TCP; popup fallback
// shows a minimal notice page.
export async function printFireNoticeTicket({ order, course, popupWin = null }) {
  const settings = await getCachedSettings();

  // 1. Server-side network print
  try {
    if (settings && settings.printer_kitchen_ip) {
      const r = await serverPrintFireNotice(order.id, course);
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[fire-notice] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[fire-notice] server print error, falling back:', e);
  }

  // 2. Electron silent print
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('kitchen_printer_name')) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  const bilingual  = isBilingual(settings);
  const html       = buildFireNoticeHTML({ order, course, bilingual });

  if (deviceName && autoOn && window.siamepos?.isElectron && window.siamepos.printHtml) {
    closeWin(popupWin);
    window.siamepos.printHtml({ html, deviceName })
      .then(r => { if (!r || !r.success) console.error('[fire-notice] print failed:', r?.error); })
      .catch(e => console.error('[fire-notice] print error:', e));
    return;
  }

  // 3. Browser popup fallback
  if (!autoOn) { closeWin(popupWin); return; }
  openPrintPopup(html, popupWin);
}

// ── Public: print bar items to bar printer (called on Send Order) ─────────────
// popupWin: pre-opened window from sendOrder (opened before async work so the
// browser does not block the popup as an unattended window.open call).
export async function printBarOrderTicket({ order, items, popupWin = null }) {
  const barItems = (items || []).filter(i => i && !i.voided && i.is_bar);
  if (barItems.length === 0) { closeWin(popupWin); return; }

  const settings = await getCachedSettings();
  const bilingual = isBilingual(settings);

  // 1. Server-side TCP to bar printer IP
  try {
    if (settings && settings.printer_bar_ip) {
      const r = await serverPrintBar(order.id, barItems);
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[bar-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[bar-ticket] server print error, falling back:', e);
  }

  // 2. Electron silent print to bar printer device
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('bar_printer_name')) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  const html       = buildKitchenTicketHTML({ order, items: barItems, course: 4, copies: 1, bilingual });

  if (deviceName && autoOn && window.siamepos?.isElectron && window.siamepos.printHtml) {
    closeWin(popupWin);
    window.siamepos.printHtml({ html, deviceName })
      .then(r => { if (!r || !r.success) console.error('[bar-ticket] print failed:', r?.error); })
      .catch(e => console.error('[bar-ticket] print error:', e));
    return;
  }

  // 3. Browser popup fallback — use pre-opened window so popup blocker is bypassed
  if (!autoOn) { closeWin(popupWin); return; }
  openPrintPopup(html, popupWin);
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
    .note     { font-size:14px; font-weight:700; margin:-2px 0 6px 50px; }
    .note-alt { font-size:15px; font-weight:700; margin:-4px 0 4px 50px; color:#333; }
    .foot   { text-align:center; font-size:13px; font-weight:700; margin-top:6px; }
  `;
}

function itemsHTML(items, bilingual = false) {
  return items.map(i => {
    const nameAlt = bilingual ? (i.name_alt || i.name_th || '') : '';
    return `
    <div class="item">
      <span class="qty">${Number(i.quantity) || 1}×</span>
      <span class="name">${esc(i.name || i.item_name || 'Item')}</span>
    </div>
    ${nameAlt ? `<div class="note-alt">${esc(nameAlt)}</div>` : ''}
    ${i.notes ? `<div class="note">▸ ${esc(i.notes)}</div>` : ''}
  `;
  }).join('');
}

// Single-course ticket body
function buildSingleCourseBody({ order, items, course, bilingual = true }) {
  const heading     = orderHeading(order);
  const courseEN    = COURSE_LABELS_EN[course] || 'ITEMS';
  const courseTH    = bilingual ? (COURSE_LABELS_TH[course] || '') : '';
  const now         = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const customer    = order?.customer_name ? `<div class="sub">${esc(order.customer_name)}</div>` : '';

  return `
    <div class="head">${esc(heading)}</div>
    <div class="course-en">${courseEN}</div>
    ${courseTH ? `<div class="course-th">${courseTH}</div>` : ''}
    ${customer}
    <div class="rule"></div>
    ${itemsHTML(items, bilingual)}
    <div class="rule"></div>
    <div class="foot">${now} &middot; Order #${order?.id ?? '—'}</div>
  `;
}

// Full-order ticket body (all courses grouped)
function buildFullOrderBody({ order, items, bilingual = true }) {
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
    ${bilingual && COURSE_LABELS_TH[c] ? `<div class="course-th">${COURSE_LABELS_TH[c]}</div>` : ''}
    <div class="rule"></div>
    ${itemsHTML(byCourse[c], bilingual)}
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

function buildKitchenTicketHTML({ order, items, course, copies = 1, bilingual = true }) {
  const body  = buildSingleCourseBody({ order, items, course, bilingual });
  const pages = multiPage(body, copies);
  return wrapHTML(pages);
}

function buildFullOrderTicketHTML({ order, items, copies = 1, bilingual = true }) {
  const body  = buildFullOrderBody({ order, items, bilingual });
  const pages = multiPage(body, copies);
  return wrapHTML(pages);
}

function buildFireNoticeHTML({ order, course, bilingual = true }) {
  const COURSE_LABELS_EN_LOCAL = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
  const COURSE_LABELS_TH_LOCAL = { 1: 'กับแกล้ม', 2: 'อาหารหลัก', 3: 'ของหวาน', 4: 'เพิ่มเติม' };
  const heading   = orderHeading(order);
  const courseEN  = COURSE_LABELS_EN_LOCAL[course] || 'COURSE';
  const courseTH  = bilingual ? (COURSE_LABELS_TH_LOCAL[course] || '') : '';
  const now       = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const css = `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; width:80mm; padding:6mm 3mm; text-align:center; }
    @media print { @page { margin:0; size:80mm auto; } body { padding:4mm 2mm; } }
    .head  { font-size:32px; font-weight:900; letter-spacing:1px; }
    .rule  { border-top:3px solid #000; margin:10px 0; }
    .fire  { font-size:48px; font-weight:900; letter-spacing:2px; margin:8px 0; }
    .course-en { font-size:28px; font-weight:900; }
    .course-th { font-size:20px; font-weight:700; color:#333; margin-top:4px; }
    .foot  { font-size:13px; font-weight:700; margin-top:10px; }
  `;

  const body = `
    <div class="head">${esc(heading)}</div>
    <div class="rule"></div>
    <div class="fire">🔥 FIRE</div>
    <div class="course-en">${courseEN}</div>
    ${courseTH ? `<div class="course-th">${courseTH}</div>` : ''}
    <div class="rule"></div>
    <div class="foot">${now} &middot; Order #${order?.id ?? '—'}</div>
    <div style="height:12mm;"></div>
  `;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${body}</body></html>`;
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
