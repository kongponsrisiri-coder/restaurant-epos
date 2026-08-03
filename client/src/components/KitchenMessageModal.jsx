// SEPOS-KITCHEN-MSG-001 — Waiter-side modal for sending a one-off
// message to the kitchen. Quick-pick template pills at the top let
// waiters one-tap common scenarios (allergies, holds, VIP, birthday);
// free-text textarea below for anything custom. Sends to the print
// endpoint which prints the distinctive 📢 ticket + emits a KDS banner.

import { useState, useEffect } from 'react';
import { getKitchenTemplates, sendKitchenMessage, getKitchenMessageBuffer, getSettings } from '../api';
import { isNativeApp, sendRawToPrinter } from '../native/printer';

// SEPOS-KITCHEN-MSG-002 — when `onSaveNote` is passed (order context), the modal
// ATTACHES the message to the order so it prints at the bottom of that order's
// kitchen ticket, instead of firing a standalone 📢 slip. Without it (floor-wide
// shout, no order open) it keeps the original send-standalone behaviour.
export default function KitchenMessageModal({ orderId, tableNumber, customerName, waiterName, onClose, onSent, onSaveNote, initialMessage }) {
  const [templates, setTemplates] = useState([]);
  const [message, setMessage]     = useState(initialMessage || '');
  const [sending, setSending]     = useState(false);
  const [error, setError]         = useState('');
  const attachMode = typeof onSaveNote === 'function';

  useEffect(() => {
    getKitchenTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const pickTemplate = (t) => {
    setMessage(prev => prev ? `${prev}\n${t.message}` : t.message);
    setError('');
  };

  const handleSend = async () => {
    const text = message.trim();
    if (!text) { setError('Type a message or pick a template'); return; }
    // Attach-to-order mode: save the note onto the order (prints at the bottom
    // of the kitchen ticket on the next send/fire) — no standalone slip.
    if (attachMode) {
      setSending(true); setError('');
      try {
        await onSaveNote(text);
        onClose?.();
      } catch (e) {
        setError(e?.message || 'Could not attach note');
      } finally { setSending(false); }
      return;
    }
    setSending(true); setError('');
    try {
      const payload = {
        order_id:      orderId || null,
        table_number:  tableNumber || null,
        customer_name: customerName || null,
        message:       text,
        waiter_name:   waiterName || '',
      };
      // Always send — this emits the KDS banner and (on web/desktop) prints.
      // api.js resolves with {error} on HTTP failure (no throw), so check it
      // explicitly — otherwise a failed send would silently close the modal.
      const res = await sendKitchenMessage(payload);
      if (res && res.error) throw new Error(res.error);
      // SEPOS-ANDROID-001 — on the native app the cloud can't reach the LAN
      // printer, so print the 📢 message on this device from the server buffer.
      if (isNativeApp()) {
        try {
          const s = await getSettings();
          const ip   = s?.printer_kitchen_ip   || s?.printer_receipt_ip;
          const port = s?.printer_kitchen_port || s?.printer_receipt_port || 9100;
          if (ip) {
            const buf = await getKitchenMessageBuffer(payload);
            if (buf?.data) await sendRawToPrinter(ip, port, buf.data);
          }
        } catch (e) { console.warn('[kitchen-message] native print failed:', e?.message); }
      }
      onSent?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ position:'fixed', top: 0, right: 0, bottom: 0, left: 0, background:'rgba(0,0,0,0.7)', zIndex:9000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'white', borderRadius:14, maxWidth:560, width:'100%', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ background:'var(--brand-primary,#0D1B3E)', color:'white', padding:'16px 20px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800, letterSpacing:0.3 }}>{attachMode ? '📢 Note for this order' : '📢 Message Kitchen'}</div>
            {attachMode && (
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', marginTop:2 }}>Prints at the bottom of the kitchen ticket</div>
            )}
            {(tableNumber || customerName) && (
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.7)', marginTop:2 }}>
                {tableNumber && `Table ${tableNumber}`}
                {tableNumber && customerName && ' · '}
                {customerName}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:'rgba(255,255,255,0.8)', fontSize:22, cursor:'pointer' }}>✕</button>
        </div>

        <div style={{ padding:'18px 20px', overflowY:'auto' }}>
          {templates.length > 0 && (
            <>
              <div style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Quick pick — tap to add</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:18 }}>
                {templates.map(t => (
                  <button key={t.id} onClick={() => pickTemplate(t)}
                    style={{ padding:'10px 14px', borderRadius:999, border:'1px solid #e5e7eb', background:'white', fontSize:13, fontWeight:600, color:'var(--brand-primary, #1a1a2e)', cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
                    {t.icon && <span style={{ fontSize:15 }}>{t.icon}</span>}
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize:12, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>Message</div>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Type a custom message, or pick a template above…"
            rows={4}
            autoFocus
            style={{ width:'100%', padding:14, borderRadius:10, border:'1px solid #ddd', fontSize:15, boxSizing:'border-box', resize:'vertical', fontFamily:'inherit' }}
          />

          {error && (
            <div style={{ background:'#fee2e2', color:'#991b1b', padding:'10px 12px', borderRadius:8, fontSize:13, marginTop:10 }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        <div style={{ padding:'14px 20px', borderTop:'1px solid #f0f0f0', display:'flex', gap:10 }}>
          <button onClick={onClose} disabled={sending}
            style={{ flex:1, padding:14, borderRadius:10, border:'none', background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:15 }}>
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending || !message.trim()}
            style={{ flex:2, padding:14, borderRadius:10, border:'none', background:'var(--brand-primary,#0D1B3E)', color:'white', cursor:'pointer', fontWeight:800, fontSize:15, opacity: sending || !message.trim() ? 0.5 : 1 }}>
            {attachMode ? (sending ? 'Attaching…' : '📎 Attach to ticket') : (sending ? 'Sending…' : '📢 Send to Kitchen')}
          </button>
        </div>
      </div>
    </div>
  );
}
