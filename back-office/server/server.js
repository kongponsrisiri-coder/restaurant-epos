// SEPOS-041 — SiamEPOS Back Office. Internal ops dashboard for managing all
// restaurant clients. Separate Railway service from the restaurant EPOS.

const express = require('express');
const cors    = require('cors');

const { ensureSchema, ensureBootstrapAdmin } = require('./db/pool');
const authRoutes    = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const healthRoutes  = require('./routes/health');
const notesRoutes   = require('./routes/notes');
const teamRoutes    = require('./routes/team');
const healthCron    = require('./services/healthCheck');

const PORT = parseInt(process.env.PORT || '3002', 10);
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Lightweight log of what we're seeing in dev / staging. Skipped in prod
// if NODE_ENV=production (Railway sets this) to keep logs tidy.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[ops-api] ${req.method} ${req.path}`);
    next();
  });
}

app.get('/', (req, res) => {
  res.json({ name: 'SiamEPOS Back Office API', version: '0.1.0', status: 'ok' });
});

app.get('/api/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/auth',    authRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/health',  healthRoutes);
app.use('/api/notes',   notesRoutes);
app.use('/api/team',    teamRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

(async () => {
  try {
    await ensureSchema();
    await ensureBootstrapAdmin();
  } catch (err) {
    console.error('[ops-api] startup error', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✅ SiamEPOS Back Office API listening on :${PORT}`);
    healthCron.start();
  });
})();
