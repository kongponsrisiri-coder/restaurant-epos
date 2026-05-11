import { useState, useEffect } from 'react';
import { getVatReport } from '../../api';

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
        <button onClick={exportCsv} disabled={!data || !data.breakdown?.length} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: data?.breakdown?.length ? '#C9A84C' : '#e5d9b2',
          color:'#0D1B3E', fontWeight:700, fontSize:13,
          cursor: data?.breakdown?.length ? 'pointer' : 'not-allowed'
        }}>⬇ Export CSV</button>
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
            <div style={{ fontSize:11, color:'#aaa', marginTop:14, lineHeight:1.5 }}>
              Prices are VAT-inclusive (UK hospitality convention): net = gross × 100 / (100 + rate).
              Service charge and bill-level discounts are out of scope of this report.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
