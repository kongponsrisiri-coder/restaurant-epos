import { useState, useEffect } from 'react';

// SEPOS-ANDROID-002 — thin top bar shown ONLY when the device loses internet.
// Reassures staff that the till keeps serving (orders save locally and sync
// later) while making clear that back-office features need a connection.
// When online it renders nothing, so the normal (connected) experience is
// completely unchanged.
export default function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  if (online) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100000,
      background: '#b45309', color: '#fff',
      fontSize: 13, fontWeight: 600, textAlign: 'center',
      padding: '5px 12px', letterSpacing: 0.2,
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
    }}>
      ⚠ Offline — orders are saved on this till and sync automatically when you’re back online. Bookings, reports &amp; settings need internet.
    </div>
  );
}
