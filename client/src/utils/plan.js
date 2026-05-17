// SEPOS-LITE-002 — plan feature gating.
// Single source of truth for what each subscription tier unlocks.
//
//   lite_booking  — Reservations + table plan/setup, Customers, Campaigns, Embed codes
//   lite_ordering — Orders + Kitchen, Customers, Campaigns, Embed codes
//   lite_bundle   — booking + ordering combined
//   pro           — everything, incl. dine-in EPOS (billing, staff, Z-report, inventory)
//
// An unknown / missing plan falls back to 'pro' — a Pro install must
// never be locked out of its own EPOS by a bad plan value.

const KNOWN = ['lite_booking', 'lite_ordering', 'lite_bundle', 'pro'];

export function normalisePlan(plan) {
  return KNOWN.includes(plan) ? plan : 'pro';
}

export function planLabel(plan) {
  return {
    lite_booking:  'Lite Booking',
    lite_ordering: 'Lite Ordering',
    lite_bundle:   'Lite Bundle',
    pro:           'Pro',
  }[normalisePlan(plan)];
}

// Reservations — also unlocks the table plan / floor map / table setup,
// because a booking restaurant needs the floor to seat its reservations.
export function canAccessReservations(plan) {
  const p = normalisePlan(plan);
  return p === 'pro' || p === 'lite_booking' || p === 'lite_bundle';
}

// Kitchen (KDS).
export function canAccessKitchen(plan) {
  const p = normalisePlan(plan);
  return p === 'pro' || p === 'lite_ordering' || p === 'lite_bundle';
}

// Online takeaway / delivery orders — same tiers as the kitchen.
export function canAccessOrders(plan) {
  return canAccessKitchen(plan);
}

// Full dine-in EPOS: table ordering + billing, Counter, Bar, staff
// management, Z-report, inventory, full reports. Pro only.
export function canAccessFullEPOS(plan) {
  return normalisePlan(plan) === 'pro';
}

// Admin section -> the capability check it needs. Sections not listed
// are open to every plan (Menu, Settings, Customers, Campaigns, Allergens).
const ADMIN_SECTION_GATE = {
  trading:      canAccessFullEPOS,
  tableplan:    canAccessReservations,
  reservations: canAccessReservations,
  reports:      canAccessFullEPOS,
  bills:        canAccessFullEPOS,
  zreport:      canAccessFullEPOS,
  staff:        canAccessFullEPOS,
  clock:        canAccessFullEPOS,
  performance:  canAccessFullEPOS,
  vat:          canAccessFullEPOS,
  inventory:    canAccessFullEPOS,
};

export function canAccessAdminSection(plan, sectionId) {
  const gate = ADMIN_SECTION_GATE[sectionId];
  return gate ? gate(plan) : true;
}
