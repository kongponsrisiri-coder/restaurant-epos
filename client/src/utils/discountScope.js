// SEPOS-DISCOUNT-SCOPE-001 — shared bill-discount maths for scoped discounts
// ('food' / 'drink' via categories.is_bar; null/'all' = whole bill). Single
// source for OrderScreen + BillScreen so the live summary, the pay screen,
// splits and the printed receipt all agree to the penny. Mirrors the server's
// billDiscountAmountFor() in src/server.js — change BOTH or totals drift.

export const inScope = (scope, isBar) => {
  if (scope === 'drink') return Number(isBar) === 1;
  if (scope === 'food')  return Number(isBar) !== 1;
  return true;
};

// Net £ of the items the discount applies to: non-voided, in-scope, AFTER
// per-item discounts (a scoped bill discount layers on the reduced price).
export function scopedBase(items, scope) {
  let base = 0;
  for (const i of items || []) {
    if (i.voided) continue;
    if (!inScope(scope, i.is_bar)) continue;
    let p = (Number(i.unit_price) || 0) * (Number(i.quantity) || 0);
    if (i.discount_value > 0) {
      p -= i.discount_type === 'percent' ? p * (Number(i.discount_value) / 100) : Math.min(Number(i.discount_value), p);
    }
    base += p;
  }
  return base;
}

// The bill discount in £. Percent recomputes live (items added later join the
// scope automatically); fixed £ caps at the scope's subtotal so a £10-off-
// drinks on £6 of drinks takes £6, never £10 off the food.
export function billDiscountAmount(order, items) {
  const v = Number(order?.discount_value || 0);
  if (!(v > 0)) return 0;
  const scope = order.discount_scope || 'all';
  const base = scopedBase(items, scope);
  return order.discount_type === 'percent' ? base * (v / 100) : Math.min(v, base);
}

// " (drinks)" / " (food)" suffix for the Discount line on screen + receipts.
export const scopeLabel = (scope) =>
  scope === 'drink' ? ' (drinks)' : scope === 'food' ? ' (food)' : '';
