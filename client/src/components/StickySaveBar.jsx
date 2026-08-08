// Shared sticky Save bar for long Admin pages (Settings, Printers, Reservation
// settings). Korakot 2026-08-08: the Save button was stranded mid-page; a bar
// pinned to the bottom of the content area is always reachable no matter how far
// you scroll. One component so every admin page saves the SAME way.
//
// The admin content area is a flex:1 column to the right of a static 200px
// sidebar (overlay on mobile) — see AdminScreen. The bar is fixed to the
// viewport bottom and offset left by the sidebar width on desktop so it spans
// exactly the content column and never sits under the nav.
import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;   // matches AdminScreen
const SIDEBAR_W = 200;           // desktop sidebar width (AdminScreen)

// Height a page should reserve at its bottom so the last card clears the bar.
export const SAVE_BAR_CLEARANCE = 92;

export default function StickySaveBar({
  onSave,
  label = 'Save',
  savingLabel = 'Saving…',
  savedLabel = '✓ Saved!',
  saving = false,
  saved = false,
  disabled = false,
}) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const busy = disabled || saving;
  return (
    <div style={{
      position: 'fixed', bottom: 0, right: 0, left: isMobile ? 0 : SIDEBAR_W,
      zIndex: 120, padding: '12px 20px',
      background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      borderTop: '1px solid #e5e7eb', boxShadow: '0 -3px 14px rgba(0,0,0,0.10)',
      display: 'flex', justifyContent: 'center',
    }}>
      <button
        onClick={onSave}
        disabled={busy}
        style={{
          width: '100%', maxWidth: 640, padding: '14px', borderRadius: 10, border: 'none',
          background: saved ? '#22c55e' : 'var(--brand-primary, #1a1a2e)', color: 'white',
          cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 16,
          transition: 'background 0.3s', opacity: disabled ? 0.6 : 1,
        }}
      >
        {saving ? savingLabel : saved ? savedLabel : label}
      </button>
    </div>
  );
}
