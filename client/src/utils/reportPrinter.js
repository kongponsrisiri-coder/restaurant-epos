/**
 * Shared print pipeline for ADMIN REPORTS.
 *
 * Two output modes:
 *   • thermalPrint(html)     — 80mm ESC/POS receipt-printer format.
 *       Tries Electron silent print to the receipt printer chosen in
 *       Settings (same one used by ReceiptPrinter.jsx); falls back to a
 *       browser popup with 80mm CSS.
 *   • fullPagePrint(html)    — A4 popup. Opens a browser window with
 *       the report sized for a normal sheet of paper; the operator
 *       triggers print (or save-as-PDF) themselves.
 *
 * The HTML you pass in should be a complete <!DOCTYPE html>...</html>
 * document. Each report (Sales / Items / Z / VAT / Bills) builds its
 * own body; the page chrome (font, body width, @page size) is the
 * report's responsibility so the same builder can render for either
 * surface.
 */

// ── Pipelines ────────────────────────────────────────────────────
export function thermalPrint(html) {
  const deviceName = (typeof localStorage !== 'undefined'
    && localStorage.getItem('receipt_printer_name')) || '';
  if (deviceName && window.siamepos?.isElectron && window.siamepos.printHtml) {
    window.siamepos.printHtml({ html, deviceName })
      .then(r => { if (!r || !r.success) { console.error('[report] silent print failed:', r?.error); openPopup(html, { thermal: true }); } })
      .catch(e => { console.error('[report] silent print error:', e); openPopup(html, { thermal: true }); });
    return;
  }
  openPopup(html, { thermal: true });
}

export function fullPagePrint(html) {
  openPopup(html, { thermal: false });
}

function openPopup(html, { thermal }) {
  const w = thermal ? 400 : 900;
  const h = thermal ? 700 : 900;
  const win = window.open('', '_blank', `width=${w},height=${h},scrollbars=yes`);
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site to print reports.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    setTimeout(() => {
      win.focus();
      win.print();
      // Thermal: auto-close after print. Full-page: leave open so the
      // operator can save-as-PDF or re-print without rebuilding.
      if (thermal) win.onafterprint = () => win.close();
    }, 400);
  };
}

// ── Formatting helpers shared across builders ─────────────────────
export const fmt = (n) => '£' + Number(n || 0).toFixed(2);
export const fmtInt = (n) => Number(n || 0).toLocaleString();
export const dateLabel = (d) => new Date(d).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short', year: 'numeric' });
export const nowStamp = () => {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
       + ' · '
       + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

// Centred name from settings, fallback to "SiamEPOS".
export const restaurantName = (settings) =>
  (settings && (settings.company_name || settings.restaurant_name)) || 'SiamEPOS';

// Period label for headers — handles preset OR custom date range.
export function periodLabel(period, from, to) {
  if (period === 'today')   return 'Today · ' + dateLabel(from);
  if (period === 'weekly')  return 'Last 7 days · ' + dateLabel(from) + ' → ' + dateLabel(to);
  if (period === 'monthly') return 'This month · ' + dateLabel(from) + ' → ' + dateLabel(to);
  if (from === to)          return dateLabel(from);
  return dateLabel(from) + ' → ' + dateLabel(to);
}

// ── Page chrome ──────────────────────────────────────────────────
// Builds the <html><head>...</head><body>BODY</body></html> wrapper.
// 'kind' picks the page CSS:
//   thermal → 80 mm Courier monospace, @page size 80mm auto
//   full    → A4 Inter/sans, normal margins
export function pageHtml(title, bodyHtml, kind) {
  if (kind === 'thermal') {
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><title>${title}</title>
<style>
  *    { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New', Courier, monospace; font-size:11px; color:#000; background:white; width:80mm; margin:0 auto; padding:4mm 2mm; line-height:1.35; }
  @media print { body { width:80mm; margin:0; padding:2mm 1mm; } @page { margin:0; size:80mm auto; } }
  h1, h2, h3 { font-weight:900; letter-spacing:1px; }
  table { width:100%; border-collapse:collapse; }
  td, th { padding:2px 0; vertical-align:top; }
  .right { text-align:right; }
  .center { text-align:center; }
  .small { font-size:9.5px; color:#444; }
  .muted { color:#555; }
  .divider       { border:none; border-top:1px dashed #999; margin:5px 0; }
  .divider-solid { border:none; border-top:1px solid #000;  margin:6px 0; }
  .total-row td  { padding:4px 0; border-top:2px solid #000; font-size:13px; font-weight:900; }
  .section-head { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#777; padding-top:6px; padding-bottom:2px; }
</style>
</head><body>
${bodyHtml}
<div style="height:6mm;"></div>
</body></html>`;
  }
  // Full A4 — sans-serif, comfortable padding, table styling for printout
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><title>${title}</title>
<style>
  *    { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Arial, sans-serif; font-size:13px; color:#1a1a2e; background:white; padding:24px 32px; line-height:1.5; }
  @media print { body { padding:14mm 12mm; } @page { size:A4 portrait; margin:0; } }
  h1 { font-size:24px; font-weight:800; color:#1a1a2e; margin-bottom:6px; }
  h2 { font-size:14px; font-weight:700; color:#1a1a2e; margin:18px 0 6px; padding-bottom:4px; border-bottom:1.5px solid #1a1a2e; text-transform:uppercase; letter-spacing:1px; }
  .sub { font-size:12px; color:#666; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; margin-top:6px; }
  th, td { padding:7px 6px; text-align:left; }
  th { border-bottom:2px solid #1a1a2e; font-weight:700; font-size:12px; color:#1a1a2e; text-transform:uppercase; letter-spacing:0.5px; }
  td { border-bottom:1px solid #eee; }
  .right { text-align:right; }
  .center { text-align:center; }
  .muted { color:#666; }
  .total-row td { border-top:2.5px solid #1a1a2e; border-bottom:none; padding-top:9px; font-weight:800; font-size:15px; }
  .pill { display:inline-block; padding:2px 8px; background:#1a1a2e; color:white; border-radius:4px; font-size:10px; letter-spacing:1px; font-weight:600; text-transform:uppercase; }
  .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .grid-3 { display:grid; grid-template-columns:repeat(3, 1fr); gap:18px; }
  .card { background:#f8f8fa; border-radius:8px; padding:12px 14px; }
  .card .lbl { font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.5px; }
  .card .val { font-size:22px; font-weight:800; color:#1a1a2e; margin-top:4px; }
  .footer { margin-top:24px; padding-top:10px; border-top:1px dashed #ccc; font-size:11px; color:#888; text-align:center; }
</style>
</head><body>
${bodyHtml}
<div class="footer">Generated by SiamEPOS · ${nowStamp()}</div>
</body></html>`;
}
