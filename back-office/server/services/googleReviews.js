// SEPOS-REVIEWS-001 — Google review snapshots per client via Places API (New).
//
// One PLATFORM key (GOOGLE_PLACES_API_KEY on this service) serves every
// client: we read their PUBLIC listing — rating, review count, the ~5 most
// recent reviews Google exposes. No client credentials, no owner OAuth.
// (Full history / replying needs per-owner Business Profile OAuth — out of
// scope on purpose.)
//
// place_id discovery: Text Search on "name, address"; stored on the clients
// row once found so the daily cron is a single cheap Place Details call.
// Dormant without the env key — routes answer 503, cron no-ops.

const { pool } = require('../db/pool');

const KEY = () => process.env.GOOGLE_PLACES_API_KEY || '';
const enabled = () => !!KEY();

async function findPlaceId(name, address) {
  const body = { textQuery: [name, address].filter(Boolean).join(', ') };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY(),
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`places search ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return (data.places && data.places[0]) || null;
}

async function fetchPlaceDetails(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': KEY(),
      'X-Goog-FieldMask': 'rating,userRatingCount,reviews',
    },
  });
  if (!r.ok) throw new Error(`place details ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Snapshot one client. Discovers + stores place_id on first run when missing.
async function snapshotClient(client) {
  if (!enabled()) return { skipped: 'no GOOGLE_PLACES_API_KEY' };
  let placeId = client.place_id;
  if (!placeId) {
    const hit = await findPlaceId(client.restaurant_name, client.metadata?.address || '');
    if (!hit) return { skipped: 'no Google listing found' };
    placeId = hit.id;
    await pool.query('UPDATE clients SET place_id = $1 WHERE id = $2', [placeId, client.id]);
  }
  const d = await fetchPlaceDetails(placeId);
  const reviews = (d.reviews || []).slice(0, 5).map(rv => ({
    author: rv.authorAttribution?.displayName || 'Anonymous',
    rating: rv.rating ?? null,
    text: (rv.text?.text || rv.originalText?.text || '').slice(0, 600),
    time: rv.publishTime || null,
  }));
  const row = await pool.query(
    `INSERT INTO reviews_snapshots (client_id, rating, review_count, reviews)
     VALUES ($1, $2, $3, $4) RETURNING id, rating, review_count, fetched_at`,
    [client.id, d.rating ?? null, d.userRatingCount ?? 0, JSON.stringify(reviews)]
  );
  return { snapshot: row.rows[0], reviews };
}

// Daily sweep over live clients. One snapshot per client per run; a client
// with no Google listing just logs and moves on.
async function snapshotAll() {
  if (!enabled()) return { skipped: true };
  const clients = await pool.query(
    `SELECT id, restaurant_name, place_id, metadata FROM clients WHERE status NOT IN ('churned', 'archived') OR status IS NULL`
  );
  let done = 0, skipped = 0;
  for (const c of clients.rows) {
    try {
      const r = await snapshotClient(c);
      r.skipped ? skipped++ : done++;
    } catch (e) {
      skipped++;
      console.warn(`[reviews] snapshot ${c.restaurant_name}:`, e.message);
    }
  }
  console.log(`[reviews] daily sweep: ${done} snapshotted, ${skipped} skipped`);
  return { done, skipped };
}

// 24h cadence, first run 90s after boot so deploys don't stampede the API.
function start() {
  if (!enabled()) { console.log('[reviews] no GOOGLE_PLACES_API_KEY — dormant'); return; }
  setTimeout(() => snapshotAll().catch(() => {}), 90 * 1000);
  setInterval(() => snapshotAll().catch(() => {}), 24 * 60 * 60 * 1000);
  console.log('[reviews] daily Google-review snapshots armed');
}

module.exports = { enabled, snapshotClient, snapshotAll, start };
