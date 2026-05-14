// SEPOS-041 — SiamEPOS Back Office. Internal ops dashboard for managing all
// restaurant clients. Separate Railway service from the restaurant EPOS.

const express = require('express');
const cors    = require('cors');

const { ensureSchema, ensureBootstrapAdmin } = require('./db/pool');
const { seedTickets } = require('./db/seeds');
const authRoutes    = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const healthRoutes  = require('./routes/health');
const notesRoutes   = require('./routes/notes');
const teamRoutes    = require('./routes/team');
const ticketsRoutes = require('./routes/tickets');
const websiteRoutes  = require('./routes/website');
const financeRoutes  = require('./routes/finance');
const healthCron     = require('./services/healthCheck');

const PORT = parseInt(process.env.PORT || '3002', 10);
const app = express();

// Startup diagnostics — log which expected env vars are present so a
// missing JWT_SECRET / DATABASE_URL is obvious in the Railway log
// instead of being inferred from downstream errors. We log presence,
// not the values, so secrets never leak.
// Note: STARLING_TOKEN and ANTHROPIC_API_KEY for the Finance section
// (SEPOS-042) are stored in the finance_settings DB table, not env vars,
// so they are not listed here.
const expectedEnv = [
  'DATABASE_URL', 'JWT_SECRET', 'PORT',
  'OPS_BOOTSTRAP_EMAIL', 'OPS_BOOTSTRAP_PASSWORD', 'OPS_BOOTSTRAP_NAME',
];
console.log('[ops-api] env check:');
for (const k of expectedEnv) {
  const v = process.env[k];
  const presence = v == null || v === '' ? '✗ MISSING'
                 : k === 'JWT_SECRET' ? `✓ set (${v.length} chars)`
                 : k.includes('PASSWORD') ? '✓ set (hidden)'
                 : k === 'DATABASE_URL' ? `✓ set (host=${(() => { try { return new URL(v).host; } catch { return '?'; } })()})`
                 : `✓ ${v}`;
  console.log(`  ${k.padEnd(24)} ${presence}`);
}

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
app.use('/api/tickets', ticketsRoutes);
app.use('/api/website-configs', websiteRoutes);
app.use('/api/finance', financeRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

(async () => {
  try {
    await ensureSchema();
    await ensureBootstrapAdmin();
    await seedTickets();
  } catch (err) {
    console.error('[ops-api] startup error', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✅ SiamEPOS Back Office API listening on :${PORT}`);
    healthCron.start();
  });
})();
