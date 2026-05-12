import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60)     return `${Math.floor(diff)}s ago`;
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ClientDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [noteCategory, setNoteCategory] = useState('general');
  const [noteText, setNoteText] = useState('');

  const load = async () => {
    try { setData(await api.getClient(id)); }
    catch (e) { console.error(e); }
  };
  useEffect(() => { load(); }, [id]);

  if (!data) return <div>Loading…</div>;
  const { client, health, notes } = data;

  const saveField = async (field, value) => {
    setSaving(true);
    try { await api.updateClient(id, { [field]: value }); await load(); }
    catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  const pingNow = async () => {
    setPinging(true);
    try { await api.runHealth(id); await load(); }
    finally { setPinging(false); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    await api.addNote(id, noteCategory, noteText.trim());
    setNoteText(''); setNoteCategory('general');
    load();
  };

  const latest = health[0];
  return (
    <div>
      <button onClick={() => nav('/')} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', marginBottom: 14, padding: 0 }}>← All clients</button>

      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 26 }}>{client.restaurant_name}</h1>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {client.owner_name && <>{client.owner_name} · </>}
              {client.email}
              {client.phone && <> · {client.phone}</>}
            </div>
            {client.railway_url && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, fontFamily: 'monospace' }}>{client.railway_url}</div>}
          </div>
          <button onClick={pingNow} disabled={pinging} style={{ padding: '8px 14px', background: '#C9A84C', color: '#0D1B3E', border: 'none', borderRadius: 6, fontWeight: 700, cursor: pinging ? 'wait' : 'pointer', fontSize: 13 }}>
            {pinging ? 'Pinging…' : '⚡ Ping now'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
        <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: 0, marginBottom: 14, fontSize: 14, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>Subscription</h3>
          <Row label="Plan">
            <select value={client.plan || 'trial'} onChange={(e) => saveField('plan', e.target.value)} disabled={saving} style={selStyle}>
              <option value="trial">Trial</option><option value="cloud">Cloud</option><option value="pro">Pro</option>
            </select>
          </Row>
          <Row label="Status">
            <select value={client.status || 'setup'} onChange={(e) => saveField('status', e.target.value)} disabled={saving} style={selStyle}>
              <option value="setup">Setup</option><option value="trial">Trial</option><option value="active">Active</option><option value="paused">Paused</option><option value="churned">Churned</option>
            </select>
          </Row>
          <Row label="Monthly fee">
            <input defaultValue={client.monthly_fee ?? ''} onBlur={(e) => saveField('monthly_fee', e.target.value || null)} type="number" step="0.01" placeholder="£" style={inStyle} />
          </Row>
          <Row label="Trial start">  <input type="date" defaultValue={client.trial_start ? String(client.trial_start).slice(0,10) : ''}   onBlur={(e) => saveField('trial_start',  e.target.value || null)} style={inStyle} /></Row>
          <Row label="Sub start">    <input type="date" defaultValue={client.sub_start    ? String(client.sub_start).slice(0,10)    : ''} onBlur={(e) => saveField('sub_start',    e.target.value || null)} style={inStyle} /></Row>
          <Row label="Next billing"> <input type="date" defaultValue={client.next_billing ? String(client.next_billing).slice(0,10) : ''} onBlur={(e) => saveField('next_billing', e.target.value || null)} style={inStyle} /></Row>
        </div>

        <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: 0, marginBottom: 14, fontSize: 14, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>Health</h3>
          {latest ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{ fontSize: 32, color: latest.is_online ? '#22c55e' : '#ef4444' }}>●</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{latest.is_online ? 'Online' : 'Offline'}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{latest.response_ms != null ? `${latest.response_ms} ms · ` : ''}{fmtRelTime(latest.checked_at)}</div>
                </div>
              </div>
              <Row label="Orders today">   <span>{latest.orders_today ?? '—'}</span></Row>
              <Row label="Last order">     <span>{latest.last_order_at ? fmtRelTime(latest.last_order_at) : '—'}</span></Row>
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Last 24 pings</div>
                <div style={{ display: 'flex', gap: 2 }}>
                  {[...health].slice(0, 24).reverse().map(h => (
                    <div key={h.id} title={`${new Date(h.checked_at).toLocaleString()} — ${h.is_online ? 'OK' : 'down'}`}
                      style={{ flex: 1, height: 24, borderRadius: 3, background: h.is_online ? '#22c55e' : '#ef4444', opacity: 0.85 }} />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ color: '#94a3b8' }}>No health checks yet. Hit "Ping now" to run one.</div>
          )}
        </div>
      </div>

      <div style={{ background: 'white', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <h3 style={{ margin: 0, marginBottom: 14, fontSize: 14, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>Support notes ({notes.length})</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <select value={noteCategory} onChange={(e) => setNoteCategory(e.target.value)} style={{ ...selStyle, width: 130 }}>
            <option value="general">General</option><option value="setup">Setup</option><option value="billing">Billing</option><option value="technical">Technical</option>
          </select>
          <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note…" onKeyDown={(e) => e.key === 'Enter' && addNote()} style={{ flex: 1, padding: 9, border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14 }} />
          <button onClick={addNote} disabled={!noteText.trim()} style={{ padding: '9px 16px', background: '#0D1B3E', color: 'white', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' }}>Add</button>
        </div>
        {notes.length === 0 && <div style={{ color: '#94a3b8' }}>No notes yet.</div>}
        {notes.map(n => (
          <div key={n.id} style={{ borderTop: '1px solid #f1f5f9', padding: '12px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ background: '#f1f5f9', color: '#475569', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase' }}>{n.category}</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>{n.created_by} · {fmtRelTime(n.created_at)}</span>
            </div>
            <div style={{ color: '#0f172a', fontSize: 14 }}>{n.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const inStyle  = { padding: 7, border: '1px solid #cbd5e1', borderRadius: 5, fontSize: 13, width: 160 };
const selStyle = { padding: 7, border: '1px solid #cbd5e1', borderRadius: 5, fontSize: 13, background: 'white', width: 160 };

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ flex: 1, fontSize: 13, color: '#64748b' }}>{label}</span>
      {children}
    </div>
  );
}
