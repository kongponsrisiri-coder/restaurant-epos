import { useState, useEffect } from 'react';
import { getStaffPerformance } from '../../api';

// SEPOS-030 — Staff Performance.
// Orders / staff member, average table turn time, starter→dessert
// upsell ratio. Pulls aggregates server-side and renders a leaderboard.

function fmtMins(m) {
  if (!Number.isFinite(m) || m <= 0) return '—';
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return h > 0 ? `${h}h ${String(rem).padStart(2, '0')}m` : `${rem}m`;
}

export default function StaffPerformanceSection() {
  const today = new Date();
  const monday = new Date(today);
  const dow = today.getDay() || 7;
  monday.setDate(today.getDate() - (dow - 1));
  const fmtDate = (d) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(fmtDate(monday));
  const [to,   setTo]   = useState(fmtDate(today));
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await getStaffPerformance(from + ' 00:00:00', to + ' 23:59:59');
      setData(Array.isArray(r) ? r : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const cardStyle = { background:'white', borderRadius:12, padding:20, marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };
  const inputStyle = { padding:'8px 10px', borderRadius:8, border:'1px solid #ddd', fontSize:13, fontFamily:'inherit' };

  return (
    <div style={{ padding:24, maxWidth:1080 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>📊 Staff Performance</h1>

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
      </div>

      <div style={cardStyle}>
        {data.length === 0 ? (
          <div style={{ color:'#888', fontSize:14 }}>No closed orders in this range.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ textAlign:'left', color:'#888', fontSize:11, textTransform:'uppercase' }}>
                <th style={{ padding:'8px 6px' }}>Staff</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Orders</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Covers</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Total sales</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Avg / cover</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Avg turn time</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Starters</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Desserts</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Dessert ratio</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s, i) => (
                <tr key={s.staff_id ?? `u-${i}`} style={{ borderTop:'1px solid #f0f0f0' }}>
                  <td style={{ padding:'10px 6px', fontWeight:600, color:'#1a1a2e' }}>
                    {s.staff_name}
                    {s.staff_role && (
                      <span style={{ marginLeft:6, fontSize:10, color:'#888', fontWeight:400 }}>· {s.staff_role}</span>
                    )}
                  </td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>{s.orders}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>{s.covers}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right', fontWeight:700 }}>£{Number(s.total_sales || 0).toFixed(2)}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>£{Number(s.avg_per_cover || 0).toFixed(2)}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>{fmtMins(s.avg_turn_mins)}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>{s.starters}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>{s.desserts}</td>
                  <td style={{ padding:'10px 6px', textAlign:'right' }}>
                    {s.starters > 0 ? (
                      <span style={{
                        background: s.dessert_ratio >= 0.5 ? '#dcfce7' : '#fef3c7',
                        color:      s.dessert_ratio >= 0.5 ? '#166534' : '#92400e',
                        padding:'3px 8px', borderRadius:6, fontWeight:700, fontSize:11
                      }}>
                        {(s.dessert_ratio * 100).toFixed(0)}%
                      </span>
                    ) : <span style={{ color:'#bbb' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize:11, color:'#aaa', marginTop:14, lineHeight:1.5 }}>
          Dessert ratio = desserts ordered ÷ starters ordered — proxy for upsell effectiveness.
          Orders created before SEPOS-030 was deployed show as <strong>Unassigned</strong>.
        </div>
      </div>
    </div>
  );
}
