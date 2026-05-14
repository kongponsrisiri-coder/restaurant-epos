// SEPOS — UK statutory 14 allergens.
// Shared between the order screen (chip badges on menu buttons) and the
// admin allergen editor (full names + colour reference). Keeping the
// mapping in one place avoids the code/name divergence between screens.
//
// The chip colours below were chosen to be distinct at a glance on a
// busy menu grid without leaning on red — red is reserved for "in cart"
// borders and the cancel UI.

export const UK14 = [
  { code: 'Ce', name: 'Celery',      colour: '#84cc16' },
  { code: 'Gl', name: 'Gluten',      colour: '#d97706' },
  { code: 'Cr', name: 'Crustaceans', colour: '#0891b2' },
  { code: 'Eg', name: 'Eggs',        colour: '#facc15' },
  { code: 'Fi', name: 'Fish',        colour: '#0ea5e9' },
  { code: 'Lu', name: 'Lupin',       colour: '#a3a3a3' },
  { code: 'Mi', name: 'Milk',        colour: '#3b82f6' },
  { code: 'Mo', name: 'Molluscs',    colour: '#1e3a8a' },
  { code: 'Mu', name: 'Mustard',     colour: '#ca8a04' },
  { code: 'Pn', name: 'Peanuts',     colour: '#b91c1c' },
  { code: 'Se', name: 'Sesame',      colour: '#f59e0b' },
  { code: 'So', name: 'Soybeans',    colour: '#65a30d' },
  { code: 'Su', name: 'Sulphites',   colour: '#7c3aed' },
  { code: 'Nt', name: 'Tree Nuts',   colour: '#92400e' },
];

const byName = new Map(UK14.map(a => [a.name.toLowerCase(), a]));
const byCode = new Map(UK14.map(a => [a.code.toLowerCase(), a]));

/**
 * Normalise an arbitrary allergen string to a UK14 entry.
 *
 * Handles plain names ("milk"), codes ("Mi"), and the looser inputs the
 * AI scanner sometimes produces ("contains milk", "Dairy", "MILK").
 * Returns null for unknown allergens (e.g. "lactose intolerance") so
 * we never render a chip we can't colour-code.
 */
export function normaliseAllergen(raw) {
  if (!raw) return null;
  const n = String(raw).toLowerCase().trim();
  if (byName.has(n)) return byName.get(n);
  if (byCode.has(n)) return byCode.get(n);
  // Loose match — substring on the full name. Lets "tree nuts" find
  // "Tree Nuts" and "wheat (gluten)" find "Gluten".
  for (const a of UK14) {
    if (n.includes(a.name.toLowerCase())) return a;
  }
  // "Dairy" → Milk is the most common alias the AI returns.
  if (n.includes('dairy')) return byName.get('milk');
  if (n.includes('nut'))   return byName.get('tree nuts');
  return null;
}

/**
 * Parse the JSON-string allergen column into an ordered, de-duplicated
 * array of UK14 entries. Defensive — handles already-array values,
 * malformed JSON, and unknown allergen strings (which are dropped).
 */
export function parseAllergens(raw) {
  if (!raw) return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const a = normaliseAllergen(item);
    if (a && !seen.has(a.code)) { out.push(a); seen.add(a.code); }
  }
  return out;
}
