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

// ── Invoice attachments ───────────────────────────────────────────────────

// GET /api/finance/attachments?ids=uid1,uid2,...
// Returns a map of { [transaction_id]: { id, filename, mimetype, file_size, uploaded_at } }
// for the given list of transaction IDs. Used by the transaction table to
// show which rows already have an attachment without fetching all files.
router.get('/attachments', authRequired, async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({});
    const { rows } = await pool.query(
      `SELECT transaction_id, id, filename, mimetype, file_size, uploaded_by, uploaded_at
       FROM transaction_attachments
       WHERE transaction_id = ANY($1)`,
      [ids]
    );
    const map = {};
    rows.forEach(r => { map[r.transaction_id] = r; });
    return res.json(map);
  } catch (err) {
    console.error('[finance] attachments GET error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/finance/transactions/:txId/attachment
// Body: { filename, mimetype, file_data (base64), file_size }
// Upserts — re-uploading replaces the existing attachment.
router.post('/transactions/:txId/attachment', authRequired, async (req, res) => {
  const { txId } = req.params;
  const { filename, mimetype, file_data, file_size } = req.body || {};
  if (!filename || !file_data) {
    return res.status(400).json({ error: 'filename and file_data are required' });
  }
  // 5 MB limit on base64 payload (~3.75 MB original file)
  if (file_data.length > 5 * 1024 * 1024 * 1.4) {
    return res.status(413).json({ error: 'File too large — maximum 5 MB' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO transaction_attachments
         (transaction_id, filename, mimetype, file_data, file_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (transaction_id) DO UPDATE SET
         filename    = EXCLUDED.filename,
         mimetype    = EXCLUDED.mimetype,
         file_data   = EXCLUDED.file_data,
         file_size   = EXCLUDED.file_size,
         uploaded_by = EXCLUDED.uploaded_by,
         uploaded_at = NOW()
       RETURNING id, filename, mimetype, file_size, uploaded_at`,
      [txId, filename, mimetype || 'application/octet-stream', file_data,
       file_size || null, req.user?.email || null]
    );
    return res.json(rows[0]);
  } catch (err) {
    console.error('[finance] attachment upload error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/finance/transactions/:txId/attachment
// Returns the file as a download (Content-Disposition: attachment).
router.get('/transactions/:txId/attachment', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT filename, mimetype, file_data FROM transaction_attachments WHERE transaction_id = $1',
      [req.params.txId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No attachment found' });
    const { filename, mimetype, file_data } = rows[0];
    const buf = Buffer.from(file_data, 'base64');
    res.set('Content-Type', mimetype);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', buf.length);
    return res.send(buf);
  } catch (err) {
    console.error('[finance] attachment download error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/finance/transactions/:txId/attachment
router.delete('/transactions/:txId/attachment', authRequired, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM transaction_attachments WHERE transaction_id = $1',
      [req.params.txId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
