// SEPOS-042 — Finance / Starling Bank route.
// All endpoints are auth-gated. Settings write is admin-only.
// Tokens are stored in finance_settings (DB row id=1) and never
// returned to the browser — only boolean presence flags are sent.

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

// ── helpers ────────────────────────────────────────────────────────────────

async function getSettings() {
  const { rows } = await pool.query(
    'SELECT starling_token, anthropic_key FROM finance_settings WHERE id = 1'
  );
  return rows[0] || {};
}

// Fetch wrapper that throws a friendly error on non-2xx Starling responses.
async function starlingFetch(path, token) {
  const res = await fetch(`https://api.starlingbank.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'SiamEPOS-BackOffice/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Starling API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Return the first account's uid + defaultCategory, cached for the life
// of each request (no persistent cache needed — it changes rarely).
async function getAccountInfo(token) {
  const data = await starlingFetch('/api/v2/accounts', token);
  if (!data.accounts || data.accounts.length === 0) {
    throw new Error('No accounts found in Starling response');
  }
  const { accountUid, defaultCategory } = data.accounts[0];
  return { accountUid, defaultCategory };
}

// ── GET /api/finance/settings ──────────────────────────────────────────────
// Returns only boolean presence flags — never the actual keys.
router.get('/settings', authRequired, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({
      has_token:     !!(s.starling_token  && s.starling_token.trim()),
      has_anthropic: !!(s.anthropic_key   && s.anthropic_key.trim()),
    });
  } catch (err) {
    console.error('[finance] settings GET error', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PUT /api/finance/settings ──────────────────────────────────────────────
// Admin only. Saves starling_token and/or anthropic_key.
// Passing an empty string clears the field; omitting a key leaves it as-is.
router.put('/settings', authRequired, adminOnly, async (req, res) => {
  try {
    const { starling_token, anthropic_key } = req.body || {};
    const sets = [];
    const vals = [];
    let idx = 1;

    if (starling_token !== undefined) {
      sets.push(`starling_token = $${idx++}`);
      vals.push(starling_token || null);
    }
    if (anthropic_key !== undefined) {
      sets.push(`anthropic_key = $${idx++}`);
      vals.push(anthropic_key || null);
    }
    if (sets.length === 0) {
      return res.json({ ok: true, message: 'Nothing to update' });
    }
    sets.push(`updated_at = now()`);
    vals.push(1); // WHERE id = $N

    await pool.query(
      `UPDATE finance_settings SET ${sets.join(', ')} WHERE id = $${idx}`,
      vals
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[finance] settings PUT error', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── GET /api/finance/balance ───────────────────────────────────────────────
router.get('/balance', authRequired, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.starling_token) {
      return res.status(422).json({ error: 'Starling token not configured' });
    }

    const { accountUid } = await getAccountInfo(s.starling_token);
    const data = await starlingFetch(
      `/api/v2/accounts/${accountUid}/balance`,
      s.starling_token
    );

    const balance = data.effectiveBalance || data.clearedBalance || {};
    res.json({
      amount:    (balance.minorUnits || 0) / 100,
      currency:  balance.currency || 'GBP',
      timestamp: new Date().toISOString(),
      raw:       data,
    });
  } catch (err) {
    console.error('[finance] balance error', err);
    res.status(502).json({ error: err.message || 'Failed to fetch balance' });
  }
});

// ── GET /api/finance/transactions?days=30 ─────────────────────────────────
router.get('/transactions', authRequired, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.starling_token) {
      return res.status(422).json({ error: 'Starling token not configured' });
    }

    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { accountUid, defaultCategory } = await getAccountInfo(s.starling_token);
    const data = await starlingFetch(
      `/api/v2/feed/account/${accountUid}/category/${defaultCategory}?changesSince=${encodeURIComponent(since)}`,
      s.starling_token
    );

    const items = (data.feedItems || [])
      .filter(item => item.status === 'SETTLED')
      .map(item => ({
        id:            item.feedItemUid,
        date:          item.transactionTime,
        description:   item.counterPartyName || item.reference || '',
        category:      item.spendingCategory || '',
        direction:     item.amount?.direction || item.direction || '',
        amount:        (item.amount?.minorUnits || 0) / 100,
        currency:      item.amount?.currency || 'GBP',
        reference:     item.reference || '',
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions: items, count: items.length, days });
  } catch (err) {
    console.error('[finance] transactions error', err);
    res.status(502).json({ error: err.message || 'Failed to fetch transactions' });
  }
});

// ── POST /api/finance/summary ──────────────────────────────────────────────
// Calls Anthropic claude-haiku to generate a plain-English monthly summary.
// Gracefully returns { summary: null, error } if key is missing or call fails.
router.post('/summary', authRequired, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.anthropic_key || !s.anthropic_key.trim()) {
      return res.json({ summary: null, error: 'Anthropic API key not set or invalid.' });
    }

    const { transactions } = req.body || {};
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ summary: null, error: 'No transactions provided.' });
    }

    const prompt = `You are a financial assistant for SiamEPOS, a UK software company. Summarise this month's transactions in plain English in 3-4 sentences. Focus on: total income, total outgoings, biggest expense categories, and overall cash flow trend.\n\nTransactions:\n${JSON.stringify(transactions)}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':          s.anthropic_key.trim(),
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => '');
      console.error('[finance] Anthropic error', anthropicRes.status, errBody.slice(0, 300));
      return res.json({ summary: null, error: 'Anthropic API key not set or invalid.' });
    }

    const aiData = await anthropicRes.json();
    const text = aiData?.content?.[0]?.text || null;
    res.json({ summary: text });
  } catch (err) {
    console.error('[finance] summary error', err);
    res.json({ summary: null, error: 'Anthropic API key not set or invalid.' });
  }
});

module.exports = router;
