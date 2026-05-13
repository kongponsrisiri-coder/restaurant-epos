import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';
import { C, card, btn, input, label, fmtRelTime } from '../theme.js';

// Markdown gets rendered through marked + DOMPurify. Bodies live in
// our own DB, never user-submitted in the wild, but sanitising is
// cheap insurance against a future paste containing inline HTML.
marked.setOptions({ breaks: false, gfm: true });

const STATUS_OPTIONS = [
  { value: 'open',        label: 'Open',        color: '#1e40af', bg: '#dbeafe' },
  { value: 'in_progress', label: 'In progress', color: '#92400e', bg: '#fef3c7' },
  { value: 'shipped',     label: 'Shipped',     color: '#166534', bg: '#dcfce7' },
  { value: 'parked',      label: 'Parked',      color: '#475569', bg: '#f1f5f9' },
];

const PRIORITY_OPTIONS = [
  { value: 'low',    label: 'Low',    color: '#475569', bg: '#f1f5f9' },
  { value: 'normal', label: 'Normal', color: '#1e40af', bg: '#dbeafe' },
  { value: 'high',   label: 'High',   color: '#92400e', bg: '#fef3c7' },
  { value: 'urgent', label: 'Urgent', color: '#991b1b', bg: '#fee2e2' },
];

function chip(opts, value) {
  const o = opts.find(x => x.value === value) || opts[0];
  return (
    <span style={{
      background: o.bg, color: o.color, fontSize: 10, fontWeight: 800,
      padding: '3px 9px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.5
    }}>{o.label}</span>
  );
}

export default function TicketsPage() {
  const { id } = useParams();
  return id ? <TicketDetail id={parseInt(id, 10)} /> : <TicketList />;
}

function TicketList() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showNew, setShowNew] = useState(false);
  const nav = useNavigate();

  const load = async () => {
    setLoading(true); setErr('');
    try { setRows(await api.listTickets()); }
    catch (e) { setErr(e.message); setRows([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>Tickets</h1>
          <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
            Engineering tickets and product specs — shareable with the team
          </p>
        </div>
        <button onClick={() => setShowNew(true)} style={{ ...btn.gold, marginLeft: 'auto' }}>+ New ticket</button>
      </div>

      {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>{err}</div>}

      {loading ? (
        <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: C.textMuted }}>
          No tickets yet. Click "New ticket" to add the first one.
        </div>
      ) : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {rows.map((t, i) => (
            <div
              key={t.id}
              onClick={() => nav(`/tickets/${t.id}`)}
              style={{
                display: 'grid', gridTemplateColumns: '120px 1fr auto auto auto',
                gap: 16, alignItems: 'center', padding: '14px 18px',
                borderTop: i === 0 ? 'none' : `1px solid ${C.borderSoft}`,
                cursor: 'pointer', transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12, fontWeight: 700, color: C.navy }}>{t.code}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                  {t.author ? `${t.author} · ` : ''}{fmtRelTime(t.updated_at)} · {(t.body_length / 1024).toFixed(1)} KB
                </div>
              </div>
              {chip(PRIORITY_OPTIONS, t.priority)}
              {chip(STATUS_OPTIONS, t.status)}
              <span style={{ color: C.textFaint, fontSize: 16 }}>›</span>
            </div>
          ))}
        </div>
      )}

      {showNew && <TicketEditModal onClose={() => setShowNew(false)} onSaved={(t) => { setShowNew(false); nav(`/tickets/${t.id}`); }} />}
    </div>
  );
}

function TicketDetail({ id }) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const nav = useNavigate();

  const load = async () => {
    setLoading(true); setErr('');
    try { setTicket(await api.getTicket(id)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [id]);

  const html = useMemo(() => {
    if (!ticket?.body_markdown) return '';
    return DOMPurify.sanitize(marked.parse(ticket.body_markdown));
  }, [ticket?.body_markdown]);

  const updateField = async (field, value) => {
    try {
      const updated = await api.updateTicket(id, { [field]: value });
      setTicket(updated);
    } catch (e) { alert(e.message); }
  };

  const remove = async () => {
    if (!confirm(`Delete ticket ${ticket.code}? This can't be undone.`)) return;
    try { await api.deleteTicket(id); nav('/tickets'); }
    catch (e) { alert(e.message); }
  };

  if (loading) return <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading…</div>;
  if (err)     return <div style={{ background: C.dangerBg, color: '#991b1b', padding: 14, borderRadius: 8 }}>{err}</div>;
  if (!ticket) return null;

  return (
    <div>
      <button onClick={() => nav('/tickets')} style={{ ...btn.ghost, marginBottom: 20 }}>← Back to tickets</button>

      <div style={{ ...card, padding: 28, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, fontWeight: 800, color: C.navy }}>{ticket.code}</span>
          {chip(PRIORITY_OPTIONS, ticket.priority)}
          {chip(STATUS_OPTIONS, ticket.status)}
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 6px', color: C.text, letterSpacing: -0.5 }}>{ticket.title}</h1>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          {ticket.author ? `${ticket.author} · ` : ''}Updated {fmtRelTime(ticket.updated_at)} · Created {fmtRelTime(ticket.created_at)}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <select value={ticket.status} onChange={(e) => updateField('status', e.target.value)} style={{ ...input, width: 'auto', padding: '6px 12px' }}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={ticket.priority} onChange={(e) => updateField('priority', e.target.value)} style={{ ...input, width: 'auto', padding: '6px 12px' }}>
            {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={() => setEditing(true)} style={btn.ghost}>Edit body</button>
          <button onClick={remove} style={{ ...btn.ghost, color: C.danger, borderColor: `${C.danger}55` }}>Delete</button>
        </div>
      </div>

      <div
        style={{ ...card, padding: '20px 32px 32px', fontSize: 15, lineHeight: 1.65, color: C.text }}
        className="ticket-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <style>{`
        .ticket-body h1, .ticket-body h2, .ticket-body h3, .ticket-body h4 {
          margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.25; color: ${C.text};
        }
        .ticket-body h1 { font-size: 24px; font-weight: 800; border-bottom: 1px solid ${C.border}; padding-bottom: 8px; }
        .ticket-body h2 { font-size: 19px; font-weight: 800; }
        .ticket-body h3 { font-size: 16px; font-weight: 700; }
        .ticket-body p, .ticket-body li { font-size: 14px; }
        .ticket-body code {
          font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px;
          background: ${C.surfaceAlt}; padding: 1px 6px; border-radius: 4px;
          border: 1px solid ${C.borderSoft};
        }
        .ticket-body pre {
          background: ${C.navyDeep}; color: #e2e8f0; padding: 14px 16px; border-radius: 8px;
          overflow-x: auto; font-size: 12.5px; line-height: 1.5;
        }
        .ticket-body pre code { background: transparent; border: none; color: inherit; padding: 0; }
        .ticket-body blockquote {
          border-left: 3px solid ${C.gold}; margin: 1em 0; padding: 4px 14px;
          color: ${C.textMuted}; background: ${C.surfaceAlt}; border-radius: 4px;
        }
        .ticket-body hr { border: none; border-top: 1px solid ${C.border}; margin: 1.8em 0; }
        .ticket-body table { border-collapse: collapse; margin: 1em 0; }
        .ticket-body th, .ticket-body td { border: 1px solid ${C.border}; padding: 6px 10px; font-size: 13px; }
        .ticket-body th { background: ${C.surfaceAlt}; font-weight: 700; }
        .ticket-body a { color: ${C.info}; }
      `}</style>

      {editing && (
        <TicketEditModal
          ticket={ticket}
          onClose={() => setEditing(false)}
          onSaved={(t) => { setEditing(false); setTicket(t); }}
        />
      )}
    </div>
  );
}

function TicketEditModal({ ticket, onClose, onSaved }) {
  const isNew = !ticket;
  const [f, setF] = useState(() => ({
    code:          ticket?.code          || '',
    title:         ticket?.title         || '',
    status:        ticket?.status        || 'open',
    priority:      ticket?.priority      || 'normal',
    author:        ticket?.author        || '',
    body_markdown: ticket?.body_markdown || '',
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    if (isNew) {
      if (!f.code || !f.title || !f.body_markdown) { setErr('Code, title and body are required.'); return; }
    }
    setSaving(true); setErr('');
    try {
      const saved = isNew ? await api.createTicket(f) : await api.updateTicket(ticket.id, f);
      onSaved(saved);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, borderRadius: 16, padding: 28, width: 'min(820px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 30px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
            {isNew ? 'New ticket' : `Edit ${ticket.code}`}
          </h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, color: C.textFaint, cursor: 'pointer' }}>×</button>
        </div>
        {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14, border: `1px solid ${C.danger}33` }}>{err}</div>}

        <div style={{ display: 'grid', gap: 14 }}>
          {isNew && (
            <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 14 }}>
              <div>
                <label style={label}>Code</label>
                <input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} style={{ ...input, fontFamily: 'ui-monospace, monospace' }} placeholder="SEPOS-XXX" />
              </div>
              <div>
                <label style={label}>Author</label>
                <input value={f.author} onChange={(e) => set('author', e.target.value)} style={input} placeholder="Your name" />
              </div>
            </div>
          )}
          <div>
            <label style={label}>Title</label>
            <input value={f.title} onChange={(e) => set('title', e.target.value)} style={input} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label style={label}>Status</label>
              <select value={f.status} onChange={(e) => set('status', e.target.value)} style={input}>
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>Priority</label>
              <select value={f.priority} onChange={(e) => set('priority', e.target.value)} style={input}>
                {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={label}>Body (Markdown)</label>
            <textarea
              value={f.body_markdown}
              onChange={(e) => set('body_markdown', e.target.value)}
              style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, minHeight: 360, resize: 'vertical' }}
              placeholder="# Ticket title&#10;&#10;## Overview&#10;..."
            />
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
