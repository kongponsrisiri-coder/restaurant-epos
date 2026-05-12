// SEPOS-041 — only DELETE lives here (admin-only). CREATE + LIST per-client
// live on routes/clients.js so the URL stays scoped to /api/clients/:id/notes.

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const noteId = parseInt(req.params.id, 10);
    const noteRes = await pool.query('SELECT client_id FROM support_notes WHERE id = $1', [noteId]);
    if (noteRes.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const clientId = noteRes.rows[0].client_id;
    await pool.query('DELETE FROM support_notes WHERE id = $1', [noteId]);
    await pool.query(
      'UPDATE clients SET notes_count = (SELECT COUNT(*) FROM support_notes WHERE client_id = $1) WHERE id = $1',
      [clientId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[ops-notes] delete error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
