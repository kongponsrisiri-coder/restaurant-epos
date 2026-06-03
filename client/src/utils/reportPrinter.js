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

import { serverPrintReportText } from '../api';

// ── ESC/POS path ──────────────────────────────────────────────────
// SEPOS-REPORTS-001 — when a receipt printer IP is configured we send
// the report straight to it as ESC/POS bytes via the server endpoint
// (same RAW → LPR → CUPS pipeline that bill receipts use). The browser
// never sees a print dialog, the thermal printer never sees HTML, and
// the £ + page-cut land correctly.
//
// lines is a tiny DSL — each line is one of:
//   { kind:'h1', text }                 — center, double-size, bold
//   { kind:'h2', text }                 — center, bold
//   { kind:'small', text }              — center, normal
//   { kind:'div' }                      — dashed rule
//   { kind:'div-solid' }                — solid rule
//   { kind:'row', left, right }         — left / right justified
//   { kind:'total', left, right }       — bold, solid rule above
//   { kind:'space' }                    — blank line
// Returns a promise that resolves to { success, reason?, error? }.
export async function escPosPrint(lines) {
  try {
    const r = await serverPrintReportText(lines);
    return r || { success: false };
  } catch (e) {
    console.error('[report] ESC/POS print error:', e);
    return { success: false, error: e.message };
  }
}

// ── HTML pipelines ───────────────────────────────────────────────
// Used when no thermal printer is configured (or as fallback). The
// thermal popup NO LONGER auto-fires print() — instead it shows the
// formatted preview with a big PRINT button at the top. This prevents
// the "blank short feed" problem you get when a thermal printer
// receives HTML it can't render.
export function thermalPrint(html) {
  openPopup(html, { thermal: true });
}

export function fullPagePrint(html) {
  openPopup(html, { thermal: false });
}

function openPopup(html, { thermal }) {
  const w = thermal ? 420 : 900;
  const h = thermal ? 720 : 900;
  const win = window.open('', '_blank', `width=${w},height=${h},scrollbars=yes`);
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site to print reports.');
    return;
  }
  // Inject a top-of-page action bar with a Print button so the operator
  // SEES the rendered content before printing. The bar is hidden during
  // the actual print job via @media print { display:none; }.
  const actionBarHtml = `
    <div id="__rp_bar__" style="position:sticky;top:0;left:0;right:0;z-index:9999;
      background:#0D1B3E;color:white;padding:10px 14px;display:flex;gap:10px;
      justify-content:center;align-items:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
      <button onclick="window.print()" style="background:#C9A84C;color:#0D1B3E;
        border:none;padding:8px 16px;border-radius:6px;font-weight:800;cursor:pointer;
        font-size:13px;">🖨 Print</button>
      <button onclick="window.close()" style="background:transparent;color:white;
        border:1px solid rgba(255,255,255,0.35);padding:8px 14px;border-radius:6px;
        cursor:pointer;font-size:13px;">Close</button>
      <span style="margin-left:8px;opacity:0.85;font-size:11.5px;">${thermal
        ? 'Preview · ${THERMAL_HINT}'
        : 'Preview · A4 — choose your printer or save as PDF'}</span>
    </div>
    <style>@media print { #__rp_bar__ { display:none !important; } }</style>
  `.replace('${THERMAL_HINT}',
    'select your 80mm thermal printer in the dialog (set Paper to 80mm)');
  // Inject the bar at the start of <body>.
  const injected = html.replace(/<body([^>]*)>/i, `<body$1>${actionBarHtml}`);
  win.document.write(injected);
  win.document.close();
  // No auto-print. Operator clicks the PRINT button in the bar when ready.
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
