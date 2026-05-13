import { useState, useEffect } from 'react';
import { SERVER_URL } from '../../api';
import { getStaff, addStaff, updateStaff } from '../../api';

export default function StaffSection() {
  const [staff, setStaff]           = useState([]);
  const [showForm, setShowForm]     = useState(false);
  const [editStaff, setEditStaff]   = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [form, setForm]             = useState({ name: '', pin: '', role: 'waiter', start_date: '', notes: '', employment_status: 'active' });
  const [filterStatus, setFilterStatus] = useState('active');

  useEffect(() => { getStaff().then(setStaff); }, []);

  const roleColors = { admin: '#e94560', manager: '#8b5cf6', supervisor: '#3b82f6', waiter: '#22c55e', kitchen: '#f97316', bar: '#eab308' };
  const filteredStaff = staff.filter(s => filterStatus === 'active' ? s.is_active : filterStatus === 'inactive' ? !s.is_active : true);

  const handleSave = async () => {
    if (!form.name || (!editStaff && !form.pin)) return alert('Name and PIN are required!');
    if (form.pin && form.pin.length !== 4) return alert('PIN must be 4 digits!');
    try {
      if (editStaff) await updateStaff(editStaff.id, form);
      else await addStaff(form);
      setShowForm(false); setEditStaff(null); getStaff().then(setStaff);
    } catch { alert('Save failed!'); }
  };

  const toggleActive = async (s) => { await updateStaff(s.id, { ...s, is_active: s.is_active ? 0 : 1 }); getStaff().then(setStaff); };

  const handleDelete = async (s) => {
    if (!confirm(`Permanently delete ${s.name}? This cannot be undone.`)) return;
    try { await fetch(`${SERVER_URL}/api/staff/${s.id}`, { method: 'DELETE' }); setSelectedStaff(null); getStaff().then(setStaff); }
    catch { alert('Delete failed!'); }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>👥 Staff</h1>
        <button onClick={() => { setEditStaff(null); setForm({ name: '', pin: '', role: 'waiter', start_date: '', notes: '', employment_status: 'active' }); setShowForm(true); }} style={{ background: '#e94560', color: 'white', border: 'none', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>+ Add Staff</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[{ key: 'active', label: `Active (${staff.filter(s => s.is_active).length})` }, { key: 'inactive', label: `Inactive (${staff.filter(s => !s.is_active).length})` }, { key: 'all', label: `All (${staff.length})` }].map(f => (
          <button key={f.key} onClick={() => setFilterStatus(f.key)} style={{ padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: filterStatus === f.key ? '#1a1a2e' : '#f0f0f0', color: filterStatus === f.key ? 'white' : '#555' }}>{f.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filteredStaff.map(s => (
          <div key={s.id}>
            <div onClick={() => setSelectedStaff(selectedStaff?.id === s.id ? null : s)} style={{ background: 'white', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', opacity: s.is_active ? 1 : 0.6, cursor: 'pointer', border: selectedStaff?.id === s.id ? '2px solid #e94560' : '2px solid transparent' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>{s.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ background: roleColors[s.role] || '#888', color: 'white', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>{s.role}</span>
                  {!s.is_active && <span style={{ background: '#fee2e2', color: '#ef4444', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20 }}>Inactive</span>}
                  {s.start_date && <span style={{ fontSize: 12, color: '#888' }}>📅 Started: {s.start_date}</span>}
                  {s.employment_status && s.employment_status !== 'active' && <span style={{ fontSize: 12, color: '#f97316', fontWeight: 600 }}>• {s.employment_status}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={e => { e.stopPropagation(); setEditStaff(s); setForm({ name: s.name, pin: '', role: s.role, is_active: s.is_active == null ? 1 : (s.is_active ? 1 : 0), start_date: s.start_date || '', notes: s.notes || '', employment_status: s.employment_status || 'active' }); setShowForm(true); }} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#f0f0f0', fontWeight: 600, fontSize: 12 }}>✏️ Edit</button>
                <button onClick={e => { e.stopPropagation(); toggleActive(s); }} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: s.is_active ? '#fff3cd' : '#dcfce7', color: s.is_active ? '#92400e' : '#14532d' }}>{s.is_active ? 'Deactivate' : 'Reactivate'}</button>
                <span style={{ color: '#ccc' }}>▾</span>
              </div>
            </div>
            {selectedStaff?.id === s.id && (
              <div style={{ background: '#f8f8f8', borderRadius: '0 0 12px 12px', padding: '16px 20px', border: '2px solid #e94560', borderTop: 'none' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  {[{ label: 'Start Date', value: s.start_date || '—' }, { label: 'Status', value: s.employment_status || 'Active' }, { label: 'Member Since', value: s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—' }, { label: 'Role', value: s.role }].map(item => (
                    <div key={item.label} style={{ background: 'white', borderRadius: 8, padding: '12px 16px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>{item.value}</div>
                    </div>
                  ))}
                </div>
                {s.notes && <div style={{ background: 'white', borderRadius: 8, padding: '12px 16px', marginBottom: 12 }}><div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>Notes</div><div style={{ fontSize: 14, color: '#555', lineHeight: 1.5 }}>{s.notes}</div></div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={() => handleDelete(s)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>🗑️ Permanently Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 32, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: '#1a1a2e' }}>{editStaff ? '✏️ Edit Staff' : '+ Add Staff'}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Full Name *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>{editStaff ? 'New PIN (leave blank to keep)' : 'PIN (4 digits) *'}</label><input value={form.pin} onChange={e => setForm({ ...form, pin: e.target.value })} type="password" maxLength={4} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Role *</label><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="admin">Admin</option><option value="manager">Manager</option><option value="supervisor">Supervisor</option><option value="waiter">Waiter</option><option value="kitchen">Kitchen</option><option value="bar">Bar</option></select></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Start Date</label><input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Employment Status</label><select value={form.employment_status} onChange={e => setForm({ ...form, employment_status: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}><option value="active">Active</option><option value="part-time">Part-time</option><option value="probation">Probation</option><option value="notice">On Notice</option><option value="left">Left</option></select></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Notes <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={3} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', resize: 'none' }} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700 }}>{editStaff ? 'Save Changes' : 'Add Staff'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
