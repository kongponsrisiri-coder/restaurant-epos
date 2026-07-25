// SEPOS-ANDROID — native HTTP layer.
//
// Old Sunmi WebViews (Android 7/8, Sunmi A9 / T2s) ship a stale `fetch`
// implementation that fails CORS / mixed-content / TLS on some tenant
// backends — which is what made the app unable to reach the cloud on
// hardware that a desktop Chrome could reach fine. CapacitorHttp routes the
// request through the native Android HTTP stack instead, bypassing the
// WebView entirely.
//
// Contract (matches the rest of api.js so call sites are unchanged):
//   • 2xx                  → resolve with the parsed JSON body
//   • non-2xx (4xx/5xx)    → resolve with { error: body.error || 'status N' }
//                            (NEVER throw — offline fallbacks + assertOk rely
//                             on the helper resolving, not rejecting)
//   • transport / network  → THROW (so offline-cache fallbacks fire)
import { CapacitorHttp } from '@capacitor/core';

// Normalise whatever CapacitorHttp hands back into a JS value:
//   '' / null / undefined → {}
//   object / array        → pass through
//   string                → try JSON.parse, else the raw string
function normaliseBody(data) {
  if (data === '' || data === null || data === undefined) return {};
  if (typeof data === 'object') return data;            // object or array
  if (typeof data === 'string') {
    const s = data.trim();
    if (s === '') return {};
    try { return JSON.parse(s); } catch { return data; }
  }
  return data;
}

// SEPOS-SEC-002 — attach the staff login token to native (Sunmi) calls too,
// mirroring the web helpers. Read localStorage directly to avoid importing
// api.js (circular). Additive + backward-compatible.
function nativeAuthHeader() {
  try {
    const raw = localStorage.getItem('siamepos_token') || localStorage.getItem('siamepos_auth');
    if (!raw) return {};
    const a = JSON.parse(raw);
    if (a && a.token && (!a.expires_at || a.expires_at > Date.now())) {
      return { Authorization: `Bearer ${a.token}` };
    }
  } catch {}
  return {};
}

export async function nativeRequest(method, fullUrl, { headers, data } = {}) {
  // CapacitorHttp.request throws only on a transport/network failure — let
  // that bubble up so api.js's catch blocks fall back to the offline cache.
  const res = await CapacitorHttp.request({
    method,
    url: fullUrl,
    headers: { ...(headers || {}), ...nativeAuthHeader() },
    // CapacitorHttp serialises objects to JSON when Content-Type is JSON.
    ...(data !== undefined ? { data } : {}),
  });

  const status = res.status || 0;
  const body = normaliseBody(res.data);

  if (status >= 200 && status < 300) return body;

  // Non-2xx: resolve (don't throw) with an {error} so the codebase contract
  // holds — assertOk() turns this into a thrown error where it matters.
  const errMsg = (body && typeof body === 'object' && body.error)
    ? body.error
    : `status ${status}`;
  return { error: errMsg };
}
