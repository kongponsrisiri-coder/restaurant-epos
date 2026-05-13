// SEPOS-044 — Floor Plan tap-to-seat action sheet.
//
// Behaviour depends on table state:
//
//   • Empty table:
//       - Lists bookings due within ±30 min that fit → tap to seat
//       - "Seat walk-in" button (uses table capacity for covers)
//       - "Pre-assign a future booking" expander for later-today bookings
//
//   • Occupied / seated table:
//       - Shows the current party + "View booking →" button
//       - Lists later-today bookings as "Assign next →" (sets table_id but
//         keeps the booking's status, so it'll be ready when the current
//         party leaves)
//
// Seating writes through the existing seatReservation / seatWalkIn
// endpoints; pre-assigning future bookings goes via PUT /api/reservations/:id
// (existing endpoint — no status change).

import { useEffect, useState } from 'react';
import { seatReservation, seatWalkIn, SERVER_URL } from '../api';

function toMins(t) {
  if (!t) return null;
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

async function putReservation(id, body) {
  const r = await fetch(`${SERVER_URL}/api/reservations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT /api/reservations/${id} ${r.status}`);
  return r.json();
}

export default function SeatActionSheet({
  table, bookings = [], currentBooking, onClose, onSeated, onViewBooking, staff,
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!table) return null;

  const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const todayIso = new Date().toISOString().slice(0, 10);
  const isOccupied = !!currentBooking;

  // Bookings due within ±30 min, not yet seated/cancelled. Used only on
  // empty tables — for the "seat now" list.
  const dueNow = bookings
    .filter(r => {
      if (currentBooking && r.id === currentBooking.id) return false;
      const date = String(r.reservation_date || '').slice(0, 10);
      if (date !== todayIso) return false;
      if (r.status !== 'pending' && r.status !== 'confirmed') return false;
      const m = toMins(r.reservation_time);
      if (m == null) return false;
      return Math.abs(m - nowMin) <= 30;
    })
    .map(r => ({ ...r, _delta: toMins(r.reservation_time) - nowMin }))
    .sort((a, b) => Math.abs(a._delta) - Math.abs(b._delta));

  // Pending/confirmed bookings later today (after the ±30-min window).
  // Used for "pre-assign to this table" on any table — including occupied
  // ones — so staff can plan the next sitting on the same table.
  const laterToday = bookings
    .filter(r => {
      if (currentBooking && r.id === currentBooking.id) return false;
      const date = String(r.reservation_date || '').slice(0, 10);
      if (date !== todayIso) return false;
      if (r.status !== 'pending' && r.status !== 'confirmed') return false;
      const m = toMins(r.reservation_time);
      if (m == null) return false;
      return (m - nowMin) > 30;  // strictly later
    })
    .sort((a, b) => toMins(a.reservation_time) - toMins(b.reservation_time));

  const seatBooking = async (booking) => {
    setBusy(true); setErr('');
    try {
      if (booking.covers > (table.capacity || 0)) {
        if (!confirm(`This booking is for ${booking.covers} guests but table ${table.table_number} seats ${table.capacity}. Seat anyway?`)) {
          setBusy(false); return;
        }
      }
      const r = await seatReservation(booking.id, {
        table_id: table.id, staff_id: staff?.id || null, open_order: true,
      });
      onSeated?.(r);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const submitWalkIn = async () => {
    setBusy(true); setErr('');
    try {
      const r = await seatWalkIn({
        table_id: table.id,
        covers: table.capacity || 1,
        customer_name: 'Walk-in',
        staff_id: staff?.id || null,
      });
      onSeated?.(r);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const assignFuture = async (booking) => {
    setBusy(true); setErr('');
    try {
      await putReservation(booking.id, {
        customer_name: booking.customer_name,
        customer_phone: booking.customer_phone,
        customer_email: booking.customer_email || null,
        covers: booking.covers,
        reservation_date: String(booking.reservation_date || '').slice(0, 10),
        reservation_time: String(booking.reservation_time || '').slice(0, 5),
        table_id: table.id,
        notes: booking.notes || null,
        status: booking.status,
      });
      onSeated?.();   // shared callback — refreshes and closes
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div style={panel}>
        <div style={header}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: 0.8 }}>Table</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0d1b3e' }}>{table.table_number}</div>
            <div style={{ fontSize: 12, color: '#666' }}>Capacity {table.capacity} · {isOccupied ? 'Occupied' : 'Empty'}</div>
          </div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        {err && <div style={errBox}>{err}</div>}

        <div style={body}>
          {/* Currently seated — shown on occupied tables */}
          {isOccupied && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionLabel}>Currently seated</div>
              <div style={{ ...candidateRow, background: '#dcfce7', borderColor: '#22c55e', cursor: 'default' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#0d1b3e' }}>
                    {currentBooking.customer_name}
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: '#16a34a' }}>· {currentBooking.covers} {currentBooking.covers === 1 ? 'guest' : 'guests'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#15803d', marginTop: 2 }}>
                    Seated {String(currentBooking.reservation_time).slice(0,5)} · status {currentBooking.status}
                    {currentBooking.notes ? ` · ${currentBooking.notes}` : ''}
                  </div>
                </div>
                <button onClick={() => onViewBooking?.(currentBooking)} style={seatBtn}>View →</button>
              </div>
            </div>
          )}

          {/* Bookings due soon — empty tables only */}
          {!isOccupied && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionLabel}>Bookings due soon (±30 min)</div>
              {dueNow.length === 0 ? (
                <div style={emptyHint}>No bookings due in the next 30 minutes.</div>
              ) : (
                dueNow.map(b => (
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
                ))
              )}

              <button onClick={submitWalkIn} disabled={busy} style={{ ...walkInBtn, opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Seating…' : `+ Seat walk-in at Table ${table.table_number}`}
              </button>
            </div>
          )}

          {/* Later today — bookings staff can pre-assign to this table.
              Shown for BOTH empty and occupied tables; on an occupied table
              this is the "what's coming next" planning view. */}
          <div>
            <div style={sectionLabel}>
              {isOccupied ? 'Assign next sitting on this table' : 'Pre-assign a later booking'}
            </div>
            {laterToday.length === 0 ? (
              <div style={emptyHint}>No more bookings today.</div>
            ) : (
              laterToday.map(b => {
                const alreadyOnThisTable = b.table_id === table.id;
                return (
                  <button key={b.id} onClick={() => !alreadyOnThisTable && assignFuture(b)}
                    disabled={busy || alreadyOnThisTable}
                    style={{ ...candidateRow, opacity: alreadyOnThisTable ? 0.65 : 1 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: '#0d1b3e' }}>
                        {b.customer_name}
                        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: '#64748b' }}>· {b.covers} {b.covers === 1 ? 'guest' : 'guests'}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {String(b.reservation_time).slice(0,5)}{b.table_id ? ` · currently on T${b.table_id === table.id ? table.table_number : '?'}` : ''}
                        {b.notes ? ` · ${b.notes}` : ''}
                      </div>
                    </div>
                    <span style={seatBtn}>
                      {alreadyOnThisTable ? 'Assigned' : 'Assign →'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div style={footer}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
        </div>
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
  background: 'white', borderRadius: 16, width: 'min(480px, 100%)',
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
  color: '#94a3b8', fontSize: 13, padding: '12px 8px', textAlign: 'center',
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
  marginTop: 10, width: '100%', padding: '14px',
  background: '#0f766e', color: 'white', border: 'none',
  borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: 'pointer',
};
const ghostBtn = {
  background: 'transparent', color: '#475569', border: '1px solid #cbd5e1',
  padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const errBox = {
  margin: '12px 20px 0', padding: '10px 12px', background: '#fee2e2',
  color: '#991b1b', borderRadius: 8, fontSize: 13,
};
