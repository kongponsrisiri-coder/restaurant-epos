import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createQrPay, qrPayStatus, assertOk } from '../api';

// SIAMPAY-QR-001 — dine-in QR pay-by-link modal.
// Creates a Stripe Checkout session for the bill, renders the QR on the
// till, and polls until the customer has paid (Apple Pay / Google Pay /
// card on their own phone). On success calls onPaid() — the Bill screen
// then records the payment ('QR Card') through the normal close flow.
export default function QRPayModal({ orderId, amount, onPaid, onClose }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [error, setError]         = useState('');
  const [paid, setPaid]           = useState(false);
  const sessionRef = useRef(null);
  const timerRef   = useRef(null);
  const paidRef    = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await assertOk(await createQrPay(orderId, amount));
        if (!alive) return;
        sessionRef.current = r.session_id;
        setQrDataUrl(await QRCode.toDataURL(r.url, { width: 480, margin: 1 }));
        // Poll every 2.5s. Stop on paid / unmount / error.
        timerRef.current = setInterval(async () => {
          try {
            const s = await assertOk(await qrPayStatus(orderId, sessionRef.current));
            if (s.paid && !paidRef.current) {
              paidRef.current = true;
              clearInterval(timerRef.current);
              setPaid(true);
              // Brief tick so staff see the green state before the modal hands off.
              setTimeout(() => onPaid(), 900);
            }
          } catch { /* transient poll failure — keep polling */ }
        }, 2500);
      } catch (e) {
        if (alive) setError(e.message || 'Could not start QR payment');
      }
    })();
    return () => { alive = false; if (timerRef.current) clearInterval(timerRef.current); };
  }, [orderId, amount]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,0.72)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 20, padding: '28px 24px', width: 'min(92vw, 420px)', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        {error ? (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>⚠️</div>
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>QR pay unavailable</div>
            <div style={{ fontSize: 14, color: '#666', marginBottom: 18 }}>{error}</div>
            <button onClick={onClose} style={{ padding: '12px 28px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Close</button>
          </>
        ) : paid ? (
          <>
            <div style={{ fontSize: 64, marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 800, fontSize: 20, color: '#16a34a' }}>Paid £{Number(amount).toFixed(2)}</div>
            <div style={{ fontSize: 14, color: '#666', marginTop: 6 }}>Closing the bill…</div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 800, fontSize: 19, color: 'var(--brand-primary, #0D1B3E)', marginBottom: 2 }}>Scan to pay</div>
            <div style={{ fontSize: 30, fontWeight: 900, color: 'var(--brand-primary, #0D1B3E)', marginBottom: 10 }}>£{Number(amount).toFixed(2)}</div>
            {qrDataUrl
              ? <img src={qrDataUrl} alt="Payment QR" style={{ width: 'min(64vw, 260px)', height: 'auto', borderRadius: 12, border: '1px solid #eee' }} />
              : <div style={{ width: 260, height: 260, maxWidth: '64vw', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>Preparing QR…</div>}
            <div style={{ fontSize: 13.5, color: '#666', margin: '12px 0 4px' }}>
              Customer scans with their phone camera —<br />Apple Pay · Google Pay · card, one tap.
            </div>
            <div style={{ fontSize: 12.5, color: '#999', marginBottom: 14 }}>Waiting for payment…</div>
            <button onClick={onClose} style={{ padding: '11px 26px', borderRadius: 12, border: '2px solid #ddd', background: '#fff', color: '#555', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}
