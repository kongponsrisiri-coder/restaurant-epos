// SEPOS-AI-HELP-001 — in-app "Ask AI" help assistant.
// A floating button that opens a grounded help chat. The backend
// (/api/ai/help) grounds answers in the app map + this restaurant's live
// settings, so it points to the right screen instead of guessing.

import { useEffect, useRef, useState } from 'react';
import { askAi } from '../api';

// A short platform hint so the assistant gives the right OS-specific steps
// (it's told to stay OS-neutral otherwise). Best-effort, never throws.
function detectPlatform() {
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return 'Sunmi / Android till';
    if (window.siamepos && window.siamepos.isElectron) {
      const p = (navigator.platform || navigator.userAgent || '').toLowerCase();
      if (p.includes('win')) return 'Windows desktop app';
      if (p.includes('mac')) return 'Mac desktop app';
      return 'desktop app';
    }
    const ua = (navigator.userAgent || '').toLowerCase();
    if (/ipad|iphone|ipod/.test(ua)) return 'iPad/iPhone browser';
    if (/android/.test(ua)) return 'Android tablet browser';
    return 'web browser';
  } catch { return null; }
}

const SUGGESTIONS = [
  'Where do I change the service charge?',
  'How do I add a printer?',
  'How do I refund a bill?',
  'Why is my till not syncing?',
];

export default function AiHelpAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setErr('');
    setInput('');
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await askAi(next, detectPlatform());
      if (res && res.reply) {
        setMessages(m => [...m, { role: 'assistant', content: res.reply }]);
      } else {
        setErr(res?.error || 'No reply — please try again.');
      }
    } catch (e) {
      setErr('Couldn’t reach the assistant. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} title="Ask AI for help" aria-label="Ask AI for help" style={fab}>
          🤖 <span style={{ marginLeft: 6 }}>Ask AI</span>
        </button>
      )}

      {open && (
        <div style={overlay} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div style={panel}>
            <div style={header}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--brand-primary,#0d1b3e)' }}>🤖 SiamEPOS Assistant</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>Ask how to do anything — I know your system.</div>
              </div>
              <button onClick={() => setOpen(false)} style={closeBtn} aria-label="Close">×</button>
            </div>

            <div style={body} ref={bodyRef}>
              {messages.length === 0 && (
                <div style={{ padding: '8px 4px' }}>
                  <div style={{ fontSize: 13, color: '#475569', marginBottom: 12 }}>
                    Hi! I can help you find settings and fix problems. Try one of these, or type your own question:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {SUGGESTIONS.map(s => (
                      <button key={s} onClick={() => send(s)} style={chip}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
                  <div style={m.role === 'user' ? userBubble : botBubble}>{m.content}</div>
                </div>
              ))}
              {busy && (
                <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '8px 0' }}>
                  <div style={{ ...botBubble, color: '#94a3b8' }}>…thinking</div>
                </div>
              )}
              {err && <div style={errBox}>{err}</div>}
            </div>

            <div style={footer}>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder="Type your question…"
                disabled={busy}
                style={inputBox}
              />
              <button onClick={() => send()} disabled={busy || !input.trim()} style={sendBtn}>Send</button>
            </div>
            <div style={{ fontSize: 10, color: '#b0b7c3', textAlign: 'center', padding: '0 0 8px' }}>
              AI can make mistakes — for anything critical, contact SiamEPOS support.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const fab = {
  position: 'fixed', right: 16, bottom: 16, zIndex: 8000,
  background: 'var(--brand-primary,#0d1b3e)', color: 'white',
  border: '1px solid var(--brand-accent,#C9A84C)', borderRadius: 999,
  padding: '11px 16px', fontSize: 14, fontWeight: 800, cursor: 'pointer',
  boxShadow: '0 8px 24px rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center',
};
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
  padding: 16, zIndex: 8100,
};
const panel = {
  background: 'white', borderRadius: 16, width: 'min(420px, 100%)',
  height: 'min(600px, 88vh)', display: 'flex', flexDirection: 'column',
  boxShadow: '0 30px 80px rgba(0,0,0,0.4)', overflow: 'hidden',
};
const header = {
  padding: '13px 16px', borderBottom: '1px solid #eee',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
};
const closeBtn = { background: 'none', border: 'none', fontSize: 26, color: '#888', cursor: 'pointer', padding: 0, lineHeight: 1 };
const body = { flex: 1, overflowY: 'auto', padding: '10px 14px' };
const userBubble = {
  background: 'var(--brand-primary,#0d1b3e)', color: 'white', borderRadius: '14px 14px 3px 14px',
  padding: '9px 13px', fontSize: 14, maxWidth: '85%', whiteSpace: 'pre-wrap', lineHeight: 1.4,
};
const botBubble = {
  background: '#f1f5f9', color: '#0f172a', borderRadius: '14px 14px 14px 3px',
  padding: '9px 13px', fontSize: 14, maxWidth: '88%', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const chip = {
  textAlign: 'left', background: 'white', border: '1px solid #cbd5e1', borderRadius: 10,
  padding: '10px 12px', fontSize: 13, color: 'var(--brand-primary,#0d1b3e)', cursor: 'pointer', fontWeight: 600,
};
const footer = { padding: '10px 12px 6px', borderTop: '1px solid #eee', display: 'flex', gap: 8 };
const inputBox = {
  flex: 1, border: '1px solid #cbd5e1', borderRadius: 10, padding: '10px 12px', fontSize: 14, outline: 'none',
};
const sendBtn = {
  background: 'var(--brand-accent,#C9A84C)', color: 'var(--brand-primary,#0d1b3e)', border: 'none',
  borderRadius: 10, padding: '0 18px', fontSize: 14, fontWeight: 800, cursor: 'pointer',
};
const errBox = {
  margin: '8px 0', padding: '9px 12px', background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 13,
};
