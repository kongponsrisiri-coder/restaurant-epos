import { useState, useEffect } from 'react';
import { isNativePlatform, probeTenant, getTenantUrl } from '../native/tenant';

// SEPOS-ANDROID-RESCAN-001 (Korakot, 9 Sep) — "i need alert bar if they need to
// re-scan the qr code".
//
// A satellite tablet is pointed at the host till by IP, and the router hands that
// address out. If it moves mid-service the app doesn't crash - it just quietly
// fails every request, which reads to staff as "the till is broken". The
// full-screen reconnect only runs at boot, so someone already signed in would
// never see it.
//
// This is the in-service counterpart: a thin bar, same grammar as OfflineBanner,
// that appears when the till stops answering and offers the scanner directly.
//
// Deliberately NOT chatty: it takes TWO consecutive failed probes to appear (a
// single dropped packet on restaurant wifi must not flash a scary bar mid-order),
// and it clears itself the moment the till answers again - so if the host merely
// rebooted, staff see it vanish without touching anything.
//
// Native satellites only: a browser is fixed to the origin it was served from and
// a host till has no tenant URL, so neither can be re-pointed.
export default function TillUnreachableBanner({ onRescan, suspended = false }) {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (!isNativePlatform() || !getTenantUrl() || suspended) { setLost(false); return; }
    let alive = true;
    let misses = 0;

    const tick = async () => {
      const ok = await probeTenant(6000);
      if (!alive) return;
      if (ok) { misses = 0; setLost(false); return; }
      misses += 1;
      if (misses >= 2) setLost(true);          // two in a row before we say anything
    };

    tick();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [suspended]);

  if (!lost) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100001,
      background: '#b91c1c', color: '#fff',
      fontSize: 13, fontWeight: 600, textAlign: 'center',
      padding: '6px 12px', letterSpacing: 0.2,
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <span>⚠ Can&rsquo;t reach the till — its address has probably changed.</span>
      {onRescan && (
        <button onClick={onRescan} style={{
          background: '#fff', color: '#b91c1c', border: 'none', borderRadius: 8,
          padding: '4px 12px', fontSize: 13, fontWeight: 800, cursor: 'pointer',
        }}>
          📷 Re-scan QR code
        </button>
      )}
    </div>
  );
}
