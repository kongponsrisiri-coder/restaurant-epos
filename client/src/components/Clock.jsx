import { useState, useEffect } from 'react';

// SEPOS-ANDROID-002 — shared live clock. Inline (default) sits in the navbar;
// `fixed` pins a compact clock top-right for screens without a navbar (the
// dedicated Kitchen / Bar displays). Gold time on the navy chrome.
export default function Clock({ fixed = false }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const body = (
    <div className={fixed ? undefined : 'nav-clock'} style={{ textAlign: 'right', lineHeight: 1.05 }}>
      <div className="nav-clock-time" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: fixed ? 22 : 16, color: 'var(--brand-accent,#C9A84C)' }}>{time}</div>
      <div className="nav-clock-date" style={{ fontSize: fixed ? 11 : 10, color: 'rgba(255,255,255,0.6)' }}>{date}</div>
    </div>
  );
  return fixed
    ? <div style={{ position: 'fixed', top: 10, right: 16, zIndex: 9000 }}>{body}</div>
    : body;
}
