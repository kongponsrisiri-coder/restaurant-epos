import React, { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host.startsWith('192.168.') || host.startsWith('10.'))
    return window.location.origin;
  return 'https://restaurant-epos-production.up.railway.app';
})();

// ── Sandy: Status colours aligned to SiamEPOS Brand CI ───────────
const STATUS_CONFIG = {
  pending:   { label: 'Pending',   bg: '#fef9c3', color: '#92400e', dot: '#f59e0b' },
  confirmed: { label: 'Confirmed', bg: '#dbeafe', color: '#1e40af', dot: '#3b82f6' },
  seated:    { label: 'Seated',    bg: '#dcfce7', color: '#14532d', dot: '#22c55e' },
  'no-show': { label: 'No Show',   bg: '#fee2e2', color: '#991b1b', dot: '#ef4444' },
  cancelled: { label: 'Cancelled', bg: '#f3f4f6', color: '#4b5563', dot: '#6b7280' },
};

const ALL_STATUSES = ['all', 'pending', 'confirmed', 'seated', 'no-show', 'cancelled'];

const TIME_SLOTS = [];
for (let h = 11; h <= 22; h++) {
  for (let m = 0; m < 60; m += 15) {
    if (h === 22 && m > 30) break;
    TIME_SLOTS.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  }
}

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

const BLANK_FORM = {
  customer_name: '', customer_phone: '', customer_email: '',
  covers: 2, reservation_date: '', reservation_time: '19:00',
  table_id: '', notes: '', status: 'pending',
};

function todayStr() { return new Date().toISOString().split('T')[0]; }

async function apiFetch(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return res.json();
}

// ── Sandy: Derive customer profiles from reservations data ────────
// Groups by phone number as unique key. No new backend endpoints needed.
function deriveCustomers(reservations) {
  const map = {};
  reservations.forEach(r => {
    const key = r.customer_phone?.trim() || r.customer_name?.trim() || r.id;
    if (!map[key]) {
      map[key] = {
        key,
        name:  r.customer_name || '',
        phone: r.customer_phone || '',
        email: r.customer_email || '',
        visits: [],
      };
    }
    // Always use the most recent name for this phone number
    if (r.customer_name) map[key].name = r.customer_name;
    map[key].visits.push(r);
  });

  return Object.values(map)
    .map(c => {
      const seated    = c.visits.filter(v => v.status === 'seated');
      const sortedAll = [...c.visits].sort((a, b) =>
        (b.reservation_date || '').localeCompare(a.reservation_date || '')
      );
      const visitCount = seated.length;
      const tag = visitCount >= 5 ? 'VIP' : visitCount >= 2 ? 'Regular' : 'New';
      const tagColor = tag === 'VIP' ? { bg: '#fef9c3', color: '#92400e', dot: '#C9A84C' }
                     : tag === 'Regular' ? { bg: '#dbeafe', color: '#1e40af', dot: '#3b82f6' }
                     : { bg: '#f3f4f6', color: '#4b5563', dot: '#6b7280' };
      return {
        ...c,
        visitCount,
        totalBookings: c.visits.length,
        lastVisit: sortedAll[0]?.reservation_date || '',
        lastNotes: sortedAll[0]?.notes || '',
        tag, tagColor,
        sortedVisits: sortedAll,
      };
    })
    .sort((a, b) => b.totalBookings - a.totalBookings);
}

// ── Sandy: Initials avatar ────────────────────────────────────────
function Initials({ name, size = 42 }) {
  const parts = (name || '?').trim().split(' ');
  const letters = parts.length >= 2
    ? parts[0][0] + parts[parts.length - 1][0]
    : (parts[0][0] || '?');
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: '#0D1B3E', color: '#C9A84C',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 800, fontSize: size * 0.38, flexShrink: 0,
      fontFamily: "Georgia, serif",
    }}>
      {letters.toUpperCase()}
    </div>
  );
}

export default function ReservationsScreen() {
  const [view, setView]                 = useState('list');
  const [reservations, setReservations] = useState([]);
  const [tables, setTables]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [filterDate, setFilterDate]     = useState(todayStr());
  const [filterStatus, setFilterStatus] = useState('all');
  const [calDate, setCalDate]           = useState(new Date());
  const [showModal, setShowModal]       = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [form, setForm]                 = useState({ ...BLANK_FORM, reservation_date: todayStr() });
  const [saving, setSaving]             = useState(false);
  const [toast, setToast]               = useState(null);
  const [newAlert, setNewAlert]         = useState(null);
  // Customer Records state
  const [customerSearch, setCustomerSearch]       = useState('');
  const [selectedCustomer, setSelectedCustomer]   = useState(null);
  const socketRef                       = useRef(null);

  // ── Load data ────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      const [res, tbls] = await Promise.all([
        apiFetch('/api/reservations'),
        apiFetch('/api/tables'),
      ]);
      setReservations(Array.isArray(res) ? res : []);
      setTables(Array.isArray(tbls) ? tbls : []);
    } catch {
      showToast('Error loading data', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Socket.io ────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('new_reservation', (reservation) => {
      setReservations(prev => {
        const exists = prev.find(r => r.id === reservation.id);
        if (exists) return prev;
        return [...prev, reservation];
      });
      setNewAlert(`New booking from ${reservation.source === 'widget' ? '🌐 website' : 'EPOS'}: ${reservation.customer_name} × ${reservation.covers} on ${reservation.reservation_date}`);
      setTimeout(() => setNewAlert(null), 6000);
    });
    socket.on('reservation_updated', (reservation) => {
      setReservations(prev => prev.map(r => r.id === reservation.id ? { ...r, ...reservation } : r));
    });
    socket.on('reservation_cancelled', ({ id }) => {
      setReservations(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled' } : r));
    });
    return () => socket.disconnect();
  }, []);

  // ── Toast ────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Modal ────────────────────────────────────────────────────
  function openAdd() {
    setEditingId(null);
    setForm({ ...BLANK_FORM, reservation_date: filterDate || todayStr() });
    setShowModal(true);
  }

  function openEdit(r) {
    setEditingId(r.id);
    setForm({
      customer_name:    r.customer_name || '',
      customer_phone:   r.customer_phone || '',
      customer_email:   r.customer_email || '',
      covers:           r.covers || 2,
      reservation_date: (r.reservation_date || '').split('T')[0],
      reservation_time: (r.reservation_time || '').slice(0, 5),
      table_id:         r.table_id || '',
      notes:            r.notes || '',
      status:           r.status || 'pending',
    });
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditingId(null); }

  async function handleSave() {
    if (!form.customer_name.trim()) { showToast('Guest name required', 'error'); return; }
    if (!form.reservation_date)     { showToast('Date required', 'error'); return; }
    if (!form.reservation_time)     { showToast('Time required', 'error'); return; }
    if (!form.covers || form.covers < 1) { showToast('Covers must be at least 1', 'error'); return; }
    setSaving(true);
    try {
      const payload = { ...form, table_id: form.table_id || null, source: 'epos' };
      if (editingId) {
        await apiFetch(`/api/reservations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Booking updated ✓');
      } else {
        await apiFetch('/api/reservations', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Booking created ✓');
      }
      closeModal();
      loadData();
    } catch {
      showToast('Save failed — try again', 'error');
    } finally {
      setSaving(false);
    }
  }

  // ── Actions — unchanged logic ─────────────────────────────────
  async function handleSeat(r) {
    if (!window.confirm(`Seat ${r.customer_name} (${r.covers} covers)?`)) return;
    try {
      await apiFetch(`/api/reservations/${r.id}/seat`, { method: 'POST' });
      showToast(`${r.customer_name} seated ✓`);
      loadData();
    } catch { showToast('Seating failed', 'error'); }
  }

  async function handleConfirm(r) {
    try {
      await apiFetch(`/api/reservations/${r.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...r,
          reservation_date: (r.reservation_date || '').split('T')[0],
          reservation_time: (r.reservation_time || '').slice(0, 5),
          status: 'confirmed',
        }),
      });
      showToast('Confirmed ✓');
      loadData();
    } catch { showToast('Update failed', 'error'); }
  }

  async function handleNoShow(r) {
    if (!window.confirm(`Mark ${r.customer_name} as no-show?`)) return;
    try {
      await apiFetch(`/api/reservations/${r.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...r,
          reservation_date: (r.reservation_date || '').split('T')[0],
          reservation_time: (r.reservation_time || '').slice(0, 5),
          status: 'no-show',
        }),
      });
      showToast('Marked as no-show');
      loadData();
    } catch { showToast('Update failed', 'error'); }
  }

  async function handleCancel(r) {
    if (!window.confirm(`Cancel ${r.customer_name}'s booking?`)) return;
    try {
      await apiFetch(`/api/reservations/${r.id}`, { method: 'DELETE' });
      showToast('Booking cancelled');
      loadData();
    } catch { showToast('Cancel failed', 'error'); }
  }

  // ── Filter ───────────────────────────────────────────────────
  const filtered = reservations.filter(r => {
    const dateOk   = filterDate ? (r.reservation_date || '').startsWith(filterDate) : true;
    const statusOk = filterStatus === 'all'
      ? r.status !== 'cancelled'
      : r.status === filterStatus;
    return dateOk && statusOk;
  });

  const counts = {};
  ALL_STATUSES.forEach(s => {
    const base = reservations.filter(r => filterDate ? (r.reservation_date || '').startsWith(filterDate) : true);
    counts[s] = s === 'all' ? base.filter(r => r.status !== 'cancelled').length : base.filter(r => r.status === s).length;
  });

  // ── Calendar ─────────────────────────────────────────────────
  const calYear     = calDate.getFullYear();
  const calMonth    = calDate.getMonth();
  const firstDow    = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayDate   = new Date();

  function resForDay(day) {
    const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return reservations.filter(r => (r.reservation_date||'').startsWith(ds) && r.status !== 'cancelled');
  }

  function calDayClick(day) {
    const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    setFilterDate(ds);
    setView('list');
  }

  // ── Customer Records ─────────────────────────────────────────
  const customers = deriveCustomers(reservations);
  const filteredCustomers = customers.filter(c => {
    if (!customerSearch) return true;
    const q = customerSearch.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) ||
           (c.phone || '').includes(q) ||
           (c.email || '').toLowerCase().includes(q);
  });

  function formatDate(ds) {
    if (!ds) return '—';
    try {
      return new Date(ds.split('T')[0] + 'T12:00:00')
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ds; }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.type === 'error' ? '#ef4444' : '#22c55e',
          color: 'white', padding: '14px 22px', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)', fontWeight: 700, fontSize: 15,
        }}>
          {toast.msg}
        </div>
      )}

      {/* New booking alert banner — Sandy: Deep Navy + Thai Gold */}
      {newAlert && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
          background: '#0D1B3E', color: 'white',
          padding: '12px 24px', textAlign: 'center',
          fontWeight: 700, fontSize: 15,
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          borderBottom: '2px solid #C9A84C',
        }}>
          🔔 {newAlert}
        </div>
      )}

      {/* Header — Sandy: Deep Navy, no gradient */}
      <div style={{
        background: '#0D1B3E',
        color: 'white', padding: '16px 24px',
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
        borderBottom: '2px solid rgba(201,168,76,0.3)',
      }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, fontFamily: "Georgia, serif" }}>
          🗓️ Reservations
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Sandy: 3 tabs — List, Calendar, Guests */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.12)', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(201,168,76,0.3)' }}>
            {[['list','📋 List'],['calendar','📅 Calendar'],['customers','👥 Guests']].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: '8px 14px', border: 'none', cursor: 'pointer', fontSize: 13,
                fontWeight: view === v ? 700 : 400,
                background: view === v ? '#C9A84C' : 'transparent',
                color: view === v ? '#0D1B3E' : 'white',
                transition: 'background 0.15s',
              }}>{label}</button>
            ))}
          </div>
          <button onClick={loadData} style={{
            background: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8, padding: '9px 14px', cursor: 'pointer', fontSize: 16,
          }}>↻</button>
          <button onClick={openAdd} style={{
            background: '#e94560', color: 'white', border: 'none',
            borderRadius: 8, padding: '9px 18px', cursor: 'pointer',
            fontWeight: 700, fontSize: 14,
          }}>➕ New Booking</button>
        </div>
      </div>

      {/* Filter Bar — only shown on list view */}
      {view === 'list' && (
        <div style={{
          background: 'white', padding: '12px 24px',
          display: 'flex', gap: 8, alignItems: 'center',
          flexWrap: 'wrap', borderBottom: '1px solid #eee',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}>
          <input type="date" value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }} />
          <button onClick={() => setFilterDate('')} style={{
            padding: '7px 12px', border: '1px solid #ddd', borderRadius: 6,
            fontSize: 13, cursor: 'pointer',
            background: !filterDate ? '#0D1B3E' : 'white',
            color: !filterDate ? 'white' : '#555',
          }}>All Dates</button>
          <button onClick={() => setFilterDate(todayStr())} style={{
            padding: '7px 12px', border: '1px solid #ddd', borderRadius: 6,
            fontSize: 13, cursor: 'pointer',
            background: filterDate === todayStr() ? '#0D1B3E' : 'white',
            color: filterDate === todayStr() ? 'white' : '#555',
          }}>Today</button>
          <div style={{ width: 1, height: 28, background: '#eee', margin: '0 2px' }} />
          {ALL_STATUSES.map(s => (
            <button key={s} onClick={() => setFilterStatus(s)} style={{
              padding: '6px 14px', border: 'none', borderRadius: 20, cursor: 'pointer',
              fontWeight: filterStatus === s ? 700 : 500, fontSize: 13,
              background: filterStatus === s ? '#0D1B3E' : '#f0f0f0',
              color: filterStatus === s ? 'white' : '#555',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {s === 'all' ? 'All' : STATUS_CONFIG[s]?.label || s}
              {counts[s] > 0 && (
                <span style={{
                  background: filterStatus === s ? 'rgba(255,255,255,0.25)' : '#ddd',
                  borderRadius: 10, padding: '1px 7px', fontSize: 11,
                }}>{counts[s]}</span>
              )}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', color: '#888', fontSize: 13 }}>
            {filtered.length} booking{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Main Content */}
      <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 80, color: '#888' }}>
            <div style={{ fontSize: 48 }}>⏳</div>
            <p>Loading reservations…</p>
          </div>

        ) : view === 'calendar' ? (
          /* ── CALENDAR VIEW ─────────────────────────────────────── */
          <div style={{ background: 'white', borderRadius: 14, padding: 28, boxShadow: '0 2px 10px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <button onClick={() => setCalDate(new Date(calYear, calMonth-1, 1))} style={calNavBtn}>‹</button>
              <h2 style={{ margin: 0, color: '#0D1B3E', fontSize: 22, fontFamily: 'Georgia, serif' }}>{MONTH_NAMES[calMonth]} {calYear}</h2>
              <button onClick={() => setCalDate(new Date(calYear, calMonth+1, 1))} style={calNavBtn}>›</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 6 }}>
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                <div key={d} style={{ textAlign: 'center', fontWeight: 700, color: '#888', fontSize: 12, padding: '6px 0' }}>{d}</div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
              {Array(firstDow).fill(null).map((_,i) => <div key={`e${i}`} />)}
              {Array.from({ length: daysInMonth }, (_,i) => i+1).map(day => {
                const dayRes = resForDay(day);
                const isToday = todayDate.getDate()===day && todayDate.getMonth()===calMonth && todayDate.getFullYear()===calYear;
                const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const isSel = filterDate === ds;
                return (
                  <div key={day} onClick={() => calDayClick(day)} style={{
                    minHeight: 80, padding: '6px 8px', borderRadius: 10, cursor: 'pointer',
                    border: `2px solid ${isSel ? '#0D1B3E' : isToday ? '#C9A84C' : '#f0f0f0'}`,
                    background: isSel ? '#f0f4ff' : isToday ? '#fffdf0' : 'white',
                    transition: 'border-color 0.1s',
                  }}>
                    <div style={{ fontWeight: isToday||isSel ? 800 : 400, color: isToday ? '#C9A84C' : isSel ? '#0D1B3E' : '#333', fontSize: 15, marginBottom: 4 }}>
                      {day}
                    </div>
                    {dayRes.slice(0,3).map(r => (
                      <div key={r.id} style={{
                        fontSize: 11, borderRadius: 4, padding: '2px 5px', marginBottom: 2,
                        background: STATUS_CONFIG[r.status]?.bg || '#f0f0f0',
                        color: STATUS_CONFIG[r.status]?.color || '#333',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {(r.reservation_time||'').slice(0,5)} {r.customer_name}
                      </div>
                    ))}
                    {dayRes.length > 3 && <div style={{ fontSize: 10, color: '#888' }}>+{dayRes.length-3} more</div>}
                  </div>
                );
              })}
            </div>
          </div>

        ) : view === 'customers' ? (
          /* ── CUSTOMER RECORDS VIEW ─────────────────────────────── */
          <div>
            {/* Header + search */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0D1B3E' }}>Guest Records</h2>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: '#888' }}>
                  {customers.length} guests · derived from booking history · sorted by visits
                </p>
              </div>
              <input
                value={customerSearch}
                onChange={e => { setCustomerSearch(e.target.value); setSelectedCustomer(null); }}
                placeholder="Search by name or phone…"
                style={{ padding: '10px 16px', border: '1px solid #ddd', borderRadius: 10, fontSize: 14, width: 240, outline: 'none' }}
              />
            </div>

            {/* Tag summary */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              {[
                { tag: 'VIP',     count: customers.filter(c => c.tag === 'VIP').length,     bg: '#fef9c3', color: '#92400e', dot: '#C9A84C' },
                { tag: 'Regular', count: customers.filter(c => c.tag === 'Regular').length, bg: '#dbeafe', color: '#1e40af', dot: '#3b82f6' },
                { tag: 'New',     count: customers.filter(c => c.tag === 'New').length,     bg: '#f3f4f6', color: '#4b5563', dot: '#6b7280' },
              ].map(t => (
                <div key={t.tag} style={{ background: 'white', borderRadius: 10, padding: '10px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: t.dot }} />
                  <span style={{ fontWeight: 700, fontSize: 18, color: t.color }}>{t.count}</span>
                  <span style={{ fontSize: 13, color: '#888' }}>{t.tag}</span>
                </div>
              ))}
              <div style={{ background: 'white', borderRadius: 10, padding: '10px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 18, color: '#0D1B3E' }}>{customers.reduce((s, c) => s + c.visitCount, 0)}</span>
                <span style={{ fontSize: 13, color: '#888' }}>total visits seated</span>
              </div>
            </div>

            {filteredCustomers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>👥</div>
                <p style={{ fontSize: 16 }}>No guests found</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
                {filteredCustomers.map(c => (
                  <CustomerCard
                    key={c.key}
                    customer={c}
                    isSelected={selectedCustomer === c.key}
                    onToggle={() => setSelectedCustomer(selectedCustomer === c.key ? null : c.key)}
                    onNewBooking={() => {
                      setEditingId(null);
                      setForm({
                        ...BLANK_FORM,
                        customer_name:  c.name,
                        customer_phone: c.phone,
                        customer_email: c.email,
                        reservation_date: todayStr(),
                      });
                      setShowModal(true);
                    }}
                    formatDate={formatDate}
                  />
                ))}
              </div>
            )}
          </div>

        ) : (
          /* ── LIST VIEW ─────────────────────────────────────────── */
          filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}>
              <div style={{ fontSize: 56 }}>📋</div>
              <p style={{ fontSize: 18, margin: '12px 0 4px' }}>No bookings found</p>
              <p style={{ fontSize: 14, color: '#aaa' }}>
                {filterDate
                  ? `Nothing on ${new Date(filterDate+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}`
                  : 'No bookings yet'}
              </p>
              <button onClick={openAdd} style={{
                marginTop: 18, background: '#0D1B3E', color: 'white',
                border: 'none', borderRadius: 8, padding: '10px 22px',
                cursor: 'pointer', fontWeight: 700, fontSize: 15,
              }}>➕ Add Booking</button>
            </div>
          ) : (
            filtered.map(r => (
              <ReservationCard
                key={r.id} r={r}
                onEdit={openEdit}
                onSeat={handleSeat}
                onConfirm={handleConfirm}
                onNoShow={handleNoShow}
                onCancel={handleCancel}
              />
            ))
          )
        )}
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: 20,
        }}>
          <div style={{
            background: 'white', borderRadius: 16, width: '100%', maxWidth: 560,
            maxHeight: '90vh', overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            {/* Sandy: Deep Navy modal header, Thai Gold accent */}
            <div style={{
              background: '#0D1B3E',
              padding: '20px 28px', borderRadius: '16px 16px 0 0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              borderBottom: '2px solid rgba(201,168,76,0.4)',
            }}>
              <h2 style={{ margin: 0, color: 'white', fontSize: 20, fontFamily: 'Georgia, serif' }}>
                {editingId ? '✏️ Edit Booking' : '➕ New Booking'}
              </h2>
              <button onClick={closeModal} style={{
                background: 'rgba(255,255,255,0.12)', color: 'white',
                border: 'none', borderRadius: 8, padding: '6px 12px',
                cursor: 'pointer', fontSize: 18,
              }}>✕</button>
            </div>
            <div style={{ padding: 28 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={labelSt}>Guest Name *</label>
                  <input value={form.customer_name}
                    onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                    placeholder="e.g. John Smith" style={inputSt} autoFocus />
                </div>
                <div>
                  <label style={labelSt}>Phone</label>
                  <input type="tel" value={form.customer_phone}
                    onChange={e => setForm(f => ({ ...f, customer_phone: e.target.value }))}
                    placeholder="07700 900000" style={inputSt} />
                </div>
                <div>
                  <label style={labelSt}>Email</label>
                  <input type="email" value={form.customer_email}
                    onChange={e => setForm(f => ({ ...f, customer_email: e.target.value }))}
                    placeholder="john@example.com" style={inputSt} />
                </div>
                <div>
                  <label style={labelSt}>Date *</label>
                  <input type="date" value={form.reservation_date}
                    onChange={e => setForm(f => ({ ...f, reservation_date: e.target.value }))}
                    style={inputSt} />
                </div>
                <div>
                  <label style={labelSt}>Time *</label>
                  <select value={form.reservation_time}
                    onChange={e => setForm(f => ({ ...f, reservation_time: e.target.value }))}
                    style={inputSt}>
                    {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelSt}>Covers *</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button type="button" onClick={() => setForm(f => ({ ...f, covers: Math.max(1, f.covers-1) }))} style={ctrBtnSt}>−</button>
                    <span style={{ fontSize: 20, fontWeight: 800, minWidth: 36, textAlign: 'center', color: '#0D1B3E' }}>{form.covers}</span>
                    <button type="button" onClick={() => setForm(f => ({ ...f, covers: Math.min(50, f.covers+1) }))} style={ctrBtnSt}>+</button>
                    <span style={{ color: '#888', fontSize: 13 }}>guests</span>
                  </div>
                </div>
                <div>
                  <label style={labelSt}>Table (optional)</label>
                  <select value={form.table_id}
                    onChange={e => setForm(f => ({ ...f, table_id: e.target.value }))}
                    style={inputSt}>
                    <option value="">— Assign later —</option>
                    {tables.map(t => <option key={t.id} value={t.id}>{t.name || `Table ${t.table_number}`} (seats {t.capacity})</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelSt}>Status</label>
                  <select value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                    style={inputSt}>
                    {Object.entries(STATUS_CONFIG).map(([k,v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={labelSt}>Notes / Special Requests</label>
                  <textarea value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Allergies, highchair, anniversary, window seat…"
                    rows={3}
                    style={{ ...inputSt, resize: 'vertical' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
                <button onClick={closeModal} style={{
                  padding: '11px 22px', border: '1px solid #ddd', borderRadius: 8,
                  cursor: 'pointer', fontSize: 14, background: 'white', color: '#555',
                }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{
                  padding: '11px 28px',
                  background: saving ? '#bbb' : '#e94560',
                  color: 'white', border: 'none', borderRadius: 8,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 700, fontSize: 15,
                }}>
                  {saving ? 'Saving…' : editingId ? '✓ Update' : '✓ Create Booking'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reservation card — unchanged layout, brand CI colours ────────
function ReservationCard({ r, onEdit, onSeat, onConfirm, onNoShow, onCancel }) {
  const sc   = STATUS_CONFIG[r.status] || STATUS_CONFIG.pending;
  const time = (r.reservation_time || '').slice(0, 5);
  const date = (() => {
    try {
      return new Date((r.reservation_date||'').split('T')[0]+'T12:00:00')
        .toLocaleDateString('en-GB',{ weekday:'short', day:'numeric', month:'short' });
    } catch { return r.reservation_date || ''; }
  })();

  return (
    <div style={{
      background: 'white', borderRadius: 10, padding: '10px 16px', marginBottom: 8,
      boxShadow: '0 1px 4px rgba(0,0,0,0.07)', borderLeft: `4px solid ${sc.dot}`,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }} />
      <span style={{ fontWeight: 700, fontSize: 14, color: '#0D1B3E', minWidth: 120 }}>{r.customer_name}</span>
      <span style={{ fontSize: 13, color: '#555' }}>🕐 <strong>{time}</strong></span>
      <span style={{ fontSize: 13, color: '#555' }}>📅 {date}</span>
      <span style={{ fontSize: 13, color: '#555' }}>👥 <strong>{r.covers}</strong></span>
      {r.table_name && <span style={{ fontSize: 13, color: '#555' }}>🪑 {r.table_name}</span>}
      {r.customer_phone && <span style={{ fontSize: 12, color: '#888' }}>📞 {r.customer_phone}</span>}
      {r.source === 'widget' && (
        <span style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
          🌐 Online
        </span>
      )}
      <span style={{ background: sc.bg, color: sc.color, borderRadius: 10, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>
        {sc.label}
      </span>
      {r.notes && (
        <span style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', flexBasis: '100%', paddingLeft: 18 }}>
          📝 {r.notes}
        </span>
      )}
      <div style={{ display: 'flex', gap: 5, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {r.status === 'pending' && (
          <button onClick={() => onConfirm(r)} style={actionBtn('#3b82f6')}>✓ Confirm</button>
        )}
        {(r.status === 'pending' || r.status === 'confirmed') && (
          <>
            <button onClick={() => onSeat(r)} style={actionBtn('#22c55e')}>🪑 Seat</button>
            <button onClick={() => onNoShow(r)} style={actionBtn('#ef4444')}>✗</button>
          </>
        )}
        <button onClick={() => onEdit(r)} style={actionBtn('#555')}>✏️</button>
        {r.status !== 'cancelled' && (
          <button onClick={() => onCancel(r)} style={actionBtn('#6b7280')}>🚫</button>
        )}
      </div>
    </div>
  );
}

// ── Customer Records Card ─────────────────────────────────────────
// Sandy: Practical card showing key guest info at a glance.
// Click to expand booking history. "Book Again" pre-fills the modal.
function CustomerCard({ customer: c, isSelected, onToggle, onNewBooking, formatDate }) {
  const { tag, tagColor } = c;

  return (
    <div style={{
      background: 'white', borderRadius: 14,
      boxShadow: isSelected ? '0 4px 20px rgba(13,27,62,0.15)' : '0 1px 4px rgba(0,0,0,0.08)',
      border: isSelected ? '2px solid #0D1B3E' : '2px solid transparent',
      overflow: 'hidden', transition: 'box-shadow 0.15s, border 0.15s',
    }}>
      {/* Card main row */}
      <div
        onClick={onToggle}
        style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'flex-start' }}
      >
        <Initials name={c.name} size={46} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: '#0D1B3E' }}>{c.name}</span>
            {/* Tag badge */}
            <span style={{
              background: tagColor.bg, color: tagColor.color,
              fontSize: 11, fontWeight: 700,
              padding: '2px 8px', borderRadius: 20,
            }}>{tag}</span>
          </div>
          {c.phone && (
            <div style={{ fontSize: 13, color: '#555', marginBottom: 2 }}>📞 {c.phone}</div>
          )}
          {c.email && (
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ✉️ {c.email}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            <span style={{ fontSize: 12, color: '#555' }}>
              <strong style={{ color: '#0D1B3E' }}>{c.visitCount}</strong> visit{c.visitCount !== 1 ? 's' : ''} seated
            </span>
            <span style={{ fontSize: 12, color: '#555' }}>
              <strong style={{ color: '#0D1B3E' }}>{c.totalBookings}</strong> total booking{c.totalBookings !== 1 ? 's' : ''}
            </span>
            {c.lastVisit && (
              <span style={{ fontSize: 12, color: '#888' }}>
                Last: {formatDate(c.lastVisit)}
              </span>
            )}
          </div>
          {c.lastNotes && (
            <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic', marginTop: 6, borderLeft: '2px solid #C9A84C', paddingLeft: 8 }}>
              {c.lastNotes}
            </div>
          )}
        </div>
        {/* Expand chevron */}
        <span style={{ color: '#bbb', fontSize: 16, flexShrink: 0, marginTop: 4 }}>
          {isSelected ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded booking history */}
      {isSelected && (
        <div style={{ borderTop: '1px solid #f0f0f0', background: '#f8f9fb' }}>
          <div style={{ padding: '12px 18px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Booking History
            </span>
            <button onClick={onNewBooking} style={{
              background: '#e94560', color: 'white', border: 'none',
              borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              fontWeight: 700, fontSize: 12,
            }}>
              + Book Again
            </button>
          </div>
          <div style={{ padding: '4px 0 12px' }}>
            {c.sortedVisits.slice(0, 8).map(v => {
              const sc = STATUS_CONFIG[v.status] || STATUS_CONFIG.pending;
              return (
                <div key={v.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 18px', borderBottom: '1px solid #eee', fontSize: 13,
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot, flexShrink: 0 }} />
                  <span style={{ color: '#555', minWidth: 90 }}>{formatDate(v.reservation_date)}</span>
                  <span style={{ color: '#555', fontWeight: 600, minWidth: 42 }}>
                    {(v.reservation_time || '').slice(0, 5)}
                  </span>
                  <span style={{ color: '#555' }}>👥 {v.covers}</span>
                  <span style={{ background: sc.bg, color: sc.color, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, marginLeft: 'auto' }}>
                    {sc.label}
                  </span>
                </div>
              );
            })}
            {c.sortedVisits.length > 8 && (
              <div style={{ textAlign: 'center', padding: '8px', fontSize: 12, color: '#aaa' }}>
                +{c.sortedVisits.length - 8} more bookings
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared styles — Sandy: SiamEPOS brand CI ──────────────────────
const labelSt  = { display: 'block', fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 5 };
const inputSt  = { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', fontFamily: 'system-ui, -apple-system, sans-serif', outline: 'none' };
const ctrBtnSt = { width: 36, height: 36, border: '2px solid #0D1B3E', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 18, background: 'white', color: '#0D1B3E' };
const calNavBtn = { background: '#f0f0f0', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontSize: 20, color: '#0D1B3E' };

function actionBtn(bg) {
  return {
    background: bg, color: 'white', border: 'none', borderRadius: 7,
    padding: '8px 13px', cursor: 'pointer', fontSize: 13,
    fontWeight: 700, whiteSpace: 'nowrap',
  };
}