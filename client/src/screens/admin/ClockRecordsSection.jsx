import { useState, useEffect } from 'react';
import { getClockRecords } from '../../api';

// SEPOS-022 — Clock Records.
// Server returns the raw events ordered by (staff_id, event_at);
// we pair consecutive in→out into sessions here in the browser.

const OT_THRESHOLD = 40; // hours/week — flag anything over this

function isoWeek(d) {
  // Monday-start ISO week key (YYYY-WW) for grouping.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function fmtHours(h) {
  if (!Number.isFinite(h) || h <= 0) return '0h';
  const hours = Math.floor(h);
  const mins  = Math.round((h - hours) * 60);
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

function pairSessions(events) {
  // events come ordered by (staff_id, event_at, id). Walk per-staff and
  // pair an 'in' with the next 'out'. Dangling 'in' = still clocked in
  // (renders as 'In progress'); dangling 'out' without an 'in' is dropped.
  const byStaff = {};
  for (const ev of events) {
    if (!byStaff[ev.staff_id]) byStaff[ev.staff_id] = { name: ev.staff_name, role: ev.staff_role, sessions: [], openIn: null };
    const bucket = byStaff[ev.staff_id];
    if (ev.event_type === 'in') {
      if (bucket.openIn) {
        bucket.sessions.push({ in: bucket.openIn, out: null });
      }
      bucket.openIn = ev.event_at;
    } else if (ev.event_type === 'out') {
      if (bucket.openIn) {
        bucket.sessions.push({ in: bucket.openIn, out: ev.event_at });
        bucket.openIn = null;
      }
    }
  }
  for (const id of Object.keys(byStaff)) {
    if (byStaff[id].openIn) {
      byStaff[id].sessions.push({ in: byStaff[id].openIn, out: null });
    }
  }
  return byStaff;
}

function sessionHours(s) {
  if (!s.out) return 0;
  return (new Date(s.out) - new Date(s.in)) / 36e5;
}

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

export default function ClockRecordsSection() {
  // Default: this week (Mon → today).
  const today = new Date();
  const monday = new Date(today);
  const dow = today.getDay() || 7;
  monday.setDate(today.getDate() - (dow - 1));
  const fmtDate = (d) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(fmtDate(monday));
  const [to,   setTo]   = useState(fmtDate(today));
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await getClockRecords(from + ' 00:00:00', to + ' 23:59:59');
      setEvents(Array.isArray(data) ? data : []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const byStaff = pairSessions(events);
  // Total hours per staff (any week within the range)
  const summary = Object.entries(byStaff).map(([id, b]) => {
    const total = b.sessions.reduce((sum, s) => sum + sessionHours(s), 0);
    // Group sessions by ISO week → max-week-hours to flag OT
    const perWeek = {};
    for (const s of b.sessions) {
      const k = isoWeek(new Date(s.in));
      perWeek[k] = (perWeek[k] || 0) + sessionHours(s);
    }
    const maxWeek = Math.max(0, ...Object.values(perWeek));
    return { id, name: b.name, role: b.role, sessions: b.sessions, totalHours: total, maxWeekHours: maxWeek, overtime: maxWeek > OT_THRESHOLD };
  }).sort((a, b) => b.totalHours - a.totalHours);

  function exportCsv() {
    const rows = [['Staff', 'Role', 'Date', 'Clock In', 'Clock Out', 'Hours']];
    for (const s of summary) {
      for (const sess of s.sessions) {
        const inD  = new Date(sess.in);
        const outD = sess.out ? new Date(sess.out) : null;
        rows.push([
          s.name,
          s.role || '',
          inD.toISOString().slice(0, 10),
          inD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          outD ? outD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'IN PROGRESS',
          outD ? sessionHours(sess).toFixed(2) : '',
        ]);
      }
      rows.push([s.name, s.role || '', '', '', 'TOTAL', s.totalHours.toFixed(2)]);
    }
    downloadCsv(`clock-records_${from}_to_${to}.csv`, rows);
  }

  const cardStyle = { background:'white', borderRadius:12, padding:20, marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };
  const inputStyle = { padding:'8px 10px', borderRadius:8, border:'1px solid #ddd', fontSize:13, fontFamily:'inherit' };

  return (
    <div style={{ padding:24, maxWidth:960 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🕐 Clock Records</h1>

      {/* Filters */}
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
        <button onClick={exportCsv} disabled={summary.length === 0} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: summary.length ? '#C9A84C' : '#e5d9b2',
          color:'#0D1B3E', fontWeight:700, fontSize:13,
          cursor: summary.length ? 'pointer' : 'not-allowed'
        }}>⬇ Export CSV</button>
      </div>

      {/* Weekly summary */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:12 }}>Summary</h2>
        {summary.length === 0 ? (
          <div style={{ color:'#888', fontSize:14 }}>No clock events in this range.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ textAlign:'left', color:'#888', fontSize:11, textTransform:'uppercase' }}>
                <th style={{ padding:'6px 4px' }}>Staff</th>
                <th style={{ padding:'6px 4px' }}>Role</th>
                <th style={{ padding:'6px 4px' }}>Sessions</th>
                <th style={{ padding:'6px 4px', textAlign:'right' }}>Total hours</th>
                <th style={{ padding:'6px 4px', textAlign:'right' }}>Busiest week</th>
                <th style={{ padding:'6px 4px' }}>Overtime</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(s => (
                <tr key={s.id} style={{ borderTop:'1px solid #f0f0f0' }}>
                  <td style={{ padding:'8px 4px', fontWeight:600, color:'#1a1a2e' }}>{s.name}</td>
                  <td style={{ padding:'8px 4px', color:'#666' }}>{s.role || '—'}</td>
                  <td style={{ padding:'8px 4px', color:'#666' }}>{s.sessions.length}</td>
                  <td style={{ padding:'8px 4px', textAlign:'right', fontWeight:700 }}>{fmtHours(s.totalHours)}</td>
                  <td style={{ padding:'8px 4px', textAlign:'right' }}>{fmtHours(s.maxWeekHours)}</td>
                  <td style={{ padding:'8px 4px' }}>
                    {s.overtime ? (
                      <span style={{ background:'#fee2e2', color:'#ef4444', padding:'3px 8px', borderRadius:6, fontSize:11, fontWeight:700 }}>
                        OT · {fmtHours(s.maxWeekHours - OT_THRESHOLD)}
                      </span>
                    ) : (
                      <span style={{ color:'#aaa', fontSize:11 }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Per-session detail */}
      {summary.map(s => (
        <div key={s.id} style={cardStyle}>
          <h3 style={{ fontSize:14, fontWeight:700, color:'#1a1a2e', marginBottom:10 }}>
            {s.name} <span style={{ color:'#888', fontWeight:400 }}>· {fmtHours(s.totalHours)}</span>
          </h3>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ textAlign:'left', color:'#888', fontSize:10, textTransform:'uppercase' }}>
                <th style={{ padding:'5px 4px' }}>Date</th>
                <th style={{ padding:'5px 4px' }}>In</th>
                <th style={{ padding:'5px 4px' }}>Out</th>
                <th style={{ padding:'5px 4px', textAlign:'right' }}>Hours</th>
              </tr>
            </thead>
            <tbody>
              {s.sessions.map((sess, i) => {
                const inD  = new Date(sess.in);
                const outD = sess.out ? new Date(sess.out) : null;
                return (
                  <tr key={i} style={{ borderTop:'1px solid #f5f5f5' }}>
                    <td style={{ padding:'5px 4px' }}>{inD.toLocaleDateString('en-GB', { day:'2-digit', month:'short' })}</td>
                    <td style={{ padding:'5px 4px' }}>{inD.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}</td>
                    <td style={{ padding:'5px 4px' }}>
                      {outD ? outD.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
                            : <span style={{ color:'#f59e0b', fontWeight:700 }}>IN PROGRESS</span>}
                    </td>
                    <td style={{ padding:'5px 4px', textAlign:'right', fontWeight:600 }}>{outD ? fmtHours(sessionHours(sess)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
