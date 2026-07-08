// SEPOS-AI-HELP-001 — "AI Assistant" section.
// Every question clients ask the in-app "Ask AI" helper, across all
// restaurants. Gold data: what clients struggle with → what to fix,
// document, or feed back into the assistant's knowledge base.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { C, card, input, label, fmtRelTime } from '../theme.js';

function Stat({ n, label: lbl, color }) {
  return (
    <div style={{ ...card, padding: '14px 18px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || C.text }}>{n ?? '—'}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{lbl}</div>
    </div>
  );
}

export default function AiHelpPage() {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [restaurant, setRestaurant] = useState('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const [logs, s] = await Promise.all([api.listAiHelpLogs(), api.aiHelpStats().catch(() => null)]);
      setRows(logs); setStats(s);
    } catch (e) { setErr(e.message); setRows([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const restaurants = useMemo(
    () => Array.from(new Set(rows.map(r => r.restaurant_name).filter(Boolean))).sort(),
    [rows]
  );
  const filtered = useMemo(() => rows.filter(r => {
    if (restaurant !== 'all' && r.restaurant_name !== restaurant) return false;
    if (q && !(`${r.question} ${r.reply || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }), [rows, restaurant, q]);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>🤖 AI Assistant</h1>
        <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
          What clients ask the in-app help assistant — across every restaurant. Spot common questions, gaps, and what to document next.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Stat n={stats?.total} label="Questions" />
        <Stat n={stats?.last_7d} label="Last 7 days" color={C.navy} />
        <Stat n={stats?.restaurants} label="Restaurants" />
        <Stat n={stats?.escalated} label="→ Support" color={C.danger} />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <select value={restaurant} onChange={e => setRestaurant(e.target.value)} style={{ ...input, width: 'auto', padding: '8px 12px' }}>
          <option value="all">All restaurants</option>
          {restaurants.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search questions…" style={{ ...input, flex: 1, minWidth: 180 }} />
        <button onClick={load} style={{ ...input, width: 'auto', padding: '8px 14px', cursor: 'pointer', fontWeight: 700 }}>↻ Refresh</button>
      </div>

      {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: C.textMuted }}>
          {rows.length === 0 ? 'No questions logged yet — they’ll appear here as clients use the in-app assistant.' : 'No questions match this filter.'}
        </div>
      ) : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {filtered.map((r, i) => {
            const open = openId === r.id;
            return (
              <div key={r.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.borderSoft}` }}>
                <div
                  onClick={() => setOpenId(open ? null : r.id)}
                  style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 14, alignItems: 'center', padding: '13px 18px', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.restaurant_name || '—'}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: open ? 'visible' : 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'normal' : 'nowrap' }}>{r.question}</div>
                    <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                      {[r.platform, r.staff_role].filter(Boolean).join(' · ')}{(r.platform || r.staff_role) ? ' · ' : ''}{fmtRelTime(r.created_at)}
                      {r.escalated && <span style={{ marginLeft: 8, background: C.dangerBg, color: '#991b1b', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999 }}>→ SUPPORT</span>}
                    </div>
                  </div>
                  <span style={{ color: C.textFaint, fontSize: 16 }}>{open ? '▾' : '›'}</span>
                </div>
                {open && (
                  <div style={{ padding: '0 18px 16px', background: C.surfaceAlt }}>
                    <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '10px 0 6px' }}>Assistant's reply</div>
                    <div style={{ fontSize: 13.5, color: C.text, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{r.reply || '—'}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
