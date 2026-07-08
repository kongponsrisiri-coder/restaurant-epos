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

  // Only meaningful on local-mode (Mac) installs. Show whenever something is
  // pending OR quarantined (a failed action the operator should see + clear).
  if (!health || health.db_mode !== 'local') return null;
  const pending = health.pending_actions || 0;
  const failed = health.failed_actions || 0;
  if (pending <= 0 && failed <= 0) return null;

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        title={failed > 0
          ? `${failed} sync action${failed === 1 ? '' : 's'} failed — tap to review`
          : `${pending} sync action${pending === 1 ? '' : 's'} pending — tap to inspect`}
        style={{
          background: failed > 0 ? '#b45309' : 'rgba(255,255,255,0.12)',
          color: 'white',
          border: failed > 0 ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.2)',
          borderRadius: 6,
          padding: compact ? '5px 9px' : '6px 12px',
          fontSize: compact ? 11 : 12,
          fontWeight: 800,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {failed > 0 ? `⚠ ${failed}${pending ? ` · 🔄 ${pending}` : ''}` : `🔄 ${pending}`}
      </button>
      {showModal && (
        <SyncQueueModal
          onClose={() => { setShowModal(false); }}
        />
      )}
    </>
  );
}
