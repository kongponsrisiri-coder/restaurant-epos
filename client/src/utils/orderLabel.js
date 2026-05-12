// Single source of truth for how an order is labelled across the UI.
// Takeaway orders never live on a table, so "Table 5" headings for them
// confuse front-of-house and kitchen staff — we surface them as
// "Online Order #123" instead, with customer + pickup-time hints when
// available.

export function isTakeaway(order) {
  return order && order.order_type === 'takeaway';
}

// Short label — fits in a card title, kitchen ticket, etc.
//   takeaway → "🥡 Online Order #123"
//   dine-in  → "Table 5"
export function orderShortLabel(order) {
  if (!order) return '—';
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return `🥡 Online Order #${id}`;
  }
  return `Table ${order.table_number ?? '—'}`;
}

// Same but for plain-text contexts (receipts, alerts) — no emoji.
export function orderShortLabelPlain(order) {
  if (!order) return '—';
  if (isTakeaway(order)) {
    const id = order.id ?? order.order_id ?? '—';
    return `Online Order #${id}`;
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
      const pickup = new Date(order.pickup_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      bits.push(pickup);
    }
    return bits.join(' · ');
  }
  if (order.covers) return `${order.covers} cvr`;
  return '';
}
