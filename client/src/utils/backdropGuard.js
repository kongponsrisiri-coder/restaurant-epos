// SEPOS-GHOST-DISMISS-001 — ghost-click-proof backdrop dismissal.
//
// The touch keyboard's "Done" key collapses the keyboard, the page re-expands
// under the finger, and the SAME physical tap re-dispatches as a click at
// those coordinates — which is now the modal BACKDROP. A plain
// `onClick={close}` backdrop then throws the card away with everything typed
// in it (Fern on-site, 17 Aug: "I tap done on the keyboard and the card is
// gone without save"). Same ghost-tap family as the idle-overlay fix
// (canary finds #5/#8b).
//
// Rule: a backdrop dismiss must be a REAL backdrop tap — pressed AND released
// on the backdrop. Ghost clicks have no matching pointerdown on the backdrop
// (the press happened on the keyboard, outside the page), so they never arm.
import { useRef, useCallback } from 'react';

export function useBackdropDismiss(onClose) {
  const armed = useRef(false);
  const onPointerDown = useCallback((e) => {
    armed.current = e.target === e.currentTarget;
  }, []);
  const onClick = useCallback((e) => {
    if (armed.current && e.target === e.currentTarget) onClose(e);
    armed.current = false;
  }, [onClose]);
  return { onPointerDown, onClick };
}
