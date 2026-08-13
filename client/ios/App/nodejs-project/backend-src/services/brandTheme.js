// SEPOS-EMAIL-BRAND-001 — per-restaurant brand colours for CUSTOMER-FACING
// emails (booking confirmation + reminder). Reads the SAME brand_primary /
// brand_accent the POS theme uses (client/src/theme.js, KV `settings` table),
// so the confirmation email a customer receives wears the restaurant's own
// colours — Baan Siam's navy, the next client's whatever they pick in
// Settings → Branding — with zero per-client code.
//
// Mirrors siamepos-spa/src/services/brandTheme.js. Includes a luminance guard:
// text on the primary colour flips between white and near-black automatically,
// so a restaurant picking a pale brand colour can't produce unreadable email.

const pool = require('../db/dbAdapter');

// Keep in lockstep with client/src/theme.js DEFAULT_PRIMARY / DEFAULT_ACCENT.
const DEFAULT_PRIMARY = '#0D1B3E'; // SiamEPOS navy
const DEFAULT_ACCENT  = '#C9A84C'; // SiamEPOS gold

const HEX_RE = /^#?([0-9a-f]{6})$/i;

function parseHex(hex, fallback) {
  const m = HEX_RE.exec(String(hex || '').trim());
  const h = m ? m[1] : HEX_RE.exec(fallback)[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const toHexString = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// WCAG-ish relative luminance (0 = black, 1 = white).
function luminance({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Mix a colour toward white — used for the very-light brand-tinted panel behind
// the booking details (so the box picks up a hint of the brand, not flat grey).
function mixToWhite({ r, g, b }, whiteFraction) {
  const m = (v) => Math.round(v + (255 - v) * whiteFraction);
  return { r: m(r), g: m(g), b: m(b) };
}

// Resolve the restaurant's brand theme from KV settings (with SiamEPOS
// defaults). Returns hex strings ready to drop into email template literals.
async function getBrandTheme(db = pool) {
  let primaryRaw, accentRaw;
  try {
    const r = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('brand_primary','brand_accent')`,
    );
    const kv = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    primaryRaw = kv.brand_primary;
    accentRaw = kv.brand_accent;
  } catch { /* settings unreadable → defaults, email still sends */ }

  const primary = parseHex(primaryRaw, DEFAULT_PRIMARY);
  const accent = parseHex(accentRaw, DEFAULT_ACCENT);
  const lightPrimary = luminance(primary) > 0.5;
  const textOnPrimary = lightPrimary ? { r: 28, g: 28, b: 28 } : { r: 255, g: 255, b: 255 };

  return {
    primaryHex: toHexString(primary),
    accentHex: toHexString(accent),
    // Text sitting ON the primary colour (header heading).
    textOnPrimaryHex: toHexString(textOnPrimary),
    // Softer secondary text on primary (the restaurant-name subline).
    softOnPrimary: lightPrimary ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)',
    // Very light brand-tinted panel background for the details box.
    tintHex: toHexString(mixToWhite(primary, 0.93)),
    lightPrimary,
  };
}

module.exports = { getBrandTheme, DEFAULT_PRIMARY, DEFAULT_ACCENT };
