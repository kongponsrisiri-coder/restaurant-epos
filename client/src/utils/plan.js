// SEPOS-LITE-001 — plan capability model.
// One source of truth for what each subscription tier unlocks.
//
//   pro            — the full EPOS (everything)
//   lite_booking   — booking widget only      → Reservations
//   lite_ordering  — takeaway/delivery only    → Kitchen (KDS)
//   lite_bundle    — booking + ordering        → Reservations + Kitchen
//
// An unknown/missing plan falls back to 'pro' — a Pro install must
// never be locked out of its own EPOS by a bad plan value.

export function planCaps(plan) {
  const p = plan || 'pro';
  const lite = p.indexOf('lite') === 0;
  return {
    plan: p,
    isLite: lite,
    // Dine-in EPOS: Tables / Counter / Bar + the order & bill flow.
    dineIn: !lite,
    // Reservations screen + booking-widget settings.
    reservations: !lite || p === 'lite_booking' || p === 'lite_bundle',
    // Kitchen (KDS) — for lite, shows online orders only.
    kitchen: !lite || p === 'lite_ordering' || p === 'lite_bundle',
    // Full Admin vs the limited lite Admin.
    fullAdmin: !lite,
  };
}

// AdminScreen section ids a lite plan keeps. Pro sees every section.
// `reservations` (booking-widget settings) is added only for plans that
// actually take bookings — without it lite_booking can't be configured.
export function liteAdminSections(caps) {
  const ids = ['menu', 'customers', 'settings'];
  if (caps.reservations) ids.push('reservations');
  return ids;
}
