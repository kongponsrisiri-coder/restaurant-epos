// SEPOS-SCAN-001 — 📷 scan-to-fill for voucher/deposit code boxes (Korakot,
// 12 Aug: "staff shouldn't type codes at the table"). Reuses the same
// html5-qrcode engine as the tenant-setup scanner; dynamic import keeps it
// out of the main bundle. Works in any WebView with a camera (iPad, Android
// tablet, laptop tills); camera-less devices get a graceful "type instead".

import { useEffect, useState } from 'react';

// Voucher emails encode the bare code; wallet passes sometimes encode a URL —
// take the last path/query token so either lands as the code.
const normalise = (v) => {
  const s = String(v || '').trim();
  if (!s.includes('://')) return s;
  return s.split(/[/?=&]/).filter(Boolean).pop() || s;
};

export default function CodeScanButton({ onScan, style }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let scanner; let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 60));
        if (cancelled) return;
        scanner = new Html5Qrcode('sepos-code-scan');
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 230, height: 230 } },
          async (decoded) => {
            try { await scanner.stop(); } catch { /* already stopping */ }
            setOpen(false);
            const v = normalise(decoded);
            if (v) onScan(v);
          },
          () => { /* per-frame decode misses are normal */ }
        );
      } catch {
        if (!cancelled) { alert('Camera unavailable — type the code instead.'); setOpen(false); }
      }
    })();
    return () => { cancelled = true; if (scanner) { try { scanner.stop().catch(() => {}); } catch { /* gone */ } } };
  }, [open, onScan]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Scan the voucher QR code"
        style={{ flex: 'none', padding: '0 12px', borderRadius: 10, border: '1.5px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 18, ...style }}>📷</button>
      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 4000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>Point the camera at the QR code</div>
          <div id="sepos-code-scan" style={{ width: 300, maxWidth: '86vw', borderRadius: 12, overflow: 'hidden' }} />
          <button onClick={() => setOpen(false)} style={{ padding: '10px 26px', borderRadius: 10, border: 'none', background: '#fff', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
    </>
  );
}
