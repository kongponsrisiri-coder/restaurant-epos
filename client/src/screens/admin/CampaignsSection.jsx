import { useState, useEffect } from 'react';
import { getCampaigns, getRecipientCount, sendCampaign } from '../../api';

// SEPOS-033 Phase 2 — email campaigns.
// Pick a segment → write subject + body → preview → send via Brevo.
// Unsubscribe link + GDPR footer are added by the server, not the
// operator; they're legally required and shouldn't be optional.

const SEGMENTS = [
  { id: 'VIP',     label: '⭐ VIP',     color: '#5b21b6' },
  { id: 'Regular', label: '🔁 Regular', color: '#1e40af' },
  { id: 'Lapsed',  label: '😴 Lapsed',  color: '#991b1b' },
  { id: 'All',     label: '👥 All',     color: '#1a1a2e' },
];

const PLACEHOLDER_BODY = `<p>Hi {{name}},</p>

<p>Thanks for visiting us recently — we'd love to see you again.</p>

<p>This week we're running…</p>

<p>Book a table any time at our website.</p>

<p>See you soon,<br/>The team</p>`;

function PreviewModal({ subject, body, onClose }) {
  const personalised = body.replace(/\{\{\s*name\s*\}\}/gi, 'Sample Guest');
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background:'#f5f5f5', borderRadius:14, width:'100%', maxWidth:680,
        maxHeight:'90vh', overflow:'auto', boxShadow:'0 12px 40px rgba(0,0,0,0.4)'
      }}>
        <div style={{ padding:'16px 24px', borderBottom:'1px solid #e0e0e0', background:'white', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5 }}>Subject</div>
            <div style={{ fontSize:15, fontWeight:700, color:'#1a1a2e' }}>{subject || '(empty)'}</div>
          </div>
          <button onClick={onClose} style={{ background:'#f0f0f0', border:'none', borderRadius:8, padding:'8px 16px', cursor:'pointer', fontWeight:700 }}>Close</button>
        </div>
        <div style={{ background:'#f5f5f5', padding:24 }}>
          <div style={{ background:'white', borderRadius:12, maxWidth:600, margin:'0 auto', boxShadow:'0 2px 8px rgba(0,0,0,0.06)' }}>
            <div style={{ background:'#0D1B3E', color:'#C9A84C', padding:'24px 30px', fontFamily:'Georgia, serif', fontSize:24, fontWeight:700, borderRadius:'12px 12px 0 0' }}>
              Your Restaurant Name
            </div>
            <div style={{ padding:30, lineHeight:1.6, fontSize:15, color:'#1a1a2e' }} dangerouslySetInnerHTML={{ __html: personalised }} />
            <div style={{ padding:'20px 30px', background:'#fafafa', borderTop:'1px solid #eee', fontSize:11, color:'#888', lineHeight:1.5, borderRadius:'0 0 12px 12px' }}>
              <div style={{ marginBottom:6 }}><strong>Your Restaurant Name</strong> · Address (configured in env)</div>
              <div>You're receiving this because you opted in to marketing emails. <span style={{ textDecoration:'underline' }}>Unsubscribe</span> at any time.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CampaignsSection() {
  const [segment, setSegment]     = useState('VIP');
  const [subject, setSubject]     = useState('');
  const [body, setBody]           = useState(PLACEHOLDER_BODY);
  const [count, setCount]         = useState(null);
  const [sending, setSending]     = useState(false);
  const [preview, setPreview]     = useState(false);
  const [history, setHistory]     = useState([]);
  const [result, setResult]       = useState(null);

  async function loadCount(seg) {
    try {
      const r = await getRecipientCount(seg);
      setCount(r?.count ?? 0);
    } catch { setCount(null); }
  }
  async function loadHistory() {
    try {
      const r = await getCampaigns();
      setHistory(Array.isArray(r) ? r : []);
    } catch {}
  }
  useEffect(() => { loadCount(segment); }, [segment]);
  useEffect(() => { loadHistory(); }, []);

  async function handleSend() {
    if (!subject.trim() || !body.trim()) {
      setResult({ error: 'Subject and body are required.' });
      return;
    }
    if (count === 0) {
      setResult({ error: 'No opted-in customers in this segment.' });
      return;
    }
    if (!window.confirm(`Send this campaign to ${count ?? '?'} ${segment} customer${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setSending(true);
    setResult(null);
    try {
      const r = await sendCampaign(subject.trim(), body, segment);
      if (r?.error) {
        setResult({ error: r.error });
      } else {
        setResult({ success: true, ...r });
        setSubject(''); setBody(PLACEHOLDER_BODY);
        loadHistory();
        loadCount(segment);
      }
    } catch (err) {
      setResult({ error: String(err.message || err) });
    } finally { setSending(false); }
  }

  const cardStyle = { background:'white', borderRadius:12, padding:20, marginBottom:16, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };
  const inputStyle = { width:'100%', padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, fontFamily:'inherit', boxSizing:'border-box' };

  return (
    <div style={{ padding:24, maxWidth:880 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>📧 Email Campaigns</h1>

      <div style={cardStyle}>
        <label style={{ fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', display:'block', marginBottom:8 }}>Audience</label>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
          {SEGMENTS.map(s => {
            const active = segment === s.id;
            return (
              <button key={s.id} onClick={() => setSegment(s.id)} style={{
                padding:'10px 16px', borderRadius:10, border:'2px solid ' + (active ? s.color : '#e0e0e0'),
                background: active ? s.color : 'white',
                color:      active ? 'white' : '#555',
                fontWeight:700, fontSize:13, cursor:'pointer',
              }}>{s.label}</button>
            );
          })}
        </div>
        <div style={{ fontSize:13, color:'#555' }}>
          {count === null
            ? <span style={{ color:'#888' }}>Counting recipients…</span>
            : <>Sending to <strong style={{ color:'#1a1a2e' }}>{count}</strong> opted-in customer{count === 1 ? '' : 's'} in <strong>{segment}</strong></>}
        </div>
      </div>

      <div style={cardStyle}>
        <label style={{ fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', display:'block', marginBottom:6 }}>Subject</label>
        <input value={subject} onChange={e => setSubject(e.target.value)}
               placeholder="e.g. This week's specials at Siam Garden"
               style={{ ...inputStyle, marginBottom:14 }} />
        <label style={{ fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', display:'block', marginBottom:6 }}>Body (HTML allowed · {`{{name}}`} substitutes the customer's name)</label>
        <textarea value={body} onChange={e => setBody(e.target.value)}
                  rows={14}
                  style={{ ...inputStyle, fontFamily:'Menlo, Consolas, monospace', fontSize:13 }} />
        <div style={{ display:'flex', gap:10, marginTop:14, flexWrap:'wrap' }}>
          <button onClick={() => setPreview(true)} disabled={!subject.trim() && !body.trim()} style={{
            padding:'12px 22px', borderRadius:10, border:'2px solid #1a1a2e', background:'white',
            color:'#1a1a2e', fontWeight:700, fontSize:14, cursor:'pointer'
          }}>👁 Preview</button>
          <button onClick={handleSend} disabled={sending || count === 0} style={{
            padding:'12px 22px', borderRadius:10, border:'none',
            background: sending ? '#999' : '#e94560', color:'white',
            fontWeight:700, fontSize:14, cursor: sending ? 'wait' : 'pointer'
          }}>{sending ? 'Sending…' : `📤 Send to ${count ?? '?'}`}</button>
        </div>

        {result && result.error && (
          <div style={{ marginTop:14, padding:'12px 16px', borderRadius:8, background:'rgba(239,68,68,0.12)', border:'1px solid rgba(239,68,68,0.35)', color:'#991b1b', fontSize:13 }}>
            ❌ {result.error}
          </div>
        )}
        {result && result.success && (
          <div style={{ marginTop:14, padding:'12px 16px', borderRadius:8, background:'rgba(34,197,94,0.12)', border:'1px solid rgba(34,197,94,0.35)', color:'#166534', fontSize:13 }}>
            ✓ Sent to {result.sent} customer{result.sent === 1 ? '' : 's'}{result.failed > 0 ? ` · ${result.failed} failed` : ''}.
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div style={cardStyle}>
          <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:12 }}>History</h2>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ textAlign:'left', color:'#888', fontSize:11, textTransform:'uppercase' }}>
                <th style={{ padding:'6px 4px' }}>Sent</th>
                <th style={{ padding:'6px 4px' }}>Segment</th>
                <th style={{ padding:'6px 4px' }}>Subject</th>
                <th style={{ padding:'6px 4px', textAlign:'right' }}>Recipients</th>
                <th style={{ padding:'6px 4px', textAlign:'right' }}>Sent</th>
                <th style={{ padding:'6px 4px', textAlign:'right' }}>Failed</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id} style={{ borderTop:'1px solid #f0f0f0' }}>
                  <td style={{ padding:'8px 4px', color:'#555' }}>
                    {new Date(h.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short' })} {new Date(h.created_at).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}
                  </td>
                  <td style={{ padding:'8px 4px', fontWeight:600 }}>{h.segment}</td>
                  <td style={{ padding:'8px 4px' }}>{h.subject}</td>
                  <td style={{ padding:'8px 4px', textAlign:'right', color:'#555' }}>{h.recipient_count}</td>
                  <td style={{ padding:'8px 4px', textAlign:'right', color:'#166534', fontWeight:700 }}>{h.sent_count}</td>
                  <td style={{ padding:'8px 4px', textAlign:'right', color: h.failed_count > 0 ? '#991b1b' : '#aaa' }}>{h.failed_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && <PreviewModal subject={subject} body={body} onClose={() => setPreview(false)} />}
    </div>
  );
}
