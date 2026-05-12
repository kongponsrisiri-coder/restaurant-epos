import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn, input, label, STATUS_STYLE } from '../theme.js';
import Avatar from '../components/Avatar.jsx';

const ROLE_BADGE = {
  admin:   { bg: '#fef3c7', color: '#92400e', label: 'Admin' },
  support: { bg: '#dbeafe', color: '#1e40af', label: 'Support' },
  viewer:  { bg: '#f1f5f9', color: '#475569', label: 'Viewer' },
};

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
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>Team</h1>
          <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
            {team.length} {team.length === 1 ? 'member' : 'members'} with access to the back office
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={{ ...btn.gold, marginLeft: 'auto' }}>
          + Add team member
        </button>
      </div>

      {err && (
        <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>{err}</div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {team.map(u => {
            const r = ROLE_BADGE[u.role] || ROLE_BADGE.support;
            return (
              <div key={u.id} style={{ ...card, padding: 18, display: 'flex', gap: 14, alignItems: 'center' }}>
                <Avatar name={u.name} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{u.name}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                  <div style={{ marginTop: 6 }}>
                    <span style={{ background: r.bg, color: r.color, fontSize: 10, fontWeight: 800, padding: '2px 9px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.label}</span>
                  </div>
                </div>
              </div>
            );
          })}
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
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!f.name || !f.email || !f.password) { setErr('All fields are required.'); return; }
    setSaving(true); setErr('');
    try { await api.addTeamMember(f); onSaved(); }
    catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, borderRadius: 16, padding: 32, width: 460, boxShadow: '0 30px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 22 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Add team member</h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, color: C.textFaint, cursor: 'pointer' }}>×</button>
        </div>
        {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14, border: `1px solid ${C.danger}33` }}>{err}</div>}
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <label style={label}>Name</label>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} style={input} />
          </div>
          <div>
            <label style={label}>Email</label>
            <input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} style={input} />
          </div>
          <div>
            <label style={label}>Password</label>
            <input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} style={input} />
          </div>
          <div>
            <label style={label}>Role</label>
            <select value={f.role} onChange={(e) => set('role', e.target.value)} style={input}>
              <option value="support">Support</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={btn.ghost}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...btn.primary, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
