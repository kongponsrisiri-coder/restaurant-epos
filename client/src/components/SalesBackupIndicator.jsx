// SEPOS-ANDROID-003 — subtle, owner-facing status for "keep all sales on this
// device". Shows when the till last warmed its full offline copy of bills +
// reports. Native Android only — renders nothing on web POS / desktop.
import { useState, useEffect } from 'react';
import { getLastBackupAt } from '../native/salesBackup';

function isNative() {
  try {
    return !!(typeof window !== 'undefined' && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch { return false; }
}

function formatWhen(ts) {
  if (!ts) return 'not yet';
  const d = new Date(ts);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, new Date())) return `today ${time}`;
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`;
}

export default function SalesBackupIndicator() {
  if (!isNative()) return null;
  const [at, setAt] = useState(getLastBackupAt());

  useEffect(() => {
    // Re-read the timestamp periodically so it reflects background backups.
    const id = setInterval(() => setAt(getLastBackupAt()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      title="A full copy of your bills and reports (last 365 days) is kept on this device, so you can view them even with no internet."
      style={{
        color: 'white', opacity: 0.55, fontSize: 11,
        padding: '0 20px 12px', lineHeight: 1.4,
      }}
    >
      <span style={{ marginRight: 5 }}>💾</span>
      Sales saved on this device · {formatWhen(at)}
    </div>
  );
}
