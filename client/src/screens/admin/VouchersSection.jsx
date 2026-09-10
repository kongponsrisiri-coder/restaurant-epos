// SEPOS-VOUCHER-001 — Admin → 🎁 Vouchers.
// Lists every voucher sold, shows balance + status, lets the operator
// look up a code, void (manager-PIN gated by backend at issue-time;
// for v1 we trust the admin section like every other admin action),
// or resend the gift email if it bounced / lost in spam.

import { useState, useEffect, useMemo } from 'react';
import {
  listVouchers, getVoucherDetail, voidVoucher, resendVoucherEmail, sellVoucher,
  createDeposit, forfeitDeposit, getSettings,
  assertOk,
} from '../../api';
import CodeScanButton from '../../components/CodeScanButton';
import { downloadCsv } from '../../utils/csv';
import { confirm } from '../../utils/confirm';
import { useBackdropDismiss } from '../../utils/backdropGuard';

const STATUS_PILL = {
  active:   { bg: '#dcfce7', fg: '#15803d', label: '✓ Active' },
  depleted: { bg: '#e0e7ff', fg: '#4338ca', label: '⊘ Depleted' },
  expired:  { bg: '#fef3c7', fg: '#92400e', label: '⏱ Expired' },
  voided:   { bg: '#fee2e2', fg: '#991b1b', label: '✕ Voided' },
  forfeited:{ bg: '#fef3c7', fg: '#92400e', label: '🧾 Forfeited' },
};

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDate(d)  {
  if (!d) return '—';
  try {
    return new Date(String(d).slice(0,10) + 'T12:00:00')
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return String(d).slice(0,10); }
}
function fmtDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return String(d); }
}

export default function VouchersSection() {
  const detailBackdrop = useBackdropDismiss(() => setDetailId(null));
  const [rows,         setRows]         = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [q,            setQ]            = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [detailId,     setDetailId]     = useState(null);
  const [detail,       setDetail]       = useState(null);
  const [busy,         setBusy]         = useState(false);
  const [sellOpen,     setSellOpen]     = useState(false);
  const [sold,         setSold]         = useState(null); // success-modal state
  // SEPOS-DEPOSIT-001 — booking deposit (gated by deposits_enabled)
  const [depositsOn,   setDepositsOn]   = useState(false);
  const [depositOpen,  setDepositOpen]  = useState(false);
  useEffect(() => { getSettings().then(s => setDepositsOn((s?.deposits_enabled ?? s?.settings?.deposits_enabled) === '1')).catch(() => {}); }, []);

  // qOverride: the scan button passes the freshly scanned code directly —
  // setQ hasn't rendered yet at that point. Non-string (e.g. the click event
  // from onClick={load}) falls back to the q state.
  async function load(qOverride) {
    const query = typeof qOverride === 'string' ? qOverride : q;
    setLoading(true);
    try {
      const r = await listVouchers(query || undefined, statusFilter || undefined);
      const arr = Array.isArray(r) ? r : [];
      setRows(arr);
      return arr;
    } catch (e) { console.error(e); return []; }
    finally     { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  const stats = useMemo(() => {
    let activeCount = 0, activeBalance = 0, soldTotal = 0, redeemedTotal = 0, sold30 = 0;
    const thirtyAgo = Date.now() - 30 * 24 * 3600 * 1000;
    for (const v of rows) {
      const orig = Number(v.original_amount || 0);
      const bal  = Number(v.balance || 0);
      soldTotal     += orig;
      redeemedTotal += (orig - bal);
      if (v.status === 'active') { activeCount++; activeBalance += bal; }
      if (new Date(v.created_at).getTime() >= thirtyAgo) sold30 += orig;
    }
    return { activeCount, activeBalance, soldTotal, redeemedTotal, sold30 };
  }, [rows]);

  const exportCsv = () => {
    if (!rows.length) return;
    const header = ['Code', 'Recipient', 'Email', 'Sender', 'Sold £', 'Balance £', 'Status', 'Created', 'Expires', 'Payment'];
    const data = [header, ...rows.map(v => [
      v.code, v.recipient_name || '', v.recipient_email || '', v.sender_name || '',
      Number(v.original_amount || 0).toFixed(2),
      Number(v.balance || 0).toFixed(2),
      v.status, fmtDate(v.created_at), fmtDate(v.expires_at), v.payment_method || '',
    ])];
    downloadCsv(`vouchers_${new Date().toISOString().slice(0,10)}.csv`, data);
  };

  async function openDetail(id) {
    setDetailId(id); setDetail(null);
    try { setDetail(await getVoucherDetail(id)); } catch (e) { console.error(e); }
  }

  // SEPOS-046y — optimistic void. Pill flips to ✕ Voided instantly in both
  // the table and the open detail modal; the POST runs in background and
  // the server's returned row (with voided_at) is patched in as canonical.
  // No load() reconcile on success. Rollback to true state only on error.
  async function handleVoid(id) {
    if (!await confirm('Void this voucher? It cannot be redeemed after voiding.')) return;
    setRows(prev => prev.map(v => v.id === id ? { ...v, status: 'voided' } : v));
    setDetail(prev => prev?.voucher?.id === id
      ? { ...prev, voucher: { ...prev.voucher, status: 'voided' } }
      : prev);
    try {
      const r = assertOk(await voidVoucher(id, null));
      if (r?.voucher) {
        setRows(prev => prev.map(v => v.id === id ? { ...v, ...r.voucher } : v));
        setDetail(prev => prev?.voucher?.id === id ? { ...prev, voucher: { ...prev.voucher, ...r.voucher } } : prev);
      }
    } catch (e) {
      alert('Void failed: ' + e.message);
      load();
      if (detailId) openDetail(detailId);
    }
  }

  // SEPOS-DEPOSIT-001 — no-show: forfeit a deposit (kept as income). Optimistic
  // flip, mirrors handleVoid; keyed by DEP- code (the forfeit endpoint's key).
  async function handleForfeit(code, id) {
    if (!await confirm('Forfeit this deposit? The customer did not show — the deposit is kept as income and can no longer be redeemed.')) return;
    setRows(prev => prev.map(v => v.id === id ? { ...v, status: 'forfeited' } : v));
    setDetail(prev => prev?.voucher?.id === id ? { ...prev, voucher: { ...prev.voucher, status: 'forfeited' } } : prev);
    try {
      assertOk(await forfeitDeposit(code));
    } catch (e) {
      alert('Forfeit failed: ' + e.message);
      load();
      if (detailId) openDetail(detailId);
    }
  }

  async function handleResend(id) {
    setBusy(true);
    try {
      const r = await resendVoucherEmail(id);
      if (r.ok)        alert('Gift email re-sent.');
      else if (r.skipped) alert('No recipient email on file.');
      else             alert('Send failed: ' + (r.error || 'unknown'));
    } catch (e) { alert('Send failed: ' + e.message); }
    finally     { setBusy(false); }
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 4 }}>🎁 Gift Vouchers</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Vouchers sold via the public widget — redeemed at checkout</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setSellOpen(true)}
            style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: 'var(--brand-accent,#C9A84C)', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
            + Sell voucher
          </button>
          {depositsOn && (
            <button onClick={() => setDepositOpen(true)}
              style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: 'var(--brand-primary,#0D1B3E)', color: 'white', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
              🧾 Take deposit
            </button>
          )}
          <button onClick={exportCsv}
            style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            ⬇ Export CSV
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { label: 'Total sold',         value: fmtMoney(stats.soldTotal),     color: 'var(--brand-primary, #1a1a2e)' },
          { label: 'Sold last 30 days',  value: fmtMoney(stats.sold30),        color: '#3b82f6' },
          { label: 'Active vouchers',    value: stats.activeCount,             color: '#22c55e' },
          { label: 'Outstanding balance',value: fmtMoney(stats.activeBalance), color: '#eab308' },
          { label: 'Redeemed (off till)',value: fmtMoney(stats.redeemedTotal), color: '#8b5cf6' },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', borderRadius: 10, padding: '10px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
          placeholder="Search code, email or name…"
          style={{ flex: 1, minWidth: 220, padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}/>
        <button onClick={load}
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Search
        </button>
        {/* SEPOS-SCAN-EVERYWHERE-001 — scan a customer's voucher QR at the
            counter: filters to it and opens its balance in one step. */}
        <CodeScanButton onScan={async (v) => {
          const code = v.toUpperCase();
          setQ(code);
          const arr = await load(code);
          if (arr.length === 1) openDetail(arr[0].id);
        }} style={{ height: 40 }} />
        {['', 'active', 'depleted', 'expired', 'voided'].map(s => (
          <button key={s || 'all'} onClick={() => setStatusFilter(s)}
            style={{ padding: '8px 14px', borderRadius: 20, border: 'none', background: statusFilter === s ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0', color: statusFilter === s ? 'white' : '#555', fontWeight: 600, fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' }}>
            {s || 'all'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: 'white', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ padding: '10px 16px', background: '#f8f8f8', display: 'grid', gridTemplateColumns: '160px 1fr 90px 90px 110px 110px', fontWeight: 700, fontSize: 12, color: '#555' }}>
          <span>Code</span><span>Recipient</span><span style={{ textAlign: 'right' }}>Sold</span><span style={{ textAlign: 'right' }}>Balance</span><span>Status</span><span>Expires</span>
        </div>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>No vouchers yet</div>
        ) : rows.map(v => {
          const pill = STATUS_PILL[v.status] || { bg: '#eee', fg: '#555', label: v.status };
          return (
            <div key={v.id} onClick={() => openDetail(v.id)} style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '160px 1fr 90px 90px 110px 110px', alignItems: 'center', borderBottom: '1px solid #f0f0f0', fontSize: 13, cursor: 'pointer' }}>
              <span style={{ fontFamily: 'Menlo,Consolas,monospace', fontWeight: 700, color: '#1e3a6e' }}>{v.code}</span>
              <span>
                <div style={{ fontWeight: 600 }}>{v.recipient_name || <em style={{ color: '#888' }}>—</em>}</div>
                <div style={{ fontSize: 11, color: '#888' }}>{v.recipient_email || ''}</div>
              </span>
              <span style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(v.original_amount)}</span>
              <span style={{ textAlign: 'right', fontWeight: 700, color: Number(v.balance) > 0 ? '#22c55e' : '#888' }}>{fmtMoney(v.balance)}</span>
              <span><span style={{ background: pill.bg, color: pill.fg, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 12 }}>{pill.label}</span></span>
              <span style={{ color: '#666', fontSize: 12 }}>{fmtDate(v.expires_at)}</span>
            </div>
          );
        })}
      </div>

      {/* Sell voucher modal */}
      {sellOpen && (
        <SellVoucherModal
          onClose={() => setSellOpen(false)}
          onSold={(voucher) => {
            setSellOpen(false); setSold(voucher);
            // SEPOS-046y — the sell response IS the full canonical row;
            // prepend it instead of a load() round-trip.
            setRows(prev => [voucher, ...prev]);
          }}
        />
      )}

      {/* SEPOS-DEPOSIT-001 — take booking deposit modal */}
      {depositOpen && (
        <TakeDepositModal
          onClose={() => setDepositOpen(false)}
          onTaken={(voucher) => {
            setDepositOpen(false); setSold(voucher);
            if (voucher) setRows(prev => [voucher, ...prev]);
          }}
        />
      )}

      {/* Sold success */}
      {sold && (
        <SoldSuccessModal voucher={sold} onClose={() => setSold(null)} />
      )}

      {/* Detail modal */}
      {detailId && (
        <div {...detailBackdrop}
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{detail?.voucher?.code || 'Loading…'}</div>
              <button onClick={() => setDetailId(null)} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#888' }}>×</button>
            </div>
            {!detail ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#bbb' }}>Loading…</div>
            ) : (
              <div style={{ padding: 22 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <KV label="Original" value={fmtMoney(detail.voucher.original_amount)} big />
                  <KV label="Balance"  value={fmtMoney(detail.voucher.balance)}         big highlight />
                  <KV label="Status"   value={STATUS_PILL[detail.voucher.status]?.label || detail.voucher.status} />
                  <KV label="Expires"  value={fmtDate(detail.voucher.expires_at)} />
                  <KV label="Recipient" value={detail.voucher.recipient_name || '—'} />
                  <KV label="Email"     value={detail.voucher.recipient_email || '—'} />
                  <KV label="From"      value={detail.voucher.sender_name || '—'} />
                  <KV label="Created"   value={fmtDateTime(detail.voucher.created_at)} />
                  <KV label="Payment"   value={detail.voucher.payment_method || '—'} />
                  <KV label="Email sent" value={detail.voucher.email_sent_at ? fmtDateTime(detail.voucher.email_sent_at) : 'no'} />
                </div>

                {detail.voucher.message && (
                  <div style={{ background: '#fdf6ec', borderLeft: '3px solid var(--brand-accent,#C9A84C)', padding: '10px 14px', borderRadius: '0 8px 8px 0', fontSize: 13, color: '#5b4a2a', fontStyle: 'italic', marginBottom: 16 }}>
                    "{detail.voucher.message}"
                  </div>
                )}

                <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700, color: '#555' }}>Redemption history ({detail.redemptions.length})</div>
                {detail.redemptions.length === 0 ? (
                  <div style={{ background: '#fafaf7', borderRadius: 8, padding: '14px 16px', fontSize: 13, color: '#888' }}>Not redeemed yet</div>
                ) : (
                  <div style={{ background: '#fafaf7', borderRadius: 8, padding: '4px 0' }}>
                    {detail.redemptions.map(r => (
                      <div key={r.id} style={{ padding: '8px 16px', display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                        <span>
                          {fmtDateTime(r.used_at)}{r.bill_id ? ` · bill #${r.bill_id}` : ''}
                          {r.redeemed_by_name ? ` · by ${r.redeemed_by_name}` : ''}
                        </span>
                        <span style={{ fontWeight: 700, color: '#e94560' }}>−{fmtMoney(r.amount_used)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
                  {detail.voucher.recipient_email && (
                    <button onClick={() => handleResend(detail.voucher.id)} disabled={busy}
                      style={{ flex: 1, padding: '12px', borderRadius: 8, border: '1px solid #1e3a6e', background: 'white', color: '#1e3a6e', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
                      ✉️ Resend gift email
                    </button>
                  )}
                  {['active','depleted'].includes(detail.voucher.status) && (
                    <button onClick={() => handleVoid(detail.voucher.id)} disabled={busy}
                      style={{ flex: 1, padding: '12px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#991b1b', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
                      ✕ Void voucher
                    </button>
                  )}
                  {/* SEPOS-DEPOSIT-001 — no-show: forfeit the deposit (kept as income). */}
                  {detail.voucher.type === 'deposit' && detail.voucher.status === 'active' && (
                    <button onClick={() => handleForfeit(detail.voucher.code, detail.voucher.id)} disabled={busy}
                      style={{ flex: 1, padding: '12px', borderRadius: 8, border: 'none', background: '#fef3c7', color: '#92400e', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
                      🧾 Forfeit (no-show)
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SellVoucherModal({ onClose, onSold }) {
  const backdrop = useBackdropDismiss(onClose);
  const PRESETS = [25, 50, 100, 150];
  const [amount, setAmount]                   = useState(50);
  const [recipientName, setRecipientName]     = useState('');
  const [recipientEmail, setRecipientEmail]   = useState('');
  const [senderName, setSenderName]           = useState('');
  const [message, setMessage]                 = useState('');
  const [method, setMethod]                   = useState(null);
  const [busy, setBusy]                       = useState(false);
  const [err, setErr]                         = useState('');

  const valid = amount >= 0.01 && amount <= 500 && !!method; // F1: any-amount sale (floor removed 12 Aug)

  async function submit() {
    if (!valid || busy) return;
    setErr(''); setBusy(true);
    try {
      const r = await sellVoucher({
        amount,
        payment_method: method,
        recipient_name:  recipientName  || null,
        recipient_email: recipientEmail || null,
        sender_name:     senderName     || null,
        message:         message        || null,
      });
      if (r.error) throw new Error(r.error);
      onSold(r.voucher);
    } catch (e) { setErr(e.message || 'Sell failed'); }
    finally     { setBusy(false); }
  }

  return (
    <div {...backdrop}
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>🎁 Sell a Gift Voucher</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: 22 }}>
          <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700 }}>Amount (up to £500)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 8 }}>
            {PRESETS.map(p => (
              <button key={p} onClick={() => setAmount(p)}
                style={{ padding: '14px 8px', borderRadius: 8, border: `2px solid ${amount === p ? '#1e3a6e' : '#e0e0e0'}`, background: amount === p ? '#fdf6ec' : 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                £{p}
              </button>
            ))}
          </div>
          <input type="text" inputMode="decimal" min="0.01" max="500" step="0.01" value={amount}
            onChange={(e) => setAmount(Math.round((parseFloat(e.target.value) || 0) * 100) / 100)}
            placeholder="Custom amount"
            style={{ width: '100%', padding: '12px', border: '1px solid #ccc', borderRadius: 8, fontSize: 16, fontWeight: 700, marginBottom: 16, boxSizing: 'border-box' }}/>

          <Field label="Recipient's name"
            value={recipientName} onChange={setRecipientName} />
          <Field label="Recipient's email (optional — leave blank for printed card)"
            value={recipientEmail} onChange={setRecipientEmail} type="email" />
          <Field label="From (sender's name)"
            value={senderName} onChange={setSenderName} />
          <Field label="Message (optional)"
            value={message} onChange={setMessage} textarea />

          <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700, marginTop: 8 }}>Payment taken at till</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[{ k: 'cash', label: '💵 Cash' }, { k: 'card', label: '💳 Card' }, { k: 'comp', label: '🎁 Comp' }].map(m => (
              <button key={m.k} onClick={() => setMethod(m.k)}
                style={{ padding: '14px', borderRadius: 8, border: `2px solid ${method === m.k ? '#1e3a6e' : '#e0e0e0'}`, background: method === m.k ? '#fdf6ec' : 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
                {m.label}
              </button>
            ))}
          </div>

          {err && <div style={{ marginTop: 14, background: '#fee2e2', color: '#991b1b', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>⚠️ {err}</div>}

          <button onClick={submit} disabled={!valid || busy}
            style={{ marginTop: 20, width: '100%', padding: 16, borderRadius: 10, border: 'none', background: 'var(--brand-accent,#C9A84C)', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 800, fontSize: 16, cursor: 'pointer', opacity: (!valid || busy) ? 0.5 : 1 }}>
            {busy ? 'Creating…' : `Sell £${amount} voucher`}
          </button>
          <p style={{ fontSize: 11, color: '#888', marginTop: 10, lineHeight: 1.4 }}>
            Take payment at the till like a normal Cash/Card sale. The voucher code is generated immediately and (if an email is provided) sent to the recipient automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

// SEPOS-DEPOSIT-001 — take a booking deposit (manual, Phase A). Creates a
// type='deposit' voucher tied to a reservation; redeemed on the day as a
// 'Deposit' tender (never a discount). Expiry = reservation date + 7 (server).
function TakeDepositModal({ onClose, onTaken }) {
  const backdrop = useBackdropDismiss(onClose);
  const PRESETS = [10, 20, 50, 100];
  const [amount, setAmount]       = useState(20);
  const [method, setMethod]       = useState(null);
  const [reservationId, setReservationId] = useState('');
  const [custName, setCustName]   = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');

  const valid = amount > 0 && amount <= 1000 && !!method;

  async function submit() {
    if (!valid || busy) return;
    setErr(''); setBusy(true);
    try {
      const r = await createDeposit({
        amount,
        payment_method: method,
        reservation_id: reservationId ? Number(reservationId) : null,
        customer_name:  custName  || null,
        customer_email: custEmail || null,
      });
      if (r.error) throw new Error(r.error);
      onTaken(r.voucher || r);
    } catch (e) { setErr(e.message || 'Could not take deposit'); }
    finally     { setBusy(false); }
  }

  return (
    <div {...backdrop}
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 500, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>🧾 Take a Booking Deposit</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        <div style={{ padding: 22 }}>
          <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700 }}>Deposit amount</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 8 }}>
            {PRESETS.map(p => (
              <button key={p} onClick={() => setAmount(p)}
                style={{ padding: '14px 8px', borderRadius: 8, border: `2px solid ${amount === p ? '#0D1B3E' : '#e0e0e0'}`, background: amount === p ? '#eef6ff' : 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                £{p}
              </button>
            ))}
          </div>
          <input type="text" inputMode="decimal" min="0.01" max="500" step="0.01" value={amount}
            onChange={(e) => setAmount(Math.round((parseFloat(e.target.value) || 0) * 100) / 100)}
            placeholder="Custom amount"
            style={{ width: '100%', padding: '12px', border: '1px solid #ccc', borderRadius: 8, fontSize: 16, fontWeight: 700, marginBottom: 16, boxSizing: 'border-box' }}/>

          <Field label="Reservation ID (optional — leave blank if the booking isn't in the system yet)"
            value={reservationId} onChange={setReservationId} />
          <Field label="Customer name (optional)" value={custName} onChange={setCustName} />
          <Field label="Customer email (optional — sends a confirmation)" value={custEmail} onChange={setCustEmail} type="email" />

          <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700, marginTop: 8 }}>How was the deposit paid?</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
            {[{ k: 'cash', label: '💵 Cash' }, { k: 'card', label: '💳 Card' }, { k: 'mock', label: '🧪 Test' }].map(m => (
              <button key={m.k} onClick={() => setMethod(m.k)}
                style={{ padding: '14px', borderRadius: 8, border: `2px solid ${method === m.k ? '#0D1B3E' : '#e0e0e0'}`, background: method === m.k ? '#eef6ff' : 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
                {m.label}
              </button>
            ))}
          </div>

          {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <button onClick={submit} disabled={!valid || busy}
            style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: (!valid || busy) ? '#ccc' : 'var(--brand-primary,#0D1B3E)', color: 'white', fontWeight: 800, fontSize: 16, cursor: (!valid || busy) ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Taking…' : `Take deposit £${Number(amount || 0).toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', textarea }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, fontWeight: 700 }}>{label}</span>
      {textarea
        ? <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={400}
            style={{ width: '100%', padding: '11px 12px', border: '1px solid #ccc', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', minHeight: 70, resize: 'vertical', boxSizing: 'border-box' }}/>
        : <input type={type} value={value} onChange={(e) => onChange(e.target.value)} maxLength={120}
            style={{ width: '100%', padding: '11px 12px', border: '1px solid #ccc', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}/>}
    </label>
  );
}

function SoldSuccessModal({ voucher, onClose }) {
  const backdrop = useBackdropDismiss(onClose);
  return (
    <div {...backdrop}
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 440 }}>
        <div style={{ padding: 26, textAlign: 'center' }}>
          <div style={{ fontSize: 44, color: '#22c55e', marginBottom: 4 }}>✓</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Voucher created</div>
          <p style={{ fontSize: 13, color: '#666', margin: '4px 0 18px' }}>
            {voucher.recipient_email
              ? `Gift email is on its way to ${voucher.recipient_email}`
              : 'No email on file — write the code on a printed card or read it to the customer'}
          </p>
          <div style={{ background: 'linear-gradient(135deg,#1e3a6e,#2a4d8a)', borderRadius: 12, padding: 22, color: 'white' }}>
            <div style={{ color: 'var(--brand-accent,#C9A84C)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>Voucher value</div>
            <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 14 }}>£{Number(voucher.original_amount).toFixed(2)}</div>
            <div style={{ background: 'rgba(255,255,255,0.1)', border: '1px dashed rgba(255,255,255,0.4)', borderRadius: 8, padding: 12, fontFamily: 'Menlo,Consolas,monospace', fontSize: 20, letterSpacing: 3, fontWeight: 700 }}>
              {voucher.code}
            </div>
          </div>
          <button onClick={onClose}
            style={{ marginTop: 20, width: '100%', padding: 14, borderRadius: 10, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value, big, highlight }) {
  return (
    <div style={{ background: highlight ? '#fdf6ec' : '#fafaf7', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: big ? 18 : 13, fontWeight: big ? 800 : 600, color: highlight ? '#5b4a2a' : 'var(--brand-primary, #1a1a2e)' }}>{value}</div>
    </div>
  );
}
