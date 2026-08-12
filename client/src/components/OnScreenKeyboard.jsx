// SEPOS-OSK-001 — in-app on-screen keyboard for touch tills.
//
// On a Windows touch terminal (and Sunmi) Chromium/Electron does NOT auto-pop
// the OS touch keyboard when you tap a field, so a keyboard-less till couldn't
// type notes / names / search. Rather than rely on the fragile Windows TabTip,
// this renders our own keyboard that appears when a TEXT field is focused.
//
// Deliberately NOT shown for numeric / PIN / password fields — those have their
// own on-screen pads, and popping a QWERTY over them would be wrong. Per-device:
// auto-on for touch devices, and switch off with localStorage.onscreen_keyboard='0'
// (there's a toggle in Admin → Settings).

import { useState, useEffect, useRef } from 'react';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

// Only genuine TEXT fields — never numeric/PIN pads (they have their own).
function isTextField(el) {
  if (!el || el.readOnly || el.disabled) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el.dataset && el.dataset.noOsk != null);
  if (tag !== 'INPUT') return false;
  if (el.dataset && el.dataset.noOsk != null) return false;
  if (String(el.inputMode || '').toLowerCase() === 'numeric') return false;
  // SEPOS-AMOUNT-PAD-001 — money boxes carry their own numpad (inputMode='none');
  // never stack the text keyboard on top of it.
  if (String(el.inputMode || '').toLowerCase() === 'none') return false;
  const t = String(el.type || 'text').toLowerCase();
  return ['text', 'search', 'email', 'tel', 'url', ''].includes(t);
}

// Write into a React-controlled input so its onChange fires (React overrides
// the value setter, so we must call the native setter then dispatch 'input').
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// SEPOS-OSK-002 (Korakot, 2026-08-08) — the keyboard existed but had NO control
// surface, and auto-detection is touch-only, so on a keyboard-less till that
// doesn't report touch (many Windows POS terminals, or a laptop under test) it
// never appeared. Per-device 3-way mode in localStorage, set from Admin →
// Settings:
//   'off'  — never show (a till WITH a real keyboard)
//   'on'   — always show for text fields (a till with NO keyboard)
//   'auto' — show on touch devices only (default; the old behaviour)
// Exported so the mode logic can be unit-tested without a DOM.
export function oskMode() {
  try {
    const m = localStorage.getItem('onscreen_keyboard_mode');
    if (m === 'off' || m === 'on' || m === 'auto') return m;
    // migrate the old boolean key: '0' meant off, anything else meant auto.
    if (localStorage.getItem('onscreen_keyboard') === '0') return 'off';
    return 'auto';
  } catch { return 'auto'; }
}
export function oskEnabled(mode, touchPoints) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return (touchPoints || 0) > 0;   // 'auto'
}
function enabled() {
  try { return oskEnabled(oskMode(), navigator.maxTouchPoints); } catch { return false; }
}

export default function OnScreenKeyboard() {
  const [visible, setVisible] = useState(false);
  const [shift, setShift] = useState(false);
  const targetRef = useRef(null);

  useEffect(() => {
    // Check enabled() per-focus (not once at mount) so the Settings toggle
    // takes effect without a page reload.
    const onFocusIn = (e) => {
      if (enabled() && isTextField(e.target)) { targetRef.current = e.target; setVisible(true); }
    };
    const onFocusOut = () => {
      // A key tap keeps the field focused (we preventDefault), so only hide
      // once focus truly leaves any text field.
      setTimeout(() => {
        if (!isTextField(document.activeElement)) { targetRef.current = null; setVisible(false); }
      }, 120);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  if (!visible) return null;

  const insert = (ch) => {
    const el = targetRef.current; if (!el) return;
    const v = el.value ?? '';
    const s = el.selectionStart ?? v.length;
    const e = el.selectionEnd ?? v.length;
    setNativeValue(el, v.slice(0, s) + ch + v.slice(e));
    try { const p = s + ch.length; el.setSelectionRange(p, p); } catch {}
  };
  const backspace = () => {
    const el = targetRef.current; if (!el) return;
    const v = el.value ?? '';
    const s = el.selectionStart ?? v.length;
    const e = el.selectionEnd ?? v.length;
    if (s === e && s === 0) return;
    const from = s === e ? s - 1 : s;
    setNativeValue(el, v.slice(0, from) + v.slice(e));
    try { el.setSelectionRange(from, from); } catch {}
  };
  const done = () => { const el = targetRef.current; if (el) el.blur(); setVisible(false); };

  // pointerDown + preventDefault: acts on press AND stops the button stealing
  // focus from the input (so the caret stays put), for mouse and touch alike.
  const Key = ({ label, act, flex = 1, bg = '#fff', color = '#0f172a' }) => (
    <button
      onPointerDown={(ev) => { ev.preventDefault(); act(); }}
      style={{ flex, minWidth: 0, height: 48, margin: 3, borderRadius: 8, border: '1px solid #cbd5e1',
        background: bg, color, fontSize: 18, fontWeight: 600, cursor: 'pointer', touchAction: 'none' }}>
      {label}
    </button>
  );

  const row = { display: 'flex', justifyContent: 'center' };

  return (
    <div onPointerDown={(e) => e.preventDefault()}
      style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100000,
        background: '#e2e8f0', padding: '6px 6px 10px', boxShadow: '0 -4px 24px rgba(0,0,0,0.25)' }}>
      <div style={row}>{ROWS[0].map(c => <Key key={c} label={c} act={() => insert(c)} />)}</div>
      <div style={row}>{ROWS[1].map(c => <Key key={c} label={shift ? c.toUpperCase() : c} act={() => { insert(shift ? c.toUpperCase() : c); if (shift) setShift(false); }} />)}</div>
      <div style={row}>{ROWS[2].map(c => <Key key={c} label={shift ? c.toUpperCase() : c} act={() => { insert(shift ? c.toUpperCase() : c); if (shift) setShift(false); }} />)}</div>
      <div style={row}>
        <Key label="⇧" act={() => setShift(s => !s)} flex={1.5} bg={shift ? '#0D1B3E' : '#cbd5e1'} color={shift ? '#fff' : '#0f172a'} />
        {ROWS[3].map(c => <Key key={c} label={shift ? c.toUpperCase() : c} act={() => { insert(shift ? c.toUpperCase() : c); if (shift) setShift(false); }} />)}
        <Key label="⌫" act={backspace} flex={1.5} bg="#cbd5e1" />
      </div>
      <div style={row}>
        <Key label="@" act={() => insert('@')} />
        <Key label="." act={() => insert('.')} />
        <Key label="-" act={() => insert('-')} />
        <Key label="space" act={() => insert(' ')} flex={5} />
        <Key label="'" act={() => insert("'")} />
        <Key label="Done" act={done} flex={2} bg="#16a34a" color="#fff" />
      </div>
    </div>
  );
}
