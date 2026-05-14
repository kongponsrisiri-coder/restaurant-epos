// SEPOS-042 — Finance / Starling Bank page.
// Shows live balance + transaction history from Starling, P&L summary,
// and an AI-generated plain-English monthly summary (Anthropic).

import { useState, useEffect, useCallback } from 'react';
import { C } from '../theme.js';
import { api } from '../api.js';

// ── tiny helpers ─────────────────────────────────────────────────────────

function fmtGBP(amount) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtCategory(raw) {
  if (!raw) return '—';
  return raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── skeleton block ───────────────────────────────────────────────────────
function Skeleton({ width = '100%', height = 20, style = {} }) {
  return (
    <div style={{
      width, height, borderRadius: 6,
      background: 'linear-gradient(90deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.06) 100%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.4s infinite',
      ...style,
    }} />
  );
}

// ── Settings panel ───────────────────────────────────────────────────────
function SettingsPanel({ onSaved }) {
  const [loading, setLoading]   = useState(true);
  const [hasToken, setHasToken] = useState(false);
  const [hasAnth, setHasAnth]   = useState(false);
  const [token, setToken]       = useState('');
  const [anthKey, setAnthKey]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState(null);

  useEffect(() => {
    api.getFinanceSettings()
      .then(d => { setHasToken(d.has_token); setHasAnth(d.has_anthropic); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body = {};
      if (token.trim())   body.starling_token = token.trim();
      if (anthKey.trim()) body.anthropic_key  = anthKey.trim();
      await api.saveFinanceSettings(body);
      setMsg({ ok: true, text: 'Settings saved.' });
      const updated = await api.getFinanceSettings();
      setHasToken(updated.has_token);
      setHasAnth(updated.has_anthropic);
      setToken('');
      setAnthKey('');
      if (onSaved) onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '9px 12px', borderRadius: 7, border: `1px solid rgba(255,255,255,0.15)`,
    background: 'rgba(255,255,255,0.06)', color: 'white', fontSize: 14,
    outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 12, color: 'rgba(255,255,255,0.6)', fontWeight: 600, marginBottom: 5, display: 'block' };

  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)',
      borderRadius: 12, padding: 24, marginBottom: 28,
    }}>
      <h3 style={{ color: C.gold, margin: '0 0 18px', fontSize: 15, fontWeight: 700 }}>
        API Settings
      </h3>

      {loading ? (
        <Skeleton height={90} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Starling Personal Access Token</label>
            {hasToken && !token && (
              <div style={{ fontSize: 12, color: '#4caf7d', marginBottom: 6 }}>
                ✓ Starling token saved — paste a new value to replace it
              </div>
            )}
            <input
              type="password"
              style={inputStyle}
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={hasToken ? '••••••••••••••••••••' : 'Bearer token from developer.starlingbank.com'}
            />
          </div>

          <div>
            <label style={labelStyle}>Anthropic API Key</label>
            {hasAnth && !anthKey && (
              <div style={{ fontSize: 12, color: '#4caf7d', marginBottom: 6 }}>
                ✓ Anthropic key saved — paste a new value to replace it
              </div>
            )}
            <input
              type="password"
              style={inputStyle}
              value={anthKey}
              onChange={e => setAnthKey(e.target.value)}
              placeholder={hasAnth ? '••••••••••••••••••••' : 'sk-ant-...'}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button
              onClick={save}
              disabled={saving || (!token.trim() && !anthKey.trim())}
              style={{
                padding: '9px 22px', borderRadius: 7, border: 'none',
                background: saving || (!token.trim() && !anthKey.trim()) ? 'rgba(255,255,255,0.12)' : C.gold,
                color: saving || (!token.trim() && !anthKey.trim()) ? 'rgba(255,255,255,0.4)' : C.navy,
                fontWeight: 700, fontSize: 14, cursor: saving ? 'wait' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {msg && (
              <span style={{ fontSize: 13, color: msg.ok ? '#4caf7d' : '#e57373' }}>
                {msg.text}
              </span>
            )}
          </div>

          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', margin: 0 }}>
            Your keys are stored securely in the database and never exposed in the browser.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Balance card ─────────────────────────────────────────────────────────
function BalanceCard({ balance, loading, error }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${C.navy} 0%, #1a2744 100%)`,
      border: `1px solid ${C.gold}44`,
      borderRadius: 14, padding: '28px 32px', marginBottom: 28,
    }}>
      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        Current Account Balance
      </div>

      {loading ? (
        <Skeleton width={200} height={48} style={{ borderRadius: 8 }} />
      ) : error ? (
        <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 15 }}>{error}</div>
      ) : balance ? (
        <>
          <div style={{ fontSize: 48, fontWeight: 800, color: 'white', letterSpacing: -1, lineHeight: 1 }}>
            {fmtGBP(balance.amount)}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 10 }}>
            {balance.currency} · as of {new Date(balance.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} today
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── P&L summary ──────────────────────────────────────────────────────────
function PLSummary({ transactions }) {
  const totalIn  = transactions.filter(t => t.direction === 'IN').reduce((s, t) => s + t.amount, 0);
  const totalOut = transactions.filter(t => t.direction === 'OUT').reduce((s, t) => s + t.amount, 0);
  const net = totalIn - totalOut;

  const boxStyle = (color) => ({
    flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: 10,
    border: `1px solid ${color}44`, padding: '18px 22px',
  });
  const labelSt = { fontSize: 12, color: 'rgba(255,255,255,0.5)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 };
  const valueSt = (color) => ({ fontSize: 26, fontWeight: 800, color });

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ color: 'white', fontSize: 17, fontWeight: 700, margin: '0 0 14px' }}>P&amp;L Summary</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={boxStyle('#4caf7d')}>
          <div style={labelSt}>Total In</div>
          <div style={valueSt('#4caf7d')}>{fmtGBP(totalIn)}</div>
        </div>
        <div style={boxStyle('#e57373')}>
          <div style={labelSt}>Total Out</div>
          <div style={valueSt('#e57373')}>{fmtGBP(totalOut)}</div>
        </div>
      </div>
      <div style={{
        marginTop: 14, padding: '14px 22px', borderRadius: 10,
        background: 'rgba(255,255,255,0.04)', border: `1px solid ${net >= 0 ? '#4caf7d' : '#e57373'}44`,
        fontSize: 18, fontWeight: 800, color: net >= 0 ? '#4caf7d' : '#e57373',
      }}>
        Net: {fmtGBP(net)}
        <span style={{ fontSize: 13, fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: 12 }}>
          ({net >= 0 ? 'positive cash flow' : 'negative cash flow'})
        </span>
      </div>
    </div>
  );
}

// ── Transactions table ───────────────────────────────────────────────────
function TransactionTable({ transactions, loading, days, onDaysChange }) {
  const DAYS = [30, 60, 90];
  const btnBase = { padding: '6px 18px', borderRadius: 20, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'background 0.12s, color 0.12s' };

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <h2 style={{ color: 'white', fontSize: 17, fontWeight: 700, margin: 0 }}>Transaction History</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {DAYS.map(d => (
            <button
              key={d}
              style={{
                ...btnBase,
                background: days === d ? C.gold : 'rgba(255,255,255,0.08)',
                color: days === d ? C.navy : 'rgba(255,255,255,0.7)',
              }}
              onClick={() => onDaysChange(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3,4,5].map(i => <Skeleton key={i} height={42} />)}
        </div>
      ) : transactions.length === 0 ? (
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 15, padding: 24, textAlign: 'center' }}>
          No settled transactions in the last {days} days.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginBottom: 10 }}>
            Showing {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
                  {['Date', 'Description', 'Category', 'Amount'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Amount' ? 'right' : 'left', padding: '8px 12px', color: 'rgba(255,255,255,0.5)', fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.7 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx, i) => (
                  <tr key={tx.id || i} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                  }}>
                    <td style={{ padding: '10px 12px', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>{fmtDate(tx.date)}</td>
                    <td style={{ padding: '10px 12px', color: 'white', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.description || '—'}</td>
                    <td style={{ padding: '10px 12px', color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>{fmtCategory(tx.category)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: tx.direction === 'IN' ? '#4caf7d' : '#e57373', whiteSpace: 'nowrap' }}>
                      {tx.direction === 'IN' ? '+' : '-'}{fmtGBP(tx.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── AI Summary ───────────────────────────────────────────────────────────
function AISummarySection({ transactions, hasAnthropicKey }) {
  const [summary, setSummary]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const result = await api.generateFinanceSummary(transactions);
      if (result.summary) {
        setSummary(result.summary);
      } else {
        setError(result.error || 'No summary returned.');
      }
    } catch (err) {
      setError(err.message || 'Failed to generate summary.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ color: 'white', fontSize: 17, fontWeight: 700, margin: '0 0 14px' }}>AI Summary</h2>

      {!hasAnthropicKey ? (
        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 14, padding: '16px 20px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}>
          Set your Anthropic API key in Settings to enable AI summaries.
        </div>
      ) : (
        <>
          <button
            onClick={generate}
            disabled={loading || transactions.length === 0}
            style={{
              padding: '10px 24px', borderRadius: 8, border: 'none',
              background: loading || transactions.length === 0 ? 'rgba(255,255,255,0.12)' : C.gold,
              color: loading || transactions.length === 0 ? 'rgba(255,255,255,0.4)' : C.navy,
              fontWeight: 700, fontSize: 14, cursor: loading ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
            }}
          >
            {loading ? (
              <>
                <span style={{
                  display: 'inline-block', width: 14, height: 14, border: `2px solid ${C.navy}55`,
                  borderTopColor: C.navy, borderRadius: '50%', animation: 'spin 0.7s linear infinite',
                }} />
                Generating…
              </>
            ) : 'Generate AI Summary'}
          </button>

          {error && (
            <div style={{ color: '#e57373', fontSize: 14, marginBottom: 12 }}>{error}</div>
          )}

          {summary && (
            <div style={{
              padding: '20px 24px', borderRadius: 10, lineHeight: 1.7,
              background: 'rgba(201,168,76,0.07)', border: `1px solid ${C.gold}33`,
              color: 'rgba(255,255,255,0.88)', fontSize: 15,
            }}>
              {summary}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function FinancePage() {
  const [showSettings, setShowSettings] = useState(false);
  const [days, setDays]                 = useState(30);

  const [balance, setBalance]           = useState(null);
  const [balLoading, setBalLoading]     = useState(true);
  const [balError, setBalError]         = useState(null);

  const [txns, setTxns]                 = useState([]);
  const [txLoading, setTxLoading]       = useState(true);
  const [txError, setTxError]           = useState(null);  // eslint-disable-line no-unused-vars

  const [hasAnthKey, setHasAnthKey]     = useState(false);

  // Check settings (for AI key presence) on mount
  useEffect(() => {
    api.getFinanceSettings()
      .then(d => setHasAnthKey(d.has_anthropic))
      .catch(() => {});
  }, []);

  const loadData = useCallback(async (daysParam) => {
    setBalLoading(true);
    setTxLoading(true);
    setBalError(null);
    setTxError(null);

    const [balRes, txRes] = await Promise.allSettled([
      api.getFinanceBalance(),
      api.getFinanceTransactions(daysParam),
    ]);

    if (balRes.status === 'fulfilled') {
      setBalance(balRes.value);
    } else {
      const msg = balRes.reason?.message || 'Failed to load balance';
      if (msg.includes('token not configured') || msg.includes('422')) {
        setBalError('Add your Starling token in Settings to get started.');
      } else {
        setBalError(msg);
      }
    }
    setBalLoading(false);

    if (txRes.status === 'fulfilled') {
      setTxns(txRes.value.transactions || []);
    } else {
      setTxns([]);
      setTxError(txRes.reason?.message || 'Failed to load transactions');
    }
    setTxLoading(false);
  }, []);

  useEffect(() => {
    loadData(days);
  }, [days, loadData]);

  const handleSettingsSaved = () => {
    api.getFinanceSettings().then(d => setHasAnthKey(d.has_anthropic)).catch(() => {});
    loadData(days);
  };

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position:  200% 0; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div style={{ maxWidth: 900 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: 'white' }}>
              💰 Company Finance
            </h1>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
              Starling Bank · live data
            </div>
          </div>
          <button
            onClick={() => setShowSettings(s => !s)}
            style={{
              padding: '9px 18px', borderRadius: 8, border: `1px solid rgba(255,255,255,0.15)`,
              background: showSettings ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)',
              color: 'white', fontWeight: 600, fontSize: 14, cursor: 'pointer',
            }}
          >
            ⚙️ Settings
          </button>
        </div>

        {/* Settings panel */}
        {showSettings && <SettingsPanel onSaved={handleSettingsSaved} />}

        {/* Balance */}
        <BalanceCard balance={balance} loading={balLoading} error={balError} />

        {/* Transactions */}
        <TransactionTable
          transactions={txns}
          loading={txLoading}
          days={days}
          onDaysChange={d => setDays(d)}
        />

        {/* P&L — only when we have data */}
        {!txLoading && txns.length > 0 && <PLSummary transactions={txns} />}

        {/* AI Summary */}
        <AISummarySection transactions={txns} hasAnthropicKey={hasAnthKey} />
      </div>
    </>
  );
}
