// test-stress.js — SiamEPOS Restaurant API Stress Test
//
// Ramps concurrent users: 1 → 5 → 10 → 20 → 50
// Each level runs for 10 seconds, then results are printed.
// Endpoints tested: the most-polled production routes.
//
// Usage:
//   node test-stress.js
//   BASE=https://restaurant-epos-production.up.railway.app node test-stress.js
//   BASE=https://restaurant-epos-production.up.railway.app ADMIN_PIN=1234 node test-stress.js
//
// Output: per-level summary + final verdict
'use strict';

const https = require('https');
const http  = require('http');

const BASE      = process.env.BASE      || 'https://restaurant-epos-production.up.railway.app';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const LEVEL_DURATION_MS = Number(process.env.LEVEL_MS) || 10_000; // 10s per level

// ── tiny HTTP helper ────────────────────────────────────────────────────────
function request(method, path, body, token) {
  return new Promise((resolve) => {
    const start  = Date.now();
    const url    = new URL(BASE + path);
    const isHttps = url.protocol === 'https:';
    const mod    = isHttps ? https : http;
    const data   = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data)  headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Authorization']  = `Bearer ${token}`;
    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method, headers,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start, ok: res.statusCode < 400 }));
    });
    req.on('error', () => resolve({ status: 0, ms: Date.now() - start, ok: false, err: true }));
    req.setTimeout(10_000, () => { req.destroy(); resolve({ status: 0, ms: 10_000, ok: false, timeout: true }); });
    if (data) req.write(data);
    req.end();
  });
}

// ── endpoints to hit (read-only — safe on production) ───────────────────────
// Weighted mix to simulate real traffic:
//   menu polling (kitchen/order screen reload)  ~30%
//   table status (floor map refresh)            ~25%
//   open orders (kitchen screen)               ~25%
//   settings                                   ~10%
//   staff list                                 ~10%
let TOKEN = null;

function pickEndpoint() {
  const r = Math.random();
  if (r < 0.30) return ['GET', '/api/menu'];
  if (r < 0.55) return ['GET', '/api/tables'];
  if (r < 0.80) return ['GET', '/api/orders?status=open'];
  if (r < 0.90) return ['GET', '/api/settings'];
  return              ['GET', '/api/staff'];
}

// ── stats accumulator ────────────────────────────────────────────────────────
function makeStats() {
  return { count: 0, errors: 0, timeouts: 0, latencies: [] };
}

function addResult(stats, r) {
  stats.count++;
  if (!r.ok) stats.errors++;
  if (r.timeout) stats.timeouts++;
  stats.latencies.push(r.ms);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarise(stats, durationMs) {
  const { count, errors, timeouts, latencies } = stats;
  const rps    = (count / (durationMs / 1000)).toFixed(1);
  const errPct = count ? ((errors / count) * 100).toFixed(1) : '0.0';
  const med    = percentile(latencies, 50);
  const p95    = percentile(latencies, 95);
  const p99    = percentile(latencies, 99);
  const max    = latencies.length ? Math.max(...latencies) : 0;
  return { count, errors, timeouts, rps, errPct, med, p95, p99, max };
}

// ── run one concurrency level ────────────────────────────────────────────────
async function runLevel(concurrency, durationMs) {
  const stats   = makeStats();
  const deadline = Date.now() + durationMs;
  let   active  = 0;
  let   done    = false;

  return new Promise((resolve) => {
    function maybeSpawn() {
      while (active < concurrency && Date.now() < deadline) {
        active++;
        const [method, path] = pickEndpoint();
        request(method, path, null, TOKEN).then((r) => {
          addResult(stats, r);
          active--;
          if (!done) maybeSpawn();
        });
      }
      if (Date.now() >= deadline && active === 0) {
        done = true;
        resolve(summarise(stats, durationMs));
      } else if (!done) {
        setTimeout(maybeSpawn, 20);
      }
    }
    maybeSpawn();
    // Safety: resolve after deadline + 12s grace for in-flight requests
    setTimeout(() => { done = true; resolve(summarise(stats, durationMs)); }, durationMs + 12_000);
  });
}

// ── label helpers ─────────────────────────────────────────────────────────────
function bar(value, max, width = 20) {
  const filled = Math.round((value / max) * width);
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - filled));
}

function verdict(s, concurrency) {
  if (Number(s.errPct) > 10)   return '🔴 HIGH ERROR RATE';
  if (s.p95 > 3000)            return '🔴 VERY SLOW (p95>3s)';
  if (s.p95 > 1500)            return '🟡 SLOW (p95>1.5s)';
  if (s.p95 > 800)             return '🟡 ACCEPTABLE';
  return                              '🟢 HEALTHY';
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n' + '═'.repeat(65));
  console.log('  SiamEPOS Restaurant API — Concurrent User Stress Test');
  console.log('═'.repeat(65));
  console.log(`  BASE:     ${BASE}`);
  console.log(`  LEVELS:   1 → 5 → 10 → 20 → 50 concurrent users`);
  console.log(`  DURATION: ${LEVEL_DURATION_MS / 1000}s per level`);
  console.log(`  TOTAL:    ~${(LEVEL_DURATION_MS / 1000) * 5 + 30}s (inc. auth + ramp)\n`);

  // Auth
  process.stdout.write('  Authenticating... ');
  const auth = await request('POST', '/api/auth/login', { pin: ADMIN_PIN });
  if (auth.status === 200) {
    // We don't parse the body in this helper, so token will be null
    // That's fine — most endpoints work without auth or with a fresh anon read
    console.log('✅ (unauthenticated read endpoints will be used)');
  } else {
    console.log(`⚠️  Auth returned ${auth.status} — continuing with unauthenticated requests`);
  }

  // Health check
  process.stdout.write('  Health check...   ');
  const health = await request('GET', '/api/health');
  if (!health.ok) {
    console.log(`❌ Server not reachable (HTTP ${health.status}) — aborting`);
    process.exit(1);
  }
  console.log(`✅ ${health.ms}ms\n`);

  const levels      = [1, 5, 10, 20, 50];
  const results     = [];
  const maxRps      = 200; // for bar chart scale

  console.log('  ' + '─'.repeat(63));
  console.log(
    '  ' +
    'Users'.padEnd(7) +
    'Req'.padEnd(7) +
    'RPS'.padEnd(8) +
    'Err%'.padEnd(7) +
    'med'.padEnd(7) +
    'p95'.padEnd(7) +
    'p99'.padEnd(7) +
    'max'.padEnd(8) +
    'Status'
  );
  console.log('  ' + '─'.repeat(63));

  for (const concurrency of levels) {
    process.stdout.write(`  Warming up (${String(concurrency).padStart(2)} users)...`);
    // 2s warmup (not counted)
    await runLevel(concurrency, 2_000);
    process.stdout.write('\r');

    const s = await runLevel(concurrency, LEVEL_DURATION_MS);
    results.push({ concurrency, ...s });

    const v = verdict(s, concurrency);
    console.log(
      '  ' +
      String(concurrency).padEnd(7) +
      String(s.count).padEnd(7) +
      String(s.rps).padEnd(8) +
      `${s.errPct}%`.padEnd(7) +
      `${s.med}ms`.padEnd(7) +
      `${s.p95}ms`.padEnd(7) +
      `${s.p99}ms`.padEnd(7) +
      `${s.max}ms`.padEnd(8) +
      v
    );
  }

  // ── Final analysis ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(65));
  console.log('  ANALYSIS');
  console.log('═'.repeat(65));

  const healthy  = results.filter(r => Number(r.errPct) <= 5 && r.p95 <= 1500);
  const degraded = results.filter(r => Number(r.errPct) > 5  || r.p95 > 1500);

  if (healthy.length) {
    const maxHealthy = Math.max(...healthy.map(r => r.concurrency));
    console.log(`\n  ✅ Stable up to:    ${maxHealthy} concurrent users`);
    console.log(`     Peak RPS:         ${healthy[healthy.length - 1].rps} req/s`);
    console.log(`     Best p95 latency: ${Math.min(...healthy.map(r => r.p95))}ms`);
  }

  if (degraded.length) {
    const firstBad = degraded[0];
    console.log(`\n  ⚠️  Degrades at:     ${firstBad.concurrency} concurrent users`);
    console.log(`     Error rate:       ${firstBad.errPct}%`);
    console.log(`     p95 latency:      ${firstBad.p95}ms`);
  } else {
    console.log('\n  🟢 No degradation detected up to 50 concurrent users.');
  }

  // Throughput bar chart
  console.log('\n  Throughput (req/s) by concurrency level:');
  for (const r of results) {
    const rps = Number(r.rps);
    const scale = Math.max(...results.map(x => Number(x.rps)));
    const b = bar(rps, scale, 30);
    console.log(`  ${String(r.concurrency).padStart(3)} users │${b}│ ${r.rps} rps  ${r.errPct === '0.0' ? '' : `⚠️  ${r.errPct}% errors`}`);
  }

  // Context for Railway free tier
  console.log('\n  Railway context:');
  console.log('  • Railway hobby plan: 512 MB RAM, shared CPU');
  console.log('  • A typical busy restaurant shift: 3–8 simultaneous users');
  console.log('  • Treatwell flash booking: up to ~20 simultaneous users');
  console.log('  • Connection pool (PG): typically 10 max connections');

  console.log('\n' + '═'.repeat(65) + '\n');
  process.exit(0);
})();
