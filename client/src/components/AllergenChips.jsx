// SEPOS — small colour-coded allergen badges for menu item buttons.
//
// Renders the UK14 letter codes (Gl, Nt, Mi, etc.) as tiny pills along
// the bottom of a menu item button so the waiter can tell a customer
// "this dish contains nuts" without opening the item detail. Required
// by UK Natasha's Law — staff must be able to answer allergen questions
// without leaving the table.

const PILL_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 22,
  height: 18,
  padding: '0 6px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.3,
  color: 'white',
  whiteSpace: 'nowrap',
  lineHeight: 1,
};

/**
 * @param {object[]} list — UK14 entries from `parseAllergens(...)`
 * @param {number}   max  — cap visible chips before "+N" overflow
 */
export default function AllergenChips({ list = [], max = 5 }) {
  if (!list || list.length === 0) return null;

  const visible  = list.slice(0, max);
  const overflow = Math.max(0, list.length - max);
  const fullText = list.map(a => a.name).join(', ');

  return (
    <div
      title={fullText}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 6,
      }}
    >
      {visible.map(a => (
        <span key={a.code} style={{ ...PILL_BASE, background: a.colour }} title={a.name}>
          {a.code}
        </span>
      ))}
      {overflow > 0 && (
        <span style={{ ...PILL_BASE, background: '#6b7280' }} title={fullText}>
          +{overflow}
        </span>
      )}
    </div>
  );
}
