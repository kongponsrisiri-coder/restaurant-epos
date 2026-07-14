// SEPOS-LOCAL-001 Phase 1 — Nightly local archive.
//
// Writes two artifacts per working day to ~/Documents/SiamEPOS-Records/YYYY/MM/:
//   bills-YYYY-MM.csv         — every closed order for the month
//   z-report-YYYY-MM-DD.pdf   — branded daily Z-report
//
// Triggered from server.js:
//   1) On server startup if yesterday's PDF doesn't exist (catchup).
//   2) Inside POST /api/z-report/save after the row is persisted.
//
// Both triggers route through archiveForDate() which is idempotent —
// re-running on a date whose PDF already exists is a no-op (CSV is
// always regenerated, cheap and ensures the latest closed orders make
// it in if the operator closed an order after running the archive).
//
// Always-on per HMRC compliance (per Korakot 2026-06-01) — no opt-in
// setting. Skips silently when running on Railway (no local FS).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const PDFDocument = require('pdfkit');

// ── Paths ──────────────────────────────────────────────────────────
function getRootDir() {
  return path.join(os.homedir(), 'Documents', 'SiamEPOS-Records');
}

function getMonthDir(dateStr) {
  // dateStr = 'YYYY-MM-DD'
  const [y, m] = dateStr.split('-');
  return path.join(getRootDir(), y, m);
}

function billsCsvPath(dateStr) {
  const [y, m] = dateStr.split('-');
  return path.join(getMonthDir(dateStr), `bills-${y}-${m}.csv`);
}

function zReportPdfPath(dateStr) {
  return path.join(getMonthDir(dateStr), `z-report-${dateStr}.pdf`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Date helpers ───────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr()    { return formatDate(new Date()); }
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

// ── Should we even run? ────────────────────────────────────────────
// Archive only makes sense when the backend is on a real machine with
// a local Documents folder. On Railway we have no persistent local
// disk and ~/Documents resolves to ephemeral container storage. Gate
// by DB_MODE — local = Electron install on operator's Mac/PC = archive.
function isLocalInstall() {
  return String(process.env.DB_MODE || '').toLowerCase() === 'local';
}

// ── CSV writer ─────────────────────────────────────────────────────
// Quote any field containing comma, quote, or newline per RFC 4180.
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvLine(cells) { return cells.map(csvEscape).join(',') + '\n'; }

// pool is the standard dbAdapter pool (PG syntax over SQLite when local).
// Caller supplies it so this module doesn't reach into ../db/dbAdapter and
// create a circular require at server startup.
async function generateBillsCsv(pool, dateStr) {
  const [y, m] = dateStr.split('-');
  const monthStart = `${y}-${m}-01`;
  // First day of next month — handles December rollover naturally
  // via JS Date arithmetic.
  const nextMonth = new Date(Number(y), Number(m), 1); // m is 1-based, Number(m) = next month 0-based
  const monthEnd = formatDate(nextMonth); // exclusive upper bound

  const sql = `
    SELECT
      o.id, o.closed_at, o.total, o.covers, o.discount_type,
      o.discount_value, o.discount_reason, o.order_type,
      t.table_number,
      p.method   AS payment_method,
      p.amount   AS paid_amount,
      string_agg(oi.quantity || 'x ' || COALESCE(mi.name, oi.item_name, '?'), '; ') AS items
    FROM orders o
    LEFT JOIN tables       t  ON t.id  = o.table_id
    LEFT JOIN payments     p  ON p.order_id = o.id
    LEFT JOIN order_items  oi ON oi.order_id = o.id AND oi.voided = 0
    LEFT JOIN menu_items   mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'closed'
      AND o.closed_at >= $1::timestamp
      AND o.closed_at <  $2::timestamp
    GROUP BY o.id, t.table_number, p.method, p.amount
    ORDER BY o.closed_at ASC
  `;
  // dbAdapter rewrites string_agg → group_concat for SQLite via the adapter.
  // If the local SQLite path doesn't have that translation, the catch
  // falls back to a simpler query without item concatenation.
  let rows;
  try {
    const r = await pool.query(sql, [monthStart, monthEnd]);
    rows = r.rows;
  } catch (err) {
    const r = await pool.query(`
      SELECT o.id, o.closed_at, o.total, o.covers, o.discount_type,
             o.discount_value, o.discount_reason, o.order_type,
             t.table_number, p.method AS payment_method, p.amount AS paid_amount
      FROM orders o
      LEFT JOIN tables   t ON t.id = o.table_id
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.status = 'closed'
        AND o.closed_at >= $1::timestamp
        AND o.closed_at <  $2::timestamp
      ORDER BY o.closed_at ASC
    `, [monthStart, monthEnd]);
    rows = r.rows.map(r => ({ ...r, items: '' }));
  }

  ensureDir(getMonthDir(dateStr));

  let out = csvLine([
    'Order #', 'Date', 'Time', 'Table', 'Type', 'Covers',
    'Total', 'Discount', 'Payment Method', 'Items',
  ]);
  for (const r of rows) {
    const closed = r.closed_at instanceof Date ? r.closed_at : new Date(r.closed_at);
    // SEPOS-048 — render the archive CSV in the restaurant's timezone: this
    // runs on Railway (UTC), so getHours()/formatDate showed every bill 1h
    // early in BST and bills closed 00:00–01:00 local on the wrong date.
    const tz = process.env.RESTAURANT_TZ || 'Europe/London';
    let date, time;
    try {
      date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(closed);
      time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(closed);
    } catch {
      date = formatDate(closed);
      time = `${pad(closed.getHours())}:${pad(closed.getMinutes())}`;
    }
    const discount = r.discount_value
      ? (r.discount_type === 'percent'
          ? `${r.discount_value}%`
          : `£${Number(r.discount_value).toFixed(2)}`)
      : '';
    out += csvLine([
      r.id,
      date,
      time,
      r.table_number ?? '',
      r.order_type || 'dine-in',
      r.covers ?? '',
      `£${Number(r.total || 0).toFixed(2)}`,
      discount,
      r.payment_method || '',
      r.items || '',
    ]);
  }

  fs.writeFileSync(billsCsvPath(dateStr), out, 'utf8');
  return { path: billsCsvPath(dateStr), rowCount: rows.length };
}

// ── Z-report PDF ───────────────────────────────────────────────────
// Branded with company name + address + (data-URL) logo. Navy/gold theme
// matches the booking email and bill receipt. Uses the same data shape as
// the on-screen Z-report.
async function generateZReportPdf(dateStr, reportData, settings) {
  const NAVY = '#0D1B3E';
  const GOLD = '#C9A84C';
  const MUTED = '#888888';

  ensureDir(getMonthDir(dateStr));
  const outPath = zReportPdfPath(dateStr);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outPath);
    stream.on('finish', () => resolve({ path: outPath }));
    stream.on('error', reject);
    doc.pipe(stream);

    // ── Header ─────────────────────────────────────────────────
    const restaurantName = settings.company_name || settings.restaurant_name || 'SiamEPOS Restaurant';
    const address        = settings.company_address || settings.restaurant_address || '';
    const phone          = settings.company_phone || '';
    const vat            = settings.company_vat   || '';

    // Try to draw a logo if a data URL is set. pdfkit accepts a Buffer
    // from base64. Wrap in try/catch — a malformed logo shouldn't kill
    // the archive.
    if (settings.company_logo && /^data:image\/(png|jpe?g);base64,/.test(settings.company_logo)) {
      try {
        const b64 = settings.company_logo.split(',', 2)[1] || '';
        const buf = Buffer.from(b64, 'base64');
        doc.image(buf, 50, 45, { fit: [70, 70] });
      } catch (e) {
        // ignore — header still renders without logo
      }
    }

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22).text(restaurantName, 130, 50);
    if (address) doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(address, 130, 78);
    const sub = [phone && `Tel ${phone}`, vat && `VAT ${vat}`].filter(Boolean).join('  ·  ');
    if (sub) doc.fillColor(MUTED).fontSize(10).text(sub, 130, 92);

    doc.moveTo(50, 120).lineTo(545, 120).strokeColor(GOLD).lineWidth(2).stroke();

    // ── Title ──────────────────────────────────────────────────
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('Z-Report', 50, 135);
    doc.fillColor('#555').font('Helvetica').fontSize(11)
       .text(`Trading day ${formatDateLong(dateStr)}`, 50, 160)
       .text(`Generated ${new Date().toLocaleString('en-GB')}`, 50, 174);

    // ── Totals block ───────────────────────────────────────────
    doc.moveTo(50, 200).lineTo(545, 200).strokeColor('#e7e3da').lineWidth(0.5).stroke();
    let y = 215;
    const totals = [
      ['Total sales',          money(reportData.total_sales)],
      ['Total covers',         String(reportData.total_covers ?? 0)],
      ['Total orders',         String(reportData.total_orders ?? 0)],
      ['Average per cover',    money(reportData.avg_per_cover)],
      ['Average per order',    money(reportData.avg_per_order)],
    ];
    for (const [label, value] of totals) {
      doc.fillColor('#444').font('Helvetica').fontSize(11).text(label, 60, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').text(value, 400, y, { width: 140, align: 'right' });
      y += 18;
    }

    // ── Payment split ──────────────────────────────────────────
    y += 12;
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12).text('Payments', 50, y); y += 18;
    const pays = [
      ['Cash',  money(reportData.total_cash)],
      ['Card',  money(reportData.total_card)],
      ['Other', money(reportData.total_other)],
    ];
    for (const [label, value] of pays) {
      doc.fillColor('#444').font('Helvetica').fontSize(11).text(label, 60, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').text(value, 400, y, { width: 140, align: 'right' });
      y += 16;
    }

    // ── Voids & discounts ──────────────────────────────────────
    y += 12;
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12).text('Voids & Discounts', 50, y); y += 18;
    const vd = [
      ['Discounts given',  money(reportData.total_discounts)],
      ['Void count',       String(reportData.void_count ?? 0)],
      ['Void value',       money(reportData.void_value)],
    ];
    for (const [label, value] of vd) {
      doc.fillColor('#444').font('Helvetica').fontSize(11).text(label, 60, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').text(value, 400, y, { width: 140, align: 'right' });
      y += 16;
    }

    // ── VAT breakdown ──────────────────────────────────────────
    if (Array.isArray(reportData.vat_breakdown) && reportData.vat_breakdown.length) {
      y += 12;
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12).text('VAT', 50, y); y += 18;
      doc.fillColor('#888').font('Helvetica').fontSize(10);
      doc.text('Rate',  60,  y);
      doc.text('Net',   200, y, { width: 90, align: 'right' });
      doc.text('VAT',   300, y, { width: 90, align: 'right' });
      doc.text('Gross', 400, y, { width: 140, align: 'right' });
      y += 14;
      for (const b of reportData.vat_breakdown) {
        doc.fillColor('#444').fontSize(11);
        doc.text(`${b.rate}%`,        60,  y);
        doc.text(money(b.net),        200, y, { width: 90,  align: 'right' });
        doc.text(money(b.vat),        300, y, { width: 90,  align: 'right' });
        doc.text(money(b.gross),      400, y, { width: 140, align: 'right' });
        y += 14;
      }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11);
      doc.text('VAT total', 60, y);
      doc.text(money(reportData.vat_total), 400, y, { width: 140, align: 'right' });
      y += 18;
    }

    // ── Vouchers (SEPOS-VOUCHER-001) ───────────────────────────
    if (reportData.vouchers_sold || reportData.vouchers_redeemed) {
      y += 12;
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12).text('Gift Vouchers', 50, y); y += 18;
      const vs = reportData.vouchers_sold     || { count: 0, total: 0 };
      const vr = reportData.vouchers_redeemed || { count: 0, total: 0 };
      doc.fillColor('#444').font('Helvetica').fontSize(11);
      doc.text(`Sold (${vs.count})`, 60, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').text(money(vs.total), 400, y, { width: 140, align: 'right' });
      y += 16;
      doc.fillColor('#444').font('Helvetica').text(`Redeemed (${vr.count})`, 60, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').text(money(vr.total), 400, y, { width: 140, align: 'right' });
      y += 16;
    }

    // ── Footer ─────────────────────────────────────────────────
    const footerY = 760;
    doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor('#e7e3da').lineWidth(0.5).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
       .text(`SiamEPOS Local Archive · HMRC record · keep for 6 years`, 50, footerY + 8, { width: 495, align: 'center' });

    doc.end();
  });
}

function money(v) { return '£' + Number(v || 0).toFixed(2); }
function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ── Main entry — orchestrates CSV + PDF ─────────────────────────────
// Idempotent on the PDF (skips if exists). CSV is always regenerated
// because it's a monthly rollup that should reflect any orders closed
// after the previous archive ran.
async function archiveForDate(pool, dateStr, opts = {}) {
  if (!isLocalInstall()) {
    return { skipped: true, reason: 'not a local install (DB_MODE != local)' };
  }
  const force = !!opts.force;

  const pdfExists = fs.existsSync(zReportPdfPath(dateStr));
  if (pdfExists && !force) {
    // Still refresh the bills CSV — cheap, ensures month rollup is current.
    try {
      const csv = await generateBillsCsv(pool, dateStr);
      return { ok: true, date: dateStr, pdf_skipped: true, csv };
    } catch (e) {
      return { ok: true, date: dateStr, pdf_skipped: true, csv_error: e.message };
    }
  }

  // Load settings for branding.
  const settingsRes = await pool.query('SELECT key, value FROM settings').catch(() => ({ rows: [] }));
  const settings = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));

  // Fetch Z-report data for that day from the saved z_reports table,
  // OR fall back to computing it live from orders if no saved row exists.
  const dayStart = `${dateStr} 00:00:00`;
  const dayEnd   = `${dateStr} 23:59:59`;

  let reportData;
  const zRes = await pool.query(
    `SELECT report_data FROM z_reports
     WHERE closed_at::date = $1::date
     ORDER BY closed_at DESC LIMIT 1`,
    [dateStr]
  ).catch(() => ({ rows: [] }));

  if (zRes.rows[0] && zRes.rows[0].report_data) {
    try { reportData = JSON.parse(zRes.rows[0].report_data); }
    catch { reportData = zRes.rows[0].report_data; }
  } else {
    // Live compute — minimal version of /api/z-report/preview maths.
    const r = await pool.query(
      `SELECT o.id, o.total, o.covers, o.discount_type, o.discount_value, p.method, p.amount as paid_amount
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
       WHERE o.status='closed' AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp`,
      [dayStart, dayEnd]
    );
    const orders = r.rows;
    const totalSales   = orders.reduce((s, o) => s + Number(o.total || 0), 0);
    const totalCovers  = orders.reduce((s, o) => s + (o.covers || 0), 0);
    const totalCash    = orders.filter(o => o.method === 'Cash').reduce((s, o) => s + Number(o.paid_amount || 0), 0);
    const totalCard    = orders.filter(o => o.method === 'Card').reduce((s, o) => s + Number(o.paid_amount || 0), 0);
    const totalOther   = orders.filter(o => o.method !== 'Cash' && o.method !== 'Card').reduce((s, o) => s + Number(o.paid_amount || 0), 0);
    const totalDiscounts = orders.reduce((s, o) => {
      if (!o.discount_value) return s;
      return s + (o.discount_type === 'percent' ? Number(o.total || 0) * (Number(o.discount_value) / 100) : Number(o.discount_value));
    }, 0);
    reportData = {
      total_sales:     totalSales,
      total_covers:    totalCovers,
      total_orders:    orders.length,
      total_cash:      totalCash,
      total_card:      totalCard,
      total_other:     totalOther,
      total_discounts: totalDiscounts,
      avg_per_cover:   totalCovers > 0 ? totalSales / totalCovers : 0,
      avg_per_order:   orders.length > 0 ? totalSales / orders.length : 0,
      void_count:      0,
      void_value:      0,
      vat_breakdown:   [],
      vat_total:       0,
    };
  }

  const [csv, pdf] = await Promise.all([
    generateBillsCsv(pool, dateStr),
    generateZReportPdf(dateStr, reportData, settings),
  ]);

  return { ok: true, date: dateStr, csv, pdf };
}

// ── Status query (for the Settings UI card) ────────────────────────
function getArchiveStatus() {
  const root = getRootDir();
  if (!fs.existsSync(root)) {
    return { dir: root, exists: false, last_archived: null, recent: [] };
  }
  // Walk the YYYY/MM tree and find the most recent .pdf.
  const recent = [];
  const years = fs.readdirSync(root).filter(n => /^\d{4}$/.test(n)).sort().reverse();
  for (const y of years) {
    const months = fs.readdirSync(path.join(root, y)).filter(n => /^\d{2}$/.test(n)).sort().reverse();
    for (const m of months) {
      const files = fs.readdirSync(path.join(root, y, m)).filter(n => n.endsWith('.pdf')).sort().reverse();
      for (const f of files) {
        recent.push({
          file: f,
          path: path.join(root, y, m, f),
          mtime: fs.statSync(path.join(root, y, m, f)).mtimeMs,
        });
        if (recent.length >= 10) break;
      }
      if (recent.length >= 10) break;
    }
    if (recent.length >= 10) break;
  }
  return {
    dir: root,
    exists: true,
    last_archived: recent[0] ? new Date(recent[0].mtime).toISOString() : null,
    recent,
  };
}

module.exports = {
  isLocalInstall,
  archiveForDate,
  generateBillsCsv,
  generateZReportPdf,
  getArchiveStatus,
  getRootDir,
  getMonthDir,
  todayStr,
  yesterdayStr,
  formatDate,
};
