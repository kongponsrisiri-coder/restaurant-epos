import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { C, card, btn, input, label, fmtRelTime, fmtMoney, STATUS_STYLE, PLAN_LABEL } from '../theme.js';
import StatusPill from '../components/StatusPill.jsx';
import HealthDot from '../components/HealthDot.jsx';
import Avatar from '../components/Avatar.jsx';
import WebsiteBuilderPanel from '../components/WebsiteBuilderPanel.jsx';

export default function ClientDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [tab, setTab] = useState('overview');
  const [noteCategory, setNoteCategory] = useState('general');
  const [noteText, setNoteText] = useState('');

  const load = async () => {
    try { setData(await api.getClient(id)); }
    catch (e) { console.error(e); }
  };
  useEffect(() => { load(); }, [id]);

  if (!data) return <div style={{ color: C.textMuted }}>Loading…</div>;
  const { client, health, notes } = data;
  const latest = health[0];

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

  return (
    <div>
      <button onClick={() => nav('/')} style={{
        background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer',
        marginBottom: 14, padding: 0, fontSize: 13, fontWeight: 600,
      }}>← All clients</button>

      {/* Hero */}
      <div style={{
        ...card,
        background: `linear-gradient(135deg, ${C.navy} 0%, ${C.navyHover} 100%)`,
        color: 'white', padding: 28, marginBottom: 20, border: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18 }}>
          <Avatar name={client.restaurant_name} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: 'white', letterSpacing: -0.5 }}>
                {client.restaurant_name}
              </h1>
              <StatusPill status={client.status} />
            </div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.78)', marginBottom: 6 }}>
              {client.owner_name && <>{client.owner_name}</>}
              {client.email && <> · {client.email}</>}
              {client.phone && <> · {client.phone}</>}
              {!client.owner_name && !client.email && !client.phone && <span style={{ opacity: 0.55 }}>No contact details on file</span>}
            </div>
            {client.railway_url && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', fontFamily: 'ui-monospace, monospace' }}>
                {client.railway_url}
              </div>
            )}
          </div>
          <button onClick={pingNow} disabled={pinging} style={{
            background: C.gold, color: C.navy, border: 'none', padding: '10px 18px',
            borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: pinging ? 'wait' : 'pointer',
            opacity: pinging ? 0.7 : 1, whiteSpace: 'nowrap',
          }}>{pinging ? 'Pinging…' : '⚡ Ping now'}</button>
        </div>

        {/* Quick stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, marginTop: 22, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
          <HeroStat label="Health" value={
            latest === undefined ? '—' :
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <HealthDot online={latest?.is_online} size={11} pulsing={latest?.is_online} />
              {latest?.is_online ? 'Online' : 'Offline'}
            </span>
          } sub={latest?.response_ms != null ? `${latest.response_ms} ms` : ''} />
          <HeroStat label="Orders today" value={latest?.orders_today ?? '—'} sub={latest?.last_order_at ? `last ${fmtRelTime(latest.last_order_at)}` : 'No orders yet'} />
          <HeroStat label="Plan" value={PLAN_LABEL[client.plan] || client.plan || '—'} sub={client.monthly_fee ? `${fmtMoney(client.monthly_fee)} / month` : 'no fee set'} />
          <HeroStat label="Last ping" value={latest?.checked_at ? fmtRelTime(latest.checked_at) : '—'} sub={latest?.checked_at ? new Date(latest.checked_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {[
          ['overview', 'Overview'],
          ['setup',    '🔐 Setup'],
          ['health',   `Health (${health.length})`],
          ['notes',    `Notes (${notes.length})`],
          ['website',  '🌐 Website'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '10px 18px', background: 'transparent',
            border: 'none', borderBottom: `2px solid ${tab === k ? C.gold : 'transparent'}`,
            color: tab === k ? C.text : C.textMuted,
            fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: -1,
          }}>{l}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
          <SectionCard title="Subscription">
            <FormRow label="Plan">
              <select value={client.plan || 'trial'} onChange={(e) => saveField('plan', e.target.value)} disabled={saving} style={miniInput}>
                <option value="trial">Trial</option><option value="cloud">Cloud</option><option value="pro">Pro</option>
              </select>
            </FormRow>
            <FormRow label="Status">
              <select value={client.status || 'setup'} onChange={(e) => saveField('status', e.target.value)} disabled={saving} style={miniInput}>
                {Object.entries(STATUS_STYLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </FormRow>
            <FormRow label="Monthly fee">
              <input type="number" step="0.01" defaultValue={client.monthly_fee ?? ''} onBlur={(e) => saveField('monthly_fee', e.target.value || null)} placeholder="£" style={miniInput} />
            </FormRow>
            <FormRow label="Trial start">
              <input type="date" defaultValue={client.trial_start ? String(client.trial_start).slice(0,10) : ''} onBlur={(e) => saveField('trial_start', e.target.value || null)} style={miniInput} />
            </FormRow>
            <FormRow label="Sub start">
              <input type="date" defaultValue={client.sub_start ? String(client.sub_start).slice(0,10) : ''} onBlur={(e) => saveField('sub_start', e.target.value || null)} style={miniInput} />
            </FormRow>
            <FormRow label="Next billing">
              <input type="date" defaultValue={client.next_billing ? String(client.next_billing).slice(0,10) : ''} onBlur={(e) => saveField('next_billing', e.target.value || null)} style={miniInput} />
            </FormRow>
          </SectionCard>

          <SectionCard title="Recent health">
            {health.length === 0 ? (
              <div style={{ color: C.textFaint, padding: 18, textAlign: 'center' }}>No pings yet. Hit "Ping now" above.</div>
            ) : (
              <>
                <HealthBars history={health.slice(0, 24)} />
                <div style={{ marginTop: 14 }}>
                  {health.slice(0, 6).map(h => (
                    <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.borderSoft}`, fontSize: 13 }}>
                      <HealthDot online={h.is_online} size={9} />
                      <span style={{ color: C.text, fontWeight: 600, minWidth: 76 }}>{h.is_online ? 'Online' : 'Offline'}</span>
                      <span style={{ color: C.textMuted, flex: 1 }}>{h.response_ms != null ? `${h.response_ms}ms` : '—'}</span>
                      <span style={{ color: C.textFaint, fontSize: 12 }}>{fmtRelTime(h.checked_at)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SectionCard>
        </div>
      )}

      {tab === 'health' && (
        <SectionCard title={`Last ${health.length} pings`}>
          {health.length === 0 ? (
            <div style={{ color: C.textFaint, padding: 18, textAlign: 'center' }}>No pings yet.</div>
          ) : (
            <div>
              <HealthBars history={health.slice().reverse().slice(-48)} />
              <div style={{ marginTop: 18 }}>
                {health.map(h => (
                  <div key={h.id} style={{ display: 'grid', gridTemplateColumns: '20px 80px 90px 90px 1fr', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.borderSoft}`, fontSize: 13 }}>
                    <HealthDot online={h.is_online} size={9} />
                    <span style={{ color: C.text, fontWeight: 600 }}>{h.is_online ? 'Online' : 'Offline'}</span>
                    <span style={{ color: C.textMuted }}>{h.response_ms != null ? `${h.response_ms}ms` : '—'}</span>
                    <span style={{ color: C.textMuted }}>{h.orders_today != null ? `${h.orders_today} orders` : '—'}</span>
                    <span style={{ color: C.textFaint, fontSize: 12, textAlign: 'right' }}>{new Date(h.checked_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'setup' && (
        <SetupSection
          metadata={client.metadata || {}}
          onSave={(metadata) => saveField('metadata', metadata)}
          saving={saving}
        />
      )}

      {tab === 'website' && (
        <WebsiteBuilderPanel
          scope={{
            kind: 'client',
            clientId: parseInt(id, 10),
            defaults: {
              restaurant_name: client.restaurant_name,
              email: client.email,
              phone: client.phone,
            },
          }}
        />
      )}

      {tab === 'notes' && (
        <SectionCard title="Support notes">
          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <select value={noteCategory} onChange={(e) => setNoteCategory(e.target.value)} style={{ ...input, width: 140, fontSize: 13 }}>
              <option value="general">General</option>
              <option value="setup">Setup</option>
              <option value="billing">Billing</option>
              <option value="technical">Technical</option>
            </select>
            <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note…" onKeyDown={(e) => e.key === 'Enter' && addNote()}
              style={{ ...input, flex: 1, fontSize: 14 }} />
            <button onClick={addNote} disabled={!noteText.trim()} style={{
              ...btn.primary, opacity: noteText.trim() ? 1 : 0.4, cursor: noteText.trim() ? 'pointer' : 'not-allowed',
            }}>Add</button>
          </div>
          {notes.length === 0 ? (
            <div style={{ color: C.textFaint, padding: 24, textAlign: 'center' }}>No notes yet. Add the first one above.</div>
          ) : (
            <div>
              {notes.map(n => <NoteItem key={n.id} note={n} />)}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function HeroStat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'white', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionCard({ title, children }) {
  return (
    <div style={{ ...card, padding: 22 }}>
      <h3 style={{ margin: 0, marginBottom: 16, fontSize: 13, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 }}>{title}</h3>
      {children}
    </div>
  );
}

function FormRow({ label: lbl, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>{lbl}</span>
      {children}
    </div>
  );
}

const miniInput = {
  padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 6,
  fontSize: 13, color: C.text, background: C.surface, width: 180, fontFamily: 'inherit', outline: 'none',
};

function HealthBars({ history }) {
  if (!history || history.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end' }}>
      {history.map(h => (
        <div key={h.id}
          title={`${new Date(h.checked_at).toLocaleString()} — ${h.is_online ? `OK ${h.response_ms ?? '?'}ms` : 'down'}`}
          style={{
            flex: 1, minWidth: 6, height: 32, borderRadius: 3,
            background: h.is_online ? C.success : C.danger, opacity: 0.85,
          }} />
      ))}
    </div>
  );
}

const CATEGORY_BADGE = {
  general:   { bg: '#f1f5f9', color: '#475569' },
  setup:     { bg: '#dbeafe', color: '#1e40af' },
  billing:   { bg: '#dcfce7', color: '#166534' },
  technical: { bg: '#fef3c7', color: '#92400e' },
};

function NoteItem({ note }) {
  const cat = CATEGORY_BADGE[note.category] || CATEGORY_BADGE.general;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '14px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <Avatar name={note.created_by} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: C.text, fontSize: 13 }}>{note.created_by}</span>
          <span style={{ background: cat.bg, color: cat.color, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.5 }}>{note.category}</span>
          <span style={{ fontSize: 11, color: C.textFaint, marginLeft: 'auto' }}>{fmtRelTime(note.created_at)}</span>
        </div>
        <div style={{ color: C.text, fontSize: 14, lineHeight: 1.5 }}>{note.note}</div>
      </div>
    </div>
  );
}

// SEPOS-WEB-002 — Setup tab: captures every credential / detail the
// ops team might need to manage this client (domain, payment, marketing,
// tax info, bank, internal notes). Auto-saves each field on blur via the
// metadata JSONB column on clients. Sensitive values are masked by
// default with a "Show" toggle so screen-shoulder-surfing isn't a risk.
const SETUP_FIELDS = [
  { group: 'Restaurant profile', fields: [
    { key: 'full_address',     label: 'Full address',     type: 'textarea' },
    { key: 'capacity',         label: 'Seats / capacity', type: 'number' },
    { key: 'cuisine',          label: 'Cuisine / tags',   placeholder: 'Thai, family-friendly, halal options' },
    { key: 'hours_summary',    label: 'Hours summary',    type: 'textarea', placeholder: 'Mon-Fri 11-22, Sat-Sun 12-23' },
  ]},
  { group: 'Tax & legal', fields: [
    { key: 'vat_number',       label: 'VAT number' },
    { key: 'companies_house',  label: 'Companies House number' },
    { key: 'legal_entity',     label: 'Legal entity / Ltd company name' },
  ]},
  { group: 'Website & hosting', fields: [
    { key: 'domain_name',      label: 'Domain name',       placeholder: 'baansiam.co.uk' },
    { key: 'domain_registrar', label: 'Domain registrar',  placeholder: 'Namecheap, GoDaddy, etc.' },
    { key: 'hosting',          label: 'Hosting',           placeholder: 'Netlify, Vercel, self-hosted, etc.' },
    { key: 'website_admin_login', label: 'Website admin login (if managed by us)', secret: true, type: 'textarea' },
  ]},
  { group: 'Online takeaway / payments', fields: [
    { key: 'stripe_account_id', label: 'Stripe Connect account ID', placeholder: 'acct_…' },
    { key: 'stripe_pk_live',    label: 'Stripe publishable key (live)', secret: true },
    { key: 'stripe_sk_live',    label: 'Stripe secret key (live)', secret: true },
    { key: 'payment_notes',     label: 'Payment notes', type: 'textarea' },
  ]},
  { group: 'Marketing / email', fields: [
    { key: 'brevo_api_key',  label: 'Brevo API key',  secret: true },
    { key: 'mail_from',      label: '"From" address for campaigns', placeholder: 'hello@baansiam.co.uk' },
    { key: 'make_webhook',   label: 'Make.com webhook URL',         secret: true },
  ]},
  { group: 'Banking (for direct debit)', fields: [
    { key: 'bank_account_name', label: 'Account name' },
    { key: 'bank_sort_code',    label: 'Sort code', placeholder: '00-00-00' },
    { key: 'bank_account_last4', label: 'Account number (last 4 only)', placeholder: '••••' },
  ]},
  { group: 'Internal notes', fields: [
    { key: 'notes_internal', label: 'Onboarding / setup notes', type: 'textarea', placeholder: 'Anything the ops team needs to remember about this client.' },
  ]},
];

function SetupSection({ metadata, onSave, saving }) {
  const [draft, setDraft] = useState(metadata || {});
  const [revealed, setRevealed] = useState({});

  useEffect(() => { setDraft(metadata || {}); }, [metadata]);

  const setField = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));
  const commit = () => {
    if (JSON.stringify(draft) === JSON.stringify(metadata || {})) return;
    onSave(draft);
  };
  const toggleReveal = (k) => setRevealed(prev => ({ ...prev, [k]: !prev[k] }));

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ background: C.infoBg, border: `1px solid ${C.info}33`, color: '#1e40af', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
        🔐 These values are stored on the back-office Postgres only. Sensitive fields are masked — click <strong>Show</strong> to reveal. Changes save when you tab out of a field.
      </div>

      {SETUP_FIELDS.map(group => (
        <div key={group.group} style={{ ...card, padding: 22 }}>
          <h3 style={{ margin: 0, marginBottom: 16, fontSize: 13, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            {group.group}
          </h3>
          <div style={{ display: 'grid', gap: 14 }}>
            {group.fields.map(f => {
              const val = draft[f.key] || '';
              const isMasked = f.secret && !revealed[f.key];
              return (
                <div key={f.key}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {f.label}
                    </label>
                    {f.secret && (
                      <button onClick={() => toggleReveal(f.key)} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                        {revealed[f.key] ? 'Hide' : 'Show'}
                      </button>
                    )}
                  </div>
                  {f.type === 'textarea' ? (
                    <textarea
                      value={val}
                      onChange={(e) => setField(f.key, e.target.value)}
                      onBlur={commit}
                      placeholder={f.placeholder}
                      disabled={saving}
                      style={{ ...input, minHeight: 70, resize: 'vertical', fontFamily: f.secret ? 'ui-monospace, monospace' : 'inherit' }}
                    />
                  ) : (
                    <input
                      type={isMasked ? 'password' : (f.type || 'text')}
                      value={val}
                      onChange={(e) => setField(f.key, e.target.value)}
                      onBlur={commit}
                      placeholder={f.placeholder}
                      disabled={saving}
                      autoComplete="off"
                      style={{ ...input, fontFamily: f.secret ? 'ui-monospace, monospace' : 'inherit' }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
