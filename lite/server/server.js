require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { runMigrations } = require('./db/schema');

const app  = express();
const PORT = process.env.PORT || 3003;

// ── Stripe webhook needs raw body — must be before express.json() ──────────
app.use('/api/stripe/webhook', require('./routes/stripe').webhookRaw ||
  ((req, res, next) => next()) // fallback — webhook is self-contained
);

app.use(cors({
  origin: [
    'http://localhost:5175',
    'https://lite.siamepos.co.uk',
    process.env.LITE_FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

// Parse JSON for all routes except the Stripe webhook (which needs raw)
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'siamepos-lite' }));

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/onboarding',  require('./routes/onboarding'));
app.use('/api/restaurant',  require('./routes/restaurant'));
app.use('/api/stripe',      require('./routes/stripe'));

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[lite-server] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function start() {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`[lite-server] listening on :${PORT}`);
  });
}

start().catch(err => {
  console.error('[lite-server] failed to start', err);
  process.exit(1);
});
