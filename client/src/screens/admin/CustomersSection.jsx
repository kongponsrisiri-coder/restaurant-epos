import { useState, useEffect, useMemo } from 'react';
import { getCustomers, setCustomerConsent, deleteCustomers, assertOk } from '../../api';
import { confirm } from '../../utils/confirm';

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

  // SEPOS-046y — optimistic consent toggle. Badge flips instantly; the PUT
  // runs in background. Mirrors the server: opt-in also clears unsubscribed.
  // No load() on success — on desktop it reads SQLite that lags cloud by up
  // to 5s and would revert the badge. Rollback to true state only on error.
  async function applyConsent(c, consent) {
    setCustomers(prev => prev.map(x => x.customer_email === c.customer_email
      ? { ...x, marketing_consent: consent ? 1 : 0, ...(consent ? { unsubscribed: 0 } : {}) }
      : x));
    try {
      assertOk(await setCustomerConsent(c.customer_email, consent));
    } catch (err) {
      alert('Could not update consent: ' + (err?.message || 'unknown'));
      load();
    }
  }

  // SEPOS-056 — delete one customer (per-row) or every customer currently
  // shown by the search/status filter. The CRM is derived, so the server
  // removes their reservations and strips their PII from takeaway orders.
  // contacts: [{ email, phone }] — identifies by email, or phone for phone-only.
  async function removeCustomers(contacts, singleLabel) {
    const list = (contacts || []).filter(c => c && (c.email || c.phone));
    if (list.length === 0) return;
    const msg = list.length === 1
      ? `Delete ${singleLabel || list[0].email || list[0].phone}?\n\nThis removes their bookings and clears their details from any takeaway orders. This cannot be undone.`
      : `Delete ${list.length} customers matching the current filter?\n\nThis removes their bookings and clears their details from any takeaway orders. This cannot be undone.`;
    if (!await confirm(msg)) return;
    try {
      const r = await deleteCustomers(list);
      assertOk(r);
      await load();
      const removed = (Number(r?.reservations_removed) || 0) + (Number(r?.orders_anonymised) || 0);
      if (removed === 0) {
        alert('Nothing was deleted — no matching bookings or orders were found for that customer. If you just updated the app, hard-refresh (Cmd/Ctrl+Shift+R) and try again.');
      }
    } catch (err) {
      alert('Could not delete: ' + (err?.message || 'unknown'));
    }
  }

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
      <h1 style={{ fontSize:22, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>👥 Customers</h1>

      {/* Status tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))', gap:10, marginBottom:16 }}>
        {/* Always-visible "All" reset — clicking a status tile filters; this
            clears it back to the full list without leaving the tab. */}
        <button onClick={() => setStatusFilter('All')} style={{
          background: statusFilter === 'All' ? 'var(--brand-primary, #1a1a2e)' : '#f1f5f9',
          color: statusFilter === 'All' ? 'white' : 'var(--brand-primary, #1a1a2e)',
          border: 'none', borderRadius: 10, padding: '14px 16px',
          textAlign: 'left', cursor: 'pointer',
          transition: 'background 0.15s, color 0.15s',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, opacity: statusFilter === 'All' ? 0.85 : 1 }}>👥 All</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{customers.length}</div>
        </button>
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
          background:'var(--brand-primary, #1a1a2e)', color:'white', fontWeight:700, fontSize:13,
          cursor: loading ? 'wait' : 'pointer'
        }}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button onClick={exportCsv} disabled={filtered.length === 0} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: filtered.length ? 'var(--brand-accent,#C9A84C)' : '#e5d9b2',
          color:'var(--brand-primary,#0D1B3E)', fontWeight:700, fontSize:13,
          cursor: filtered.length ? 'pointer' : 'not-allowed'
        }}>⬇ Export CSV</button>
        <button onClick={() => removeCustomers(filtered.map(c => ({ email: c.customer_email, phone: c.customer_phone })), null)} disabled={filtered.length === 0} style={{
          padding:'10px 18px', borderRadius:8, border:'none',
          background: filtered.length ? '#fee2e2' : '#f3e3e3',
          color: filtered.length ? '#991b1b' : '#c9a3a3', fontWeight:700, fontSize:13,
          cursor: filtered.length ? 'pointer' : 'not-allowed'
        }} title="Delete every customer currently shown by the search/filter">🗑 Delete all {filtered.length}</button>
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
                <th style={{ padding:'8px 6px', textAlign:'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const st = STATUS_STYLE[c.status] || STATUS_STYLE.New;
                return (
                  <tr key={c.customer_email || i} style={{ borderTop:'1px solid #f0f0f0' }}>
                    <td style={{ padding:'10px 6px', fontWeight:600, color:'var(--brand-primary, #1a1a2e)' }}>{c.customer_name || '—'}</td>
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
                            if (!await confirm(`Re-opt-in ${c.customer_email}? They previously unsubscribed.`)) return;
                            applyConsent(c, true);
                          }}
                          style={{ background:'#fee2e2', color:'#991b1b', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Click to re-opt-in (requires operator to have fresh consent)"
                        >OPTED OUT</button>
                      ) : c.marketing_consent ? (
                        <button
                          onClick={() => applyConsent(c, false)}
                          style={{ background:'#dcfce7', color:'#166534', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Click to opt out"
                        >OPTED IN</button>
                      ) : (
                        <button
                          onClick={() => applyConsent(c, true)}
                          style={{ background:'var(--brand-primary,#0D1B3E)', color:'var(--brand-accent,#C9A84C)', padding:'3px 9px', borderRadius:6, fontSize:10, fontWeight:700, border:'none', cursor:'pointer' }}
                          title="Only opt in when you have legitimate consent (verbal, signed, etc.)"
                        >+ Opt in</button>
                      )}
                    </td>
                    <td style={{ padding:'10px 6px', textAlign:'right' }}>
                      <button
                        onClick={() => removeCustomers([{ email: c.customer_email, phone: c.customer_phone }], c.customer_name || c.customer_email || c.customer_phone)}
                        disabled={!c.customer_email && !c.customer_phone}
                        title="Delete this customer"
                        style={{ background:'#fee2e2', color:'#991b1b', padding:'4px 9px', borderRadius:6, fontSize:12, fontWeight:700, border:'none', cursor: (c.customer_email || c.customer_phone) ? 'pointer' : 'not-allowed' }}
                      >🗑</button>
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
          New widget bookings can tick consent themselves; for off-widget bookings (phone, walk-in) click <span style={{ background:'var(--brand-primary,#0D1B3E)', color:'var(--brand-accent,#C9A84C)', padding:'1px 6px', borderRadius:4, fontWeight:700 }}>+ Opt in</span> only when you have legitimate consent.
        </div>
      </div>
    </div>
  );
}
