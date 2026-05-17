import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn, input, label } from '../theme.js';

const STATUS_COLOURS = {
  confirmed:  { bg: '#dcfce7', color: '#15803d' },
  pending:    { bg: '#fef9c3', color: '#a16207' },
  cancelled:  { bg: '#fee2e2', color: '#dc2626' },
  completed:  { bg: '#e0f2fe', color: '#0369a1' },
  no_show:    { bg: '#f3e8ff', color: '#7e22ce' },
};

export default function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [date, setDate]         = useState(today());
  const [status, setStatus]     = useState('');
  const [search, setSearch]     = useState('');

  useEffect(() => { load(); }, [date, status]);

  const load = () => {
    setLoading(true); setError('');
    const params = { limit: 100 };
    if (date)   params.date   = date;
    if (status) params.status = status;
    api.getBookings(params)
      .then(setBookings)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  const filtered = bookings.filter(b => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (b.customer_name || '').toLowerCase().includes(q)
        || (b.customer_email || '').toLowerCase().includes(q)
        || (b.customer_phone || '').toLowerCase().includes(q);
  });

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Bookings</h1>
        <p style={{ margin: '5px 0 0', color: C.textMuted, fontSize: 14 }}>View and manage your table reservations.</p>
      </div>

      {/* Filters */}
      <div style={{ ...card, padding: '16px 20px', marginBottom: 20, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={label}>Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...input, width: 'auto' }} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={label}>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...input, width: 'auto' }}>
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
            <option value="completed">Completed</option>
            <option value="no_show">No-show</option>
          </select>
        </div>
        <div style={{ flex: '2 1 200px' }}>
          <label style={label}>Search</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, email, phone…" style={input} />
        </div>
        <button onClick={load} style={{ ...btn.ghost, flexShrink: 0 }}>Refresh</button>
      </div>

      {/* Summary chips */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {['confirmed','pending','cancelled','completed','no_show'].map(s => {
          const count = bookings.filter(b => b.status === s).length;
          if (!count) return null;
          const col = STATUS_COLOURS[s] || {};
          return (
            <span key={s} style={{ padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, background: col.bg, color: col.color }}>
              {s.replace('_',' ')} · {count}
            </span>
          );
        })}
        {bookings.length > 0 && (
          <span style={{ padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, background: C.surfaceAlt, color: C.textMuted }}>
            {bookings.reduce((a,b) => a + (b.party_size || 0), 0)} covers total
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ ...card, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.textFaint, fontSize: 14 }}>Loading bookings…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: C.textFaint }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
            <div style={{ fontSize: 14 }}>No bookings found for the selected filters.</div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.bg }}>
                {['Time', 'Guest', 'Party', 'Contact', 'Notes', 'Status'].map(h => (
                  <th key={h} style={{ padding: '11px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${C.border}` }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((b, i) => {
                const col = STATUS_COLOURS[b.status] || { bg: C.surfaceAlt, color: C.textMuted };
                return (
                  <tr key={b.id} style={{ background: i % 2 === 0 ? '#fff' : C.bg }}>
                    <td style={td}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{formatDate(b.reservation_date)}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{formatTime(b.reservation_date)}</div>
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{b.customer_name || '—'}</div>
                    </td>
                    <td style={td}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{b.party_size}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}> guests</span>
                    </td>
                    <td style={td}>
                      {b.customer_email && <div style={{ fontSize: 12, color: C.text }}>{b.customer_email}</div>}
                      {b.customer_phone && <div style={{ fontSize: 12, color: C.textMuted }}>{b.customer_phone}</div>}
                    </td>
                    <td style={{ ...td, maxWidth: 180 }}>
                      {b.notes ? (
                        <span style={{ fontSize: 12, color: C.textMuted, fontStyle: 'italic' }}>{b.notes}</span>
                      ) : (
                        <span style={{ fontSize: 12, color: C.textFaint }}>—</span>
                      )}
                    </td>
                    <td style={td}>
                      <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: col.bg, color: col.color, textTransform: 'capitalize' }}>
                        {(b.status || 'pending').replace('_',' ')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: C.textFaint, textAlign: 'right' }}>
        {filtered.length} booking{filtered.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}

const td = { padding: '12px 16px', borderBottom: `1px solid ${C.borderSoft}`, verticalAlign: 'top' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
