// SEPOS-VOUCHER-001 — Admin → 🎁 Vouchers.
// Lists every voucher sold, shows balance + status, lets the operator
// look up a code, void (manager-PIN gated by backend at issue-time;
// for v1 we trust the admin section like every other admin action),
// or resend the gift email if it bounced / lost in spam.

import { useState, useEffect, useMemo } from 'react';
import {
  listVouchers, getVoucherDetail, voidVoucher, resendVoucherEmail,
} from '../../api';
import { downloadCsv } from '../../utils/csv';

const STATUS_PILL = {
  active:   { bg: '#dcfce7', fg: '#15803d', label: '✓ Active' },
  depleted: { bg: '#e0e7ff', fg: '#4338ca', label: '⊘ Depleted' },
  expired:  { bg: '#fef3c7', fg: '#92400e', label: '⏱ Expired' },
  voided:   { bg: '#fee2e2', fg: '#991b1b', label: '✕ Voided' },
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
  const [rows,         setRows]         = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [q,            setQ]            = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [detailId,     setDetailId]     = useState(null);
  const [detail,       setDetail]       = useState(null);
  const [busy,         setBusy]         = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await listVouchers(q || undefined, statusFilter || undefined);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { console.error(e); }
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

  async function handleVoid(id) {
    if (!window.confirm('Void this voucher? It cannot be redeemed after voiding.')) return;
    setBusy(true);
    try { await voidVoucher(id, null); await load(); if (detailId) openDetail(detailId); }
    catch (e) { alert('Void failed: ' + e.message); }
    finally   { setBusy(false); }
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>🎁 Gift Vouchers</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Vouchers sold via the public widget — redeemed at checkout</p>
        </div>
        <button onClick={exportCsv}
          style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          ⬇ Export CSV
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { label: 'Total sold',         value: fmtMoney(stats.soldTotal),     color: '#1a1a2e' },
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
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#1a1a2e', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Search
        </button>
        {['', 'active', 'depleted', 'expired', 'voided'].map(s => (
          <button key={s || 'all'} onClick={() => setStatusFilter(s)}
            style={{ padding: '8px 14px', borderRadius: 20, border: 'none', background: statusFilter === s ? '#1a1a2e' : '#e0e0e0', color: statusFilter === s ? 'white' : '#555', fontWeight: 600, fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' }}>
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

      {/* Detail modal */}
      {detailId && (
        <div onClick={(e) => e.target === e.currentTarget && setDetailId(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
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
                  <div style={{ background: '#fdf6ec', borderLeft: '3px solid #C9A84C', padding: '10px 14px', borderRadius: '0 8px 8px 0', fontSize: 13, color: '#5b4a2a', fontStyle: 'italic', marginBottom: 16 }}>
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
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ label, value, big, highlight }) {
  return (
    <div style={{ background: highlight ? '#fdf6ec' : '#fafaf7', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: big ? 18 : 13, fontWeight: big ? 800 : 600, color: highlight ? '#5b4a2a' : '#1a1a2e' }}>{value}</div>
    </div>
  );
}
