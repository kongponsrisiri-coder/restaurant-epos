import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_STYLE = {
  setup:   { bg: '#fef3c7', color: '#92400e' },
  active:  { bg: '#dcfce7', color: '#166534' },
  trial:   { bg: '#dbeafe', color: '#1e40af' },
  churned: { bg: '#fee2e2', color: '#991b1b' },
  paused:  { bg: '#f3f4f6', color: '#475569' },
};

function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60)     return `${Math.floor(diff)}s ago`;
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function DashboardPage() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const nav = useNavigate();

  const load = async () => {
    setLoading(true);
    try { setClients(await api.listClients()); }
    catch { setClients([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Soft auto-refresh every 30s so the dashboard reflects fresh health pings.
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const sumByStatus = clients.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {});
  const totalMRR = clients
    .filter(c => c.status === 'active')
    .reduce((s, c) => s + (Number(c.monthly_fee) || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 22 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#0f172a' }}>Clients</h1>
        <button onClick={() => setShowAdd(true)} style={{
          marginLeft: 'auto', padding: '10px 18px', background: '#0D1B3E', color: 'white',
          border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer'
        }}>+ Add client</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total clients', value: clients.length, color: '#0D1B3E' },
          { label: 'Active',        value: sumByStatus.active || 0, color: '#16a34a' },
          { label: 'Trial',         value: sumByStatus.trial || 0,  color: '#2563eb' },
          { label: 'Setup',         value: sumByStatus.setup || 0,  color: '#d97706' },
          { label: 'MRR (active)',  value: `£${totalMRR.toFixed(2)}`, color: '#C9A84C' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', padding: 16, borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {loading ? <div style={{ color: '#64748b' }}>Loading…</div> : (
        <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 100px 110px 110px', padding: '12px 16px', background: '#f8fafc', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <div>Restaurant</div><div>Owner</div><div>Plan / Status</div><div style={{ textAlign: 'center' }}>Health</div><div>Orders today</div><div>Last ping</div>
          </div>
          {clients.length === 0 && (
            <div style={{ padding: 36, textAlign: 'center', color: '#94a3b8' }}>No clients yet — add your first one.</div>
          )}
          {clients.map(c => {
            const st = STATUS_STYLE[c.status] || STATUS_STYLE.setup;
            const online = c.last_is_online;
            const lastChecked = c.last_checked_at;
            return (
              <div key={c.id} onClick={() => nav(`/clients/${c.id}`)} style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 100px 110px 110px',
                padding: '14px 16px', borderTop: '1px solid #f1f5f9', cursor: 'pointer',
                alignItems: 'center', transition: 'background 0.1s'
              }} onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'} onMouseLeave={(e) => e.currentTarget.style.background = 'white'}>
                <div>
                  <div style={{ fontWeight: 700, color: '#0f172a' }}>{c.restaurant_name}</div>
                  {c.railway_url && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{c.railway_url}</div>}
                </div>
                <div style={{ fontSize: 13, color: '#475569' }}>
                  {c.owner_name || '—'}
                  {c.email && <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.email}</div>}
                </div>
                <div>
                  <span style={{ background: st.bg, color: st.color, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, textTransform: 'uppercase' }}>{c.status}</span>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{c.plan} {c.monthly_fee ? `· £${Number(c.monthly_fee).toFixed(2)}/mo` : ''}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  {online === null || online === undefined ? (
                    <span style={{ color: '#cbd5e1', fontSize: 22 }}>○</span>
                  ) : online ? (
                    <span title={`${c.last_response_ms}ms`} style={{ color: '#22c55e', fontSize: 22 }}>●</span>
                  ) : (
                    <span style={{ color: '#ef4444', fontSize: 22 }}>●</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 600 }}>{c.last_orders_today ?? '—'}</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>{fmtRelTime(lastChecked)}</div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && <AddClientModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

function AddClientModal({ onClose, onSaved }) {
  const [f, setF] = useState({
    restaurant_name: '', owner_name: '', email: '', phone: '',
    railway_url: '', plan: 'trial', status: 'setup', monthly_fee: '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!f.restaurant_name) { setErr('Restaurant name required'); return; }
    setSaving(true); setErr('');
    try {
      await api.createClient({ ...f, monthly_fee: f.monthly_fee || null });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
      <div style={{ background: 'white', borderRadius: 12, padding: 28, width: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <h2 style={{ margin: 0, marginBottom: 16, fontSize: 20 }}>Add client</h2>
        {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 8, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            ['restaurant_name', 'Restaurant name *'],
            ['owner_name',      'Owner name'],
            ['email',           'Email'],
            ['phone',           'Phone'],
            ['railway_url',     'Railway URL (e.g. xyz.up.railway.app)'],
          ].map(([k, label]) => (
            <label key={k} style={{ display: 'block', fontSize: 12, color: '#475569', gridColumn: k === 'railway_url' ? '1 / span 2' : 'auto' }}>
              {label}
              <input value={f[k]} onChange={(e) => set(k, e.target.value)}
                style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }} />
            </label>
          ))}
          <label style={{ fontSize: 12, color: '#475569' }}>Plan
            <select value={f.plan} onChange={(e) => set('plan', e.target.value)}
              style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }}>
              <option value="trial">Trial</option>
              <option value="cloud">Cloud</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#475569' }}>Status
            <select value={f.status} onChange={(e) => set('status', e.target.value)}
              style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }}>
              <option value="setup">Setup</option>
              <option value="trial">Trial</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="churned">Churned</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#475569' }}>Monthly fee £
            <input type="number" step="0.01" value={f.monthly_fee} onChange={(e) => set('monthly_fee', e.target.value)}
              style={{ width: '100%', padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, marginTop: 4, fontSize: 14 }} />
          </label>
        </div>
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
