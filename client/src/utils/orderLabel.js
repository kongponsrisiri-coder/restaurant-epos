// Single source of truth for how an order is labelled across the UI.
// Takeaway orders never live on a table, so "Table 5" headings for them
// confuse front-of-house and kitchen staff — we surface them as
// "Online Order #123" instead, with customer + pickup-time hints when
// available.

export function isTakeaway(order) {
  return order && order.order_type === 'takeaway';
}

// SEPOS-TAKEAWAY-TABLE — a takeaway order rung up at the till sits on a
// takeaway "table", so it carries a table_number. Website orders are
// tableless. We use the presence of a table number to tell the two apart
// and label the walk-in one "Takeaway {n}" instead of "Online Order #id".
export function isTakeawayTable(order) {
  return isTakeaway(order) && order.table_number != null && order.table_number !== '';
}

// SEPOS-DELIVERY-002 — a takeaway order is either collection (default)
// or delivery. Delivery orders get the 🚗 treatment so the kitchen +
// expo bag them differently and know a courier/driver is involved.
export function isDelivery(order) {
  return isTakeaway(order) && order.order_subtype === 'delivery';
}

// Short label — fits in a card title, kitchen ticket, etc.
//   delivery → "🚗 Online Delivery #123"
//   takeaway → "🥡 Online Order #123"
//   dine-in  → "Table 5"
// SEPOS-QR-ORDER-001 follow-up — tables can carry a NAME ("Bar 3") whose
// internal number differs (Bar 3 = table_number 9). Prefer the name whenever
// the payload carries it; numeric fallback identical to before.
function dineInLabel(order) {
  const label = order.table_label && String(order.table_label).trim();
  return label || `Table ${order.table_number ?? '—'}`;
}

// Exported for screens that show a table heading on an ORDER row (OrderScreen,
// Bills, Reports, Z…). Every surface must use this instead of building
// `Table ${order.table_number}` by hand — that's how "Bar 2" leaks as
// "Table 2" (the 2026-08-07 sweep). For a TABLE object use tableLabel(t).
export function dineTableLabel(order) {
  return dineInLabel(order || {});
}

export function orderShortLabel(order) {
  if (!order) return '—';
  if (isTakeawayTable(order)) return `🥡 Takeaway ${order.table_number}`;
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return isDelivery(order)
      ? `🚗 Online Delivery #${id}`
      : `🥡 Online Order #${id}`;
  }
  // SEPOS-QR-ORDER-001 — customer placed it themselves from the table QR;
  // the 📱 tells staff nobody keyed it (and that it's already PAID).
  if (order.source === 'qr') return `📱 ${dineInLabel(order)}`;
  return dineInLabel(order);
}

// Same but for plain-text contexts (receipts, alerts) — no emoji.
export function orderShortLabelPlain(order) {
  if (!order) return '—';
  if (isTakeawayTable(order)) return `Takeaway ${order.table_number}`;
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return isDelivery(order)
      ? `Online Delivery #${id}`
      : `Online Order #${id}`;
  }
  return dineInLabel(order);
}

// Returns a secondary string with covers (dine-in) or customer + pickup
// (takeaway). Caller decides how to render — separator, font, etc.
export function orderSubLabel(order) {
  if (!order) return '';
  if (isTakeaway(order)) {
    const bits = [];
    if (order.customer_name) bits.push(order.customer_name);
    if (order.pickup_time) {
      // Pin display to UK time — server stores pickup_time as UTC ISO,
      // and we want a UK-running kitchen to see UK hours regardless of
      // the iPad's region setting.
      const pickup = new Date(order.pickup_time).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
      });
      bits.push(pickup);
    }
    // SEPOS-DELIVERY-002 — surface the delivery address so the kitchen
    // knows where it's going (and whoever dispatches has it to hand).
    if (isDelivery(order) && order.delivery_address) {
      bits.push(`📍 ${order.delivery_address}`);
    }
    return bits.join(' · ');
  }
  if (order.covers) return `${order.covers} cvr`;
  return '';
}

// SEPOS-TABLE-NAME — what to print on a table block. Tables can carry a text
// label ("Bar 1") in `name`; the server materialises "Table {n}" as a fallback
// for unnamed tables, so only a name that ISN'T that auto pattern counts as a
// custom label. Falls back to the number.
export function tableLabel(t) {
  const name = (t?.name || '').trim();
  if (name && !/^Table\s+\d+$/i.test(name)) return name;
  return t?.table_number;
}
