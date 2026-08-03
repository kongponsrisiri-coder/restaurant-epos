// SEPOS-BRAND-001 — per-client branding (logo + 2-colour theme).
//
// Brand colours are CSS variables set at app load from the tenant's settings
// (applyBrandTheme). Screens reference these via the CSS vars — with the
// default SiamEPOS colour baked in as fallback — so a tenant's theme repaints
// the whole POS. With no override, the vars fall back to the current navy/gold,
// so existing clients look identical (zero change).
//
// Only PRIMARY (brand base) and ACCENT (highlight) are themeable, per spec.
// RED/GREEN stay fixed — they're functional (alert / success), not brand.
//
// NOTE: the hex literals below must stay PLAIN hex (they feed <input type=color>
// and the CSS-var fallbacks). Don't wrap them in var().

export const DEFAULT_PRIMARY = '#0D1B3E'; // SiamEPOS navy
export const DEFAULT_ACCENT  = '#C9A84C'; // SiamEPOS gold

// Brand tokens — resolve to the CSS var, default baked in for when it's unset.
export const NAVY  = 'var(--brand-primary, #0D1B3E)';
export const GOLD  = 'var(--brand-accent, #C9A84C)';
export const RED   = '#e94560';   // action / alert — not brand-themed
export const GREEN = '#2E9E6E';   // success — not brand-themed

// Preset palettes the client can pick from { primary, accent }.
export const BRAND_PRESETS = [
  { name: 'SiamEPOS (default)', primary: '#0D1B3E', accent: '#C9A84C' },
  { name: 'Emerald & Gold',     primary: '#0B3D2E', accent: '#D4AF37' },
  { name: 'Charcoal & Copper',  primary: '#1E1E1E', accent: '#B87333' },
  { name: 'Burgundy & Cream',   primary: '#5B1A1A', accent: '#E8D9B5' },
  { name: 'Teal & Coral',       primary: '#0E4D54', accent: '#E4572E' },
  { name: 'Plum & Blush',       primary: '#3B1F3B', accent: '#E7A3B0' },
];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (v) => typeof v === 'string' && HEX.test(v.trim());

// Apply a tenant's brand colours to the whole app (sets the CSS vars). Bad /
// missing values fall back to the defaults, so a broken colour can never blank
// the UI. Call once settings load (and after a branding save).
export function applyBrandTheme(settings) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.style.setProperty('--brand-primary', isHex(settings && settings.brand_primary) ? settings.brand_primary.trim() : DEFAULT_PRIMARY);
  root.style.setProperty('--brand-accent',  isHex(settings && settings.brand_accent)  ? settings.brand_accent.trim()  : DEFAULT_ACCENT);
}
