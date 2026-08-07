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

import { serverPrintKitchen, serverPrintKitchenFull, serverPrintBar, serverPrintFireNotice, getSettings, getKitchenTicketBuffer, getPrinters, getMenu } from '../api';
import { isNativeApp, sendRawToPrinter } from '../native/printer';
import { sunmiAvailable, sunmiPrintOps, printTarget } from '../native/sunmiPrinter';
import { buildKitchenOps, opsForSunmi, renderOpsToBytes } from '../native/escpos';

const COURSE_LABELS_EN = { 1: 'STARTERS', 2: 'MAINS', 3: 'DESSERTS', 4: 'EXTRAS' };
const COURSE_LABELS_TH = { 1: 'กับแกล้ม', 2: 'อาหารหลัก', 3: 'ของหวาน',  4: 'เพิ่มเติม' };

// ── Settings cache — re-fetched at most every 60 s ────────────────────────────
let _settingsCache   = null;
let _settingsFetched = false;
async function getCachedSettings() {
  if (_settingsFetched) return _settingsCache;
  let result = null;
  try { result = await getSettings(); } catch {}
  // M4 fix — only cache a GOOD result. api.js resolves with {error} on an HTTP
  // failure (it does NOT throw), so a transient 500 would otherwise poison the
  // cache with a useless object for 60s and every kitchen ticket in that window
  // would print with no printer settings. On failure leave the cache untouched
  // and let the next print retry.
  if (result && typeof result === 'object' && !result.error) {
    _settingsCache = result;
    _settingsFetched = true;
    setTimeout(() => { _settingsFetched = false; }, 5000); // short TTL so print-routing changes take effect quickly
  }
  return _settingsCache;
}

// ── SEPOS-STATION-001 — resolve each item to its printer station ──────────────
// A category can be routed to an extra printer station (categories.printer_id).
// We map menu_item_id → category.printer_id via the cached menu, and look up the
// station (ip/port/copies) from getPrinters(). Both cached ~10s. Returns
// { def: [items with no station], stations: [{ printer, items }] }.
// If there are NO active stations OR NO item is assigned, everything lands in
// `def` and the caller behaves exactly as today (migration-safe).
let _stationCache = null, _stationAt = 0;
let _menuPrinterMap = null, _menuMapAt = 0;
async function getStationRouting() {
  const now = Number(new Date());
  if (!_stationCache || now - _stationAt > 10000) {
    try { const p = await getPrinters(); if (Array.isArray(p)) { _stationCache = p; _stationAt = now; } }
    catch {}
  }
  if (!_menuPrinterMap || now - _menuMapAt > 10000) {
    try {
      const menu = await getMenu();
      if (Array.isArray(menu)) {
        const m = new Map();
        for (const cat of menu) {
          const pid = cat && cat.printer_id != null ? Number(cat.printer_id) : null;
          // SEPOS-STATION-003 — a dish-level printer_id overrides the category
          // route (same inherit pattern as default_course).
          for (const it of (cat.items || [])) if (it && it.id != null) {
            m.set(it.id, it.printer_id != null ? Number(it.printer_id) : pid);
          }
        }
        _menuPrinterMap = m; _menuMapAt = now;
      }
    } catch {}
  }
  return { stations: _stationCache || [], menuMap: _menuPrinterMap || new Map() };
}
async function splitByStation(items) {
  const { stations, menuMap } = await getStationRouting();
  const byId = new Map(stations.filter(s => s && s.ip).map(s => [Number(s.id), s]));
  const def = [], groups = new Map();
  for (const it of items) {
    const pid = menuMap.get(it.menu_item_id);
    const station = pid != null ? byId.get(Number(pid)) : null;
    if (station) {
      if (!groups.has(station.id)) groups.set(station.id, { printer: station, items: [] });
      groups.get(station.id).items.push(it);
    } else def.push(it);
  }
  return { def, stations: [...groups.values()] };
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
  // Native app (Sunmi/Android) never opens system Chrome — it prints via the
  // built-in/network path (dispatchPrint step 0). This is a hard backstop so a
  // fallthrough can't pop a browser window on the till.
  if (isNativeApp()) { try { closeWin(preWin); } catch {} return; }
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

// ── SEPOS-ANDROID-001 — native (Android) print path ──────────────────────────
// On the native app the FIRING device pushes the server-built ESC/POS buffer
// straight to the LAN printer's TCP port — the cloud can't reach it. Bytes come
// from the same printService builders as the desktop, so the ticket is
// byte-identical. `native` = { order_id, items?, course?, kind }. Returns true
// when it handled the print (so the dispatcher stops), false to fall through.
async function nativeKitchenPrint({ native, copies = 1, ip, port, target = 'auto', settings = {} }) {
  if (target === 'off') return;   // operator routed this ticket type to "off"

  // Resolve the destination, then render the SAME layout the right way:
  // built-in → Sunmi printText (UTF-8: £ + Thai); network → raw ESC/POS bytes.
  let dest = null;
  const sunmiOk = (target === 'builtin' || target === 'auto') ? await sunmiAvailable() : false;
  if (sunmiOk) dest = 'builtin';
  else if ((target === 'network' || target === 'auto') && ip) dest = 'network';
  if (!dest) { console.warn('[kitchen-ticket] native: no printer for target', target); return; }

  // SEPOS-PRINT-FONT-001 — per-role font scale: bar tickets use bar_font_scale,
  // everything else (kitchen + fire notice) uses kitchen_font_scale (default 'large' = today).
  const fontScale = (native && native.kind === 'bar')
    ? (settings.bar_font_scale || 'large')
    : (settings.kitchen_font_scale || 'large');
  let ops = null;
  try { ops = buildKitchenOps({ ...native, fontScale }); } catch (e) { console.warn('[kitchen-ticket] build error:', e?.message); }
  if (!ops) return;

  const copyN = Math.max(1, copies);
  try {
    for (let i = 0; i < copyN; i++) {
      if (dest === 'builtin') await sunmiPrintOps(opsForSunmi(ops));
      else await sendRawToPrinter(ip, port || 9100, renderOpsToBytes(ops, { thaiCp: settings.kitchen_thai_codepage }));
    }
  } catch (e) { console.warn('[kitchen-ticket] print error:', e?.message); }
}

// ── Core dispatcher — tries server → Electron → popup ────────────────────────
// popupWin: a pre-opened window (opened synchronously before any awaits in
// the calling code). Closed when server/Electron handles print; used for popup
// fallback so the window.open() bypass is preserved.
async function dispatchPrint({ settings, serverFn, html, copies = 1, popupWin = null, native = null }) {
  if (!shouldPrint(settings)) { closeWin(popupWin); return; }

  // 0. Native Android app — the firing device pushes the buffer to the kitchen
  // printer itself (single-printer Sunmi falls back to the receipt printer IP).
  if (native && isNativeApp()) {
    closeWin(popupWin);
    const route = native.kind === 'bar' ? 'bar' : 'kitchen';
    const ip   = settings?.[`printer_${route}_ip`]   || settings?.printer_receipt_ip;
    const port = settings?.[`printer_${route}_port`] || settings?.printer_receipt_port || 9100;
    await nativeKitchenPrint({ native, copies, ip, port, target: printTarget(settings, route), settings });
    return;
  }

  // Desktop's chosen kitchen device — falls back to the receipt printer for
  // single-printer setups. SEPOS-058: when set with no IP, print via the
  // server's raw ESC/POS path (crisp black + silent) like the receipt does;
  // the HTML/GDI path below prints faint grey on thermal units.
  const deviceName = (typeof localStorage !== 'undefined' &&
    (localStorage.getItem('kitchen_printer_name') || localStorage.getItem('receipt_printer_name'))) || '';
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  const usbName    = (!settings?.printer_kitchen_ip && deviceName && window.siamepos?.isElectron) ? deviceName : null;

  // 1. Server-side ESC/POS — network IP, or USB-by-name on the desktop.
  // Backend reads settings.printer_kitchen_copies and loops by itself.
  try {
    if ((settings && settings.printer_kitchen_ip) || usbName) {
      const r = await serverFn(usbName || undefined, copies);
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[kitchen-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[kitchen-ticket] server print error, falling back:', e);
  }

  // 2. Electron silent HTML print (fallback if the raw path errors) — must
  // pass copies; Electron's printHtml accepts { copies } and loops internally.
  if (deviceName && autoOn && window.siamepos?.isElectron && window.siamepos.printHtml) {
    closeWin(popupWin); // Electron prints — no popup needed
    window.siamepos.printHtml({ html, deviceName, copies })
      .then(r => { if (!r || !r.success) console.error('[kitchen-ticket] print failed:', r?.error); })
      .catch(e => console.error('[kitchen-ticket] print error:', e));
    return;
  }

  // 3. Browser popup fallback — copies via successive openings, since the
  // browser print dialog only fires once per window. Stagger to give each
  // window time to render before triggering its own print.
  if (!autoOn) { closeWin(popupWin); return; }
  openPrintPopup(html, popupWin);
  for (let i = 1; i < copies; i++) {
    setTimeout(() => openPrintPopup(html, null), i * 800);
  }
}

// Resolve the effective number of copies. Network Printers card (new,
// shared via settings table) wins over the legacy "Printer (this device)"
// card (per-device localStorage). Both are clamped to 1-5 to defend
// against an operator hammering "9" in dev tools.
function resolveKitchenCopies(settings) {
  const fromSettings = settings && parseInt(settings.printer_kitchen_copies, 10);
  if (fromSettings && fromSettings > 0) return Math.max(1, Math.min(5, fromSettings));
  if (typeof localStorage === 'undefined') return 1;
  const fromLocal = parseInt(localStorage.getItem('kitchen_print_copies') || '1', 10);
  return Math.max(1, Math.min(5, fromLocal || 1));
}

// ── Public: print ALL courses on one ticket (called on Send Order) ────────────
// popupWin: pre-opened window from the calling code (to beat popup blocker).
export async function printFullOrderTicket({ order, items, popupWin = null }) {
  const active = (items || []).filter(i => i && !i.voided && !i.is_bar);
  if (active.length === 0) { closeWin(popupWin); return; }

  const settings = await getCachedSettings();
  const copies   = resolveKitchenCopies(settings);
  const bilingual = isBilingual(settings);

  // SEPOS-STATION-001 — station routing runs ONLY on a native till, which can
  // TCP straight to each station's IP. Browser/desktop tills reach a network
  // printer only via the server (no per-station dine-in endpoint yet), so they
  // keep today's single-kitchen behaviour. No stations assigned ⇒ native also
  // behaves exactly as today (split.stations is empty → the unchanged path).
  let split = { def: active, stations: [] };
  if (isNativeApp()) { try { split = await splitByStation(active); } catch { split = { def: active, stations: [] }; } }

  if (split.stations.length === 0) {
    await dispatchPrint({
      settings,
      serverFn: (pn, cp) => serverPrintKitchenFull(order.id, active, pn, cp),
      html:     buildFullOrderTicketHTML({ order, items: active, copies, bilingual, fontScale: kitchenFs(settings) }),
      copies,
      popupWin,
      native:   { order, items: active, kind: 'full', bilingual },
    });
    return;
  }

  // Native + stations: one ticket per printer, sent straight to each IP.
  closeWin(popupWin);
  if (!shouldPrint(settings)) return;
  const kIp   = settings.printer_kitchen_ip || settings.printer_receipt_ip;
  const kPort = settings.printer_kitchen_port || settings.printer_receipt_port || 9100;
  if (split.def.length) {
    await nativeKitchenPrint({ native: { order, items: split.def, kind: 'full', bilingual }, ip: kIp, port: kPort, copies, target: printTarget(settings, 'kitchen'), settings });
  }
  for (const g of split.stations) {
    const cp = Math.max(1, Math.min(5, parseInt(g.printer.copies, 10) || copies));
    await nativeKitchenPrint({ native: { order, items: g.items, kind: 'full', bilingual }, ip: g.printer.ip, port: g.printer.port || 9100, copies: cp, target: 'network', settings });
  }
}

// ── Public: print a single course (called when a course is fired) ─────────────
// popupWin must be pre-opened by the caller before any awaits.
export async function printKitchenTicket({ order, items, course, popupWin = null }) {
  const active = (items || []).filter(i => i && !i.voided);
  if (active.length === 0) { closeWin(popupWin); return; }

  const settings = await getCachedSettings();
  const copies   = resolveKitchenCopies(settings);
  const bilingual = isBilingual(settings);

  await dispatchPrint({
    settings,
    serverFn: (pn, cp) => serverPrintKitchen(order.id, active, course, pn, cp),
    html:     buildKitchenTicketHTML({ order, items: active, course, copies, bilingual, fontScale: kitchenFs(settings) }),
    copies,
    popupWin,
    native:   { order, items: active, course, kind: 'course', bilingual },
  });
}

// ── Public: fire notice — "TABLE X / FIRE MAINS" call card, no item list ──────
// Called when chef fires a course. Server prints via TCP; popup fallback
// shows a minimal notice page.
export async function printFireNoticeTicket({ order, course, popupWin = null }) {
  const settings = await getCachedSettings();

  // 0. Native Android — firing device pushes the fire-notice to the LAN printer.
  if (isNativeApp()) {
    closeWin(popupWin);
    if (!shouldPrint(settings)) return;
    const ip   = settings?.printer_kitchen_ip   || settings?.printer_receipt_ip;
    const port = settings?.printer_kitchen_port || settings?.printer_receipt_port || 9100;
    await nativeKitchenPrint({ native: { order, course, kind: 'fire-notice' }, ip, port, target: printTarget(settings, 'kitchen'), settings });
    return;
  }

  const deviceName = (typeof localStorage !== 'undefined' &&
    (localStorage.getItem('kitchen_printer_name') || localStorage.getItem('receipt_printer_name'))) || '';
  const usbName    = (!settings?.printer_kitchen_ip && deviceName && window.siamepos?.isElectron) ? deviceName : null;

  // 1. Server-side ESC/POS — network IP, or USB-by-name on the desktop.
  try {
    if ((settings && settings.printer_kitchen_ip) || usbName) {
      const r = await serverPrintFireNotice(order.id, course, usbName || undefined);
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[fire-notice] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[fire-notice] server print error, falling back:', e);
  }

  // 2. Electron silent print (fallback)
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

  // 0. Native Android — firing device pushes bar items to the bar printer
  // (falls back to kitchen, then receipt, for single-printer setups).
  if (isNativeApp()) {
    closeWin(popupWin);
    if (!shouldPrint(settings)) return;
    const ip   = settings?.printer_bar_ip   || settings?.printer_kitchen_ip   || settings?.printer_receipt_ip;
    const port = settings?.printer_bar_port || settings?.printer_kitchen_port || settings?.printer_receipt_port || 9100;
    await nativeKitchenPrint({ native: { order, items: barItems, kind: 'bar', bilingual }, ip, port, target: printTarget(settings, 'bar'), settings });
    return;
  }

  const deviceName = (typeof localStorage !== 'undefined' &&
    (localStorage.getItem('bar_printer_name') || localStorage.getItem('kitchen_printer_name') || localStorage.getItem('receipt_printer_name'))) || '';
  const usbName    = (!settings?.printer_bar_ip && deviceName && window.siamepos?.isElectron) ? deviceName : null;

  // 1. Server-side ESC/POS — bar printer IP, or USB-by-name on the desktop.
  try {
    if ((settings && settings.printer_bar_ip) || usbName) {
      const r = await serverPrintBar(order.id, barItems, usbName || undefined);
      if (r && r.success) { closeWin(popupWin); return; }
      console.warn('[bar-ticket] server print failed, falling back:', r?.error || r?.reason);
    }
  } catch (e) {
    console.warn('[bar-ticket] server print error, falling back:', e);
  }

  // 2. Electron silent print to bar printer device (fallback)
  const autoOn     = typeof localStorage === 'undefined' || localStorage.getItem('kitchen_auto_print') !== '0';
  const html       = buildKitchenTicketHTML({ order, items: barItems, course: 4, copies: 1, bilingual, fontScale: kitchenFs(settings, 'bar') });

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

// SEPOS-PRINT-FONT-001 — fs is the kitchen font multiplier (1 = today, no
// regression). Applied to the ticket content sizes so the HTML/Electron kitchen
// print matches the picker. Default caller passes 1 for 'large' (= today's px).
function ticketCSS(fs = 1) {
  const px = (n) => `${Math.round(n * fs)}px`;
  return `
    *    { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; width:80mm; padding:4mm 3mm; }
    @media print { @page { margin:0; size:80mm auto; } body { padding:3mm 2mm; } }
    .page       { }
    .break      { page-break-after:always; }
    .head   { text-align:center; font-size:${px(24)}; font-weight:900; letter-spacing:1px; }
    .sub    { text-align:center; font-size:13px; margin-top:2px; }
    .course-en  { text-align:center; font-size:${px(16)}; font-weight:700; margin-top:6px; }
    .course-th  { text-align:center; font-size:${px(14)}; font-weight:600; margin-top:1px; color:#333; }
    .rule   { border-top:2px dashed #000; margin:8px 0; }
    .rule-solid { border-top:2px solid #000; margin:8px 0; }
    .item   { display:flex; gap:8px; align-items:baseline; margin:7px 0; }
    .qty    { font-size:${px(22)}; font-weight:900; min-width:42px; }
    .name   { font-size:${px(20)}; font-weight:900; line-height:1.2; -webkit-text-stroke:0.35px currentColor; }
    /* Modifier line + second-language line print at the same size as
       the primary item name (Korakot 2026-06-07). */
    .note     { font-size:${px(20)}; font-weight:800; margin:-2px 0 6px 50px; line-height:1.2; }
    .note-alt { font-size:${px(20)}; font-weight:800; margin:-4px 0 4px 50px; line-height:1.2; color:#333; }
    .delivery { margin:6px 0; padding:6px 4px; border-top:1px dashed #000; border-bottom:1px dashed #000; }
    .delivery-label { font-size:14px; font-weight:800; text-align:center; margin-bottom:4px; letter-spacing:1px; }
    .delivery div   { font-size:16px; font-weight:800; line-height:1.3; }
    .cust-note { font-size:18px; font-weight:800; text-align:center; margin:6px 0; padding:4px 0; line-height:1.3; }
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
  const phone    = order?.customer_phone ? `<div class="sub">${esc(order.customer_phone)}</div>` : '';
  // SEPOS-046c — delivery orders show the address in bold under the customer name.
  const delivery = (order?.order_subtype === 'delivery' && order?.delivery_address)
    ? `<div class="delivery">
         <div class="delivery-label">— DELIVERY —</div>
         ${String(order.delivery_address).split(',').map(s => s.trim()).filter(Boolean)
            .map(line => `<div>${esc(line)}</div>`).join('')}
       </div>`
    : '';
  // SEPOS-046d/g — customer's order-level note in big bold so the chef
  // notices. Reads `notes` (real-time socket payload) or `customer_note`
  // (DB on reprint).
  const noteText = order?.notes || order?.customer_note;
  const orderNote = noteText
    ? `<div class="cust-note">** ${esc(String(noteText).slice(0, 80))} **</div>`
    : '';

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
    ${phone}
    ${delivery}
    ${orderNote}
    <div class="rule"></div>
    ${courseBlocks}
    <div class="rule"></div>
    <div class="foot">${now} &middot; Order #${order?.id ?? '—'}</div>
  `;
}

function buildKitchenTicketHTML({ order, items, course, copies = 1, bilingual = true, fontScale = 1 }) {
  const body  = buildSingleCourseBody({ order, items, course, bilingual });
  const pages = multiPage(body, copies);
  return wrapHTML(pages, fontScale);
}

function buildFullOrderTicketHTML({ order, items, copies = 1, bilingual = true, fontScale = 1 }) {
  const body  = buildFullOrderBody({ order, items, bilingual });
  const pages = multiPage(body, copies);
  return wrapHTML(pages, fontScale);
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
    // SEPOS-TAKEAWAY-TABLE — walk-in takeaway sits on a takeaway table, so
    // print its table number; website orders are tableless → use the id.
    const ref = order.table_number != null ? order.table_number : `#${order.id}`;
    return order.order_subtype === 'delivery'
      ? `DELIVERY #${order.id}`
      : `TAKEAWAY ${ref}`;
  }
  // Table NAME wins over the raw number ("Bar 2" is table_number 2) —
  // same rule as printService.tableHeading and orderLabel.dineTableLabel.
  const label = order.table_label && String(order.table_label).trim();
  if (label) return label.toUpperCase();
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

// SEPOS-PRINT-FONT-001 — HTML/Electron kitchen multiplier. Centred so the role's
// DEFAULT = today's px (kitchen default 'large' = ×1.0), no regression.
const HTML_FS_KITCHEN = { normal: 0.85, medium: 0.95, tall: 0.95, wide: 1.0, large: 1.0, xlarge: 1.2 };
// SEPOS-PRINT-FONT-002 — "WxH" tokens map to an approximate css scale by their
// dominant multiplier (browser print can't do independent char width/height).
const kitchenFs = (settings, role = 'kitchen') => {
  const scale = (settings && settings[`${role}_font_scale`]) || 'large';
  const m = /^([1-4])x([1-4])$/.exec(String(scale));
  if (m) { const x = Math.max(Number(m[1]), Number(m[2])); return x <= 1 ? 0.85 : x === 2 ? 1.0 : 1.2; }
  return HTML_FS_KITCHEN[scale] ?? 1;
};

function wrapHTML(pages, fs = 1) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${ticketCSS(fs)}</style>
</head>
<body>${pages}</body>
</html>`;
}
