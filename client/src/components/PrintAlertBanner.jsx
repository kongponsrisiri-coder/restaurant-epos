// SEPOS-PRINT-ALERT-001 — unmissable in-app printer alerts.
// The till runs fullscreen, so OS print errors are invisible. This banner
// lives INSIDE the app on every screen:
//   • RED — tickets are being HELD because a printer failed. Staff choose:
//     Retry (printer's back) / Print to main kitchen (explicit hand-off) /
//     Dismiss (manager decision — the ticket is dropped).
//   • AMBER — a configured printer stopped answering pings (early warning,
//     before any ticket is lost). Auto-clears when the printer recovers.
// Polls every 15s; cloud/web tills get empty lists so it never renders there.

import { useEffect, useRef, useState } from 'react';
import { getPrintAlerts, printAlertAction } from '../api';

const POLL_MS = 15 * 1000;

export default function PrintAlertBanner() {
  const [alerts, setAlerts] = useState([]);
  const [printersDown, setPrintersDown] = useState([]);
  const [busy, setBusy] = useState(false);
  const [snoozed, setSnoozed] = useState({}); // amber-only: key -> down_since snoozed
  const timerRef = useRef(null);

  const refresh = async () => {
    try {
      const d = await getPrintAlerts();
      if (d && !d.error) {
        setAlerts(Array.isArray(d.alerts) ? d.alerts : []);
        setPrintersDown(Array.isArray(d.printers) ? d.printers : []);
      }
    } catch { /* offline — keep last state */ }
  };

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timerRef.current); window.removeEventListener('focus', onFocus); };
  }, []);

  const act = async (action, ids) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await printAlertAction(action, ids);
      // Surface per-ticket failures (e.g. retry while still off) simply.
      const failed = (r?.results || []).filter(x => !x.ok);
      if (failed.length && action !== 'dismiss') {
        window.alert(`${failed.length} ticket(s) still could not print — printer may still be off.`);
      }
    } catch { /* refresh below shows truth */ }
    await refresh();
    setBusy(false);
  };

  // Group held tickets by printer for one row per printer.
  const groups = [];
  {
    const byPrinter = new Map();
    for (const a of alerts) {
      const key = `${a.kind}:${a.printer_id ?? a.printer_name}`;
      if (!byPrinter.has(key)) byPrinter.set(key, { name: a.printer_name || 'Printer', kind: a.kind, ids: [], labels: [] });
      const g = byPrinter.get(key);
      g.ids.push(a.id);
      if (a.order_label) g.labels.push(a.order_label);
    }
    groups.push(...byPrinter.values());
  }

  // Amber list: printers down that have NO held tickets yet (else red covers it),
  // minus snoozed entries (snooze auto-expires when down_since changes).
  const heldNames = new Set(groups.map(g => g.name));
  const amber = printersDown.filter(p => !heldNames.has(p.name) && snoozed[`${p.name}|${p.down_since}`] !== true);

  if (!groups.length && !amber.length) return null;

  return (
    <div style={wrap}>
      {groups.map(g => (
        <div key={`red-${g.kind}-${g.name}`} style={redRow}>
          <span style={{ flex: 1, minWidth: 0 }}>
            🖨️⚠️ <b>{g.name}</b> printer failed — <b>{g.ids.length} ticket{g.ids.length > 1 ? 's' : ''} waiting</b>
            {g.labels.length > 0 && <span style={{ opacity: 0.85 }}> ({g.labels.slice(0, 3).join(', ')}{g.labels.length > 3 ? '…' : ''})</span>}
            {' '}— NOT printed anywhere yet
          </span>
          <button style={btn} disabled={busy} onClick={() => act('retry', g.ids)}>↻ Retry</button>
          {g.kind !== 'kitchen' && (
            <button style={btn} disabled={busy} onClick={() => act('redirect', g.ids)}>→ Print to main kitchen</button>
          )}
          <button style={btnGhost} disabled={busy} onClick={() => {
            if (window.confirm(`Throw away ${g.ids.length} held ticket(s) for ${g.name}? The kitchen will NOT get them.`)) act('dismiss', g.ids);
          }}>✕</button>
        </div>
      ))}
      {amber.map(p => (
        <div key={`amber-${p.name}-${p.down_since}`} style={amberRow}>
          <span style={{ flex: 1 }}>
            🖨️ <b>{p.name}</b> printer is not responding ({p.ip}) — check power &amp; cable before sending orders
          </span>
          <button style={btnGhostDark} onClick={() => setSnoozed(s => ({ ...s, [`${p.name}|${p.down_since}`]: true }))}>Hide</button>
        </div>
      ))}
    </div>
  );
}

const wrap = { flexShrink: 0, zIndex: 500 };
const redRow = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
  background: '#b91c1c', color: '#fff', fontSize: 14, fontWeight: 600,
  borderBottom: '1px solid rgba(0,0,0,0.25)',
};
const amberRow = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
  background: '#b45309', color: '#fff', fontSize: 13, fontWeight: 600,
  borderBottom: '1px solid rgba(0,0,0,0.25)',
};
const btn = {
  background: '#fff', color: '#b91c1c', border: 'none', borderRadius: 8,
  padding: '7px 12px', fontSize: 13, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
};
const btnGhost = {
  background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)',
  borderRadius: 8, padding: '7px 10px', fontSize: 13, fontWeight: 800, cursor: 'pointer',
};
const btnGhostDark = { ...btnGhost, fontWeight: 600 };
