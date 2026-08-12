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
import { getPrintAlerts, printAlertAction, getPrinters } from '../api';

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

  // SEPOS-PRINT-FALLBACK-001 — staff picks WHICH printer takes the held tickets.
  const [pickFor, setPickFor] = useState(null);   // group whose tickets are being rerouted
  const [printerList, setPrinterList] = useState([]);
  const openPicker = async (g) => {
    try {
      const list = await getPrinters();
      const rows = (Array.isArray(list) ? list : []).filter(p => p.is_active && p.ip && p.name !== g.name);
      if (!rows.length) { window.alert('No other active printer is configured — add one in Admin → Printers.'); return; }
      setPrinterList(rows); setPickFor(g);
    } catch { window.alert('Could not load the printer list.'); }
  };

  const act = async (action, ids, printerId) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await printAlertAction(action, ids, printerId);
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
          {/* SEPOS-PRINT-FALLBACK-001 — reroute to a chosen printer */}
          <button style={btn} disabled={busy} onClick={() => openPicker(g)}>→ Another printer…</button>
          <button style={btnGhost} disabled={busy} onClick={() => {
            if (window.confirm(`Throw away ${g.ids.length} held ticket(s) for ${g.name}? The kitchen will NOT get them.`)) act('dismiss', g.ids);
          }}>✕</button>
        </div>
      ))}
      {/* SEPOS-PRINT-FALLBACK-001 — printer picker for held tickets */}
      {pickFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: '#fff', color: '#1a1a2e', borderRadius: 16, padding: 22, width: 380, maxWidth: '92vw' }}>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Print {pickFor.ids.length} held ticket{pickFor.ids.length > 1 ? 's' : ''} on…</div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 14 }}>{pickFor.name} is down — pick the printer that should take its tickets. The ticket is tagged so the station knows it was redirected.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
              {printerList.map(p => (
                <button key={p.id} disabled={busy} onClick={async () => { const grp = pickFor; setPickFor(null); await act('reroute', grp.ids, p.id); }}
                  style={{ padding: '13px 14px', borderRadius: 10, border: '1.5px solid #ddd', background: '#fff', textAlign: 'left', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>
                  🖨 {p.name} <span style={{ color: '#888', fontWeight: 400, fontSize: 12 }}>({p.ip})</span>
                </button>
              ))}
            </div>
            <button onClick={() => setPickFor(null)} style={{ marginTop: 14, width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: '#f0f0f0', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
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
