'use strict';

// SEPOS-027 — table-aware reservation allocation. Pure, unit-tested functions.
//
// Model (flexible): every table is a seating unit on its own; every LINKED GROUP
// (a connected component of 2+ tables in table_combinations) is also a unit whose
// capacity is the sum of its members. A group and its member tables share the
// same physical tables, so using one makes the others unavailable.

// Build seating units from tables [{id, table_number, capacity}] + pairwise
// combinations [{table_id_a, table_id_b, is_active}].
function buildUnits(tables, combinations) {
  const cap = new Map(), num = new Map();
  for (const t of (tables || [])) {
    const id = Number(t.id);
    cap.set(id, Number(t.capacity) || 0);
    num.set(id, t.table_number != null ? String(t.table_number) : String(id));
  }
  // union-find for connected components (linked groups)
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const id of cap.keys()) parent.set(id, id);
  for (const c of (combinations || [])) {
    if (c.is_active === false) continue;
    const a = Number(c.table_id_a), b = Number(c.table_id_b);
    if (!cap.has(a) || !cap.has(b)) continue;
    parent.set(find(a), find(b));
  }
  const comp = new Map();
  for (const id of cap.keys()) { const r = find(id); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(id); }

  // rank drives seating preference: 0 = standalone table, 1 = a table that
  // belongs to a group (using it alone blocks that group), 2 = a joined group
  // (only worth using for a party too big for any single table). This keeps big
  // groups intact for big parties instead of fragmenting them on small ones.
  const inGroup = new Set();
  for (const ids of comp.values()) if (ids.length > 1) ids.forEach((id) => inGroup.add(id));

  const units = [];
  for (const id of cap.keys()) units.push({ tableIds: [id], capacity: cap.get(id), label: 'T' + num.get(id), rank: inGroup.has(id) ? 1 : 0 });
  for (const ids of comp.values()) {
    if (ids.length > 1) {
      const c = ids.reduce((s, id) => s + (cap.get(id) || 0), 0);
      const sorted = [...ids].sort((a, b) => a - b);
      units.push({ tableIds: sorted, capacity: c, label: sorted.map((i) => 'T' + num.get(i)).join('+'), rank: 2 });
    }
  }
  return units;
}

// Greedy best-fit seating of a set of bookings [{covers, tableIds?}].
// Largest parties first (hardest to seat); honour a pre-assignment whose tables
// are still free, else take the smallest free unit that fits. Returns
// { assign: Map(index -> unit), unseatable: index[] }.
function seatAll(units, bookings) {
  const order = bookings.map((b, i) => i).sort((i, j) => (bookings[j].covers || 0) - (bookings[i].covers || 0));
  const used = new Set();
  const assign = new Map();
  const unseatable = [];
  const isFree = (ids) => ids.every((t) => !used.has(t));
  const occupy = (ids) => ids.forEach((t) => used.add(t));
  for (const i of order) {
    const b = bookings[i];
    const pre = (b.tableIds || []).map(Number).filter(Boolean);
    if (pre.length && isFree(pre)) { occupy(pre); assign.set(i, { tableIds: pre, capacity: 0, label: pre.map((t) => 'T' + t).join('+') }); continue; }
    const cands = units
      .filter((u) => u.capacity >= (b.covers || 0) && isFree(u.tableIds))
      // standalone tables first, then group-member tables, then joined groups;
      // within a rank, best-fit (smallest capacity, then fewest tables).
      .sort((a, c) => (a.rank - c.rank) || (a.capacity - c.capacity) || (a.tableIds.length - c.tableIds.length));
    if (cands.length) { occupy(cands[0].tableIds); assign.set(i, cands[0]); }
    else unseatable.push(i);
  }
  return { assign, unseatable };
}

// Can a NEW party of `covers` be seated given the `existing` overlapping
// bookings? Returns { ok, tableIds, label, maxUnit }.
// maxUnit = largest single unit capacity (caller falls back to covers-based
// rules when covers > maxUnit, so an incomplete floor plan never over-rejects).
function canSeat(units, existing, covers) {
  const maxUnit = units.reduce((m, u) => Math.max(m, u.capacity), 0);
  const all = [...(existing || []), { covers }];
  const newIdx = all.length - 1;
  const { assign, unseatable } = seatAll(units, all);
  if (unseatable.includes(newIdx)) return { ok: false, maxUnit };
  const u = assign.get(newIdx);
  return { ok: true, tableIds: u.tableIds, label: u.label, maxUnit };
}

module.exports = { buildUnits, seatAll, canSeat };
