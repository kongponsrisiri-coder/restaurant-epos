// SEPOS-044 follow-up — warns the operator when the Mac install is in
// local mode but SYNC_SECRET isn't configured. In that state, deletes
// done on the Mac don't propagate to the cloud and orders appear stuck.
// Also surfaces a backed-up sync queue (>=20 pending actions).

import { useEffect, useState } from 'react';
import { getSyncHealth } from '../api';

export default function SyncHealthBanner() {
  const [health, setHealth] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let stopped = false;
    const check = () => getSyncHealth()
      .then(h => { if (!stopped) setHealth(h); })
      .catch(() => {});
    check();
    const id = setInterval(check, 60_000);  // re-check every minute
    return () => { stopped = true; clearInterval(id); };
  }, []);

  if (!health || dismissed) return null;
  if (health.healthy) return null;
  if (health.db_mode !== 'local') return null;   // only meaningful on Mac/desktop installs

  const missingSecret = !health.sync_secret_set;
  const backedUp = health.pending_actions >= 20;

  return (
    <div style={wrap}>
      <span style={{ fontSize: 18 }}>{missingSecret ? '⚠️' : '🐌'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {missingSecret ? (
          <>
            <strong>Sync not fully configured.</strong>{' '}
            <code style={code}>SYNC_SECRET</code> is missing from this install. Deletes and bill-history won't reach the cloud until you set it in <code style={code}>config.json</code> to match the Railway value. <em>Manager-PIN order delete is the most common thing that silently fails.</em>
          </>
        ) : (
          <>
            <strong>Sync queue is backing up.</strong> {health.pending_actions} actions waiting to push to cloud. Network outage, Railway down, or an action failing repeatedly.
          </>
        )}
      </div>
      <button onClick={() => setDismissed(true)} style={dismissBtn} title="Hide until reload">×</button>
    </div>
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
