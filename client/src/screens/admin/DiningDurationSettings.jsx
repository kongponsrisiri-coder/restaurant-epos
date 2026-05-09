import { useState, useEffect } from 'react';
import { SERVER_URL } from '../api';

// ─────────────────────────────────────────────────────────────────
// DiningDurationSettings
// Location: Admin → Reservations settings tab
//
// Sandy: Self-contained component — drop anywhere in admin.
// Krit: import and render inside wherever reservations settings live.
//   import DiningDurationSettings from './DiningDurationSettings';
//   <DiningDurationSettings />
// ─────────────────────────────────────────────────────────────────

const DEFAULT_TIERS = [
  { id: 1, covers_min: 1, covers_max: 4,    duration_mins: 90  },
  { id: 2, covers_min: 5, covers_max: 8,    duration_mins: 120 },
  { id: 3, covers_min: 9, covers_max: null, duration_mins: 150 },
];

function coverLabel(tier) {
  if (!tier.covers_max) return `${tier.covers_min}+ covers`;
  return `${tier.covers_min}–${tier.covers_max} covers`;
}

export default function DiningDurationSettings() {
  const [tiers,   setTiers]   = useState(DEFAULT_TIERS);
  const [saving,  setSaving]  = useState({});  // { [id]: true }
  const [saved,   setSaved]   = useState({});  // { [id]: true } — flash tick
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  // ── Load ───────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${SERVER_URL}/api/dining-duration-tiers`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length) setTiers(data);
      })
      .catch(() => setError('Could not load tiers — using defaults'))
      .finally(() => setLoading(false));
  }, []);

  // ── Update a single tier ───────────────────────────────────────
  async function handleSave(tier) {
    setSaving(p => ({ ...p, [tier.id]: true }));
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/dining-duration-tiers/${tier.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_mins: tier.duration_mins }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaved(p => ({ ...p, [tier.id]: true }));
      setTimeout(() => setSaved(p => ({ ...p, [tier.id]: false })), 2000);
    } catch {
      setError(`Failed to save ${coverLabel(tier)} — try again`);
    } finally {
      setSaving(p => ({ ...p, [tier.id]: false }));
    }
  }

  function updateDuration(id, val) {
    setTiers(prev => prev.map(t => t.id === id ? { ...t, duration_mins: val } : t));
    setSaved(p => ({ ...p, [id]: false }));
  }

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={{ background: 'white', borderRadius: 14, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', maxWidth: 480 }}>

      {/* Header */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>Dining Duration Tiers</div>
        <div style={{ fontSize: 13, color: '#888', marginTop: 3, lineHeight: 1.5 }}>
          How long each booking occupies a table. Applied automatically by party size when checking availability.
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Tiers table */}
      <div style={{ marginTop: 16 }}>

        {/* Column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 90px', gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
          <div style={colHdr}>Party size</div>
          <div style={{ ...colHdr, textAlign: 'center' }}>Duration (mins)</div>
          <div />
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: '#aaa', fontSize: 13 }}>Loading…</div>
        ) : (
          tiers.map(tier => (
            <div
              key={tier.id}
              style={{ display: 'grid', gridTemplateColumns: '1fr 140px 90px', gap: 10, alignItems: 'center', marginBottom: 10 }}
            >
              {/* Covers label — read only */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: tier.covers_min <= 4 ? '#3b82f6' : tier.covers_min <= 8 ? '#f59e0b' : '#e94560',
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#1a1a2e' }}>{coverLabel(tier)}</span>
              </div>

              {/* Duration input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number"
                  value={tier.duration_mins}
                  min={30}
                  max={360}
                  step={15}
                  onChange={e => updateDuration(tier.id, parseInt(e.target.value) || 90)}
                  onKeyDown={e => e.key === 'Enter' && handleSave(tier)}
                  style={{
                    flex: 1, padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8,
                    fontSize: 15, fontWeight: 700, textAlign: 'center',
                    color: '#1a1a2e', fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
                <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>min</span>
              </div>

              {/* Save button */}
              <button
                onClick={() => handleSave(tier)}
                disabled={saving[tier.id]}
                style={{
                  padding: '8px 0', borderRadius: 8, border: 'none', cursor: saving[tier.id] ? 'not-allowed' : 'pointer',
                  fontWeight: 700, fontSize: 13, width: '100%',
                  background: saved[tier.id]  ? '#dcfce7' : saving[tier.id] ? '#f0f0f0' : '#1a1a2e',
                  color:      saved[tier.id]  ? '#14532d' : saving[tier.id] ? '#aaa'    : 'white',
                  transition: 'background .15s, color .15s',
                }}
              >
                {saving[tier.id] ? '…' : saved[tier.id] ? '✓ Saved' : 'Save'}
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #f0f0f0', fontSize: 12, color: '#888', lineHeight: 1.6 }}>
        💡 These times control how far ahead a table is blocked after a booking starts.
        A table booked at 19:00 for a party of 6 (120 min) is unavailable until 21:00.
        Use multiples of 15 for clean slot alignment.
      </div>
    </div>
  );
}

const colHdr = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
