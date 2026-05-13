// SEPOS-044 follow-up — always-visible navbar pill that surfaces the
// current sync_queue depth and opens the inspector modal. Complements
// the amber SyncHealthBanner which is gated at 5+ entries or missing
// SYNC_SECRET — this pill shows whenever anything is pending, so a
// single stuck item is still reachable.

import { useEffect, useState } from 'react';
import { getSyncHealth } from '../api';
import SyncQueueModal from './SyncQueueModal';

export default function SyncQueuePill({ compact }) {
  const [health, setHealth] = useState(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let stopped = false;
    const check = () => getSyncHealth()
      .then(h => { if (!stopped) setHealth(h); })
      .catch(() => {});
    check();
    const id = setInterval(check, 15000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // Only meaningful on local-mode (Mac) installs with something pending.
  if (!health || health.db_mode !== 'local') return null;
  if (!health.pending_actions || health.pending_actions <= 0) return null;

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        title={`${health.pending_actions} sync action${health.pending_actions === 1 ? '' : 's'} pending — tap to inspect`}
        style={{
          background: 'rgba(255,255,255,0.12)',
          color: 'white',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 6,
          padding: compact ? '5px 9px' : '6px 12px',
          fontSize: compact ? 11 : 12,
          fontWeight: 800,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        🔄 {health.pending_actions}
      </button>
      {showModal && (
        <SyncQueueModal
          onClose={() => { setShowModal(false); }}
        />
      )}
    </>
  );
}
