import { useState, useEffect } from 'react';
import { getSettings } from '../../api';
import {
  thermalPrint, fullPagePrint, escPosPrint, pageHtml,
  fmt, fmtInt, restaurantName, nowStamp,
} from '../../utils/reportPrinter';
import { getZReportPreview, getZReportPreviewBySession, saveZReport, getZReportHistory,
         getCurrentSession, openSession, closeSession } from '../../api';
import { downloadCsv } from '../../utils/csv';
import { confirm } from '../../utils/confirm';

export default function ZReportSection() {
  const [step, setStep]           = useState(1);
  const [reportType, setReportType] = useState(null);
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [saved, setSaved]         = useState(false);
  const [history, setHistory]     = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [fromTime, setFromTime]   = useState('');
  const [toTime, setToTime]       = useState('');
  const [pettyCash, setPettyCash]           = useState('');
  const [pettyCashReason, setPettyCashReason] = useState('');
  const [actualCash, setActualCash]         = useState('');
  const [actualCard, setActualCard]         = useState('');   // card-machine takings for reconciliation
  // SEPOS-053 — current open trading session (EposNow-style shift)
  const [session, setSession]       = useState(null);   // { session, orders, takings } | null
  const [openFloat, setOpenFloat]   = useState('');
  const [shiftBusy, setShiftBusy]   = useState(false);

  const refreshSession = () => getCurrentSession()
    .then(r => setSession(r && r.session ? r : null))
    .catch(() => {});

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd   = now.toISOString();

  // Korakot 2026-06-02: the From/To boxes were showing 1 hour behind during
  // BST because we sliced toISOString() (UTC) and dropped it into a
  // <input type="datetime-local">, which interprets the value as LOCAL
  // time. Format from getHours()/etc. directly so the box matches the
  // wall clock. Server-side `from`/`to` still go through `.toISOString()`
  // in loadReport(), so the UTC comparison against orders.closed_at stays
  // correct.
  const padTwo = (n) => String(n).padStart(2, '0');
  const formatLocalDateTime = (d) =>
    `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}T${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`;

  useEffect(() => {
    getZReportHistory().then(setHistory);
    setFromTime(formatLocalDateTime(new Date(now.getFullYear(), now.getMonth(), now.getDate())));
    setToTime(formatLocalDateTime(now));
    refreshSession();
  }, []);

  const loadReport = async (type) => {
    setReportType(type); setLoading(true); setSaved(false);
    try {
      let data, from, to;
      if (type === 'session') {
        // SEPOS-053 — scope the Z to the open shift's own window (open→now),
        // not a calendar date, so it spans midnight free of the timezone edge.
        data = await getZReportPreviewBySession(session.session.id);
        from = data.from; to = data.to;
      } else {
        from = type === 'day' ? todayStart : new Date(fromTime).toISOString();
        to   = type === 'day' ? todayEnd   : new Date(toTime).toISOString();
        data = await getZReportPreview(from, to);
      }
      setReportData({ ...data, from, to }); setStep(2);
    } catch { alert('Failed to load report!'); }
    finally { setLoading(false); }
  };

  // SEPOS-053 — open a new trading session (shift).
  const handleOpenShift = async () => {
    setShiftBusy(true);
    try {
      const r = await openSession(null, parseFloat(openFloat) || 0);
      if (r && r.error && !r.session) { alert(r.error); }
      setOpenFloat('');
      await refreshSession();
    } catch { alert('Could not open shift.'); }
    finally { setShiftBusy(false); }
  };

  const handleConfirmSave = async () => {
    // Split open orders by type so warnings are accurate. Takeaway orders
    // that never got "Collected" are NOT a "tables didn't close" problem.
    const openOrders = reportData.open_orders || [];
    const openTables    = openOrders.filter(o => o.order_type !== 'takeaway' && o.table_number);
    const openTakeaway  = openOrders.filter(o => o.order_type === 'takeaway');
    if (openTables.length > 0 || openTakeaway.length > 0) {
      const msg = [
        openTables.length > 0
          ? `⚠️ ${openTables.length} table${openTables.length>1?'s':''} still open:\n` + openTables.map(o => `Table ${o.table_number}`).join(', ')
          : '',
        openTakeaway.length > 0
          ? `\n\n🥡 ${openTakeaway.length} takeaway order${openTakeaway.length>1?'s':''} not collected:\n` + openTakeaway.map(o => `#${o.id}${o.customer_name ? ' · '+o.customer_name : ''}`).join(', ')
          : '',
      ].filter(Boolean).join('');
      if (!await confirm(msg + '\n\nAre you sure you want to close the report?')) return;
    }
    const pettyNum = parseFloat(pettyCash) || 0;
    const actualNum = parseFloat(actualCash) || 0;
    const expectedCash = (reportData.total_cash || 0) - pettyNum;
    const difference = actualNum - expectedCash;
    // Card reconciliation: only compute a variance if the operator entered the
    // card-machine takings (blank = not reconciled → null, not 0).
    const actualCardNum = actualCard !== '' ? (parseFloat(actualCard) || 0) : null;
    const cardDifference = actualCardNum != null ? actualCardNum - (reportData.total_card || 0) : null;
    try {
      const saved = await saveZReport(reportType, reportData.from, reportData.to, reportData, 0, pettyNum, pettyCashReason, actualNum, difference, actualCardNum, cardDifference);
      // SEPOS-053 — if this Z closed an open shift, mark the session closed and
      // link it to the saved z_report. Open tables stay open and will land in
      // the NEXT shift's Z (matches EposNow).
      if (reportType === 'session' && session?.session?.id) {
        try { await closeSession(null, saved?.id || null); } catch {}
        await refreshSession();
      }
      setSaved(true); setStep(4); getZReportHistory().then(setHistory);
    } catch { alert('Failed to save Z Report!'); }
  };

  const formatDateTime = (dt) => dt ? new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  const exportHistoryCsv = () => {
    if (!history.length) return;
    const rows = [['Closed at', 'Type', 'Orders', 'Total sales £', 'Cash £', 'Card £', 'Other £', 'Petty cash £', 'Actual cash £', 'Cash difference £', 'Actual card £', 'Card difference £']];
    history.forEach(r => {
      rows.push([
        r.closed_at ? new Date(r.closed_at).toISOString() : '',
        r.type, r.total_orders || 0,
        Number(r.total_sales || 0).toFixed(2),
        Number(r.total_cash || 0).toFixed(2),
        Number(r.total_card || 0).toFixed(2),
        Number(r.total_other || 0).toFixed(2),
        Number(r.petty_cash || 0).toFixed(2),
        Number(r.actual_cash || 0).toFixed(2),
        Number(r.cash_difference || 0).toFixed(2),
        r.actual_card == null ? '' : Number(r.actual_card).toFixed(2),
        r.card_difference == null ? '' : Number(r.card_difference).toFixed(2),
      ]);
    });
    downloadCsv(`z-report-history_${new Date().toISOString().slice(0,10)}.csv`, rows);
  };

  const exportReportCsv = () => {
    if (!reportData) return;
    const rows = [];
    rows.push(['Z Report', reportType === 'day' ? 'End of Day' : reportType === 'custom' ? 'Custom Range Report' : 'Shift Close']);
    rows.push(['From', reportData.from || '']);
    rows.push(['To', reportData.to || '']);
    rows.push([]);
    rows.push(['Sales summary', 'Amount £']);
    rows.push(['Cash', Number(reportData.total_cash || 0).toFixed(2)]);
    rows.push(['Card', Number(reportData.total_card || 0).toFixed(2)]);
    rows.push(['Other', Number(reportData.total_other || 0).toFixed(2)]);
    rows.push(['Food',           Number(reportData.total_food     || 0).toFixed(2)]);
    rows.push(['Drink',          Number(reportData.total_drink    || 0).toFixed(2)]);
    rows.push(['Service charge', Number(reportData.total_service  || 0).toFixed(2)]);
    rows.push(['TOTAL SALES', Number(reportData.total_sales || 0).toFixed(2)]);
    rows.push([]);
    rows.push(['Channel', 'Amount £', 'Orders']);
    rows.push(['Dine-in', Number(reportData.total_dine_in || 0).toFixed(2), reportData.dine_in_count || 0]);
    rows.push(['Takeaway', Number(reportData.total_takeaway || 0).toFixed(2), reportData.takeaway_count || 0]);
    rows.push([]);
    rows.push(['Orders', reportData.total_orders || 0]);
    rows.push(['Covers', reportData.total_covers || 0]);
    rows.push(['Avg per cover £', Number(reportData.avg_per_cover || 0).toFixed(2)]);
    rows.push(['Discounts £', Number(reportData.total_discounts || 0).toFixed(2)]);
    rows.push(['Void items', reportData.void_count || 0]);
    if (Array.isArray(reportData.vat_breakdown) && reportData.vat_breakdown.length) {
      rows.push([]);
      rows.push(['VAT breakdown', 'Rate %', 'Net £', 'VAT £']);
      reportData.vat_breakdown.forEach(b => {
        rows.push(['', b.rate, Number(b.net || 0).toFixed(2), Number(b.vat || 0).toFixed(2)]);
      });
      rows.push(['', 'Total VAT', '', Number(reportData.vat_total || 0).toFixed(2)]);
    }
    if (Array.isArray(reportData.voids_by_type) && reportData.voids_by_type.length) {
      rows.push([]);
      rows.push(['Voids by type', 'Type', 'Count', 'Value £']);
      reportData.voids_by_type.forEach(v => {
        rows.push(['', v.void_type, v.count, Number(v.value || 0).toFixed(2)]);
      });
    }
    const dt = (reportData.from || new Date().toISOString()).slice(0, 10);
    downloadCsv(`z-report_${reportType || 'shift'}_${dt}.csv`, rows);
  };
  const [settings, setSettings] = useState({});
  useEffect(() => { getSettings().then(s => setSettings(s || {})).catch(() => {}); }, []);

  const doPrintZ = async (mode) => {
    if (!reportData) return;
    const isThermal = (mode === 'thermal');
    const title = (reportType === 'day' ? 'End of Day' : reportType === 'custom' ? 'Custom Range Report' : 'Shift Close') + ' — ' + restaurantName(settings);
    if (isThermal) {
      const lines = buildZReportLines(reportData, reportType, settings,
        { pettyCash: pettyNum, actualCash: actualNum, difference, actualCard: actualCardR, cardDifference: cardDiffR });
      const r = await escPosPrint(lines, settings);
      if (r && r.success) return;
      const fallback = buildZReportBody(reportData, reportType, settings,
        { pettyCash: pettyNum, actualCash: actualNum, difference, actualCard: actualCardR, cardDifference: cardDiffR }, true);
      thermalPrint(pageHtml(title, fallback, 'thermal'));
      return;
    }
    const body = buildZReportBody(reportData, reportType, settings,
      { pettyCash: pettyNum, actualCash: actualNum, difference, actualCard: actualCardR, cardDifference: cardDiffR }, false);
    fullPagePrint(pageHtml(title, body, 'full'));
  };

  const pettyNum     = parseFloat(pettyCash) || 0;
  const actualNum    = parseFloat(actualCash) || 0;
  const expectedCash = reportData ? (reportData.total_cash || 0) - pettyNum : 0;
  const difference   = actualNum - expectedCash;
  const actualCardR  = actualCard !== '' ? (parseFloat(actualCard) || 0) : null;
  const cardDiffR    = (reportData && actualCardR != null) ? actualCardR - (reportData.total_card || 0) : null;
  const inputStyle   = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 15, boxSizing: 'border-box' };

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>🔐 Z Report / Close Shift</h1>
        <button onClick={() => setShowHistory(!showHistory)} style={{ background: '#f0f0f0', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{showHistory ? 'Hide History' : '📋 View History'}</button>
      </div>

      {/* SEPOS-053 — open/close trading shift (EposNow-style). The shift's
          own open→close window is the Z boundary, so it can span midnight or
          two nights with no calendar/timezone edge. */}
      {step === 1 && (
        session ? (
          <div style={{ background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 12, padding: 18, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#166534' }}>🟢 Shift open</div>
                <div style={{ fontSize: 13, color: '#15803d', marginTop: 2 }}>
                  Since {formatDateTime(session.session.opened_at)} · {session.orders || 0} order{(session.orders||0)===1?'':'s'} · £{Number(session.takings || 0).toFixed(2)}
                </div>
              </div>
              <button onClick={() => loadReport('session')} disabled={loading}
                style={{ padding: '12px 20px', borderRadius: 10, border: 'none', background: '#16a34a', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                {loading ? 'Loading…' : '✅ Close this shift (Z)'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ background: '#f8fafc', border: '2px dashed #cbd5e1', borderRadius: 12, padding: 18, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#334155' }}>No shift open</div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Open a shift to total takings by session — it can run overnight, even across two nights.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b', fontSize: 14 }}>£</span>
                  <input type="number" step="0.01" value={openFloat} onChange={e => setOpenFloat(e.target.value)} placeholder="Float"
                    style={{ width: 100, padding: '11px 10px 11px 22px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <button onClick={handleOpenShift} disabled={shiftBusy}
                  style={{ padding: '12px 20px', borderRadius: 10, border: 'none', background: '#0ea5e9', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                  {shiftBusy ? 'Opening…' : '▶ Open Shift'}
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {showHistory && (
        <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Past Z Reports</div>
            <button onClick={exportHistoryCsv} disabled={!history.length} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontWeight: 700, fontSize: 12, cursor: history.length ? 'pointer' : 'not-allowed', opacity: history.length ? 1 : 0.5 }}>⬇ Export CSV</button>
          </div>
          {history.length === 0 ? <div style={{ color: '#aaa', fontSize: 14 }}>No Z reports yet</div> : history.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
              <div><span style={{ fontWeight: 600, marginRight: 8 }}>{r.type === 'day' ? '🌙 End of Day' : r.type === 'custom' ? '📅 Custom Range' : '⏰ Shift Close'}</span><span style={{ color: '#888' }}>{formatDateTime(r.closed_at)}</span></div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ color: '#555' }}>{r.total_orders} orders</span>
                <span style={{ fontWeight: 700, color: '#e94560' }}>£{Number(r.total_sales || 0).toFixed(2)}</span>
                {r.cash_difference !== 0 && <span style={{ fontWeight: 700, fontSize: 12, color: r.cash_difference > 0 ? '#22c55e' : '#ef4444' }}>{r.cash_difference > 0 ? `Over £${Number(r.cash_difference).toFixed(2)}` : `Short £${Math.abs(Number(r.cash_difference)).toFixed(2)}`}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* SEPOS-Z-TIDY — one report section. "End of Day" and "Custom Range"
              were the same operation (a Z over a from→to window); merged so it's
              clear this is report-only and doesn't touch the shift. */}
          <div style={{ background: '#eff6ff', borderRadius: 12, padding: 24, border: '1px solid #bfdbfe' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#1e40af', marginBottom: 4 }}>📊 Sales Report (Z)</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 18 }}>A read-only sales report for a chosen period. This does <strong>not</strong> close a shift — to end a shift, use “Close this shift” above.</div>

            <button onClick={() => loadReport('day')} disabled={loading} style={{ width: '100%', padding: '16px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', fontWeight: 800, cursor: 'pointer', fontSize: 16 }}>{loading ? 'Loading…' : "🌙 Today's Z — End of Day"}</button>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 6 }}>Covers all of today's trading, midnight → now.</div>

            <div style={{ borderTop: '1px solid #dbeafe', marginTop: 20, paddingTop: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#1e40af', marginBottom: 4 }}>📅 Any other period</div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>e.g. last Tuesday's lunch, or last week's totals.</div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From</label><input type="datetime-local" value={fromTime} onChange={e => setFromTime(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
                <div style={{ flex: 1, minWidth: 180 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To</label><input type="datetime-local" value={toTime} onChange={e => setToTime(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              </div>
              <button onClick={() => loadReport('custom')} disabled={loading} style={{ padding: '14px 28px', borderRadius: 10, border: 'none', background: '#2563eb', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>{loading ? 'Loading…' : '📅 Run Report'}</button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && reportData && (
        <div>
          {(() => {
            const allOpen = reportData.open_orders || [];
            const openTables   = allOpen.filter(o => o.order_type !== 'takeaway' && o.table_number);
            const openTakeaway = allOpen.filter(o => o.order_type === 'takeaway');
            if (openTables.length === 0 && openTakeaway.length === 0) return null;
            return (
              <div style={{ background: '#fef9c3', borderRadius: 12, padding: 16, marginBottom: 20, border: '2px solid #eab308' }}>
                {openTables.length > 0 && (
                  <>
                    <div style={{ fontWeight: 700, color: '#713f12', marginBottom: 4 }}>⚠️ {openTables.length} table{openTables.length>1?'s':''} still open!</div>
                    <div style={{ fontSize: 13, color: '#92400e', marginBottom: openTakeaway.length > 0 ? 10 : 0 }}>{openTables.map(o => `Table ${o.table_number}`).join(' · ')}</div>
                  </>
                )}
                {openTakeaway.length > 0 && (
                  <>
                    <div style={{ fontWeight: 700, color: '#713f12', marginBottom: 4 }}>🥡 {openTakeaway.length} takeaway order{openTakeaway.length>1?'s':''} not yet marked collected</div>
                    <div style={{ fontSize: 13, color: '#92400e' }}>{openTakeaway.map(o => `#${o.id}${o.customer_name ? ' · '+o.customer_name : ''}`).join(' · ')}</div>
                  </>
                )}
              </div>
            );
          })()}
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', paddingBottom: 16, marginBottom: 16, borderBottom: '2px dashed #eee' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>{reportType === 'day' ? '🌙 END OF DAY' : reportType === 'custom' ? '📅 CUSTOM RANGE' : '⏰ SHIFT CLOSE'}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>💰 Sales Summary</div>
              {[{ label: '💵 Cash Sales', value: reportData.total_cash || 0, color: '#22c55e' }, { label: '💳 Card Sales', value: reportData.total_card || 0, color: '#3b82f6' }, { label: '🔄 Other', value: reportData.total_other || 0, color: '#8b5cf6' }].map(p => (
                <div key={p.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 15 }}><span>{p.label}</span><span style={{ fontWeight: 700, color: p.color }}>£{Number(p.value).toFixed(2)}</span></div>
              ))}
              {/* Korakot 2026-06-02: split out Food / Drink / Service
                  charge so the day's £ break-down by kitchen vs bar vs
                  optional service is obvious on the Z Report. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14, color: '#555' }}>
                <span>🍽️ Food</span>
                <span style={{ fontWeight: 700 }}>£{Number(reportData.total_food || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14, color: '#555' }}>
                <span>🍺 Drink</span>
                <span style={{ fontWeight: 700 }}>£{Number(reportData.total_drink || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14, color: 'var(--brand-primary,#0D1B3E)' }}>
                <span style={{ fontWeight: 600 }}>Service charge (12.5%)</span>
                <span style={{ fontWeight: 800 }}>£{Number(reportData.total_service || 0).toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontSize: 20, fontWeight: 800, color: '#e94560' }}><span>TOTAL SALES</span><span>£{Number(reportData.total_sales || 0).toFixed(2)}</span></div>
              {(reportData.takeaway_count > 0 || reportData.dine_in_count > 0) && (
                <div style={{ marginTop: 4, marginBottom: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Dine-in</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--brand-primary, #1a1a2e)' }}>£{Number(reportData.total_dine_in || 0).toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{reportData.dine_in_count || 0} orders</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>🥡 Online Takeaway</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--brand-accent,#C9A84C)' }}>£{Number(reportData.total_takeaway || 0).toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{reportData.takeaway_count || 0} orders</div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
              {[{ label: 'Orders', value: reportData.total_orders || 0, color: '#3b82f6' }, { label: 'Covers', value: reportData.total_covers || 0, color: '#22c55e' }, { label: 'Avg/Cover', value: `£${Number(reportData.avg_per_cover || 0).toFixed(2)}`, color: '#8b5cf6' }].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 12, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div></div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 10, padding: 12, border: '1px solid #bbf7d0' }}><div style={{ fontSize: 11, color: '#888' }}>Discounts Given</div><div style={{ fontSize: 18, fontWeight: 800, color: '#22c55e' }}>£{Number(reportData.total_discounts || 0).toFixed(2)}</div></div>
              <div style={{ flex: 1, background: '#fff0f3', borderRadius: 10, padding: 12, border: '1px solid #fecdd3' }}><div style={{ fontSize: 11, color: '#888' }}>Void Items</div><div style={{ fontSize: 18, fontWeight: 800, color: '#e94560' }}>{reportData.void_count || 0} items</div></div>
            </div>

            {/* SEPOS-VOUCHER-001 — gift voucher activity (off till — settled to Stripe at sale time) */}
            {(reportData.vouchers_sold?.count > 0 || reportData.vouchers_redeemed?.count > 0) && (
              <div style={{ marginTop: 12, background: '#fdf6ec', border: '1px solid #f3e1bb', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#5b4a2a', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  🎁 Gift vouchers — settled to Stripe, not the till
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ color: '#888' }}>Sold ({reportData.vouchers_sold?.count || 0})</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#5b4a2a' }}>£{Number(reportData.vouchers_sold?.total || 0).toFixed(2)}</div>
                  </div>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ color: '#888' }}>Redeemed ({reportData.vouchers_redeemed?.count || 0})</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#5b4a2a' }}>£{Number(reportData.vouchers_redeemed?.total || 0).toFixed(2)}</div>
                  </div>
                </div>
              </div>
            )}

            {/* SEPOS-021 — VAT breakdown */}
            {Array.isArray(reportData.vat_breakdown) && reportData.vat_breakdown.length > 0 && (
              <div style={{ marginTop: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1e40af', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  VAT breakdown
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {reportData.vat_breakdown.map(b => (
                    <div key={b.rate} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ color: '#555' }}>@ {b.rate}% — net £{Number(b.net || 0).toFixed(2)}</span>
                      <span style={{ color: '#1e40af', fontWeight: 700 }}>£{Number(b.vat || 0).toFixed(2)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #bfdbfe', paddingTop: 6, marginTop: 2, fontSize: 13, fontWeight: 800 }}>
                    <span>Total VAT</span>
                    <span style={{ color: '#1e40af' }}>£{Number(reportData.vat_total || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* SEPOS-023 — voids by type */}
            {Array.isArray(reportData.voids_by_type) && reportData.voids_by_type.length > 0 && (
              <div style={{ marginTop: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9a3412', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Void breakdown
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {reportData.voids_by_type.map(v => (
                    <div key={v.void_type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ color: '#555' }}>
                        {v.void_type === 'Comp' ? '🎁 ' : ''}{v.void_type}
                      </span>
                      <span style={{ color: '#9a3412', fontWeight: 700 }}>
                        {v.count} · £{Number(v.value || 0).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setStep(3)} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Next — Till Reconciliation →</button>
            <button onClick={() => { setStep(1); setReportData(null); }} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 3 && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: 'var(--brand-primary, #1a1a2e)' }}>💵 Till Reconciliation</div>
            <div style={{ background: '#f0f7ff', borderRadius: 10, padding: 14, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 14, color: '#555' }}>Cash Sales from System</span><span style={{ fontSize: 20, fontWeight: 800, color: '#1e40af' }}>£{Number(reportData.total_cash || 0).toFixed(2)}</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🧾 Petty Cash Out</label><div style={{ position: 'relative', marginBottom: 8 }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={pettyCash} onChange={e => setPettyCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div><input value={pettyCashReason} onChange={e => setPettyCashReason(e.target.value)} placeholder="Reason e.g. Bought supplies..." style={inputStyle} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🏦 Actual Cash Counted</label><div style={{ position: 'relative' }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={actualCash} onChange={e => setActualCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div></div>
            </div>
            {actualCash !== '' && (
              <div style={{ marginTop: 20, background: '#f8f8f8', borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: 'var(--brand-primary, #1a1a2e)' }}>📊 Cash Calculation</div>
                {[{ label: 'Cash Sales', val: `£${Number(reportData.total_cash || 0).toFixed(2)}` }, pettyNum > 0 && { label: 'Less Petty Cash', val: `-£${pettyNum.toFixed(2)}` }].filter(Boolean).map(r => (
                  <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, color: '#555' }}><span>{r.label}</span><span>{r.val}</span></div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginBottom: 8, paddingTop: 8, borderTop: '1px solid #eee' }}><span>Expected Cash</span><span>£{expectedCash.toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginBottom: 8 }}><span>Actual Counted</span><span>£{actualNum.toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800, paddingTop: 10, borderTop: '2px solid #eee', color: difference === 0 ? '#22c55e' : difference > 0 ? '#3b82f6' : '#ef4444' }}>
                  <span>{difference === 0 ? '✅ Exact!' : difference > 0 ? '📈 Over' : '📉 Short'}</span><span>£{Math.abs(difference).toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: 'var(--brand-primary, #1a1a2e)' }}>💳 Card Reconciliation</div>
            <div style={{ background: '#eff6ff', borderRadius: 10, padding: 14, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 14, color: '#555' }}>Card Sales from System</span><span style={{ fontSize: 20, fontWeight: 800, color: '#3b82f6' }}>£{Number(reportData.total_card || 0).toFixed(2)}</span></div>
            <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>💳 Actual Card Takings <span style={{ fontWeight: 400, color: '#aaa' }}>(from the card machine)</span></label><div style={{ position: 'relative' }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={actualCard} onChange={e => setActualCard(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div></div>
            {actualCard !== '' && (
              <div style={{ marginTop: 20, background: '#f8f8f8', borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: 'var(--brand-primary, #1a1a2e)' }}>📊 Card Calculation</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, color: '#555' }}><span>Card Sales (system)</span><span>£{Number(reportData.total_card || 0).toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, marginBottom: 8, paddingTop: 8, borderTop: '1px solid #eee' }}><span>Actual Takings</span><span>£{(actualCardR || 0).toFixed(2)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, fontWeight: 800, paddingTop: 10, borderTop: '2px solid #eee', color: (cardDiffR || 0) === 0 ? '#22c55e' : (cardDiffR || 0) > 0 ? '#3b82f6' : '#ef4444' }}>
                  <span>{(cardDiffR || 0) === 0 ? '✅ Exact!' : (cardDiffR || 0) > 0 ? '📈 Over (system under-recorded)' : '📉 Short'}</span><span>£{Math.abs(cardDiffR || 0).toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={handleConfirmSave} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: reportType === 'day' ? '#e94560' : reportType === 'custom' ? '#2563eb' : '#16a34a', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{reportType === 'day' ? '🌙 Confirm End of Day' : reportType === 'custom' ? '📅 Save Custom Report' : '✅ Confirm Close Shift'}</button>
            <button onClick={() => doPrintZ('thermal')} style={{ flex: 1, padding: '16px', borderRadius: 12, border: '2px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>🖨️ Print</button>
            <button onClick={() => setStep(2)} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 4 && saved && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 48 }}>✅</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginTop: 8 }}>{reportType === 'day' ? 'End of Day Complete!' : reportType === 'custom' ? 'Report Saved!' : 'Shift Closed!'}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
              {[{ label: 'Total Sales', value: `£${(reportData.total_sales || 0).toFixed(2)}`, color: '#e94560' }, { label: 'Cash Sales', value: `£${Number(reportData.total_cash || 0).toFixed(2)}`, color: '#22c55e' }, { label: 'Card Sales', value: `£${Number(reportData.total_card || 0).toFixed(2)}`, color: '#3b82f6' }, { label: 'Orders', value: reportData.total_orders || 0, color: '#8b5cf6' }].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 14, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div></div>
              ))}
            </div>
            <div style={{ background: difference === 0 ? '#f0fdf4' : difference > 0 ? '#eff6ff' : '#fff0f3', borderRadius: 12, padding: 16, border: `2px solid ${difference === 0 ? '#bbf7d0' : difference > 0 ? '#bfdbfe' : '#fecdd3'}`, textAlign: 'center' }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>Cash Reconciliation</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: difference === 0 ? '#22c55e' : difference > 0 ? '#3b82f6' : '#ef4444' }}>{difference === 0 ? '✅ Exact Match!' : difference > 0 ? `📈 Over by £${difference.toFixed(2)}` : `📉 Short by £${Math.abs(difference).toFixed(2)}`}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => doPrintZ('thermal')} style={{ flex: 2, minWidth: 180, padding: '16px', borderRadius: 12, border: '2px solid var(--brand-primary, #1a1a2e)', background: 'var(--brand-primary, #1a1a2e)', color: 'white', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>🖨 Print (80mm)</button>
            <button onClick={() => doPrintZ('full')}    style={{ flex: 1, minWidth: 110, padding: '16px', borderRadius: 12, border: '2px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>📄 Export</button>
            <button onClick={exportReportCsv}            style={{ flex: 1, minWidth: 90, padding: '16px', borderRadius: 12, border: '2px solid var(--brand-primary, #1a1a2e)', background: 'white', color: 'var(--brand-primary, #1a1a2e)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>⬇ CSV</button>
            <button onClick={() => { setStep(1); setReportData(null); setSaved(false); setPettyCash(''); setPettyCashReason(''); setActualCash(''); setActualCard(''); }} style={{ flex: 1, minWidth: 90, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Print body builder ────────────────────────────────────────────
function buildZReportBody(r, type, settings, cash, thermal) {
  const head = thermal
    ? `<div class="center" style="font-size:13px;font-weight:900;letter-spacing:1px;">${restaurantName(settings)}</div>
       <div class="center small">${type === 'day' ? 'END OF DAY' : type === 'custom' ? 'CUSTOM RANGE' : 'SHIFT CLOSE'}</div>
       <div class="center small muted">${r.from || ''} → ${r.to || ''}</div>
       <div class="center small muted">${nowStamp()}</div>
       <hr class="divider"/>`
    : `<h1>${restaurantName(settings)} — ${type === 'day' ? 'End of Day Z Report' : 'Shift Close Z Report'}</h1>
       <div class="sub"><span class="pill">PERIOD</span> &nbsp; ${r.from || ''} → ${r.to || ''}</div>`;

  const total = Number(r.total_sales || 0);
  const summary = `
    <table>
      <tr><td>💵 Cash</td><td class="right">${fmt(r.total_cash)}</td></tr>
      <tr><td>💳 Card</td><td class="right">${fmt(r.total_card)}</td></tr>
      <tr><td>🔄 Other</td><td class="right">${fmt(r.total_other)}</td></tr>
      <tr><td>🍽️ Food</td><td class="right">${fmt(r.total_food)}</td></tr>
      <tr><td>🍺 Drink</td><td class="right">${fmt(r.total_drink)}</td></tr>
      <tr><td>Service charge (12.5%)</td><td class="right">${fmt(r.total_service)}</td></tr>
      <tr class="total-row"><td>TOTAL SALES</td><td class="right">${fmt(total)}</td></tr>
    </table>`;

  const channels = `
    ${thermal ? '<hr class="divider"/>' : '<h2>Channels</h2>'}
    <table>
      <tr><td>Dine-in (${r.dine_in_count || 0})</td><td class="right">${fmt(r.total_dine_in)}</td></tr>
      <tr><td>🥡 Takeaway (${r.takeaway_count || 0})</td><td class="right">${fmt(r.total_takeaway)}</td></tr>
    </table>`;

  const stats = `
    ${thermal ? '<hr class="divider"/>' : '<h2>Operations</h2>'}
    <table>
      <tr><td>Orders</td><td class="right">${fmtInt(r.total_orders)}</td></tr>
      <tr><td>Covers</td><td class="right">${fmtInt(r.total_covers)}</td></tr>
      <tr><td>Avg per cover</td><td class="right">${fmt(r.avg_per_cover)}</td></tr>
      <tr><td>Discounts</td><td class="right">${fmt(r.total_discounts)}</td></tr>
      <tr><td>Void items</td><td class="right">${fmtInt(r.void_count)} · ${fmt(r.void_value)}</td></tr>
    </table>`;

  const vat = (Array.isArray(r.vat_breakdown) && r.vat_breakdown.length) ? `
    ${thermal ? '<hr class="divider"/><div class="section-head">VAT Breakdown</div>' : '<h2>VAT Breakdown</h2>'}
    <table>
      <tr><td>Rate</td><td class="right">Net</td><td class="right">VAT</td></tr>
      ${r.vat_breakdown.map(b => `<tr><td>${b.rate}%</td><td class="right">${fmt(b.net)}</td><td class="right">${fmt(b.vat)}</td></tr>`).join('')}
      <tr class="total-row"><td colspan="2">Total VAT</td><td class="right">${fmt(r.vat_total)}</td></tr>
    </table>` : '';

  const voids = (Array.isArray(r.voids_by_type) && r.voids_by_type.length) ? `
    ${thermal ? '<hr class="divider"/><div class="section-head">Voids by Type</div>' : '<h2>Voids by Type</h2>'}
    <table>
      ${r.voids_by_type.map(v => `<tr><td>${v.void_type}</td><td class="right">${fmtInt(v.count)}</td><td class="right">${fmt(v.value)}</td></tr>`).join('')}
    </table>` : '';

  const recon = `
    ${thermal ? '<hr class="divider-solid"/><div class="section-head">Cash Reconciliation</div>' : '<h2>Cash Reconciliation</h2>'}
    <table>
      <tr><td>Cash sales</td><td class="right">${fmt(r.total_cash)}</td></tr>
      <tr><td>– Petty cash</td><td class="right">${fmt(cash.pettyCash)}</td></tr>
      <tr><td>Expected in drawer</td><td class="right">${fmt((r.total_cash || 0) - cash.pettyCash)}</td></tr>
      <tr><td>Actual counted</td><td class="right">${fmt(cash.actualCash)}</td></tr>
      <tr class="total-row"><td>${cash.difference === 0 ? '✅ Exact match' : cash.difference > 0 ? '📈 Over' : '📉 Short'}</td><td class="right">${fmt(Math.abs(cash.difference))}</td></tr>
    </table>`;

  const cardRecon = (cash.actualCard == null) ? '' : `
    ${thermal ? '<hr class="divider"/><div class="section-head">Card Reconciliation</div>' : '<h2>Card Reconciliation</h2>'}
    <table>
      <tr><td>Card sales (system)</td><td class="right">${fmt(r.total_card)}</td></tr>
      <tr><td>Actual takings</td><td class="right">${fmt(cash.actualCard)}</td></tr>
      <tr class="total-row"><td>${cash.cardDifference === 0 ? '✅ Exact match' : cash.cardDifference > 0 ? '📈 Over' : '📉 Short'}</td><td class="right">${fmt(Math.abs(cash.cardDifference || 0))}</td></tr>
    </table>`;

  return head + summary + channels + stats + vat + voids + recon + cardRecon;
}

// ── ESC/POS line builder ──────────────────────────────────────────
function buildZReportLines(r, type, settings, cash) {
  const lines = [];
  lines.push({ kind: 'h1', text: restaurantName(settings) });
  lines.push({ kind: 'h2', text: type === 'day' ? 'END OF DAY' : type === 'custom' ? 'CUSTOM RANGE' : 'SHIFT CLOSE' });
  if (r.from) lines.push({ kind: 'small', text: `${r.from} -> ${r.to}` });
  lines.push({ kind: 'small', text: nowStamp() });
  lines.push({ kind: 'div' });
  lines.push({ kind: 'h2', text: 'PAYMENTS' });
  lines.push({ kind: 'row', left: 'Cash',                    right: fmt(r.total_cash) });
  lines.push({ kind: 'row', left: 'Card',                    right: fmt(r.total_card) });
  lines.push({ kind: 'row', left: 'Other',                   right: fmt(r.total_other) });
  lines.push({ kind: 'div' });
  lines.push({ kind: 'h2', text: 'SALES' });
  lines.push({ kind: 'row', left: 'Food',                    right: fmt(r.total_food) });
  lines.push({ kind: 'row', left: 'Drink',                   right: fmt(r.total_drink) });
  lines.push({ kind: 'row', left: 'Service charge (12.5%)',  right: fmt(r.total_service) });
  lines.push({ kind: 'total', left: 'TOTAL SALES',           right: fmt(r.total_sales) });

  lines.push({ kind: 'div' });
  lines.push({ kind: 'row', left: `Dine-in (${r.dine_in_count || 0})`,   right: fmt(r.total_dine_in) });
  lines.push({ kind: 'row', left: `Takeaway (${r.takeaway_count || 0})`, right: fmt(r.total_takeaway) });

  lines.push({ kind: 'div' });
  lines.push({ kind: 'row', left: 'Orders',         right: fmtInt(r.total_orders) });
  lines.push({ kind: 'row', left: 'Covers',         right: fmtInt(r.total_covers) });
  lines.push({ kind: 'row', left: 'Avg per cover',  right: fmt(r.avg_per_cover) });
  lines.push({ kind: 'row', left: 'Discounts',      right: fmt(r.total_discounts) });
  lines.push({ kind: 'row', left: 'Void items',     right: `${fmtInt(r.void_count)}  ${fmt(r.void_value)}` });

  if (Array.isArray(r.vat_breakdown) && r.vat_breakdown.length) {
    lines.push({ kind: 'div' });
    lines.push({ kind: 'h2', text: 'VAT BREAKDOWN' });
    for (const b of r.vat_breakdown) {
      lines.push({ kind: 'row', left: `${b.rate}%  net ${fmt(b.net)}`, right: fmt(b.vat) });
    }
    lines.push({ kind: 'total', left: 'Total VAT', right: fmt(r.vat_total) });
  }

  if (Array.isArray(r.voids_by_type) && r.voids_by_type.length) {
    lines.push({ kind: 'div' });
    lines.push({ kind: 'h2', text: 'VOIDS BY TYPE' });
    for (const v of r.voids_by_type) {
      lines.push({ kind: 'row', left: `${v.void_type}  x${fmtInt(v.count)}`, right: fmt(v.value) });
    }
  }

  lines.push({ kind: 'div-solid' });
  lines.push({ kind: 'h2', text: 'CASH RECONCILIATION' });
  lines.push({ kind: 'row', left: 'Cash sales',       right: fmt(r.total_cash) });
  lines.push({ kind: 'row', left: '- Petty cash',     right: fmt(cash.pettyCash) });
  lines.push({ kind: 'row', left: 'Expected drawer',  right: fmt((r.total_cash || 0) - cash.pettyCash) });
  lines.push({ kind: 'row', left: 'Actual counted',   right: fmt(cash.actualCash) });
  const label = cash.difference === 0 ? 'Exact match' : cash.difference > 0 ? 'Over by' : 'Short by';
  lines.push({ kind: 'total', left: label, right: fmt(Math.abs(cash.difference)) });

  // Card reconciliation — only when the operator entered the card-machine takings.
  if (cash.actualCard != null) {
    lines.push({ kind: 'div' });
    lines.push({ kind: 'h2', text: 'CARD RECONCILIATION' });
    lines.push({ kind: 'row', left: 'Card sales (sys)', right: fmt(r.total_card) });
    lines.push({ kind: 'row', left: 'Actual takings',   right: fmt(cash.actualCard) });
    const clabel = cash.cardDifference === 0 ? 'Exact match' : cash.cardDifference > 0 ? 'Over by' : 'Short by';
    lines.push({ kind: 'total', left: clabel, right: fmt(Math.abs(cash.cardDifference || 0)) });
  }

  return lines;
}
