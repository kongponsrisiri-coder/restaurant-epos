// SEPOS-044 follow-up — warns the operator when the Mac install is in
// local mode but SYNC_SECRET isn't configured. In that state, deletes
// done on the Mac don't propagate to the cloud and orders appear stuck.
// Also surfaces a backed-up sync queue (>=20 pending actions).

import { useEffect, useState } from 'react';
import { getSyncHealth } from '../api';
import SyncQueueModal from './SyncQueueModal';

// Threshold for the "queue backing up" warning. Lowered from 20 because
// even a handful of stuck actions usually means something is wrong, and
// the operator should know now rather than after it's a real backlog.
const BACKUP_THRESHOLD = 5;

export default function SyncHealthBanner() {
  const [health, setHealth] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  const check = () => getSyncHealth()
    .then(h => setHealth(h))
    .catch(() => {});

  useEffect(() => {
    check();
    const id = setInterval(check, 60_000);  // re-check every minute
    return () => clearInterval(id);
  }, []);

  if (!health) return null;
  if (health.db_mode !== 'local') return null;   // only meaningful on Mac/desktop installs

  const missingSecret = !health.sync_secret_set;
  const backedUp      = health.pending_actions >= BACKUP_THRESHOLD;
  const showBanner    = !dismissed && (missingSecret || backedUp);

  return (
    <>
      {showBanner && (
        <div style={wrap}>
          <span style={{ fontSize: 18 }}>{missingSecret ? '⚠️' : '🐌'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {missingSecret ? (
              <>
                <strong>Sync not fully configured.</strong>{' '}
                <code style={code}>SYNC_SECRET</code> is missing from this install. Deletes and bill-history won't reach the cloud until you set it in <code style={code}>config.json</code> to match the Railway value.
                {health.pending_actions > 0 && <> {health.pending_actions} action{health.pending_actions === 1 ? '' : 's'} queued so far.</>}
              </>
            ) : (
              <>
                <strong>Sync queue is backing up.</strong> {health.pending_actions} action{health.pending_actions === 1 ? '' : 's'} waiting to push to cloud. Network outage, Railway down, or an action failing repeatedly.
              </>
            )}
          </div>
          <button onClick={() => setShowQueue(true)} style={inspectBtn}>
            View queue →
          </button>
          <button onClick={() => setDismissed(true)} style={dismissBtn} title="Hide until reload">×</button>
        </div>
      )}
      {showQueue && <SyncQueueModal onClose={() => { setShowQueue(false); check(); }} />}
    </>
  );
}

const wrap = {
  background: '#fef3c7', borderBottom: '2px solid #f59e0b',
  color: '#78350f', padding: '10px 18px', fontSize: 13,
  display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
};
const code = {
  background: 'rgba(120,53,15,0.12)', padding: '1px 6px', borderRadius: 4,
  fontFamily: 'ui-monospace, monospace', fontSize: 12,
};
const dismissBtn = {
  background: 'transparent', border: 'none', fontSize: 22,
  color: '#78350f', cursor: 'pointer', padding: 0, lineHeight: 1,
  opacity: 0.6,
};
const inspectBtn = {
  background: '#0d1b3e', color: 'white', border: 'none',
  padding: '6px 12px', borderRadius: 6,
  fontWeight: 800, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
};
