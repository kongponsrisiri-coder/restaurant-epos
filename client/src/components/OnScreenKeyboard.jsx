// SEPOS-OSK-001/002/003 — in-app on-screen keyboard for touch tills.
//
// On a Windows touch terminal (and Sunmi) Chromium/Electron does NOT auto-pop
// the OS touch keyboard when you tap a field, so a keyboard-less till couldn't
// type notes / names / search. Rather than rely on the fragile Windows TabTip,
// this renders our own keyboard that appears when a field is focused.
//
// SEPOS-OSK-003 (Korakot, 24 Aug — "the keyboard always missing"):
//   • 'auto' now ALSO enables on the desktop till app (window.siamepos.isElectron).
//     Many POS touchscreens present to the OS as a MOUSE, so maxTouchPoints
//     stays 0 and the old touch-only auto never fired — a touch till with no
//     keyboard had no way to type. A desktop till is a till; default it on.
//   • NUMBER fields get a numeric pad layer (they were excluded entirely, so
//     menu prices / Z counts / stock quantities were untypeable). Fields with
//     their own pad still opt out via inputMode='none' or data-no-osk.
//   • Thai layer (Kedmanee, with shift) — Yum Yum need Thai as the menu's
//     second language, typed on the till. 🌐 switches EN ⇄ ไทย, remembered
//     per device. Plus a ?123 symbols layer and an ⏎ Enter key (commits
//     table renames, search boxes, anything listening for Enter).
//
// Per-device 3-way mode in localStorage, set from Admin → Settings:
//   'off'  — never show (a till WITH a real keyboard)
//   'on'   — always show for text/number fields (a till with NO keyboard)
//   'auto' — touch devices OR the desktop till app (default)

import { useState, useEffect, useRef } from 'react';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const EN_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

// Thai Kedmanee — laid out on the same physical rows people know from a Thai
// keyboard (q→ๆ, a→ฟ, …), extended with the ;'[],./ characters so the common
// letters (ว ง บ ล ม ใ ฝ) are all reachable without shift.
const TH_ROWS = [
  // SEPOS-OSK-005 — the Kedmanee NUMBER row types LETTERS in Thai; it was
  // missing entirely, so ภ ถ ค ต จ ข ช and the ุ/ึ vowels could not be typed
  // at all (Korakot/Yum Yum). Exact physical key mapping, 12 keys.
  ['ๅ', '/', '-', 'ภ', 'ถ', 'ุ', 'ึ', 'ค', 'ต', 'จ', 'ข', 'ช'],
  ['ๆ', 'ไ', 'ำ', 'พ', 'ะ', 'ั', 'ี', 'ร', 'น', 'ย', 'บ', 'ล'],
  ['ฟ', 'ห', 'ก', 'ด', 'เ', '้', '่', 'า', 'ส', 'ว', 'ง'],
  ['ผ', 'ป', 'แ', 'อ', 'ิ', 'ื', 'ท', 'ม', 'ใ', 'ฝ'],
];
const TH_SHIFT_ROWS = [
  ['+', '๑', '๒', '๓', '๔', 'ู', '฿', '๕', '๖', '๗', '๘', '๙'],
  ['๐', '"', 'ฎ', 'ฑ', 'ธ', 'ํ', '๊', 'ณ', 'ฯ', 'ญ', 'ฐ', 'ฅ'],
  ['ฤ', 'ฆ', 'ฏ', 'โ', 'ฌ', '็', '๋', 'ษ', 'ศ', 'ซ', '.'],
  ['(', ')', 'ฉ', 'ฮ', 'ฺ', '์', '?', 'ฒ', 'ฬ', 'ฦ'],
];

const SYM_ROWS = [
  ['!', '@', '#', '£', '$', '%', '&', '*', '(', ')'],
  ['-', '_', '+', '=', '/', ':', ';', '"', "'"],
  [',', '.', '?', '~', '[', ']', '…'],
];

// What kind of keyboard does this field want?
//   'text'    — QWERTY / Thai / symbols
//   'decimal' — number pad with a . key   (money, quantities)
//   'numeric' — number pad, digits only
//   'tel'     — number pad with a + key   (phone numbers)
//   null      — no keyboard (PIN pads, amount pads, opted out, read-only)
function fieldKind(el) {
  if (!el || el.readOnly || el.disabled) return null;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
  if (el.dataset && el.dataset.noOsk != null) return null;
  const im = String(el.inputMode || '').toLowerCase();
  // SEPOS-AMOUNT-PAD-001 — money boxes carry their own numpad (inputMode='none');
  // never stack a keyboard on top of it.
  if (im === 'none') return null;
  if (tag === 'TEXTAREA') return 'text';
  if (im === 'decimal') return 'decimal';
  if (im === 'numeric') return 'numeric';
  if (im === 'tel') return 'tel';
  const t = String(el.type || 'text').toLowerCase();
  if (t === 'number') return 'decimal';   // legacy — swept to text+inputMode, but stay safe
  if (t === 'tel') return 'tel';
  // SEPOS-OSK-004 — password boxes fell through to null, so a keyboard-less
  // touchscreen could not type in them AT ALL (Yum Yum: the Add-Staff PIN box,
  // Back Office password, host sync-secret). Short ones are PINs → number pad;
  // anything longer gets the full keyboard.
  if (t === 'password') return (Number(el.maxLength) > 0 && Number(el.maxLength) <= 6) ? 'numeric' : 'text';
  return ['text', 'search', 'email', 'url', ''].includes(t) ? 'text' : null;
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
export function oskEnabled(mode, touchPoints, isDesktopTill) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return (touchPoints || 0) > 0 || !!isDesktopTill;   // 'auto'
}
function enabled() {
  try {
    return oskEnabled(oskMode(), navigator.maxTouchPoints, window.siamepos?.isElectron);
  } catch { return false; }
}

export default function OnScreenKeyboard() {
  const [kind, setKind] = useState(null);          // null = hidden
  const [shift, setShift] = useState(false);
  const [view, setView] = useState('abc');         // 'abc' | 'sym'
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem('osk_lang') === 'th' ? 'th' : 'en'; } catch { return 'en'; }
  });
  const targetRef = useRef(null);

  useEffect(() => {
    // Check enabled() per-focus (not once at mount) so the Settings toggle
    // takes effect without a page reload.
    const onFocusIn = (e) => {
      const k = enabled() ? fieldKind(e.target) : null;
      if (k) {
        targetRef.current = e.target;
        setKind(k); setShift(false); setView('abc');
        // The keyboard covers the bottom of the screen — bring the field up
        // if it would sit behind it. Best-effort; scroll containers vary.
        const el = e.target;
        setTimeout(() => {
          try {
            if (el === document.activeElement && el.getBoundingClientRect().bottom > window.innerHeight - 300) {
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          } catch {}
        }, 80);
      }
    };
    const onFocusOut = () => {
      // A key tap keeps the field focused (we preventDefault), so only hide
      // once focus truly leaves any keyboard-worthy field.
      setTimeout(() => {
        if (!fieldKind(document.activeElement)) { targetRef.current = null; setKind(null); }
      }, 120);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  if (!kind) return null;

  // Selection APIs throw on some input types — fall back to append-at-end.
  const insert = (ch) => {
    const el = targetRef.current; if (!el) return;
    const v = el.value ?? '';
    let s = v.length, e = v.length;
    try { if (el.selectionStart != null) { s = el.selectionStart; e = el.selectionEnd; } } catch {}
    setNativeValue(el, v.slice(0, s) + ch + v.slice(e));
    try { const p = s + ch.length; el.setSelectionRange(p, p); } catch {}
  };
  const backspace = () => {
    const el = targetRef.current; if (!el) return;
    const v = el.value ?? '';
    let s = v.length, e = v.length;
    try { if (el.selectionStart != null) { s = el.selectionStart; e = el.selectionEnd; } } catch {}
    if (s === e && s === 0) return;
    const from = s === e ? s - 1 : s;
    setNativeValue(el, v.slice(0, from) + v.slice(e));
    try { el.setSelectionRange(from, from); } catch {}
  };
  // Real Enter keydown/keyup so handlers listening for it (table-rename
  // commit, search boxes, "Enter saves the row") fire exactly as if typed.
  const pressEnter = () => {
    const el = targetRef.current; if (!el) return;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  };
  const done = () => { const el = targetRef.current; if (el) el.blur(); setKind(null); };
  const typed = (ch) => { insert(ch); if (shift) setShift(false); };
  const switchLang = () => {
    const next = lang === 'en' ? 'th' : 'en';
    setLang(next); setShift(false);
    try { localStorage.setItem('osk_lang', next); } catch {}
  };

  // pointerDown + preventDefault: acts on press AND stops the button stealing
  // focus from the input (so the caret stays put), for mouse and touch alike.
  const Key = ({ label, act, flex = 1, bg = '#fff', color = '#0f172a', fs = 18 }) => (
    <button
      onPointerDown={(ev) => { ev.preventDefault(); act(); }}
      style={{ flex, minWidth: 0, height: 46, margin: 3, borderRadius: 8, border: '1px solid #cbd5e1',
        background: bg, color, fontSize: fs, fontWeight: 600, cursor: 'pointer', touchAction: 'none' }}>
      {label}
    </button>
  );
  const row = { display: 'flex', justifyContent: 'center' };
  // Max-int z-index: the keyboard must sit above EVERY modal/popup — a modal
  // over the keyboard hides the very keys its focused field needs (found on
  // the Open-the-day float box, whose card covered the 7-8-9 row).
  const sheet = {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 2147483000,
    background: '#e2e8f0', padding: '6px 6px 10px', boxShadow: '0 -4px 24px rgba(0,0,0,0.25)',
  };

  // ── Number pad (decimal / numeric / tel fields) ──
  if (kind !== 'text') {
    const extra = kind === 'decimal' ? '.' : kind === 'tel' ? '+' : null;
    return (
      <div onPointerDown={(e) => e.preventDefault()} style={sheet}>
        <div style={{ maxWidth: 340, margin: '0 auto' }}>
          {[['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3']].map((r, i) => (
            <div key={i} style={row}>{r.map(c => <Key key={c} label={c} act={() => insert(c)} fs={20} />)}</div>
          ))}
          <div style={row}>
            {extra ? <Key label={extra} act={() => insert(extra)} fs={20} /> : <div style={{ flex: 1, margin: 3 }} />}
            <Key label="0" act={() => insert('0')} fs={20} />
            <Key label="⌫" act={backspace} bg="#cbd5e1" />
          </div>
          <div style={row}>
            <Key label="⏎" act={pressEnter} bg="#cbd5e1" />
            <Key label="Done" act={done} flex={2} bg="#16a34a" color="#fff" fs={16} />
          </div>
        </div>
      </div>
    );
  }

  // ── Text keyboard: EN / TH / symbols ──
  const letters = view === 'sym' ? SYM_ROWS : lang === 'th' ? (shift ? TH_SHIFT_ROWS : TH_ROWS) : EN_ROWS;
  const cap = (c) => (view === 'sym' || lang === 'th') ? c : (shift ? c.toUpperCase() : c);

  return (
    <div onPointerDown={(e) => e.preventDefault()} style={sheet}>
      <div style={row}>{DIGITS.map(c => <Key key={c} label={c} act={() => insert(c)} />)}</div>
      {letters.slice(0, -1).map((r, i) => (
        <div key={i} style={row}>{r.map(c => <Key key={c} label={cap(c)} act={() => typed(cap(c))} />)}</div>
      ))}
      <div style={row}>
        {view !== 'sym'
          ? <Key label="⇧" act={() => setShift(s => !s)} flex={1.5} bg={shift ? '#0D1B3E' : '#cbd5e1'} color={shift ? '#fff' : '#0f172a'} />
          : <div style={{ flex: 1.5, margin: 3 }} />}
        {letters[letters.length - 1].map(c => <Key key={c} label={cap(c)} act={() => typed(cap(c))} />)}
        <Key label="⌫" act={backspace} flex={1.5} bg="#cbd5e1" />
      </div>
      <div style={row}>
        <Key label={view === 'sym' ? 'ABC' : '?123'} act={() => { setView(v => v === 'sym' ? 'abc' : 'sym'); setShift(false); }} flex={1.5} bg="#cbd5e1" fs={14} />
        <Key label={lang === 'en' ? '🌐 ไทย' : '🌐 EN'} act={switchLang} flex={1.5} bg="#cbd5e1" fs={13} />
        <Key label="space" act={() => insert(' ')} flex={4} fs={14} />
        <Key label="⏎" act={pressEnter} flex={1.2} bg="#cbd5e1" />
        <Key label="Done" act={done} flex={1.8} bg="#16a34a" color="#fff" fs={15} />
      </div>
    </div>
  );
}
