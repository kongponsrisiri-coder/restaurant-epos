import React, { useState, useEffect, useCallback } from 'react';

const SERVER_URL = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host.startsWith('192.168.') || host.startsWith('10.'))
    return window.location.origin;
  return 'https://restaurant-epos-production.up.railway.app';
})();

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   bg: '#FFF3CD', color: '#856404', dot: '#FFC107' },
  confirmed: { label: 'Confirmed', bg: '#D1ECF1', color: '#0C5460', dot: '#17A2B8' },
  seated:    { label: 'Seated',    bg: '#D4EDDA', color: '#155724', dot: '#28A745' },
  'no-show': { label: 'No Show',   bg: '#F8D7DA', color: '#721C24', dot: '#DC3545' },
  cancelled: { label: 'Cancelled', bg: '#E2E3E5', color: '#383D41', dot: '#6C757D' },
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

  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

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

  async function handleSeat(r) {
    if (!window.confirm(`Seat ${r.customer_name} (${r.covers} covers)?`)) return;
    try {
      await apiFetch(`/api/reservations/${r.id}/seat`, { method: 'POST' });
      showToast(`${r.customer_name} seated ✓`);
      loadData();
      // Go to table map so staff can open the table
      setTimeout(() => onClose(), 800);
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
    counts[s] = s === 'all' ? base.length : base.filter(r => r.status === s).length;
  });

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

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', fontFamily: 'Arial, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.type === 'error' ? '#DC3545' : '#28A745',
          color: 'white', padding: '14px 22px', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)', fontWeight: 'bold', fontSize: 15,
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg,#1a472a 0%,#2d6a4f 100%)',
        color: 'white', padding: '16px 24px',
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 'bold' }}>🗓️ Reservations</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: 8, overflow: 'hidden' }}>
            {[['list','📋 List'],['calendar','📅 Calendar']].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13,
                fontWeight: view === v ? 'bold' : 'normal',
                background: view === v ? 'white' : 'transparent',
                color: view === v ? '#1a472a' : 'white',
              }}>{label}</button>
            ))}
          </div>
          <button onClick={loadData} style={{
  background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none',
  borderRadius: 8, padding: '9px 14px', cursor: 'pointer',
  fontWeight: 'bold', fontSize: 18,
  title: 'Refresh',
}}>🔄</button>
<button onClick={openAdd} style={{
  background: '#4CAF50', color: 'white', border: 'none',
  borderRadius: 8, padding: '9px 18px', cursor: 'pointer',
  fontWeight: 'bold', fontSize: 14,
}}>➕ New Booking</button>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{
        background: 'white', padding: '12px 24px',
        display: 'flex', gap: 10, alignItems: 'center',
        flexWrap: 'wrap', borderBottom: '1px solid #e0e0e0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        <input type="date" value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 }} />
        <button onClick={() => setFilterDate('')} style={{
          padding: '7px 12px', border: '1px solid #ddd', borderRadius: 6,
          fontSize: 13, cursor: 'pointer',
          background: !filterDate ? '#1a472a' : 'white',
          color: !filterDate ? 'white' : '#555',
        }}>All Dates</button>
        <div style={{ width: 1, height: 28, background: '#e0e0e0', margin: '0 4px' }} />
        {ALL_STATUSES.map(s => (
          <button key={s} onClick={() => setFilterStatus(s)} style={{
            padding: '6px 14px', border: 'none', borderRadius: 20, cursor: 'pointer',
            fontWeight: filterStatus === s ? 'bold' : 'normal', fontSize: 13,
            background: filterStatus === s ? '#1a472a' : '#f0f2f5',
            color: filterStatus === s ? 'white' : '#555',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            {s === 'all' ? 'All' : STATUS_CONFIG[s]?.label || s}
            {counts[s] > 0 && (
              <span style={{
                background: filterStatus === s ? 'rgba(255,255,255,0.3)' : '#ddd',
                borderRadius: 10, padding: '1px 7px', fontSize: 11,
              }}>{counts[s]}</span>
            )}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: '#888', fontSize: 13 }}>
          {filtered.length} booking{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Main Content */}
      <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 80, color: '#888' }}>
            <div style={{ fontSize: 48 }}>⏳</div>
            <p>Loading reservations…</p>
          </div>
        ) : view === 'calendar' ? (

          /* Calendar View */
          <div style={{ background: 'white', borderRadius: 14, padding: 28, boxShadow: '0 2px 10px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <button onClick={() => setCalDate(new Date(calYear, calMonth-1, 1))} style={calNavBtn}>‹</button>
              <h2 style={{ margin: 0, color: '#1a472a', fontSize: 22 }}>{MONTH_NAMES[calMonth]} {calYear}</h2>
              <button onClick={() => setCalDate(new Date(calYear, calMonth+1, 1))} style={calNavBtn}>›</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 6 }}>
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                <div key={d} style={{ textAlign: 'center', fontWeight: 'bold', color: '#999', fontSize: 12, padding: '6px 0' }}>{d}</div>
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
                    border: `2px solid ${isSel ? '#1a472a' : isToday ? '#4CAF50' : '#f0f2f5'}`,
                    background: isSel ? '#f0fff4' : isToday ? '#f9fff9' : 'white',
                  }}>
                    <div style={{ fontWeight: isToday||isSel ? 'bold' : 'normal', color: isToday ? '#4CAF50' : isSel ? '#1a472a' : '#333', fontSize: 15, marginBottom: 4 }}>
                      {day}
                    </div>
                    {dayRes.slice(0,3).map(r => (
                      <div key={r.id} style={{
                        fontSize: 11, borderRadius: 4, padding: '2px 5px', marginBottom: 2,
                        background: STATUS_CONFIG[r.status]?.bg || '#f0f2f5',
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
            <p style={{ marginTop: 16, color: '#888', fontSize: 13, textAlign: 'center' }}>
              Click a day to see its bookings in list view
            </p>
          </div>

        ) : (

          /* List View */
          filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}>
              <div style={{ fontSize: 56 }}>📋</div>
              <p style={{ fontSize: 18, margin: '12px 0 4px' }}>No bookings found</p>
              <p style={{ fontSize: 14, color: '#aaa' }}>
                {filterDate
                  ? `Nothing on ${new Date(filterDate+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}`
                  : 'Try a different filter'}
              </p>
              <button onClick={openAdd} style={{
                marginTop: 18, background: '#1a472a', color: 'white',
                border: 'none', borderRadius: 8, padding: '10px 22px',
                cursor: 'pointer', fontWeight: 'bold', fontSize: 15,
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
            <div style={{
              background: 'linear-gradient(135deg,#1a472a,#2d6a4f)',
              padding: '20px 28px', borderRadius: '16px 16px 0 0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <h2 style={{ margin: 0, color: 'white', fontSize: 20 }}>
                {editingId ? '✏️ Edit Booking' : '➕ New Booking'}
              </h2>
              <button onClick={closeModal} style={{
                background: 'rgba(255,255,255,0.2)', color: 'white',
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
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, covers: Math.max(1, f.covers-1) }))}
                      style={ctrBtnSt}>−</button>
                    <span style={{ fontSize: 20, fontWeight: 'bold', minWidth: 36, textAlign: 'center', color: '#1a472a' }}>
                      {form.covers}
                    </span>
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, covers: Math.min(50, f.covers+1) }))}
                      style={ctrBtnSt}>+</button>
                    <span style={{ color: '#888', fontSize: 13 }}>guests</span>
                  </div>
                </div>

                <div>
                  <label style={labelSt}>Table (optional)</label>
                  <select value={form.table_id}
                    onChange={e => setForm(f => ({ ...f, table_id: e.target.value }))}
                    style={inputSt}>
                    <option value="">— Assign later —</option>
                    {tables.map(t => (
                      <option key={t.id} value={t.id}>{t.name} (seats {t.capacity})</option>
                    ))}
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
                    placeholder="Allergies, highchair, anniversary…"
                    rows={3}
                    style={{ ...inputSt, resize: 'vertical', fontFamily: 'Arial, sans-serif' }} />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
                <button onClick={closeModal} style={{
                  padding: '11px 22px', border: '1px solid #ddd', borderRadius: 8,
                  cursor: 'pointer', fontSize: 14, background: 'white', color: '#555',
                }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{
                  padding: '11px 28px',
                  background: saving ? '#aaa' : '#1a472a',
                  color: 'white', border: 'none', borderRadius: 8,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold', fontSize: 15,
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
      background: 'white', borderRadius: 12, padding: 18, marginBottom: 10,
      boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
      borderLeft: `5px solid ${sc.dot}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 'bold', color: '#1a472a' }}>{r.customer_name}</span>
            <span style={{ background: sc.bg, color: sc.color, borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 'bold' }}>
              {sc.label}
            </span>
            {r.source === 'widget' && (
              <span style={{ background: '#e8f4fd', color: '#0066cc', borderRadius: 12, padding: '3px 8px', fontSize: 11 }}>
                🌐 Online
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 14, color: '#555' }}>
            <span>🕐 <strong>{time}</strong></span>
            <span>📅 {date}</span>
            <span>👥 <strong>{r.covers}</strong> covers</span>
            {r.table_name && <span>🪑 {r.table_name}</span>}
            {r.customer_phone && <span>📞 {r.customer_phone}</span>}
            {r.customer_email && <span>✉️ {r.customer_email}</span>}
          </div>
          {r.notes && (
            <div style={{ marginTop: 7, fontSize: 13, color: '#888', fontStyle: 'italic' }}>📝 {r.notes}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {r.status === 'pending' && (
            <button onClick={() => onConfirm(r)} style={actionBtn('#17A2B8')}>✓ Confirm</button>
          )}
          {(r.status === 'pending' || r.status === 'confirmed') && (
            <>
              <button onClick={() => onSeat(r)} style={actionBtn('#28A745')}>🪑 Seat</button>
              <button onClick={() => onNoShow(r)} style={actionBtn('#DC3545')}>✗ No Show</button>
            </>
          )}
          <button onClick={() => onEdit(r)} style={actionBtn('#6C757D')}>✏️ Edit</button>
          {r.status !== 'cancelled' && (
            <button onClick={() => onCancel(r)} style={actionBtn('#343A40')}>🚫 Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

const labelSt  = { display: 'block', fontSize: 13, fontWeight: 'bold', color: '#555', marginBottom: 5 };
const inputSt  = { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', fontFamily: 'Arial, sans-serif' };
const ctrBtnSt = { width: 36, height: 36, border: '2px solid #1a472a', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 18, background: 'white', color: '#1a472a' };
const calNavBtn = { background: '#f0f2f5', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontSize: 20 };
function actionBtn(bg) {
  return { background: bg, color: 'white', border: 'none', borderRadius: 7, padding: '8px 13px', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', whiteSpace: 'nowrap' };
}