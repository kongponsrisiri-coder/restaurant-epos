// Single source of truth for how an order is labelled across the UI.
// Takeaway orders never live on a table, so "Table 5" headings for them
// confuse front-of-house and kitchen staff — we surface them as
// "Online Order #123" instead, with customer + pickup-time hints when
// available.

export function isTakeaway(order) {
  return order && order.order_type === 'takeaway';
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
export function orderShortLabel(order) {
  if (!order) return '—';
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return isDelivery(order)
      ? `🚗 Online Delivery #${id}`
      : `🥡 Online Order #${id}`;
  }
  return `Table ${order.table_number ?? '—'}`;
}

// Same but for plain-text contexts (receipts, alerts) — no emoji.
export function orderShortLabelPlain(order) {
  if (!order) return '—';
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return isDelivery(order)
      ? `Online Delivery #${id}`
      : `Online Order #${id}`;
  }
  return `Table ${order.table_number ?? '—'}`;
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
