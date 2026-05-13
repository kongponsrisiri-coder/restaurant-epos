// SEPOS-044 follow-up — sync queue inspector modal.
// Opens from SyncHealthBanner. Lists every entry in the Mac's local
// sync_queue that hasn't pushed to cloud, with a per-entry "Skip" button
// for permanently-failing actions (e.g. delete_order for a row that's
// already gone on cloud).

import { useEffect, useState } from 'react';
import { getSyncQueue, skipSyncQueueEntry } from '../api';

const ACTION_LABEL = {
  create_order:  'Create order',
  add_items:     'Add items',
  fire_course:   'Fire course',
  pay_order:     'Pay order',
  delete_order:  'Delete order',
};

function describePayload(actionType, payload) {
  if (!payload) return '';
  switch (actionType) {
    case 'create_order':
      return `local order #${payload.localOrderId} · table ${payload.table_id} · ${payload.covers ?? '?'} covers`;
    case 'add_items':
      return `local order #${payload.localOrderId} · ${payload.items?.length || 0} item(s)`;
    case 'fire_course':
      return `local order #${payload.localOrderId} · course ${payload.course}`;
    case 'pay_order':
      return `local order #${payload.localOrderId} · £${Number(payload.amount || 0).toFixed(2)} · ${payload.method || ''}`;
    case 'delete_order':
      return `local order #${payload.localOrderId}${payload.cloudOrderId ? ` (cloud #${payload.cloudOrderId})` : ''} · "${payload.reason || ''}"`;
    default:
      return JSON.stringify(payload).slice(0, 80);
  }
}

function ago(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SyncQueueModal({ onClose }) {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr('');
    try { const r = await getSyncQueue(); setEntries(r.entries || []); }
    catch (e) { setErr(e.message || String(e)); setEntries([]); }
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const skip = async (id, label) => {
    if (!confirm(`Skip "${label}"? It won't push to cloud — only do this if you're certain it's permanently failing.`)) return;
    setBusy(true);
    try {
      await skipSyncQueueEntry(id);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div style={panel}>
        <div style={header}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0d1b3e' }}>Sync queue</div>
            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
              {entries === null ? 'Loading…'
                : entries.length === 0 ? 'Queue is empty.'
                : `${entries.length} action${entries.length === 1 ? '' : 's'} waiting to push to cloud`}
            </div>
          </div>
          <button onClick={load} disabled={busy} style={refreshBtn} title="Refresh">↻</button>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        {err && <div style={errBox}>{err}</div>}

        <div style={body}>
          {entries === null && <div style={{ color: '#888', padding: 24, textAlign: 'center' }}>Loading…</div>}
          {entries?.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 32, textAlign: 'center' }}>
              Nothing pending. Everything's synced. 🎉
            </div>
          )}
          {entries?.map(e => {
            const label = ACTION_LABEL[e.action_type] || e.action_type;
            return (
              <div key={e.id} style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: '#0d1b3e' }}>{label}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>#{e.id} · {ago(e.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#475569', marginTop: 3, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {describePayload(e.action_type, e.payload)}
                  </div>
                </div>
                <button onClick={() => skip(e.id, label)} disabled={busy} style={skipBtn}>Skip</button>
              </div>
            );
          })}
        </div>

        <div style={footer}>
          <div style={{ fontSize: 11, color: '#94a3b8', flex: 1 }}>
            Skip drops an entry without pushing. Use only for actions you know are already reconciled on cloud.
          </div>
          <button onClick={onClose} style={ghostBtn}>Close</button>
        </div>
      </div>
    </div>
  );
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16, zIndex: 9100,
};
const panel = {
  background: 'white', borderRadius: 14, width: 'min(560px, 100%)',
  maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 30px 80px rgba(0,0,0,0.35)', overflow: 'hidden',
};
const header = {
  padding: '14px 18px', borderBottom: '1px solid #eee',
  display: 'flex', alignItems: 'center', gap: 10,
};
const closeBtn = {
  background: 'none', border: 'none',
  fontSize: 24, color: '#888', cursor: 'pointer', padding: 0, lineHeight: 1,
};
const refreshBtn = {
  background: '#f1f5f9', color: '#475569', border: 'none',
  width: 32, height: 32, borderRadius: 8, fontSize: 16, cursor: 'pointer',
};
const body = { flex: 1, overflowY: 'auto', padding: '6px 0' };
const row = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '12px 18px', borderBottom: '1px solid #f3f4f6',
};
const skipBtn = {
  background: '#fef3c7', color: '#92400e', border: '1px solid #fbbf24',
  padding: '7px 14px', borderRadius: 7, fontWeight: 800, fontSize: 12, cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const footer = {
  padding: '12px 18px', borderTop: '1px solid #eee',
  display: 'flex', gap: 10, alignItems: 'center',
};
const ghostBtn = {
  background: 'transparent', color: '#475569', border: '1px solid #cbd5e1',
  padding: '8px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer',
};
const errBox = {
  margin: '10px 18px 0', padding: '10px 12px', background: '#fee2e2',
  color: '#991b1b', borderRadius: 8, fontSize: 13,
};
