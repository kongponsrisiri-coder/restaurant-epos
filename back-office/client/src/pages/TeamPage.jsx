import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function TeamPage() {
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try { setTeam(await api.listTeam()); }
    catch (e) { setErr(e.message); setTeam([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 22 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Team</h1>
        <button onClick={() => setShowAdd(true)} style={{ marginLeft: 'auto', padding: '10px 18px', background: '#0D1B3E', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>+ Add team member</button>
      </div>
      {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {loading ? <div>Loading…</div> : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 100px 130px', padding: '12px 16px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase' }}>
            <div>Name</div><div>Email</div><div>Role</div><div>Added</div>
          </div>
          {team.map(u => (
            <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 100px 130px', padding: '12px 16px', borderTop: '1px solid #f1f5f9', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, color: '#0f172a' }}>{u.name}</div>
              <div style={{ fontSize: 13, color: '#475569' }}>{u.email}</div>
              <div>
                <span style={{ background: u.role === 'admin' ? '#fef3c7' : '#dbeafe', color: u.role === 'admin' ? '#92400e' : '#1e40af', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, textTransform: 'uppercase' }}>{u.role}</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b' }}>{new Date(u.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
            </div>
          ))}
        </div>
      )}
      {showAdd && <AddTeamModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

function AddTeamModal({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'support' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!f.name || !f.email || !f.password) { setErr('All fields required'); return; }
    setSaving(true); setErr('');
    try { await api.addTeamMember(f); onSaved(); }
    catch (e) { setErr(e.message); } finally { setSaving(false); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
      <div style={{ background: 'white', borderRadius: 12, padding: 28, width: 440 }}>
        <h2 style={{ margin: 0, marginBottom: 16, fontSize: 20 }}>Add team member</h2>
        {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 8, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        {[['name','Name'],['email','Email'],['password','Password']].map(([k,label]) => (
          <label key={k} style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 10 }}>
            {label}
            <input type={k === 'password' ? 'password' : k === 'email' ? 'email' : 'text'} value={f[k]} onChange={(e) => setF(p => ({ ...p, [k]: e.target.value }))}
              style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }} />
          </label>
        ))}
        <label style={{ display: 'block', fontSize: 12, color: '#475569' }}>Role
          <select value={f.role} onChange={(e) => setF(p => ({ ...p, role: e.target.value }))}
            style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }}>
            <option value="support">Support</option><option value="admin">Admin</option><option value="viewer">Viewer</option>
          </select>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', background: '#f1f5f9', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '9px 18px', background: '#0D1B3E', color: 'white', border: 'none', borderRadius: 6, fontWeight: 700, cursor: saving ? 'wait' : 'pointer' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
