/**
 * SiamEPOS Receipt Printer — SEPOS-020 / SEPOS-025
 * Totals passed in from BillScreen — no recalculation.
 * Logo support via base64 stored in settings.
 *
 * Print priority:
 *  1. Server-side ESC/POS via TCP (SEPOS-025) — works from iPad, browser,
 *     any device on the same Wi-Fi. Requires printer_receipt_ip in settings.
 *  2. Electron silent print — desktop app only, printer chosen in Settings.
 *  3. Browser print dialog — universal fallback.
 */

import { serverPrintReceipt, getReceiptBuffer } from '../api';
import { isNativeApp, sendRawToPrinter } from '../native/printer';   // SEPOS-ANDROID-001
import { sunmiAvailable, sunmiPrintOps, printTarget } from '../native/sunmiPrinter';
import { buildReceiptOps, opsForSunmi, renderOpsToBytes } from '../native/escpos';

export function printReceipt({ order, items, settings, paymentDetails = {} }) {
  // ── 0. Native Android app — build the receipt ON-DEVICE (works offline) and
  // send it to the destination chosen in Admin → Printers (built-in Sunmi /
  // network / off). The cloud can't reach a LAN printer, so we never rely on it.
  if (isNativeApp()) {
    _nativePrintReceipt({ order, items, settings, paymentDetails })
      .catch((e) => {
        console.warn('[receipt] native print failed, falling back:', e?.message || e);
        _clientPrint({ order, items, settings, paymentDetails });
      });
    return;
  }
  // ── 1. Server-side print (ESC/POS — crisp black + silent) ─────────────────
  // Use it for a network printer (IP) OR — SEPOS-058 — a USB printer addressed
  // by name on the desktop. The HTML/GDI fallback (_clientPrint) prints faint
  // anti-aliased text on thermal units, so prefer the raw path whenever we have
  // a target. The desktop's chosen device lives in localStorage.receipt_printer_name.
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('receipt_printer_name')) || '';
  const usbName = (!settings.printer_receipt_ip && deviceName && window.siamepos?.isElectron) ? deviceName : null;
  if (settings.printer_receipt_ip || usbName) {
    serverPrintReceipt(order.id, paymentDetails, usbName || undefined)
      .then(r => {
        if (!r || !r.success) {
          console.warn('[receipt] server print failed, falling back:', r?.error || r?.reason);
          _clientPrint({ order, items, settings, paymentDetails });
        }
      })
      .catch(e => {
        console.warn('[receipt] server print error, falling back:', e);
        _clientPrint({ order, items, settings, paymentDetails });
      });
    return;
  }
  // ── 2 + 3. Client-side (Electron silent or browser popup) ────────────────
  _clientPrint({ order, items, settings, paymentDetails });
}

// SEPOS-ANDROID-002 — native receipt: on-device ESC/POS → built-in / network.
async function _nativePrintReceipt({ order, items, settings, paymentDetails }) {
  const target = printTarget(settings, 'receipt');
  if (target === 'off') return;                       // operator chose not to print the bill
  const ip = settings?.printer_receipt_ip;
  const port = settings?.printer_receipt_port || 9100;

  // Resolve destination first — the Thai code page differs per printer.
  let dest = null;
  const sunmiOk = (target === 'builtin' || target === 'auto') ? await sunmiAvailable() : false;
  if (sunmiOk) dest = 'builtin';
  else if ((target === 'network' || target === 'auto') && ip) dest = 'network';
  if (!dest) throw new Error('no printer for target ' + target);

  const ops = buildReceiptOps({ order, items, settings, paymentDetails });
  if (dest === 'builtin') { await sunmiPrintOps(opsForSunmi(ops)); return; } // UTF-8 + logo via printBitmap

  // Network: prefer the cloud-built buffer (rasterises the LOGO + exact format)
  // when reachable; fall back to on-device bytes (no logo) only when offline.
  try {
    const b = await getReceiptBuffer(order.id, paymentDetails);
    if (b && b.data) { await sendRawToPrinter(ip, port, b.data); return; }
  } catch { /* offline → on-device */ }
  await sendRawToPrinter(ip, port, renderOpsToBytes(ops, { thaiCp: settings?.kitchen_thai_codepage }));
}

function _clientPrint({ order, items, settings, paymentDetails }) {
  const html = buildReceiptHTML({ order, items, settings, paymentDetails });

  // SEPOS-025 — in the SiamEPOS desktop app, print silently (no dialog)
  // to the receipt printer chosen in Admin → Settings → Printer. If no
  // printer is chosen, or the silent print fails, fall back to the
  // browser print-dialog popup so a receipt is never lost.
  const deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('receipt_printer_name')) || '';
  if (deviceName && window.siamepos?.isElectron && window.siamepos.printHtml) {
    window.siamepos.printHtml({ html, deviceName })
      .then((r) => {
        if (!r || !r.success) {
          console.error('[receipt] silent print failed:', r && r.error);
          openPrintPopup(html);
        }
      })
      .catch((e) => {
        console.error('[receipt] silent print error:', e);
        openPrintPopup(html);
      });
    return;
  }
  openPrintPopup(html);
}

function openPrintPopup(html) {
  // Never open an external browser window on the native app (Sunmi/Android):
  // window.open launches system Chrome, which can't reach the thermal head and
  // just confuses the operator. Native printing goes via built-in/network only.
  if (isNativeApp()) { console.warn('[receipt] no printer available on native — skipping browser popup'); return; }
  const win = window.open('', '_blank', 'width=400,height=700,scrollbars=yes');
  if (!win) { alert('Pop-up blocked. Please allow pop-ups for this site to print receipts.'); return; }
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    setTimeout(() => {
      win.focus();
      win.print();
      win.onafterprint = () => win.close();
    }, 400);
  };
}

function fmt(n) { return '£' + parseFloat(n || 0).toFixed(2); }

function buildReceiptHTML({ order, items, settings, paymentDetails }) {
  const restaurantName  = settings?.company_name        || settings?.restaurant_name || 'SiamEPOS';
  const restaurantAddr  = settings?.company_address     || settings?.address         || '';
  const restaurantPhone = settings?.company_phone       || settings?.phone           || '';
  const restaurantVat   = settings?.company_vat         || '';
  const googleReviewUrl = settings?.google_review_url   || '';
  const footerMsg       = settings?.receipt_footer      || 'Thank you for dining with us!';
  const logoDataUrl     = settings?.company_logo        || '';  // base64 data URL
  const logoSizePx      = { small:'80px', medium:'150px', large:'220px', full:'100%' }[settings?.receipt_logo_size||'medium'];
  const scRate          = parseFloat(settings?.service_charge_rate || settings?.service_charge_percent || 12.5);

  const now  = new Date();
  const date = now.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // ── Use pre-calculated values from BillScreen ─────────────────
  const subtotal       = parseFloat(paymentDetails.subtotal       ?? 0);
  const discountAmount = parseFloat(paymentDetails.discountAmount ?? 0);
  const serviceCharge  = parseFloat(paymentDetails.serviceCharge  ?? 0);
  const tip            = parseFloat(paymentDetails.tip            ?? 0);
  const billTotal      = parseFloat(paymentDetails.billTotal      ?? (subtotal - discountAmount + serviceCharge + tip));
  const amountPaid     = parseFloat(paymentDetails.amountPaid     ?? billTotal);
  const change         = parseFloat(paymentDetails.change         ?? Math.max(0, amountPaid - billTotal));
  const method         = paymentDetails.method || '';

  // ── Items grouped by course ───────────────────────────────────
  const activeItems = (items || []).filter(i => !i.voided);
  const courseNames = { 1:'STARTERS', 2:'MAINS', 3:'DESSERTS', 4:'EXTRAS' };
  const byCourse = {};
  activeItems.forEach(item => {
    const c = item.course||1; if(!byCourse[c]) byCourse[c]=[];
    // Merge identical items (same dish + options + price, undiscounted) into one
    // "N x" line — separate sends of the same dish shouldn't be multiple 1x rows.
    if (Number(item.discount_value) > 0) { byCourse[c].push({ ...item, quantity: Number(item.quantity)||0 }); return; }
    const key = [item.menu_item_id, item.name||item.item_name, item.notes||'', item.unit_price].join('|');
    const existing = byCourse[c].find(x => x._key === key);
    if (existing) existing.quantity += Number(item.quantity)||0;
    else byCourse[c].push({ ...item, quantity: Number(item.quantity)||0, _key: key });
  });

  const itemRows = Object.keys(byCourse).sort().map(course => {
    const rows = byCourse[course].map(item => {
      const itemTotal = item.quantity * item.unit_price;
      let finalPrice  = itemTotal;
      if (item.discount_type === 'percent') finalPrice = itemTotal * (1 - (item.discount_value||0)/100);
      if (item.discount_type === 'fixed')   finalPrice = Math.max(0, itemTotal - (item.discount_value||0));
      const name = item.name || item.item_name || 'Item';
      return `
        <tr>
          <td style="padding:2px 0;">${item.quantity}x ${name}</td>
          <td style="text-align:right;padding:2px 0;">${fmt(finalPrice)}</td>
        </tr>
        ${item.notes ? `<tr><td colspan="2" style="padding-left:12px;font-size:10px;color:#666;">${item.notes}</td></tr>` : ''}
      `;
    }).join('');
    return `
      <tr><td colspan="2" style="padding-top:6px;padding-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;">${courseNames[course]||'ITEMS'}</td></tr>
      ${rows}
    `;
  }).join('');

  const discountRow  = discountAmount > 0 ? `<tr><td>Discount ${order.discount_type==='percent'?`(${order.discount_value}%)`:''}  </td><td style="text-align:right;">-${fmt(discountAmount)}</td></tr>` : '';
  const scRow        = serviceCharge  > 0 ? `<tr><td>Service charge (${scRate}%)</td><td style="text-align:right;">${fmt(serviceCharge)}</td></tr>` : '';
  const tipRow       = tip            > 0 ? `<tr><td>Gratuity</td><td style="text-align:right;">${fmt(tip)}</td></tr>` : '';

  // SEPOS-021 — VAT breakdown. Prices VAT-inclusive: net = gross × 100/(100+rate).
  const vatBuckets = {};
  for (const i of activeItems) {
    const rate = Number(i.vat_rate ?? 20);
    let g = (i.quantity || 0) * (i.unit_price || 0);
    if (i.discount_type === 'percent') g *= 1 - ((i.discount_value || 0) / 100);
    if (i.discount_type === 'fixed')   g = Math.max(0, g - (i.discount_value || 0));
    const net = rate > 0 ? g * (100 / (100 + rate)) : g;
    const vat = g - net;
    if (!vatBuckets[rate]) vatBuckets[rate] = { rate, net: 0, vat: 0 };
    vatBuckets[rate].net += net;
    vatBuckets[rate].vat += vat;
  }
  const vatRows = Object.values(vatBuckets).sort((a, b) => a.rate - b.rate);
  const vatTotal = vatRows.reduce((s, b) => s + b.vat, 0);
  const vatBlock = vatTotal > 0 ? `
    <hr class="divider"/>
    <table>
      <tr><td colspan="2" style="font-size:10px;color:#666;padding-top:2px;text-transform:uppercase;letter-spacing:1px;">VAT Breakdown</td></tr>
      ${vatRows.map(b => `
        <tr><td style="font-size:10px;color:#444;">VAT ${b.rate}% on ${fmt(b.net)} net</td><td style="text-align:right;font-size:10px;">${fmt(b.vat)}</td></tr>
      `).join('')}
      <tr><td style="font-size:11px;font-weight:700;">Total VAT</td><td style="text-align:right;font-size:11px;font-weight:700;">${fmt(vatTotal)}</td></tr>
    </table>` : '';
  const paymentRows  = method ? `
    <tr><td>Payment</td><td style="text-align:right;">${method}</td></tr>
    ${method==='Cash'&&amountPaid>0?`
      <tr><td>Cash tendered</td><td style="text-align:right;">${fmt(amountPaid)}</td></tr>
      <tr style="font-weight:700;"><td>Change</td><td style="text-align:right;">${fmt(change)}</td></tr>
    `:''}
  ` : '';

  const logoHtml = logoDataUrl ? `
    <div style="text-align:center;margin-bottom:10px;">
      <img src="${logoDataUrl}" style="max-width:${logoSizePx};${logoSizePx==='100%'?'width:100%;':''}object-fit:contain;display:block;margin:0 auto;" alt="Logo" />
    </div>` : '';

  const qrHtml = googleReviewUrl ? `
    <div style="text-align:center;margin-top:10px;">
      <div style="font-size:10px;color:#666;margin-bottom:4px;">Enjoyed your meal? Leave us a review!</div>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(googleReviewUrl)}" width="80" height="80" alt="QR" style="border:1px solid #eee;" />
      <div style="font-size:9px;color:#aaa;margin-top:2px;">Scan to review on Google</div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Receipt - ${order.order_type === 'takeaway' ? (order.table_number != null ? `Takeaway ${order.table_number}` : `Online Order #${order.id}`) : `Table ${order.table_number}`}</title>
  <style>
    *    { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Courier New',Courier,monospace; font-size:12px; color:#000; background:white; width:80mm; margin:0 auto; padding:4mm 2mm; }
    @media print {
      body { width:80mm; margin:0; padding:2mm 1mm; }
      @page { margin:0; size:80mm auto; }
    }
    table { width:100%; border-collapse:collapse; }
    .divider       { border:none; border-top:1px dashed #999; margin:6px 0; }
    .divider-solid { border:none; border-top:1px solid #000;  margin:6px 0; }
    .total-row td  { padding:4px 0; border-top:2px solid #000; font-size:15px; font-weight:900; }
    .center        { text-align:center; }
    .small         { font-size:10px; color:#555; }
  </style>
</head>
<body>

  ${logoHtml}

  <div class="center" style="font-size:15px;font-weight:900;letter-spacing:1px;margin-bottom:2px;">${restaurantName}</div>
  ${restaurantAddr  ? `<div class="center small">${restaurantAddr}</div>` : ''}
  ${restaurantPhone ? `<div class="center small">Tel: ${restaurantPhone}</div>` : ''}
  ${restaurantVat   ? `<div class="center small">VAT No: ${restaurantVat}</div>` : ''}

  <hr class="divider"/>

  ${order.order_type !== 'takeaway' && order.table_number != null
    ? `<div style="text-align:center;font-size:24px;font-weight:900;margin:2px 0 10px;">TABLE ${order.table_number}</div>` : ''}

  <table>
    ${order.order_type === 'takeaway'
      ? `<tr><td>Type</td><td style="text-align:right;font-weight:700;">${order.table_number != null ? `🥡 Takeaway ${order.table_number}` : '🥡 Online Order'}</td></tr>
         ${order.customer_name ? `<tr><td>Customer</td><td style="text-align:right;">${order.customer_name}</td></tr>` : ''}
         ${order.pickup_time   ? `<tr><td>Pickup</td><td style="text-align:right;">${new Date(order.pickup_time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'})}</td></tr>` : ''}`
      : `<tr><td>Covers</td> <td style="text-align:right;">${order.covers||'—'}</td></tr>`}
    <tr><td>Date</td>    <td style="text-align:right;">${date}</td></tr>
    <tr><td>Time</td>    <td style="text-align:right;">${time}</td></tr>
    <tr><td>Order #</td> <td style="text-align:right;">${order.id}</td></tr>
  </table>

  <hr class="divider"/>

  <table>${itemRows}</table>

  <hr class="divider"/>

  <table>
    <tr><td>Subtotal</td><td style="text-align:right;">${fmt(subtotal)}</td></tr>
    ${discountRow}
    ${scRow}
    ${tipRow}
    <tr class="total-row"><td>TOTAL</td><td style="text-align:right;">${fmt(billTotal)}</td></tr>
    ${paymentRows}
  </table>

  ${vatBlock}

  <hr class="divider-solid"/>

  <div class="center" style="font-size:11px;margin-top:8px;color:#333;">${footerMsg}<br/>ขอบคุณที่มาใช้บริการ</div>

  ${qrHtml}
  <div style="height:10mm;"></div>

</body>
</html>`;
}
