// SEPOS-FLOOR-FIT — the "room" rectangle that BOTH the Table Plan editor and
// the Tables floor map render. One source of truth so the two screens always
// show the same picture: a table at the room's left wall in the editor sits at
// the left on the floor too (Korakot, 2026-08-05: centring just the cluster of
// tables made Bar 1 jump from the left edge to the middle — nonsense).
//
// The room starts at a sensible minimum and grows to hold whatever the
// operator lays out, with breathing space so there's always somewhere to drag.
export const ROOM_MIN_W = 1560;
export const ROOM_MIN_H = 940;
const GROW_PAD = 120;

export function roomSize(tables = [], walls = []) {
  let w = ROOM_MIN_W, h = ROOM_MIN_H;
  for (const t of tables) {
    w = Math.max(w, (t.pos_x ?? 40) + (t.width || 80) + GROW_PAD);
    h = Math.max(h, (t.pos_y ?? 40) + (t.height || 80) + GROW_PAD);
  }
  for (const wl of walls) {
    w = Math.max(w, (wl.pos_x || 0) + (wl.width || 12) + GROW_PAD);
    h = Math.max(h, (wl.pos_y || 0) + (wl.height || 100) + GROW_PAD);
  }
  return { w, h };
}
