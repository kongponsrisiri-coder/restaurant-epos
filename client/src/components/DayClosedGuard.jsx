// SEPOS-ZCLOSE-GUARD-001 — "the day is already closed" guard.
//
// Once the End of Day Z for a trading day has been saved, any new sale or bill
// edit on that day changes figures the owner has already printed (Yum Yum,
// 3 Sep: a bill re-paid after the 21:53 Z → two Z prints of the same day
// disagreed and the till got the blame). Nothing is blocked outright — a late
// table still has to pay — but the person doing it must be a manager and must
// see the warning. The auto-open of a new shift (SEPOS-AUTO-SESSION-001) is
// untouched.
//
// Usage:
//   const { guard, guardModal } = useDayClosedGuard();
//   guard(() => doTheThing(), { date: '2026-09-03' });   // date optional = today
//   ... {guardModal}
//
// Fail-open by design: if the status endpoint errors or is slow, the action
// runs as before (a warning must never stop service) — the miss is logged.
import { useCallback, useRef, useState } from 'react';
import { getZReportDayStatus, loginStaff } from '../api';
import { useBackdropDismiss } from '../utils/backdropGuard';

const CACHE_MS = 30 * 1000;
const _cache = new Map();   // date-key → { at, status }

// Trading-day key of a bill: local calendar day of its close (matches the Z's
// "same calendar day" rule — the Z save keys on the till's local midnight).
export function dayKeyOf(v) {
  const d = v ? new Date(v) : new Date();
  if (isNaN(d)) return String(v).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function fetchDayStatus(date) {
  const key = date || dayKeyOf();
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  try {
    const status = await getZReportDayStatus(key);
    if (!status || status.error) throw new Error(status?.error || 'no status');
    _cache.set(key, { at: Date.now(), status });
    return status;
  } catch (e) {
    console.warn('[day-closed-guard] status unavailable — allowing action:', e.message);
    return null;
  }
}

const fmtTime = (v) => {
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export function DayClosedModal({ status, isNewSale, onCancel, onContinue }) {
  const backdrop = useBackdropDismiss(onCancel);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!pin.trim()) { setErr('PIN required.'); return; }
    setBusy(true); setErr('');
    try {
      const staff = await loginStaff(pin.trim());
      if (!staff || staff.error) { setErr('Invalid PIN.'); setBusy(false); return; }
      const role = (staff.role || '').toLowerCase();
      if (!['admin', 'manager', 'supervisor'].includes(role)) {
        setErr('A manager PIN is needed after the day has been closed.');
        setBusy(false); return;
      }
      onContinue(staff);
    } catch (e) {
      setErr(e.message || 'PIN check failed.');
      setBusy(false);
    }
  };

  const when = status?.closed_at ? fmtTime(status.closed_at) : '';
  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9500, padding: 20 }}
      {...backdrop}>
      <div style={{ background: 'white', borderRadius: 14, padding: 28, width: 'min(420px, 100%)', boxShadow: '0 30px 80px rgba(0,0,0,0.35)' }}>
        <div style={{ fontSize: 30, marginBottom: 6 }}>🌙</div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>
          Day closed{when ? ` at ${when}` : ''}
        </h2>
        <p style={{ margin: '8px 0 6px', fontSize: 14, color: '#374151', lineHeight: 1.45 }}>
          The End of Day report for {status?.date === dayKeyOf() ? 'today' : status?.date} has already been printed.
          {' '}{isNewSale
            ? 'Continuing will start a new shift and change the day\'s figures.'
            : 'Continuing will change the day\'s figures — the printed report will no longer match.'}
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>Manager PIN to continue.</p>
        <input
          type="password"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Manager PIN"
          inputMode="numeric"
          maxLength={6}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 18, fontFamily: 'ui-monospace, monospace', textAlign: 'center', letterSpacing: 6, boxSizing: 'border-box' }}
        />
        {err && (
          <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginTop: 10 }}>{err}</div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ background: 'transparent', color: '#475569', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ background: 'var(--brand-primary,#0D1B3E)', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Checking…' : 'Continue with PIN'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Hook: guard(action, { date, isNewSale }) runs `action` straight away when the
// day is open (or the status is unknown), otherwise shows the modal and runs
// it after a manager PIN. Returns the modal element to render.
export function useDayClosedGuard() {
  const [pending, setPending] = useState(null);   // { status, action, isNewSale }
  const busyRef = useRef(false);

  const guard = useCallback(async (action, opts = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const status = await fetchDayStatus(opts.date);
      if (status && status.closed) {
        setPending({ status, action, isNewSale: !!opts.isNewSale });
        return;
      }
      await action();
    } finally {
      busyRef.current = false;
    }
  }, []);

  const guardModal = pending ? (
    <DayClosedModal
      status={pending.status}
      isNewSale={pending.isNewSale}
      onCancel={() => setPending(null)}
      onContinue={() => { const a = pending.action; setPending(null); a(); }}
    />
  ) : null;

  return { guard, guardModal };
}
