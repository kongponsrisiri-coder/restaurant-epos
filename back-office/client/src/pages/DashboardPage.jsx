import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { C, card, btn, input, label, fmtRelTime, fmtMoney, PLAN_LABEL, STATUS_STYLE } from '../theme.js';
import StatusPill from '../components/StatusPill.jsx';
import HealthDot from '../components/HealthDot.jsx';

export default function DashboardPage() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const nav = useNavigate();

  const load = async () => {
    setLoading(true);
    try { setClients(await api.listClients()); }
    catch { setClients([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter(c => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!q) return true;
      return (c.restaurant_name || '').toLowerCase().includes(q) ||
             (c.owner_name || '').toLowerCase().includes(q) ||
             (c.email || '').toLowerCase().includes(q);
    });
  }, [clients, search, filter]);

  const counts = clients.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {});
  const onlineCount = clients.filter(c => c.last_is_online).length;
  const totalMRR = clients.filter(c => c.status === 'active').reduce((s, c) => s + (Number(c.monthly_fee) || 0), 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>Clients</h1>
          <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
            {clients.length} {clients.length === 1 ? 'restaurant' : 'restaurants'} · {onlineCount} online now
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button onClick={() => setShowAdd(true)} style={btn.ghost} title="Add a placeholder row only">
            + Quick add
          </button>
          {/* SEPOS-029 — primary CTA → full onboarding wizard. */}
          <Link to="/clients/new" style={{ ...btn.gold, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            🚀 Onboard new client
          </Link>
        </div>
      </div>

      {/* Stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 28 }}>
        <StatTile label="Active subs"  value={counts.active || 0} sub={`${fmtMoney(totalMRR)} MRR`}    accent={C.success} />
        <StatTile label="On trial"     value={counts.trial  || 0}                                      accent={C.info} />
        <StatTile label="In setup"     value={counts.setup  || 0}                                      accent={C.warning} />
        <StatTile label="Online now"   value={onlineCount}        sub={`/ ${clients.length} total`}    accent={C.gold} />
        <StatTile label="Churned"      value={counts.churned || 0}                                     accent={C.textMuted} />
      </div>

      {/* Filter bar */}
      <div style={{ ...card, padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, owner, or email…"
          style={{ ...input, flex: 1, minWidth: 200 }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...input, width: 160 }}>
          <option value="all">All statuses</option>
          {Object.entries(STATUS_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      {/* Client cards */}
      {loading ? (
        <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: 48, textAlign: 'center', color: C.textFaint }}>
          {clients.length === 0 ? 'No clients yet — add your first one above.' : 'No clients match the current filter.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
          {filtered.map(c => <ClientCard key={c.id} client={c} onClick={() => nav(`/clients/${c.id}`)} />)}
        </div>
      )}

      {showAdd && <AddClientModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

function StatTile({ label, value, sub, accent }) {
  return (
    <div style={{ ...card, padding: 18, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, height: 3, width: '100%', background: accent }} />
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: C.text, marginTop: 6, letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ClientCard({ client, onClick }) {
  const online = client.last_is_online;
  const lastChecked = client.last_checked_at;
  return (
    <div onClick={onClick} style={{
      ...card, padding: 18, cursor: 'pointer', transition: 'transform 0.12s, box-shadow 0.12s',
    }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(15,23,42,0.10)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = card.boxShadow; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <HealthDot online={online} size={9} pulsing={online} />
            <span style={{ fontSize: 16, fontWeight: 800, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {client.restaurant_name}
            </span>
          </div>
          <div style={{ fontSize: 12, color: C.textFaint, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {client.railway_url || 'No URL set'}
          </div>
        </div>
        <StatusPill status={client.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
        <Metric label="Plan" value={PLAN_LABEL[client.plan] || client.plan || '—'} />
        <Metric label="MRR" value={client.monthly_fee ? fmtMoney(client.monthly_fee) : '—'} />
        <Metric label="Orders today" value={client.last_orders_today ?? '—'} accent={client.last_orders_today > 0 ? C.success : null} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.textFaint, paddingTop: 10, borderTop: `1px solid ${C.borderSoft}` }}>
        <span>{client.owner_name || '—'}</span>
        <span>Pinged {fmtRelTime(lastChecked)}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: accent || C.text, marginTop: 2 }}>{value}</div>
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
    if (!f.restaurant_name) { setErr('Restaurant name is required.'); return; }
    setSaving(true); setErr('');
    try {
      await api.createClient({ ...f, monthly_fee: f.monthly_fee || null });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100,
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, borderRadius: 16, padding: 32, width: 600, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 30px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 22 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>Add client</h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, color: C.textFaint, cursor: 'pointer' }}>×</button>
        </div>
        {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label="Restaurant name *" gridColumn="1 / span 2" value={f.restaurant_name} onChange={(v) => set('restaurant_name', v)} />
          <Field label="Owner name"  value={f.owner_name} onChange={(v) => set('owner_name', v)} />
          <Field label="Phone"       value={f.phone}      onChange={(v) => set('phone', v)} />
          <Field label="Email"       value={f.email}      onChange={(v) => set('email', v)} type="email" gridColumn="1 / span 2" />
          <Field label="Railway URL" value={f.railway_url} onChange={(v) => set('railway_url', v)} placeholder="xyz.up.railway.app" gridColumn="1 / span 2" mono />
          <div>
            <label style={label}>Plan</label>
            <select value={f.plan} onChange={(e) => set('plan', e.target.value)} style={input}>
              <option value="trial">Trial</option><option value="cloud">Cloud</option><option value="pro">Pro</option>
            </select>
          </div>
          <div>
            <label style={label}>Status</label>
            <select value={f.status} onChange={(e) => set('status', e.target.value)} style={input}>
              {Object.entries(STATUS_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <Field label="Monthly fee (£)" value={f.monthly_fee} onChange={(v) => set('monthly_fee', v)} type="number" placeholder="89.00" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
          <button onClick={onClose} style={btn.ghost}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...btn.primary, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save client'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label: lbl, value, onChange, type = 'text', placeholder, gridColumn, mono }) {
  return (
    <div style={{ gridColumn }}>
      <label style={label}>{lbl}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...input, fontFamily: mono ? 'ui-monospace, monospace' : 'inherit' }} />
    </div>
  );
}
