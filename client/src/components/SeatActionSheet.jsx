// SEPOS-044 — Tap-to-seat action sheet.
// Opens when an empty table is tapped on the Reservations > Plan >
// Floor Plan view. Two paths:
//   1. Seat an upcoming booking (within ±30 min of now, fits capacity)
//   2. Seat a walk-in (party size required, name + phone optional)

import { useState, useEffect } from 'react';
import { seatReservation, seatWalkIn } from '../api';

function toMins(t) {
  if (!t) return null;
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

export default function SeatActionSheet({ table, bookings = [], onClose, onSeated, staff }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkIn, setWalkIn] = useState({
    covers: '',
    customer_name: '',
    customer_phone: '',
  });

  // Esc to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!table) return null;

  const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const todayIso = new Date().toISOString().slice(0, 10);

  // Today's bookings within ±30 min of now, not yet seated/cancelled.
  // Sorted by "closest to now first".
  const candidates = bookings
    .filter(r => {
      const date = String(r.reservation_date || '').slice(0, 10);
      if (date !== todayIso) return false;
      if (r.status !== 'pending' && r.status !== 'confirmed') return false;
      const m = toMins(r.reservation_time);
      if (m == null) return false;
      return Math.abs(m - nowMin) <= 30;
    })
    .map(r => ({ ...r, _delta: toMins(r.reservation_time) - nowMin }))
    .sort((a, b) => Math.abs(a._delta) - Math.abs(b._delta));

  const seatBooking = async (booking) => {
    setBusy(true); setErr('');
    try {
      if (booking.covers > (table.capacity || 0)) {
        if (!confirm(`This booking is for ${booking.covers} guests but table ${table.table_number} seats ${table.capacity}. Seat anyway?`)) {
          setBusy(false); return;
        }
      }
      const r = await seatReservation(booking.id, {
        table_id: table.id,
        staff_id: staff?.id || null,
        open_order: true,
      });
      onSeated?.(r);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const submitWalkIn = async () => {
    const covers = parseInt(walkIn.covers, 10);
    if (!covers || covers < 1) { setErr('Party size required (1+).'); return; }
    if (covers > (table.capacity || 0)) {
      if (!confirm(`Table ${table.table_number} seats ${table.capacity}. Seat a party of ${covers} anyway?`)) return;
    }
    setBusy(true); setErr('');
    try {
      const r = await seatWalkIn({
        table_id: table.id,
        covers,
        customer_name: walkIn.customer_name.trim() || 'Walk-in',
        customer_phone: walkIn.customer_phone.trim() || null,
        staff_id: staff?.id || null,
      });
      onSeated?.(r);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div style={panel}>
        <div style={header}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: 0.8 }}>Seat at</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0d1b3e' }}>Table {table.table_number}</div>
            <div style={{ fontSize: 12, color: '#666' }}>Capacity {table.capacity}</div>
          </div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        {err && <div style={errBox}>{err}</div>}

        {!walkInOpen && (
          <div style={body}>
            <div style={sectionLabel}>Bookings due soon (±30 min)</div>
            {candidates.length === 0 ? (
              <div style={emptyHint}>No bookings due in the next 30 minutes.</div>
            ) : (
              <div>
                {candidates.map(b => (
                  <button key={b.id} onClick={() => seatBooking(b)} disabled={busy} style={candidateRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: '#0d1b3e' }}>
                        {b.customer_name}
                        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: '#64748b' }}>· {b.covers} {b.covers === 1 ? 'guest' : 'guests'}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {String(b.reservation_time).slice(0,5)} {b._delta < 0 ? `· ${-b._delta}m late` : b._delta === 0 ? '· now' : `· in ${b._delta}m`}
                        {b.notes ? ` · ${b.notes}` : ''}
                      </div>
                    </div>
                    <span style={seatBtn}>Seat →</span>
                  </button>
                ))}
              </div>
            )}

            <button onClick={() => setWalkInOpen(true)} style={walkInBtn}>
              + Seat a walk-in
            </button>
          </div>
        )}

        {walkInOpen && (
          <div style={body}>
            <div style={sectionLabel}>Walk-in</div>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={fieldLabel}>Party size *</label>
                <input
                  type="number" min="1" max="50" autoFocus
                  value={walkIn.covers}
                  onChange={(e) => setWalkIn(w => ({ ...w, covers: e.target.value }))}
                  style={input}
                />
              </div>
              <div>
                <label style={fieldLabel}>Customer name (optional)</label>
                <input
                  value={walkIn.customer_name}
                  onChange={(e) => setWalkIn(w => ({ ...w, customer_name: e.target.value }))}
                  style={input}
                  placeholder="Walk-in"
                />
              </div>
              <div>
                <label style={fieldLabel}>Phone (optional)</label>
                <input
                  type="tel"
                  value={walkIn.customer_phone}
                  onChange={(e) => setWalkIn(w => ({ ...w, customer_phone: e.target.value }))}
                  style={input}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => { setWalkInOpen(false); setErr(''); }} style={ghostBtn}>Back</button>
              <button onClick={submitWalkIn} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1, flex: 1 }}>
                {busy ? 'Seating…' : 'Seat walk-in'}
              </button>
            </div>
          </div>
        )}

        {!walkInOpen && (
          <div style={footer}>
            <button onClick={onClose} style={ghostBtn}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16, zIndex: 9000,
};
const panel = {
  background: 'white', borderRadius: 16, width: 'min(460px, 100%)',
  maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 30px 80px rgba(0,0,0,0.35)', overflow: 'hidden',
};
const header = {
  padding: '16px 20px', borderBottom: '1px solid #eee',
  display: 'flex', alignItems: 'flex-start', gap: 8,
};
const closeBtn = {
  marginLeft: 'auto', background: 'none', border: 'none',
  fontSize: 26, color: '#888', cursor: 'pointer', padding: 0, lineHeight: 1,
};
const body = { padding: 18, overflowY: 'auto', flex: 1 };
const footer = {
  padding: 14, borderTop: '1px solid #eee',
  display: 'flex', gap: 10, justifyContent: 'flex-end',
};
const sectionLabel = {
  fontSize: 11, fontWeight: 800, color: '#64748b',
  textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
};
const emptyHint = {
  color: '#94a3b8', fontSize: 13, padding: '14px 8px', textAlign: 'center',
  background: '#f8fafc', borderRadius: 10,
};
const candidateRow = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
  padding: '12px 14px', marginBottom: 8,
  background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
  cursor: 'pointer', textAlign: 'left', font: 'inherit',
};
const seatBtn = {
  background: '#0d1b3e', color: 'white', padding: '8px 14px',
  borderRadius: 8, fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap',
};
const walkInBtn = {
  marginTop: 14, width: '100%', padding: '14px',
  background: '#0f766e', color: 'white', border: 'none',
  borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: 'pointer',
};
const fieldLabel = {
  display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b',
  textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6,
};
const input = {
  width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1',
  borderRadius: 8, fontSize: 14, outline: 'none', fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const ghostBtn = {
  background: 'transparent', color: '#475569', border: '1px solid #cbd5e1',
  padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const primaryBtn = {
  background: '#0d1b3e', color: 'white', border: 'none',
  padding: '10px 18px', borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: 'pointer',
};
const errBox = {
  margin: '12px 20px 0', padding: '10px 12px', background: '#fee2e2',
  color: '#991b1b', borderRadius: 8, fontSize: 13,
};
