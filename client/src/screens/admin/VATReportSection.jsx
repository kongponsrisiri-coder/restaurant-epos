import { useState, useEffect } from 'react';
import { getVatReport, getSettings } from '../../api';
import {
  thermalPrint, fullPagePrint, escPosPrint, pageHtml,
  fmt, fmtInt, dateLabel, restaurantName, nowStamp,
} from '../../utils/reportPrinter';

// SEPOS-021 — VAT report (date range).
// Groups closed-order items by vat_rate over the chosen window and shows
// net / vat / gross per rate plus totals. CSV export for record-keeping
// (Making Tax Digital still needs an HMRC submission step — that's a
// future ticket; this gives the operator the digital records).

function downloadCsv(filename, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map(r => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function VATReportSection() {
  // Default range: month-to-date
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fmtDate = (d) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(fmtDate(monthStart));
  const [to,   setTo]   = useState(fmtDate(today));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await getVatReport(from + ' 00:00:00', to + ' 23:59:59');
      setData(r);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const [settings, setSettings] = useState({});
  useEffect(() => { getSettings().then(s => setSettings(s || {})).catch(() => {}); }, []);

  const doPrintVat = async (mode) => {
    if (!data?.breakdown?.length) return;
    const isThermal = (mode === 'thermal');
    if (isThermal) {
      const lines = buildVatLines(data, from, to, settings);
      const r = await escPosPrint(lines);
      if (r && r.success) return;
      const body = buildVatBody(data, from, to, settings, true);
      thermalPrint(pageHtml('VAT Report — ' + restaurantName(settings), body, 'thermal'));
      return;
    }
    const body = buildVatBody(data, from, to, settings, false);
    fullPagePrint(pageHtml('VAT Report — ' + restaurantName(settings), body, 'full'));
  };

  const exportCsv = () => {
    if (!data?.breakdown) return;
    const rows = [['Rate %', 'Net £', 'VAT £', 'Gross £', 'Items']];
    for (const b of data.breakdown) {
      rows.push([
        Number(b.rate).toFixed(2),
        Number(b.net || 0).toFixed(2),
        Number(b.vat || 0).toFixed(2),
        Number(b.gross || 0).toFixed(2),
        b.items || 0,
      ]);
    }
    rows.push(['TOTAL', Number(data.total.net).toFixed(2), Number(data.total.vat).toFixed(2), Number(data.total.gross).toFixed(2), data.total.items || 0]);
    // Korakot 2026-06-02: also dump the Food vs Drink split so the
    // accountant can see at a glance how much of the period's gross is
    // kitchen vs bar.
    if (data.by_kind) {
      rows.push([]);
      rows.push(['By category', 'Net £', 'VAT £', 'Gross £', 'Items']);
      rows.push(['Food',  Number(data.by_kind.food.net  || 0).toFixed(2), Number(data.by_kind.food.vat  || 0).toFixed(2), Number(data.by_kind.food.gross  || 0).toFixed(2), data.by_kind.food.items  || 0]);
      rows.push(['Drink', Number(data.by_kind.drink.net || 0).toFixed(2), Number(data.by_kind.drink.vat || 0).toFixed(2), Number(data.by_kind.drink.gross || 0).toFixed(2), data.by_kind.drink.items || 0]);
    }
    downloadCsv(`vat-report_${from}_to_${to}.csv`, rows);
  };

  const cardStyle = { background:'white', borderRadius:12, padding:20, marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };
  const inputStyle = { padding:'8px 10px', borderRadius:8, border:'1px solid #ddd', fontSize:13, fontFamily:'inherit' };

  return (
    <div style={{ padding:24, maxWidth:840 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🧾 VAT Report</h1>

      <div style={{ ...cardStyle, display:'flex', gap:10, alignItems:'flex-end', flexWrap:'wrap' }}>
        <div>
          <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#888', marginBottom:4, textTransform:'uppercase' }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#888', marginBottom:4, textTransform:'uppercase' }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
        </div>
        <button onClick={load} disabled={loading} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13,
          cursor: loading ? 'wait' : 'pointer'
        }}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button onClick={() => doPrintVat('thermal')} disabled={!data?.breakdown?.length} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: data?.breakdown?.length ? '#1a1a2e' : '#bbb',
          color:'white', fontWeight:700, fontSize:13,
          cursor: data?.breakdown?.length ? 'pointer' : 'not-allowed'
        }}>🖨 Print</button>
        <button onClick={() => doPrintVat('full')} disabled={!data?.breakdown?.length} style={{
          padding:'10px 18px', borderRadius:8, border:'1px solid #1a1a2e',
          background: 'white', color:'#1a1a2e', fontWeight:700, fontSize:13,
          cursor: data?.breakdown?.length ? 'pointer' : 'not-allowed',
          opacity: data?.breakdown?.length ? 1 : 0.5,
        }}>📄 Export</button>
        <button onClick={exportCsv} disabled={!data || !data.breakdown?.length} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: data?.breakdown?.length ? '#C9A84C' : '#e5d9b2',
          color:'#0D1B3E', fontWeight:700, fontSize:13,
          cursor: data?.breakdown?.length ? 'pointer' : 'not-allowed'
        }}>⬇ CSV</button>
      </div>

      <div style={cardStyle}>
        {!data || data.breakdown.length === 0 ? (
          <div style={{ color:'#888', fontSize:14 }}>No closed orders in this range.</div>
        ) : (
          <>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ textAlign:'left', color:'#888', fontSize:11, textTransform:'uppercase' }}>
                  <th style={{ padding:'8px 6px' }}>Rate</th>
                  <th style={{ padding:'8px 6px', textAlign:'right' }}>Net</th>
                  <th style={{ padding:'8px 6px', textAlign:'right' }}>VAT</th>
                  <th style={{ padding:'8px 6px', textAlign:'right' }}>Gross</th>
                  <th style={{ padding:'8px 6px', textAlign:'right' }}>Items</th>
                </tr>
              </thead>
              <tbody>
                {data.breakdown.map(b => (
                  <tr key={b.rate} style={{ borderTop:'1px solid #f0f0f0' }}>
                    <td style={{ padding:'10px 6px', fontWeight:700 }}>{Number(b.rate).toFixed(0)}%</td>
                    <td style={{ padding:'10px 6px', textAlign:'right' }}>£{Number(b.net || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 6px', textAlign:'right', color:'#1e40af', fontWeight:700 }}>£{Number(b.vat || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 6px', textAlign:'right' }}>£{Number(b.gross || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 6px', textAlign:'right', color:'#888' }}>{b.items || 0}</td>
                  </tr>
                ))}
                <tr style={{ borderTop:'2px solid #1a1a2e', background:'#f8f8f8' }}>
                  <td style={{ padding:'12px 6px', fontWeight:800 }}>TOTAL</td>
                  <td style={{ padding:'12px 6px', textAlign:'right', fontWeight:800 }}>£{Number(data.total.net).toFixed(2)}</td>
                  <td style={{ padding:'12px 6px', textAlign:'right', fontWeight:800, color:'#1e40af' }}>£{Number(data.total.vat).toFixed(2)}</td>
                  <td style={{ padding:'12px 6px', textAlign:'right', fontWeight:800 }}>£{Number(data.total.gross).toFixed(2)}</td>
                  <td style={{ padding:'12px 6px', textAlign:'right', fontWeight:800, color:'#888' }}>{data.total.items || 0}</td>
                </tr>
              </tbody>
            </table>
            {/* Korakot 2026-06-02: Food / Drink split — same numbers
                broken down by categories.is_bar so the operator can sanity
                check the VAT against till receipts (e.g. drink should be
                100% 20% rated; food can be 20% / 5% / 0% depending on
                what's sold). */}
            {data.by_kind && (
              <div style={{ marginTop:18, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                {[
                  { key:'food',  label:'🍽️ Food',  tone:'#0D1B3E' },
                  { key:'drink', label:'🍺 Drink', tone:'#0D1B3E' },
                ].map(k => {
                  const b = data.by_kind[k.key] || { net:0, vat:0, gross:0, items:0 };
                  return (
                    <div key={k.key} style={{ background:'#fafafa', border:'1px solid #eee', borderRadius:10, padding:14 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:k.tone, marginBottom:8 }}>{k.label}</div>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'3px 0' }}>
                        <span style={{ color:'#888' }}>Net</span>
                        <span style={{ fontWeight:700 }}>£{Number(b.net || 0).toFixed(2)}</span>
                      </div>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'3px 0' }}>
                        <span style={{ color:'#888' }}>VAT</span>
                        <span style={{ fontWeight:700, color:'#1e40af' }}>£{Number(b.vat || 0).toFixed(2)}</span>
                      </div>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, padding:'3px 0', borderTop:'1px solid #eee', marginTop:4, paddingTop:6 }}>
                        <span>Gross</span>
                        <span style={{ fontWeight:800 }}>£{Number(b.gross || 0).toFixed(2)}</span>
                      </div>
                      <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>{b.items || 0} items</div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize:11, color:'#aaa', marginTop:14, lineHeight:1.5 }}>
              Prices are VAT-inclusive (UK hospitality convention): net = gross × 100 / (100 + rate).
              Per-item discounts are applied before the split; the optional 12.5% service charge
              and any bill-level discounts sit outside this report.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Print body builder ────────────────────────────────────────────
function buildVatBody(data, from, to, settings, thermal) {
  const head = thermal
    ? `<div class="center" style="font-size:13px;font-weight:900;letter-spacing:1px;">${restaurantName(settings)}</div>
       <div class="center small">VAT REPORT</div>
       <div class="center small muted">${dateLabel(from)} → ${dateLabel(to)}</div>
       <div class="center small muted">${nowStamp()}</div>
       <hr class="divider"/>`
    : `<h1>${restaurantName(settings)} — VAT Report</h1>
       <div class="sub"><span class="pill">PERIOD</span> &nbsp; ${dateLabel(from)} → ${dateLabel(to)}</div>`;

  const breakdown = `
    ${thermal ? '<div class="section-head">By Rate</div>' : '<h2>By Rate</h2>'}
    <table>
      <tr><td>Rate</td><td class="right">Net</td><td class="right">VAT</td><td class="right">Gross</td></tr>
      ${data.breakdown.map(b => `<tr>
        <td>${Number(b.rate).toFixed(0)}%</td>
        <td class="right">${fmt(b.net)}</td>
        <td class="right">${fmt(b.vat)}</td>
        <td class="right">${fmt(b.gross)}</td>
      </tr>`).join('')}
      <tr class="total-row">
        <td>TOTAL</td>
        <td class="right">${fmt(data.total.net)}</td>
        <td class="right">${fmt(data.total.vat)}</td>
        <td class="right">${fmt(data.total.gross)}</td>
      </tr>
    </table>`;

  const byKind = data.by_kind ? `
    ${thermal ? '<hr class="divider"/><div class="section-head">By Category</div>' : '<h2>By Category</h2>'}
    <table>
      <tr><td>🍽️ Food (${fmtInt(data.by_kind.food.items)} items)</td><td class="right">${fmt(data.by_kind.food.gross)}</td></tr>
      <tr><td>🍺 Drink (${fmtInt(data.by_kind.drink.items)} items)</td><td class="right">${fmt(data.by_kind.drink.gross)}</td></tr>
    </table>` : '';

  return head + breakdown + byKind;
}

// ── ESC/POS line builder ──────────────────────────────────────────
function buildVatLines(data, from, to, settings) {
  const lines = [];
  lines.push({ kind: 'h1', text: restaurantName(settings) });
  lines.push({ kind: 'h2', text: 'VAT REPORT' });
  lines.push({ kind: 'small', text: `${dateLabel(from)} -> ${dateLabel(to)}` });
  lines.push({ kind: 'small', text: nowStamp() });
  lines.push({ kind: 'div' });
  for (const b of data.breakdown) {
    lines.push({ kind: 'row',
      left: `${Number(b.rate).toFixed(0)}%  net ${fmt(b.net)}`,
      right: fmt(b.vat) });
  }
  lines.push({ kind: 'total', left: 'TOTAL VAT', right: fmt(data.total.vat) });
  lines.push({ kind: 'row', left: 'Gross total', right: fmt(data.total.gross) });
  if (data.by_kind) {
    lines.push({ kind: 'div' });
    lines.push({ kind: 'h2', text: 'BY CATEGORY' });
    lines.push({ kind: 'row', left: `Food (${fmtInt(data.by_kind.food.items)})`,   right: fmt(data.by_kind.food.gross) });
    lines.push({ kind: 'row', left: `Drink (${fmtInt(data.by_kind.drink.items)})`, right: fmt(data.by_kind.drink.gross) });
  }
  return lines;
}
