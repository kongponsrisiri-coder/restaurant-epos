import { useState, useEffect } from 'react';
import { getZReportPreview, saveZReport, getZReportHistory } from '../../api';

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
  const [floatAmount, setFloatAmount]       = useState('');
  const [pettyCash, setPettyCash]           = useState('');
  const [pettyCashReason, setPettyCashReason] = useState('');
  const [actualCash, setActualCash]         = useState('');

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd   = now.toISOString();

  useEffect(() => {
    getZReportHistory().then(setHistory);
    setFromTime(todayStart.slice(0, 16));
    setToTime(todayEnd.slice(0, 16));
  }, []);

  const loadReport = async (type) => {
    setReportType(type); setLoading(true); setSaved(false);
    try {
      const from = type === 'day' ? todayStart : new Date(fromTime).toISOString();
      const to   = type === 'day' ? todayEnd   : new Date(toTime).toISOString();
      const data = await getZReportPreview(from, to);
      setReportData({ ...data, from, to }); setStep(2);
    } catch { alert('Failed to load report!'); }
    finally { setLoading(false); }
  };

  const handleConfirmSave = async () => {
    if (reportData.open_orders?.length > 0) {
      const ok = window.confirm(`⚠️ ${reportData.open_orders.length} tables still open:\n` + reportData.open_orders.map(o => `Table ${o.table_number}`).join(', ') + '\n\nAre you sure?');
      if (!ok) return;
    }
    const floatNum = parseFloat(floatAmount) || 0;
    const pettyNum = parseFloat(pettyCash) || 0;
    const actualNum = parseFloat(actualCash) || 0;
    const expectedCash = (reportData.total_cash || 0) - floatNum - pettyNum;
    const difference = actualNum - expectedCash;
    try {
      await saveZReport(reportType, reportData.from, reportData.to, reportData, floatNum, pettyNum, pettyCashReason, actualNum, difference);
      setSaved(true); setStep(4); getZReportHistory().then(setHistory);
    } catch { alert('Failed to save Z Report!'); }
  };

  const formatDateTime = (dt) => dt ? new Date(dt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const floatNum     = parseFloat(floatAmount) || 0;
  const pettyNum     = parseFloat(pettyCash) || 0;
  const actualNum    = parseFloat(actualCash) || 0;
  const expectedCash = reportData ? (reportData.total_cash || 0) - floatNum - pettyNum : 0;
  const difference   = actualNum - expectedCash;
  const inputStyle   = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 15, boxSizing: 'border-box' };

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>🔐 Z Report / Close Shift</h1>
        <button onClick={() => setShowHistory(!showHistory)} style={{ background: '#f0f0f0', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{showHistory ? 'Hide History' : '📋 View History'}</button>
      </div>

      {showHistory && (
        <div style={{ background: 'white', borderRadius: 12, padding: 20, marginBottom: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Past Z Reports</div>
          {history.length === 0 ? <div style={{ color: '#aaa', fontSize: 14 }}>No Z reports yet</div> : history.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}>
              <div><span style={{ fontWeight: 600, marginRight: 8 }}>{r.type === 'day' ? '🌙 End of Day' : '⏰ Shift Close'}</span><span style={{ color: '#888' }}>{formatDateTime(r.closed_at)}</span></div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ color: '#555' }}>{r.total_orders} orders</span>
                <span style={{ fontWeight: 700, color: '#e94560' }}>£{(r.total_sales || 0).toFixed(2)}</span>
                {r.cash_difference !== 0 && <span style={{ fontWeight: 700, fontSize: 12, color: r.cash_difference > 0 ? '#22c55e' : '#ef4444' }}>{r.cash_difference > 0 ? `Over £${Number(r.cash_difference).toFixed(2)}` : `Short £${Math.abs(Number(r.cash_difference)).toFixed(2)}`}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: '#fff8f0', borderRadius: 12, padding: 24, border: '1px solid #fed7aa' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#c2410c', marginBottom: 8 }}>⏰ Close Shift</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>For lunch or dinner shift. Choose your time range.</div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>From</label><input type="datetime-local" value={fromTime} onChange={e => setFromTime(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
              <div style={{ flex: 1, minWidth: 180 }}><label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 }}>To</label><input type="datetime-local" value={toTime} onChange={e => setToTime(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} /></div>
            </div>
            <button onClick={() => loadReport('shift')} disabled={loading} style={{ padding: '14px 28px', borderRadius: 10, border: 'none', background: '#f97316', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>{loading ? 'Loading...' : '⏰ Run Shift Z Report'}</button>
          </div>
          <div style={{ background: '#fff0f3', borderRadius: 12, padding: 24, border: '1px solid #fecdd3' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#e94560', marginBottom: 8 }}>🌙 End of Day</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Closes all of today's trading from midnight to now.</div>
            <button onClick={() => loadReport('day')} disabled={loading} style={{ padding: '14px 28px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}>{loading ? 'Loading...' : '🌙 Run End of Day'}</button>
          </div>
        </div>
      )}

      {step === 2 && reportData && (
        <div>
          {reportData.open_orders?.length > 0 && (
            <div style={{ background: '#fef9c3', borderRadius: 12, padding: 16, marginBottom: 20, border: '2px solid #eab308' }}>
              <div style={{ fontWeight: 700, color: '#713f12', marginBottom: 4 }}>⚠️ {reportData.open_orders.length} tables still open!</div>
              <div style={{ fontSize: 13, color: '#92400e' }}>{reportData.open_orders.map(o => `Table ${o.table_number}`).join(' · ')}</div>
            </div>
          )}
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', paddingBottom: 16, marginBottom: 16, borderBottom: '2px dashed #eee' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>{reportType === 'day' ? '🌙 END OF DAY' : '⏰ SHIFT CLOSE'}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>💰 Sales Summary</div>
              {[{ label: '💵 Cash Sales', value: reportData.total_cash || 0, color: '#22c55e' }, { label: '💳 Card Sales', value: reportData.total_card || 0, color: '#3b82f6' }, { label: '🔄 Other', value: reportData.total_other || 0, color: '#8b5cf6' }].map(p => (
                <div key={p.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', fontSize: 15 }}><span>{p.label}</span><span style={{ fontWeight: 700, color: p.color }}>£{p.value.toFixed(2)}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontSize: 20, fontWeight: 800, color: '#e94560' }}><span>TOTAL SALES</span><span>£{(reportData.total_sales || 0).toFixed(2)}</span></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
              {[{ label: 'Orders', value: reportData.total_orders || 0, color: '#3b82f6' }, { label: 'Covers', value: reportData.total_covers || 0, color: '#22c55e' }, { label: 'Avg/Cover', value: `£${(reportData.avg_per_cover || 0).toFixed(2)}`, color: '#8b5cf6' }].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 12, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div></div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 10, padding: 12, border: '1px solid #bbf7d0' }}><div style={{ fontSize: 11, color: '#888' }}>Discounts Given</div><div style={{ fontSize: 18, fontWeight: 800, color: '#22c55e' }}>£{(reportData.total_discounts || 0).toFixed(2)}</div></div>
              <div style={{ flex: 1, background: '#fff0f3', borderRadius: 10, padding: 12, border: '1px solid #fecdd3' }}><div style={{ fontSize: 11, color: '#888' }}>Void Items</div><div style={{ fontSize: 18, fontWeight: 800, color: '#e94560' }}>{reportData.void_count || 0} items</div></div>
            </div>

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
            <button onClick={() => setStep(3)} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: '#1a1a2e', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>Next — Till Reconciliation →</button>
            <button onClick={() => { setStep(1); setReportData(null); }} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 3 && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: '#1a1a2e' }}>💵 Till Reconciliation</div>
            <div style={{ background: '#f0f7ff', borderRadius: 10, padding: 14, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: 14, color: '#555' }}>Cash Sales from System</span><span style={{ fontSize: 20, fontWeight: 800, color: '#1e40af' }}>£{(reportData.total_cash || 0).toFixed(2)}</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>💰 Float at Start of Shift</label><div style={{ position: 'relative' }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={floatAmount} onChange={e => setFloatAmount(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div></div>
              <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🧾 Petty Cash Out</label><div style={{ position: 'relative', marginBottom: 8 }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={pettyCash} onChange={e => setPettyCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div><input value={pettyCashReason} onChange={e => setPettyCashReason(e.target.value)} placeholder="Reason e.g. Bought supplies..." style={inputStyle} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>🏦 Actual Cash Counted</label><div style={{ position: 'relative' }}><span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: 15 }}>£</span><input type="number" step="0.01" value={actualCash} onChange={e => setActualCash(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28 }} /></div></div>
            </div>
            {actualCash !== '' && (
              <div style={{ marginTop: 20, background: '#f8f8f8', borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: '#1a1a2e' }}>📊 Cash Calculation</div>
                {[{ label: 'Cash Sales', val: `£${(reportData.total_cash || 0).toFixed(2)}` }, floatNum > 0 && { label: 'Less Float', val: `-£${floatNum.toFixed(2)}` }, pettyNum > 0 && { label: 'Less Petty Cash', val: `-£${pettyNum.toFixed(2)}` }].filter(Boolean).map(r => (
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
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={handleConfirmSave} style={{ flex: 2, padding: '16px', borderRadius: 12, border: 'none', background: reportType === 'day' ? '#e94560' : '#f97316', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{reportType === 'day' ? '🌙 Confirm End of Day' : '⏰ Confirm Close Shift'}</button>
            <button onClick={() => window.print()} style={{ flex: 1, padding: '16px', borderRadius: 12, border: '2px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>🖨️ Print</button>
            <button onClick={() => setStep(2)} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      )}

      {step === 4 && saved && reportData && (
        <div>
          <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 20 }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 48 }}>✅</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginTop: 8 }}>{reportType === 'day' ? 'End of Day Complete!' : 'Shift Closed!'}</div>
              <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{formatDateTime(reportData.from)} — {formatDateTime(reportData.to)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
              {[{ label: 'Total Sales', value: `£${(reportData.total_sales || 0).toFixed(2)}`, color: '#e94560' }, { label: 'Cash Sales', value: `£${(reportData.total_cash || 0).toFixed(2)}`, color: '#22c55e' }, { label: 'Card Sales', value: `£${(reportData.total_card || 0).toFixed(2)}`, color: '#3b82f6' }, { label: 'Orders', value: reportData.total_orders || 0, color: '#8b5cf6' }].map(s => (
                <div key={s.label} style={{ background: '#f8f8f8', borderRadius: 10, padding: 14, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div><div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{s.label}</div></div>
              ))}
            </div>
            <div style={{ background: difference === 0 ? '#f0fdf4' : difference > 0 ? '#eff6ff' : '#fff0f3', borderRadius: 12, padding: 16, border: `2px solid ${difference === 0 ? '#bbf7d0' : difference > 0 ? '#bfdbfe' : '#fecdd3'}`, textAlign: 'center' }}>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 4 }}>Cash Reconciliation</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: difference === 0 ? '#22c55e' : difference > 0 ? '#3b82f6' : '#ef4444' }}>{difference === 0 ? '✅ Exact Match!' : difference > 0 ? `📈 Over by £${difference.toFixed(2)}` : `📉 Short by £${Math.abs(difference).toFixed(2)}`}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => window.print()} style={{ flex: 2, padding: '16px', borderRadius: 12, border: '2px solid #1a1a2e', background: 'white', color: '#1a1a2e', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>🖨️ Print Z Report</button>
            <button onClick={() => { setStep(1); setReportData(null); setSaved(false); setFloatAmount(''); setPettyCash(''); setPettyCashReason(''); setActualCash(''); }} style={{ flex: 1, padding: '16px', borderRadius: 12, border: 'none', background: '#f0f0f0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
