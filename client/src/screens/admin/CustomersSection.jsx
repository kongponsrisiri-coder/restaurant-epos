import { useState, useEffect, useMemo } from 'react';
import { getCustomers, setCustomerConsent } from '../../api';

// SEPOS-033 Phase 1 — Customer CRM.
// Aggregates reservations by email, computes status from visits + spend.
// Filter + search + CSV export. Phase 2 will add campaign sending.

const STATUS_STYLE = {
  VIP:     { bg: '#ede9fe', color: '#5b21b6', icon: '⭐' },
  Regular: { bg: '#dbeafe', color: '#1e40af', icon: '🔁' },
  New:     { bg: '#dcfce7', color: '#166534', icon: '🆕' },
  Lapsed:  { bg: '#fee2e2', color: '#991b1b', icon: '😴' },
};

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

export default function CustomersSection() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');

  async function load() {
    setLoading(true);
    try {
      const data = await getCustomers();
      setCustomers(Array.isArray(data) ? data : []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter(c => {
      if (statusFilter !== 'All' && c.status !== statusFilter) return false;
      if (!q) return true;
      const hay = `${c.customer_name || ''} ${c.customer_email || ''} ${c.customer_phone || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [customers, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { VIP: 0, Regular: 0, New: 0, Lapsed: 0 };
    for (const x of customers) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [customers]);

  function exportCsv() {
    const rows = [['Name', 'Email', 'Phone', 'Status', 'Visits', 'First visit', 'Last visit', 'Total spend (est.)', 'Marketing consent', 'Unsubscribed']];
    for (const c of filtered) {
      rows.push([
        c.customer_name || '',
        c.customer_email || '',
        c.customer_phone || '',
        c.status,
        c.total_visits,
        c.first_visit || '',
        c.last_visit  || '',
        Number(c.total_spend || 0).toFixed(2),
        c.marketing_consent ? 'Yes' : 'No',
        c.unsubscribed      ? 'Yes' : 'No',
      ]);
    }
    downloadCsv(`customers_${new Date().toISOString().slice(0,10)}.csv`, rows);
  }

  const cardStyle = { background:'white', borderRadius:12, padding:20, marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };
  const inputStyle = { padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:13, fontFamily:'inherit' };
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';

  return (
    <div style={{ padding:24, maxWidth:1180 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>👥 Customers</h1>

      {/* Status tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))', gap:10, marginBottom:16 }}>
        {['VIP', 'Regular', 'New', 'Lapsed'].map(s => {
          const st = STATUS_STYLE[s];
          const active = statusFilter === s;
          return (
            <button key={s} onClick={() => setStatusFilter(active ? 'All' : s)} style={{
              background: active ? st.color : st.bg,
              color: active ? 'white' : st.color,
              border: 'none', borderRadius: 10, padding: '14px 16px',
              textAlign: 'left', cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, opacity: active ? 0.85 : 1 }}>
                {st.icon} {s}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{counts[s] || 0}</div>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div style={{ ...cardStyle, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email or phone…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
          <option value="All">All statuses</option>
          <option value="VIP">VIP</option>
          <option value="Regular">Regular</option>
          <option value="New">New</option>
          <option value="Lapsed">Lapsed</option>
        </select>
        <button onClick={load} disabled={loading} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background:'#1a1a2e', color:'white', fontWeight:700, fontSize:13,
          cursor: loading ? 'wait' : 'pointer'
        }}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button onClick={exportCsv} disabled={filtered.length === 0} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: filtered.length ? '#C9A84C' : '#e5d9b2',
          color:'#0D1B3E', fontWeight:700, fontSize:13,
          cursor: filtered.length ? 'pointer' : 'not-allowed'
        }}>⬇ Export CSV</button>
      </div>

      {/* Table */}
      <div style={cardStyle}>
        {filtered.length === 0 ? (
          <div style={{ color:'#888', fontSize:14 }}>
            {customers.length === 0 ? 'No customers yet — they\'ll appear here once reservations come in.' : 'No customers match the current filter.'}
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ textAlign:'left', color:'#888', fontSize:11, textTransform:'uppercase' }}>
                <th style={{ padding:'8px 6px' }}>Name</th>
                <th style={{ padding:'8px 6px' }}>Contact</th>
                <th style={{ padding:'8px 6px' }}>Status</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Visits</th>
                <th style={{ padding:'8px 6px' }}>First visit</th>
                <th style={{ padding:'8px 6px' }}>Last visit</th>
                <th style={{ padding:'8px 6px', textAlign:'right' }}>Spend (est.)</th>
                <th style={{ padding:'8px 6px' }}>Consent</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const st = STATUS_STYLE[c.status] || STATUS_STYLE.New;
                return (
                  <tr key={c.customer_email || i} style={{ borderTop:'1px solid #f0f0f0' }}>
                    <td style={{ padding:'10px 6px', fontWeight:600, color:'#1a1a2e' }}>{c.customer_name || '—'}</td>
                    <td style={{ padding:'10px 6px', fontSize:12, color:'#555' }}>
                      <div>{c.customer_email}</div>
                      {c.customer_phone && <div style={{ color:'#888' }}>{c.customer_phone}</div>}
                    </td>
                    <td style={{ padding:'10px 6px' }}>
                      <span style={{
                        background: st.bg, color: st.color,
                        padding:'3px 10px', borderRadius:12,
                        fontSize:11, fontWeight:700
                      }}>{st.icon} {c.status}</span>
                    </td>
                    <td style={{ padding:'10px 6px', textAlign:'right', fontWeight:700 }}>{c.total_visits}</td>
                    <td style={{ padding:'10px 6px', color:'#555' }}>{fmtDate(c.first_visit)}</td>
                    <td style={{ padding:'10px 6px', color:'#555' }}>
                      {fmtDate(c.last_visit)}
                      {c.days_since_last != null && c.days_since_last > 0 && (
                        <div style={{ fontSize:10, color:'#888' }}>{c.days_since_last}d ago</div>
                      )}
                    </td>
                    <td style={{ padding:'10px 6px', textAlign:'right', fontWeight:700 }}>£{Number(c.total_spend || 0).toFixed(2)}</td>
                    <td style={{ padding:'10px 6px' }}>
                      {c.unsubscribed ? (
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Re-opt-in ${c.customer_email}? They previously unsubscribed.`)) return;
                            await setCustomerConsent(c.customer_email, true); load();
                          }}
                          style={{ background:'#fee2e2', color:'#991b1b', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Click to re-opt-in (requires operator to have fresh consent)"
                        >OPTED OUT</button>
                      ) : c.marketing_consent ? (
                        <button
                          onClick={async () => { await setCustomerConsent(c.customer_email, false); load(); }}
                          style={{ background:'#dcfce7', color:'#166534', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Click to opt out"
                        >OPTED IN</button>
                      ) : (
                        <button
                          onClick={async () => { await setCustomerConsent(c.customer_email, true); load(); }}
                          style={{ background:'#0D1B3E', color:'#C9A84C', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Only opt in when you have legitimate consent (verbal, signed, etc.)"
                        >+ Opt in</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ fontSize:11, color:'#aaa', marginTop:14, lineHeight:1.5 }}>
          Status: <strong>VIP</strong> = 5+ visits or £200+ lifetime · <strong>Regular</strong> = 2-4 visits · <strong>New</strong> = 1 visit · <strong>Lapsed</strong> = no visit in 60+ days.
          Spend estimate joins orders on table_id + reservation date — accuracy will improve once orders are explicitly linked to reservations.
          <br/><br/>
          <strong>Marketing consent:</strong> only <span style={{ background:'#dcfce7', color:'#166534', padding:'1px 6px', borderRadius:4, fontWeight:700 }}>OPTED IN</span> customers receive campaigns.
          New widget bookings can tick consent themselves; for off-widget bookings (phone, walk-in) click <span style={{ background:'#0D1B3E', color:'#C9A84C', padding:'1px 6px', borderRadius:4, fontWeight:700 }}>+ Opt in</span> only when you have legitimate consent.
        </div>
      </div>
    </div>
  );
}
