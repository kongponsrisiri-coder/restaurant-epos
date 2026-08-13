import { useState, useEffect, useMemo, useRef } from 'react';
import { getMenu, getOrder, addOrderItems, payOrder, getItemModifiers, voidItem, applyDiscount, fireCourse, resendToKitchen, applyItemDiscount, loginStaff, removeVoucherFromBill, closeOrderZero, setOrderServiceCharge, assertOk, getSettings, SERVER_URL, updateMenuItemsSortOrder, saveOrderNote, getVoucher, redeemVoucher, getOrderDeposit, getOrderDepositApplied, createDeposit } from '../api';
import AmountInput from '../components/AmountInput';
import { unapplyOrderDeposit } from '../api';
import CodeScanButton from '../components/CodeScanButton';

// SEPOS-MENU-COLOR-001 — auto black/white text on a coloured button.
const textOn = (hex) => {
  try {
    const n = hex.replace('#', '');
    const L = parseInt(n.substr(0,2),16)*0.299 + parseInt(n.substr(2,2),16)*0.587 + parseInt(n.substr(4,2),16)*0.114;
    return L > 150 ? '#1a1a2e' : '#ffffff';
  } catch { return '#1a1a2e'; }
};

import BillScreen from './BillScreen';
import { printKitchenTicket, printFullOrderTicket, printBarOrderTicket, printFireNoticeTicket } from './KitchenTicket';
import { isNativeApp } from '../native/printer';
// SEPOS — DeleteOrderModal removed from OrderScreen 2026-06-01 (Korakot's
// call). Order screen / kitchen screen no longer expose a delete button;
// closed-bill delete still lives in Admin → Bills for managers.
import KitchenMessageModal from '../components/KitchenMessageModal';
import { confirm } from '../utils/confirm';
import { dineTableLabel } from '../utils/orderLabel';
import { billDiscountAmount, scopeLabel } from '../utils/discountScope';
import AllergenChips from '../components/AllergenChips';
import { parseAllergens } from '../utils/allergens';

const COURSE_LABELS = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };
const COURSE_COLORS = { 1: '#3b82f6', 2: '#e94560', 3: '#8b5cf6', 4: '#22c55e' };

// SEPOS-046z — temp ids for optimistic rows (sendOrder pending rows, void
// ghosts). Strictly monotonic so two events in the same millisecond can
// never collide — bare -Date.now() could.
let tempSeq = 0;
const nextTempId = () => { tempSeq += 1; return -(Date.now() + tempSeq); };

export default function OrderScreen({ orderId, tableId, staff, onClose, onSent }) {
  const [menu, setMenu] = useState([]);
  // SEPOS-TILL-LOCK-001 — full-screen "✓ sent" flash before returning to the
  // PIN screen. Only ever used when App passes onSent (Till Security setting on).
  const [sentFlash, setSentFlash] = useState(false);
  // SEPOS allergens — dish_allergens overrides keyed by menu_item_id.
  // Loaded once on mount; merged with menu_items.allergens at render time.
  const [allergenOverrides, setAllergenOverrides] = useState({});
  const [order, setOrder] = useState(null);
  // Cart persists in localStorage so un-sent items aren't lost when the waiter
  // leaves the table without sending — they're restored on return. Keyed by
  // order id when one exists; for a BRAND-NEW table (no order created until the
  // first Send) there is no order id yet, so we key by TABLE id — otherwise the
  // items a waiter tapped on a fresh table vanished the moment they navigated
  // away (Korakot 2026-08-08: "sometimes you have to go to another page… the
  // order the staff took will be gone"). Cleared on a successful Send.
  const cartKey = orderId
    ? `sepos_cart_${orderId}`
    : (tableId ? `sepos_cart_table_${tableId}` : null);
  const [cart, setCart] = useState(() => {
    try { const raw = cartKey && localStorage.getItem(cartKey); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  });
  const [activeCategory, setActiveCategory] = useState(null);
  const [activeSubcat, setActiveSubcat] = useState(null);
  const [search, setSearch] = useState('');   // menu search box (whole-menu filter)
  // SEPOS-ORDER-ARRANGE — on-screen menu reorder (manager-gated, drag & drop)
  const [arrangeMode, setArrangeMode]   = useState(false);
  const [arrangeItems, setArrangeItems] = useState([]);
  const [arrangeDrag, setArrangeDrag]   = useState(null);
  const [arrangePin, setArrangePin]     = useState(null); // null=closed, {pin,err,busy}=open
  const [arrangeSaving, setArrangeSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modifierPopup, setModifierPopup] = useState(null);
  const [showKitchenMsg, setShowKitchenMsg] = useState(false); // SEPOS-KITCHEN-MSG-001
  const [selectedModifiers, setSelectedModifiers] = useState({});
  const [notePopup, setNotePopup] = useState(null);
  const [miscPopup, setMiscPopup] = useState(null); // SEPOS-MISC-001 — off-menu / special open item
  const [voidPopup, setVoidPopup] = useState(null);
  const [resendPopup, setResendPopup] = useState(null);
  const [showBill, setShowBill] = useState(false);
  // SEPOS-046z — React modal for discounts. The old flow used
  // window.prompt(), which is disabled in Electron, so discounts
  // silently did nothing on desktop installs.
  // { scope: 'item'|'bill', item?, type: 'percent'|'fixed', value, reason? }
  const [discountPopup, setDiscountPopup] = useState(null);
  // SEPOS-DEPOSIT-ORDER-001 — apply a booking deposit right on the order screen
  // (redeem-on-tap, model A). depositApplied = { amount, code } already redeemed.
  const [depositPopup, setDepositPopup]   = useState(null); // { code, amount } modal
  const [depositApplied, setDepositApplied] = useState({ amount: 0, code: null });
  const [depositBusy, setDepositBusy]     = useState(false);
  const [serviceChargeRemoved, setServiceChargeRemoved] = useState(false);
  const [settings, setSettings] = useState({}); // for the configured service-charge rate
  const [activeCourse, setActiveCourse] = useState(1);
  const [firingCourse, setFiringCourse] = useState(null);

  // ── Sandy: Mobile layout state ──
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mobileTab, setMobileTab] = useState('menu');

  // SEPOS-046z — sendBusy: true while a sendOrder POST is in flight.
  // Pay / Close-at-£0 / Back-cancel are gated on it (~300ms) so an order
  // can't be paid or closed before the items it shows have landed.
  const [sendBusy, setSendBusy] = useState(false);
  // Sequence guard: several background fetchOrder reconciles can be in
  // flight at once; only the latest response may win, or an older snapshot
  // would overwrite newer optimistic state.
  const fetchSeqRef = useRef(0);

  // Persist the un-sent cart per order so it survives leaving the table and
  // coming back (was lost on unmount). Cleared automatically once the cart
  // empties — i.e. after a successful Send.
  useEffect(() => {
    if (!cartKey) return;
    try {
      if (cart.length) localStorage.setItem(cartKey, JSON.stringify(cart));
      else localStorage.removeItem(cartKey);
    } catch {}
  }, [cart, cartKey]);
  const fetchOrder = async () => {
    const seq = ++fetchSeqRef.current;
    const orderData = await getOrder(orderId);
    if (seq === fetchSeqRef.current) setOrder(orderData);
  };

  // SEPOS-DEPOSIT-ORDER-001 — reload any deposit already redeemed against this
  // order, so it persists across navigation and shows on the summary + bill.
  const fetchDepositApplied = async () => {
    if (!orderId) { setDepositApplied({ amount: 0, code: null }); return; }
    try {
      const r = await getOrderDepositApplied(orderId);
      setDepositApplied({ amount: Number(r?.applied || 0), code: r?.code || null });
    } catch { /* keep whatever we have */ }
  };
  useEffect(() => { fetchDepositApplied(); }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // SEPOS-DEPOSIT-ORDER-001 — open the deposit modal (permission-gated).
  const openDepositModal = async () => {
    const allowedRoles = ['admin', 'manager', 'supervisor'];
    if (!allowedRoles.includes(staff?.role) && !staff?.can_redeem_deposit) {
      alert('⛔ You don\'t have permission to redeem deposits.\n\nA manager can enable it for you in Admin → Staff → "Can redeem deposit".');
      return;
    }
    if (!orderId) { alert('Send the order first, then apply the deposit.'); return; }
    // Auto-suggest a deposit linked to this table's booking, if any.
    let suggested = { code: '', amount: '' };
    try { const d = await getOrderDeposit(orderId); if (d?.deposit) suggested = { code: d.deposit.code, amount: String(d.deposit.balance) }; } catch { /* none */ }
    setDepositPopup(suggested);
  };

  // SEPOS-DEPOSIT-ORDER-001 — redeem the deposit NOW (model A). Reuses the
  // hardened voucher redeem path; the deposit reduces the balance due.
  const confirmDeposit = async () => {
    if (!depositPopup || depositBusy) return;
    const code = (depositPopup.code || '').trim().toUpperCase();
    const amt = parseFloat(depositPopup.amount);
    if (!code) { alert('Enter or scan the deposit code.'); return; }
    if (!(amt > 0)) { alert('Enter the deposit amount.'); return; }
    setDepositBusy(true);
    try {
      // Must be a real deposit voucher (a gift code is bounced).
      let v = null; try { v = await getVoucher(code); } catch { v = null; }
      if (!v || v.error || v.status !== 'active' || !(Number(v.balance) > 0)) {
        // SEPOS-DEPOSIT-EXT-001 — external bypass, same philosophy as the pay
        // screen: a deposit taken outside SiamEPOS (old system, phone, paper)
        // is still real money the customer paid. Record it as a deposit and
        // apply it, instead of telling staff "invalid" in front of the guest.
        const ok = await confirm(`"${code}" isn't in the system.\n\nRecord it as an external deposit of £${amt.toFixed(2)} and apply it to this bill?`);
        if (!ok) { setDepositBusy(false); return; }
        const remainingX = Math.max(0, orderTotal - (depositApplied.amount || 0));
        const extAmt = remainingX > 0 ? Math.min(amt, remainingX) : amt; // F2 cap
        const created = await createDeposit({ amount: extAmt, payment_method: 'external', code, customer_name: `External deposit (ref ${code})` });
        if (!created || created.error || !created.code) { alert('Could not record the external deposit: ' + (created?.error || 'unknown')); setDepositBusy(false); return; }
        const r2 = await redeemVoucher(created.code, extAmt, orderId, staff?.id ?? null);
        if (r2 && r2.error) { alert('Recorded but could not apply: ' + r2.error); setDepositBusy(false); return; }
        setDepositPopup(null); await fetchDepositApplied(); setDepositBusy(false); return;
      }
      if (v.type !== 'deposit') { alert('That\'s a gift voucher, not a booking deposit — take it as a Voucher on the pay screen.'); setDepositBusy(false); return; }
      // F2 — never redeem past what's owed: cap at the bill remaining so a
      // £20 deposit on an £18.40 bill leaves £1.60 ON the deposit, and the
      // bill lands at exactly zero (closable via the deposit tender below).
      const remaining = Math.max(0, orderTotal - (depositApplied.amount || 0));
      const use = Math.min(Number(v.balance), amt, remaining > 0 ? remaining : amt);
      const r = await redeemVoucher(code, use, orderId, staff?.id ?? null);
      if (r && r.error) { alert('Could not apply deposit: ' + r.error); setDepositBusy(false); return; }
      setDepositPopup(null);
      await fetchDepositApplied();
    } catch (e) {
      alert('Could not apply deposit: ' + (e?.message || 'unknown'));
    } finally { setDepositBusy(false); }
  };

  // SEPOS — toggle + PERSIST the per-order service-charge removal. Optimistic:
  // flip local state immediately, then write the flag so the Bill / receipt /
  // splits honour it (previously this was local-only and the Bill re-added SC).
  // If there's no order id yet (brand-new unsent order), we skip the write —
  // the item send creates the order, and the persisted flag then rides the
  // useEffect hydrate on the next fetchOrder / snapshot.
  const toggleServiceCharge = () => {
    const next = !serviceChargeRemoved;
    setServiceChargeRemoved(next);                              // optimistic
    setOrder(prev => prev ? { ...prev, no_service_charge: next ? 1 : 0 } : prev);
    if (!orderId) return;                                       // no id yet — persisted once it exists
    setOrderServiceCharge(orderId, next).catch(() => {
      // Roll back the toggle if the write failed so the Order screen doesn't
      // lie about what the Bill will charge.
      setServiceChargeRemoved(!next);
      setOrder(prev => prev ? { ...prev, no_service_charge: !next ? 1 : 0 } : prev);
    });
  };

  // Load settings once for the configured service-charge rate (the running
  // total below previously hard-coded 12.5%, so any client on a different rate
  // — or with service charge disabled — saw a wrong "View Bill & Pay" amount).
  useEffect(() => {
    getSettings().then((s) => { if (s && typeof s === 'object' && !s.error) setSettings(s); }).catch(() => {});
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [menuData, orderData, dishAllergens] = await Promise.all([
          getMenu(),
          getOrder(orderId),
          // Manual allergen overrides set on the admin Allergen screen.
          // Soft-fail — if the endpoint isn't reachable we just fall back
          // to menu_items.allergens (AI scanner output) on each item.
          fetch(`${SERVER_URL}/api/dish-allergens`).then(r => r.ok ? r.json() : []).catch(() => []),
        ]);
        setMenu(menuData);
        setOrder(orderData);
        const map = {};
        (Array.isArray(dishAllergens) ? dishAllergens : []).forEach(row => {
          map[row.menu_item_id] = row.allergens;  // JSON string
        });
        setAllergenOverrides(map);
        if (menuData.length > 0) {
          const first = menuData[0];
          setActiveCategory(first.id);
          setActiveCourse(first.default_course || 1);
          // Auto-select the first sub-cat tab (or "General" for un-filed items)
          // so the initial category shows dishes immediately, matching taps.
          const subs = first.subcategories || [];
          if (subs.length) {
            const hasNone = (first.items || []).some(i => i.subcategory_id == null);
            setActiveSubcat(hasNone ? '__none__' : subs[0].id);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [orderId]);

  // SEPOS — hydrate the "Remove service charge" toggle from the persisted
  // per-order flag whenever the order (re)loads. Keeps the Order screen in
  // step with what the Bill / receipt will actually charge.
  useEffect(() => {
    if (order) setServiceChargeRemoved(order.no_service_charge === 1 || order.no_service_charge === true);
  }, [order?.id, order?.no_service_charge]);

  // SEPOS — menu-button allergen chips render ONLY from confirmed
  // entries in dish_allergens (the Allergen Matrix). AI-scanner output
  // on menu_items.allergens is treated as a suggestion only, surfaced
  // in admin → Allergen Menu where staff review and tap "🤖 Confirm AI
  // Allergens" (bulk) or individual cells to promote them. Once
  // promoted, they land in dish_allergens and the chips appear here.
  // This prevents an unreviewed AI guess from showing to a waiter as
  // gospel — Natasha's Law is a real liability if we get it wrong.
  const allergensByItemId = useMemo(() => {
    const out = {};
    for (const cat of menu) {
      for (const item of (cat.items || [])) {
        const parsed = parseAllergens(allergenOverrides[item.id]);
        if (parsed.length > 0) out[item.id] = parsed;
      }
    }
    return out;
  }, [menu, allergenOverrides]);

  // ── Sandy: Listen for screen resize so layout switches automatically ──
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const getItemIsBar = (item) => {
    const cat = menu.find(c => c.id === item.category_id);
    return !!cat?.is_bar;
  };

  const handleItemClick = async (item) => {
    const allMods = await getItemModifiers(item.id);
    const isBar = getItemIsBar(item);
    // Course priority: a per-item override (menu_items.default_course) wins so a
    // mixed category like "Lunch" files each dish correctly (its mains print as
    // MAINS). Otherwise fall back to the operator's current course-bar selection,
    // which already defaults to the category's default_course on tab tap.
    const course = isBar ? 0
      : (item.default_course != null && item.default_course !== '')
        ? Number(item.default_course)
        : activeCourse;
    // SEPOS-ALLERGEN-OPT-001 (UX option A) — GLOBAL groups (the dietary/allergen
    // group) apply to every item; don't let them force the modifier popup open on
    // every tap. Only the item's OWN (non-global) groups trigger the picker; the
    // dietary group is offered as chips in the note popup (which shows anyway).
    const ownGroups    = (allMods || []).filter(g => !g.is_global);
    const dietaryGroups = (allMods || []).filter(g => g.is_global);
    if (ownGroups.length > 0) {
      setSelectedModifiers({});
      setModifierPopup({ item, modifiers: ownGroups, course, isBar, dietaryGroups });
    } else {
      setNotePopup({ item, modifiers: [], course, isBar, note: '', dietaryGroups, dietary: [] });
    }
  };

  const handleModifierSelect = (groupId, modifier, isMulti) => {
    setSelectedModifiers(prev => {
      if (isMulti) {
        const current = prev[groupId] || [];
        const exists = current.find(m => m.id === modifier.id);
        if (exists) return { ...prev, [groupId]: current.filter(m => m.id !== modifier.id) };
        return { ...prev, [groupId]: [...current, modifier] };
      }
      return { ...prev, [groupId]: [modifier] };
    });
  };

  const confirmModifiers = () => {
    const { item, modifiers, course, isBar, dietaryGroups } = modifierPopup;
    for (const group of modifiers) {
      if (group.required) {
        const selected = selectedModifiers[group.id];
        if (!selected || selected.length === 0) {
          alert(`Please select an option for "${group.name}"`);
          return;
        }
      }
    }
    const chosen = Object.values(selectedModifiers).flat();
    setModifierPopup(null);
    setNotePopup({ item, modifiers: chosen, course, isBar, note: '', dietaryGroups: dietaryGroups || [], dietary: [] });
  };

  // SEPOS-ALLERGEN-OPT-001 — toggle a dietary/allergen chip in the note popup.
  const toggleDietary = (opt) => setNotePopup(p => {
    const cur = p.dietary || [];
    const on = cur.some(d => d.id === opt.id);
    return { ...p, dietary: on ? cur.filter(d => d.id !== opt.id) : [...cur, opt] };
  });

  const confirmNote = () => {
    const { item, modifiers, course, isBar, note, dietary } = notePopup;
    // Dietary/allergen selections are a STRUCTURED option (stamped is_allergen so
    // they print with ⚠️ emphasis) and always free.
    const dietaryMods = (dietary || []).map(m => ({ ...m, is_allergen: true, extra_price: 0 }));
    addToCart(item, [...modifiers, ...dietaryMods], course, isBar, note);
    setNotePopup(null);
  };

  const addToCart = (item, chosenModifiers, course, isBar, note) => {
    // Prices can arrive as strings — coerce so we ADD, not string-concat (£NaN).
    const extraPrice = chosenModifiers.reduce((sum, m) => sum + (Number(m.extra_price) || 0), 0);
    // SEPOS-ALLERGEN-OPT-001 — allergen/dietary selections are wrapped
    // "** ALLERGEN: … **" in the printed notes so they stand out on ALL three
    // print paths (network / Sunmi / HTML all render this notes string, and the
    // ** ** convention already prints bold+big). Kept ASCII — ESC/POS thermal
    // printers can't render an emoji. The structured is_allergen flag also stays
    // on each modifier for any structured consumer.
    const plainMods    = chosenModifiers.filter(m => !m.is_allergen).map(m => m.name);
    const allergenMods = chosenModifiers.filter(m =>  m.is_allergen).map(m => m.name);
    const modifierNames = [
      ...plainMods,
      ...(allergenMods.length ? [`** ALLERGEN: ${allergenMods.join(', ')} **`] : []),
    ].join(', ');
    const cartKey = item.id + '_' + modifierNames + '_' + course;
    setCart(prev => {
      const existing = prev.find(c => c.cartKey === cartKey && c.item_note === note);
      if (existing && !note) {
        return prev.map(c => c.cartKey === cartKey ? { ...c, quantity: c.quantity + 1 } : c);
      }
      return [...prev, {
        cartKey, menu_item_id: item.id, name: item.name, name_alt: item.name_alt || '',
        unit_price: (Number(item.price) || 0) + extraPrice, quantity: 1,
        notes: modifierNames, item_note: note || '',
        course: isBar ? 0 : course,
        is_bar: isBar ? 1 : 0,
        modifiers: chosenModifiers
      }];
    });
  };

  // SEPOS-MISC-001 — off-menu / special "open item". Staff type a free name +
  // price + qty and pick a destination CATEGORY, which drives kitchen-vs-bar and
  // which printer/station the ticket routes to (same as a normal item's
  // category). The line has no menu_item_id — a first-class custom row.
  const openMiscPopup = () => {
    // One Misc button — the destination category (chosen in the popup) decides
    // food/drink → kitchen/bar routing. Default to the category being viewed.
    const preset = menu.find(c => c.id === activeCategory) || menu[0];
    setMiscPopup({ name: '', price: '', quantity: 1, category_id: preset ? preset.id : null });
  };

  const addMiscToCart = () => {
    const p = miscPopup;
    if (!p) return;
    const name = (p.name || '').trim();
    const price = Number(p.price) || 0;
    const qty = Math.max(1, Math.floor(Number(p.quantity) || 1));
    if (!name || price <= 0) return;
    const cat = menu.find(c => c.id === p.category_id);
    const isBar = cat ? !!cat.is_bar : false;
    const course = isBar ? 0 : (cat && cat.default_course != null ? Number(cat.default_course) : 1);
    setCart(prev => [...prev, {
      cartKey: 'MISC_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_' + name,   // unique so misc lines never merge with each other
      menu_item_id: null, name, name_alt: '',
      unit_price: price, quantity: qty,
      notes: '', item_note: '',
      course,
      is_bar: isBar ? 1 : 0,
      category_id: cat ? cat.id : null,
      modifiers: [],
    }]);
    setMiscPopup(null);
  };

  const removeFromCart = (cartKey, item_note) => {
    setCart(prev => {
      const existing = prev.find(c => c.cartKey === cartKey && c.item_note === item_note);
      if (existing && existing.quantity > 1) {
        return prev.map(c => (c.cartKey === cartKey && c.item_note === item_note) ? { ...c, quantity: c.quantity - 1 } : c);
      }
      return prev.filter(c => !(c.cartKey === cartKey && c.item_note === item_note));
    });
  };

  // ── Quick +/− from the menu grid badge ──────────────────────────────
  // Increments the most-recent cart line for this menu item (so repeating
  // the same drink/dish is one tap). If nothing's in the cart yet for it,
  // fall back to the normal modifier/note flow.
  const incrementInCart = (item) => {
    const matching = cart.filter(c => c.menu_item_id === item.id);
    if (matching.length === 0) {
      handleItemClick(item);
      return;
    }
    const target = matching[matching.length - 1];
    setCart(prev => prev.map(c =>
      (c.cartKey === target.cartKey && c.item_note === target.item_note)
        ? { ...c, quantity: c.quantity + 1 }
        : c
    ));
  };

  const decrementInCart = (item) => {
    const matching = cart.filter(c => c.menu_item_id === item.id);
    if (matching.length === 0) return;
    const target = matching[matching.length - 1];
    removeFromCart(target.cartKey, target.item_note);
  };

  // ── Void with optional partial quantity ─────────────────────────────
  // window.prompt() is disabled in Electron, so we route this through a
  // React modal (voidPopup) instead of native prompts.
  const handleVoidItem = (item) => {
    // SEPOS-046z — negative id = optimistic row still being confirmed by
    // the server (real id arrives on the next fetchOrder, sub-second).
    if (item.id < 0) return alert('Still sending — try again in a second.');
    setVoidPopup({ item, qty: item.quantity, reason: '', type: null, managerPin: '', authError: '' });
  };

  // SEPOS-023 — void types. "Comp" needs a manager PIN if the current
  // staff isn't admin/manager/supervisor.
  const VOID_TYPES = ['Wastage', 'Wrong Order', 'Customer Changed Mind', 'Comp'];
  const MANAGER_ROLES = ['admin', 'manager', 'supervisor'];

  const confirmVoid = async () => {
    if (!voidPopup) return;
    const { item, qty, reason, type, managerPin } = voidPopup;
    if (!type) {
      setVoidPopup({ ...voidPopup, authError: 'Pick a void type.' });
      return;
    }
    if (type === 'Comp' && !MANAGER_ROLES.includes(staff?.role)) {
      if (!managerPin) {
        setVoidPopup({ ...voidPopup, authError: 'Manager PIN required for Comp.' });
        return;
      }
      try {
        const mgr = await loginStaff(managerPin);
        if (!mgr?.id || !MANAGER_ROLES.includes(mgr.role)) {
          setVoidPopup({ ...voidPopup, authError: 'Not a manager PIN.' });
          return;
        }
      } catch {
        setVoidPopup({ ...voidPopup, authError: 'PIN check failed.' });
        return;
      }
    }
    const n = Math.max(1, Math.min(item.quantity, Number(qty) || item.quantity));
    const finalReason = (reason && reason.trim()) || type;
    setVoidPopup(null);
    // SEPOS-046z — optimistic void, mirroring the server: full void marks
    // the row; partial void shrinks it and adds a voided ghost copy. The
    // background fetchOrder swaps in the real rows — orders are written
    // local-first on desktop, so the refetch reads its own write (this is
    // NOT the menu-style stale-pull situation). fetchOrder doubles as the
    // rollback on error.
    setOrder(prev => {
      if (!prev) return prev;
      if (n >= item.quantity) {
        return { ...prev, items: (prev.items || []).map(i =>
          i.id === item.id ? { ...i, voided: 1, void_reason: finalReason, void_type: type } : i) };
      }
      const ghost = { ...item, id: nextTempId(), quantity: n, voided: 1, void_reason: finalReason, void_type: type };
      return { ...prev, items: [...(prev.items || []).map(i =>
        i.id === item.id ? { ...i, quantity: i.quantity - n } : i), ghost] };
    });
    try {
      assertOk(await voidItem(item.id, finalReason, n, type));
      fetchOrder();
    } catch (e) {
      alert('Void failed: ' + (e?.message || 'unknown'));
      fetchOrder();
    }
  };

  // SEPOS-024 — resend with reason (Not Cooked / Wrong Item / Missing Item / Remake)
  const RESEND_REASONS = ['Not Cooked', 'Wrong Item', 'Missing Item', 'Remake'];
  const confirmResend = async (reason) => {
    if (!resendPopup) return;
    const { item } = resendPopup;
    setResendPopup(null);
    if (item.id < 0) return alert('Still sending — try again in a second.');
    // Open the popup window BEFORE awaits so the browser doesn't block it
    // (popup blocker requires user-gesture context, lost across awaits) — but
    // ONLY when we'd need the browser fallback. With a network kitchen printer
    // (or the desktop app) the resend prints silently, so skip the empty popup.
    const popupWin = (!settings?.printer_kitchen_ip && !window.siamepos?.isElectron && !isNativeApp())
      ? window.open('', '_blank', 'width=400,height=600,scrollbars=yes') : null;
    // SEPOS-046z — optimistic: the row flips back to 🔥 cooking instantly.
    setOrder(prev => prev ? { ...prev, items: (prev.items || []).map(i =>
      i.id === item.id ? { ...i, status: 'cooking' } : i) } : prev);
    try {
      assertOk(await resendToKitchen(orderId, [item.id], reason));
    } catch (e) {
      try { popupWin?.close(); } catch {}
      alert('Resend failed: ' + (e?.message || 'unknown'));
      fetchOrder(); // rollback to true state
      return;
    }
    fetchOrder(); // background reconcile
    try {
      // SEPOS-024 follow-up 2026-06-02: also dispatch a kitchen print so
      // the chef sees the resend on paper. The /resend endpoint only
      // updates DB + emits the KDS socket event — restaurants with no
      // KDS had no visible signal that a resend happened. Prepend the
      // reason to the item notes so it shows up prominently on the
      // ticket alongside any existing dish note.
      const noteWithReason = `🔄 RESEND [${reason}]${item.notes ? ' | ' + item.notes : ''}`;
      await printKitchenTicket({
        order: order ? { ...order } : { id: orderId },
        items: [{ ...item, notes: noteWithReason }],
        course: item.course || 0,
        popupWin,
      });
    } catch (e) {
      console.warn('[resend] print failed:', e?.message);
      try { popupWin?.close(); } catch {}
    }
  };

  // SEPOS-KITCHEN-MSG-002 — attach a kitchen note to THIS order. It prints at
  // the bottom of the order's kitchen ticket on the next send/fire (the server
  // reads customer_note from the order), and shows as a chip here so the waiter
  // can edit or clear it. Optimistic local update so the chip appears at once.
  const handleSaveKitchenNote = async (text) => {
    const note = String(text || '').trim();
    setOrder(prev => prev ? { ...prev, customer_note: note } : prev);
    assertOk(await saveOrderNote(orderId, note));
  };

  const sendOrder = async () => {
    if (cart.length === 0) return alert('No items to send!');

    // Snapshot cart before clearing.  Detect bar/kitchen split now (before any await)
    // so we can pre-open popup windows while the user-gesture context is still live.
    const cartAsItems   = cart.map(c => ({
      // SEPOS-STATION-004 — menu_item_id MUST ride along: the server's
      // per-station split (and Sunmi's client-side split) look the dish up by
      // it. This projection predates stations and silently dropped the id, so
      // every ticket printed from the UI lost its routing identity and fell
      // back to the role default — while direct API tests (which carried the
      // id) routed perfectly. Found via the live print trace on the Fern rig.
      menu_item_id: c.menu_item_id ?? null,
      name: c.name, name_alt: c.name_alt || '', quantity: c.quantity, course: c.course || 1, notes: c.notes || '', item_note: c.item_note || '', is_bar: !!c.is_bar,
    }));
    // Print ONLY what was just added — not the entire order. When a
    // table has 3 dishes already cooking and the waiter adds a 4th,
    // the kitchen ticket should show just the new dish (otherwise the
    // chef sees 4 dishes including 3 they're already working on).
    // Previously this was `[...existingItems, ...cartAsItems]` which
    // re-printed already-fired items each time. The full-order view
    // is still available via Bill / Receipt; kitchen sees only deltas.
    const justAdded     = cartAsItems;
    const hasKitchen    = justAdded.some(i => !i.is_bar);
    const hasBar        = justAdded.some(i => i.is_bar);

    // ── Pre-open ONE popup window SYNCHRONOUSLY (user gesture is fresh here). ───
    // Chrome allows only ONE window.open() per user gesture. Kitchen always uses
    // server-side TCP or Electron print, so we give the one popup slot to bar.
    // If bar also uses server/Electron print the window is closed immediately.
    // Only when we'd need the browser fallback — a network bar printer (or the
    // desktop app) prints silently, so don't flash an empty popup.
    const barWin = (hasBar && !settings?.printer_bar_ip && !window.siamepos?.isElectron && !isNativeApp())
      ? window.open('', '_blank', 'width=400,height=600,scrollbars=yes') : null;

    // SEPOS-046z — optimistic send: the cart lines appear in the order
    // panel as ⏳ PENDING rows immediately (negative temp ids), and the
    // background fetchOrder swaps in the real rows once the POST lands.
    // Orders are written LOCAL-FIRST on desktop (unlike menu writes), so
    // the refetch reads its own write — no stale-pull risk. Prints stay on
    // the success path: a kitchen ticket must never fire for items the
    // server hasn't accepted. On error the cart is restored intact.
    const cartSnapshot = cart;
    const tempIds = new Set();
    const tempItems = cart.map((c) => {
      const id = nextTempId();
      tempIds.add(id);
      return {
        id,
        menu_item_id: c.menu_item_id, name: c.name, name_alt: c.name_alt || '',
        unit_price: c.unit_price, quantity: c.quantity,
        notes: c.notes || '', item_note: c.item_note || '',
        course: c.is_bar ? 0 : (c.course || 1), is_bar: c.is_bar ? 1 : 0,
        category_id: c.category_id ?? null,
        is_fired: c.is_bar ? 1 : 0, status: c.is_bar ? 'cooking' : 'pending', voided: 0,
      };
    });
    setOrder(prev => prev ? { ...prev, items: [...(prev.items || []), ...tempItems] } : prev);
    setCart([]);
    if (isMobile) setMobileTab('order');
    setSendBusy(true);

    try {
      // SEPOS-SENTBY-001 — stamp who pressed Send on this round
      assertOk(await addOrderItems(orderId, cartSnapshot, staff?.name || null));
      fetchOrder(); // background reconcile — real ids replace the temp rows

      // SEPOS-026 — kitchen then bar, sequentially in background.
      // Running both simultaneously causes the USB print server to receive two TCP
      // connections at once and drop the first (kitchen) ticket. Chaining with .then()
      // means bar only starts after kitchen's TCP connection closes (+ the 1.5s queue
      // gap in printService). sendOrder doesn't await these — UI is unblocked.
      const orderSnap = order; // capture before any async state changes
      Promise.resolve()
        .then(() => hasKitchen ? printFullOrderTicket({ order: orderSnap, items: justAdded, popupWin: null }) : null)
        .then(() => hasBar     ? printBarOrderTicket({ order: orderSnap, items: justAdded, popupWin: barWin }) : null)
        .catch(e => console.error('[sendOrder] print chain error:', e));

      // No success popup — the items are already in the Order Summary and the
      // 🔥 Fire buttons are right there; a blocking confirm on every send is noise.

      // SEPOS-TILL-LOCK-001 — when Till Security's send-lock is on, close the
      // loop visibly: a 1.4s "✓ Order sent" flash, then back to the PIN screen.
      // The print chain above is fire-and-forget (module-level services), so
      // unmounting this screen does not interrupt kitchen/bar tickets.
      if (onSent) {
        setSentFlash(true);
        setTimeout(() => onSent(), 1400);
      }
    } catch (err) {
      // Clean up pre-opened window on error
      try { if (barWin && !barWin.closed) barWin.close(); } catch {}
      // Rollback: drop only OUR temp rows (void ghosts also use negative
      // ids) and put the cart back exactly as it was.
      setOrder(prev => prev ? { ...prev, items: (prev.items || []).filter(i => !tempIds.has(i.id)) } : prev);
      setCart(cartSnapshot);
      alert('Failed to send order — your items are back in the cart.');
    } finally {
      setSendBusy(false);
    }
  };

  const handleFireCourse = async (course) => {
    setFiringCourse(course);
    // Only pre-open the browser-print popup when we'd actually need the fallback —
    // i.e. NO network kitchen printer and not the desktop app. With a printer set
    // the fire notice prints silently server-side, so this blank window was just
    // flashing an empty popup on every fire (the operator complaint).
    const coursePopupWin = (!settings?.printer_kitchen_ip && !window.siamepos?.isElectron && !isNativeApp())
      ? window.open('', '_blank', 'width=400,height=600,scrollbars=yes') : null;
    // SEPOS-046z — optimistic: mirror the server's UPDATE (non-bar, unfired,
    // unvoided items of this course flip to fired/cooking). The pulsing
    // PENDING cards settle instantly; fetchOrder reconciles/rolls back.
    const firedAt = new Date().toISOString();
    setOrder(prev => prev ? { ...prev, items: (prev.items || []).map(i =>
      (!i.is_bar && !i.voided && !i.is_fired && (i.course || 1) === course)
        ? { ...i, is_fired: 1, status: 'cooking', fired_at: firedAt }
        : i) } : prev);
    try {
      assertOk(await fireCourse(orderId, course));
      fetchOrder();
      // Fire notice — just "TABLE X / FIRE MAINS", no item list
      printFireNoticeTicket({ order, course, popupWin: coursePopupWin });
      // No success popup — the course already flipped to 🔥 cooking on screen and
      // the ticket prints silently; a blocking confirm on every fire is just noise.
    } catch (err) {
      try { if (coursePopupWin && !coursePopupWin.closed) coursePopupWin.close(); } catch {}
      alert('Failed to fire course.');
      fetchOrder(); // rollback
    } finally {
      setFiringCourse(null);
    }
  };

  // ── Item discount — apply or remove ──
  // SEPOS-046z — value entry moved from window.prompt() (DISABLED in
  // Electron — discounts silently did nothing on desktop installs) to the
  // DiscountModal. Apply/remove are optimistic with fetchOrder reconcile.
  const handleItemDiscount = async (item) => {
    const allowedRoles = ['admin', 'manager', 'supervisor'];
    if (!allowedRoles.includes(staff?.role) && !staff?.can_discount) {
      alert('⛔ You don\'t have permission to give discounts.\n\nA manager can enable it for you in Admin → Staff → "Can give discount".');
      return;
    }
    if (item.id < 0) return alert('Still sending — try again in a second.');
    if (item.discount_value > 0) {
      const remove = await confirm(
        `This item has a discount:\n${item.discount_type === 'percent' ? item.discount_value + '%' : '£' + item.discount_value} off\n\nOK = Remove discount\nCancel = Change discount`
      );
      if (remove) {
        setOrder(prev => prev ? { ...prev, items: (prev.items || []).map(i =>
          i.id === item.id ? { ...i, discount_type: null, discount_value: 0 } : i) } : prev);
        try { assertOk(await applyItemDiscount(item.id, null, 0)); fetchOrder(); }
        catch (e) { alert('Could not remove discount: ' + (e?.message || 'unknown')); fetchOrder(); }
        return;
      }
    }
    setDiscountPopup({ scope: 'item', item, type: 'percent', value: '10' });
  };

  const confirmDiscount = async () => {
    if (!discountPopup) return;
    const { scope, item, type, value, reason, applies } = discountPopup;
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) { alert('Invalid value!'); return; }
    if (type === 'percent' && num > 100) { alert('Percentage cannot exceed 100.'); return; }
    if (scope === 'bill' && !(reason || '').trim()) { alert('A reason is required for bill discounts.'); return; }
    setDiscountPopup(null);
    if (scope === 'item') {
      setOrder(prev => prev ? { ...prev, items: (prev.items || []).map(i =>
        i.id === item.id ? { ...i, discount_type: type, discount_value: num } : i) } : prev);
      try { assertOk(await applyItemDiscount(item.id, type, num)); fetchOrder(); }
      catch (e) { alert('Discount failed: ' + (e?.message || 'unknown')); fetchOrder(); }
    } else {
      // SEPOS-DISCOUNT-SCOPE-001 — 'applies' pill: 'all' | 'food' | 'drink'
      const dScope = (applies === 'food' || applies === 'drink') ? applies : null;
      setOrder(prev => prev ? { ...prev, discount_type: type, discount_value: num, discount_reason: reason.trim(), discount_scope: dScope } : prev);
      try { assertOk(await applyDiscount(orderId, type, num, reason.trim(), dScope)); fetchOrder(); }
      catch (e) { alert('Discount failed: ' + (e?.message || 'unknown')); fetchOrder(); }
    }
  };

  const cartTotal = cart.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  // Compute the existing-items subtotal LIVE from order.items, filtering
  // voids and applying per-item discounts. Was previously using
  // `order.total` directly — the persisted column set at order-create
  // time which the void endpoint never recalculates, so voiding every
  // item left £X.XX in the subtotal. (Bug fix 2026-06-02 — Korakot
  // surfaced via "I voided all items, why total still has amount".)
  // BillScreen.jsx uses the same pattern for closed-bill totals.
  const existingItemsTotal = (order?.items || [])
    .filter(i => !i.voided)
    .reduce((sum, i) => {
      const p = (Number(i.unit_price) || 0) * (Number(i.quantity) || 0);
      const d = i.discount_value > 0
        ? (i.discount_type === 'percent' ? p * (Number(i.discount_value) / 100) : Math.min(Number(i.discount_value), p))
        : 0;
      return sum + p - d;
    }, 0);
  const subtotal = existingItemsTotal + cartTotal;
  // order.discount_value comes back from the server as a STRING (PG DECIMAL),
  // so coerce — otherwise the fixed-discount branch returned a string and
  // discountAmount.toFixed() crashed the screen ("ct.toFixed is not a function").
  // SEPOS-DISCOUNT-SCOPE-001 — scope-aware (food/drink via is_bar), shared
  // helper with BillScreen. Unsent cart lines count too (they carry is_bar),
  // so the summary matches what the Bill will show after Send. A fixed £
  // discount now caps at its scope's subtotal (was shown uncapped).
  const discountAmount = Number(order?.discount_value) > 0
    ? billDiscountAmount(order, [...(order?.items || []), ...cart])
    : 0;
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  // Mirror BillScreen's logic exactly (single source of truth for the rate).
  const scRate = parseFloat(settings.service_charge_rate || settings.service_charge_percent || 12.5) / 100;
  const scEnabled = settings.service_charge_enabled !== '0' && settings.service_charge_enabled !== 'false';
  // SEPOS-TAKEAWAY-TABLE — service charge is dine-in only. Takeaway (walk-in
  // table or online) and counter orders never carry it.
  const isNonDineIn = !!(order && order.order_type && order.order_type !== 'dine_in');
  const serviceChargeAmount = (serviceChargeRemoved || !scEnabled || isNonDineIn) ? 0 : afterDiscount * scRate;
  const orderTotal = afterDiscount + serviceChargeAmount;

  const activeItems = menu.find(c => c.id === activeCategory)?.items || [];
  const activeSubs = menu.find(c => c.id === activeCategory)?.subcategories || [];
  const activeCatIsBar = !!menu.find(c => c.id === activeCategory)?.is_bar;
  const existingItems = order?.items || [];

  // ── Menu navigation (redesign): category buttons → sub-category tabs ──────────
  // Categories are big wrapping buttons; a category with sub-cats shows a tab
  // strip (no big "All" list) and the first tab auto-selects. Items filed under
  // no sub-cat surface under a leading "General" tab so nothing is ever hidden.
  const NONE_SUBCAT = '__none__';
  const activeHasUnfiled = activeItems.some(i => i.subcategory_id == null);
  const subTabs = activeSubs.length
    ? [...(activeHasUnfiled ? [{ id: NONE_SUBCAT, name: 'General' }] : []), ...activeSubs]
    : [];
  // Search the whole menu — when the box has text, ignore category/sub-cat and
  // show every matching dish across all categories (name or 2nd-language name).
  const searchQ = (search || '').trim().toLowerCase();
  const dishesToShow = searchQ
    ? menu.flatMap(c => c.items || []).filter(it =>
        (it.name || '').toLowerCase().includes(searchQ) || (it.name_alt || '').toLowerCase().includes(searchQ))
    : activeItems.filter(item =>
        activeSubcat == null ? true
          : activeSubcat === NONE_SUBCAT ? item.subcategory_id == null
          : item.subcategory_id === activeSubcat
      );
  const selectCategory = (cat) => {
    setActiveCategory(cat.id);
    setActiveCourse(cat.default_course || 1);
    const subs = cat.subcategories || [];
    if (!subs.length) { setActiveSubcat(null); return; }
    // Auto-select the first tab so dishes show immediately (no dead-end).
    const hasNone = (cat.items || []).some(i => i.subcategory_id == null);
    setActiveSubcat(hasNone ? NONE_SUBCAT : subs[0].id);
  };

  // SEPOS-ORDER-ARRANGE — reorder the current category's items right on the
  // order screen (manager-gated). Reorders the WHOLE active category (flat),
  // saves 1-based sort_order (matches the reorder-reset fix), refetches menu.
  const MANAGER_ARR = ['admin', 'manager', 'supervisor'];
  const enterArrange = () => { setArrangeItems([...activeItems]); setArrangeMode(true); setSearch(''); };
  const openArrange = () => { if (MANAGER_ARR.includes(staff?.role)) enterArrange(); else setArrangePin({ pin: '', err: '', busy: false }); };
  const verifyArrangePin = async () => {
    if (arrangePin?.busy) return;
    setArrangePin(p => ({ ...p, busy: true, err: '' }));
    try {
      const mgr = await loginStaff(arrangePin.pin);
      if (mgr?.id && MANAGER_ARR.includes(mgr.role)) { setArrangePin(null); enterArrange(); }
      else setArrangePin(p => ({ ...p, busy: false, err: 'Not a manager PIN.' }));
    } catch { setArrangePin(p => ({ ...p, busy: false, err: 'PIN check failed.' })); }
  };
  const onArrangeDrop = (dropIdx) => {
    if (arrangeDrag == null || arrangeDrag === dropIdx) { setArrangeDrag(null); return; }
    setArrangeItems(prev => { const a = [...prev]; const [m] = a.splice(arrangeDrag, 1); a.splice(dropIdx, 0, m); return a; });
    setArrangeDrag(null);
  };
  const saveArrange = async () => {
    if (arrangeSaving) return;
    setArrangeSaving(true);
    try {
      await updateMenuItemsSortOrder(arrangeItems.map((it, i) => ({ id: it.id, sort_order: i + 1 })));
      const fresh = await getMenu(); if (Array.isArray(fresh)) setMenu(fresh);
    } catch (e) { alert('Could not save the new order: ' + (e?.message || 'unknown')); }
    finally { setArrangeSaving(false); setArrangeMode(false); setArrangeDrag(null); }
  };
  const cancelArrange = () => { setArrangeMode(false); setArrangeDrag(null); };

  const existingByCourse = {};
  existingItems.filter(item => !item.is_bar).forEach(item => {
    const course = item.course || 1;
    if (!existingByCourse[course]) existingByCourse[course] = [];
    existingByCourse[course].push(item);
  });

  const existingBarItems = existingItems.filter(item => item.is_bar);
  const cartBar = cart.filter(i => i.is_bar);
  const cartByCourse = {};
  cart.filter(i => !i.is_bar).forEach(item => {
    const c = item.course || 1;
    if (!cartByCourse[c]) cartByCourse[c] = [];
    cartByCourse[c].push(item);
  });

  // ── Sandy: Badge count — total items in cart + existing sent items ──
  const badgeCount = cart.reduce((sum, i) => sum + i.quantity, 0) +
    existingItems.filter(i => !i.voided).reduce((sum, i) => sum + i.quantity, 0);

  // Reusable DISC button
  const DiscButton = ({ item }) => (
    <button onClick={() => handleItemDiscount(item)} style={{
      background: item.discount_value > 0 ? '#fef9c3' : '#dcfce7',
      border: 'none', borderRadius: 4,
      padding: '2px 6px', cursor: 'pointer',
      color: item.discount_value > 0 ? '#92400e' : '#16a34a',
      fontSize: 10, fontWeight: 700
    }}>
      {item.discount_value > 0 ? '🏷️ DISC' : 'DISC'}
    </button>
  );

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{ fontSize: 18, color: '#888' }}>Loading order...</div>
    </div>
  );

  return (
    <>
      {/* SEPOS-TILL-LOCK-001 — sent confirmation flash (shown just before the
          screen returns to sign-in, so staff SEE the loop close) */}
      {sentFlash && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 100003,
          background: 'rgba(22,163,74,0.96)', color: 'white', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        }}>
          <div style={{ fontSize: 84, lineHeight: 1 }}>✓</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 12 }}>Order sent to kitchen</div>
          {order?.table_number != null && (
            <div style={{ fontSize: 17, marginTop: 6, opacity: 0.9 }}>{dineTableLabel(order)}</div>
          )}
        </div>
      )}
      <style>{`
        @keyframes pendingPulse {
          0%, 100% { border-color: #f59e0b; box-shadow: 0 0 0 0 rgba(245,158,11,0); }
          50% { border-color: #d97706; box-shadow: 0 0 0 4px rgba(245,158,11,0.15); }
        }
      `}</style>

      {/*
        ── Sandy: Outer wrapper ──
        Desktop: flex ROW  — LEFT (menu) | RIGHT (order panel, 340px)
        Mobile:  flex COLUMN — active tab fills space, tab bar pinned to bottom
      */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        height: '100%',
        width: '100%'
      }}>

        {/* LEFT — mobile keeps the stacked menu; desktop uses the rail+grid (else branch) */}
        {isMobile ? (
        <div style={{
          flex: 1,
          display: mobileTab !== 'menu' ? 'none' : 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>

          {/* Top bar */}
          <div style={{
            background: 'white', padding: '14px 20px', borderBottom: '1px solid #eee',
            display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
          }}>
            <button onClick={async () => {
              // SEPOS-046z — don't auto-cancel while a send is in flight:
              // the items it would judge "empty" may be landing right now.
              if (!sendBusy) {
                const allVoided = existingItems.length > 0 && existingItems.every(i => i.voided);
                const isEmpty = existingItems.length === 0 && cart.length === 0;
                if (allVoided || isEmpty) await payOrder(orderId, 0, 'cancelled');
              }
              onClose();
            }} style={{
              background: '#f0f0f0', border: 'none', borderRadius: 10,
              padding: '10px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 15
            }}>
              ← Back
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', flex: 1 }}>
              {dineTableLabel(order)} — Order #{orderId}
              {order?.covers && (
                <span style={{ fontSize: 14, fontWeight: 400, color: '#888', marginLeft: 8 }}>
                  {order.covers} covers
                </span>
              )}
            </h2>
            {/* SEPOS-KITCHEN-MSG-001 — one-tap kitchen message */}
            <button onClick={() => setShowKitchenMsg(true)} style={{
              background: 'white', color: 'var(--brand-primary,#0D1B3E)', border: '1px solid var(--brand-primary,#0D1B3E)',
              borderRadius: 10, padding: '10px 14px', cursor: 'pointer',
              fontWeight: 700, fontSize: 14
            }}>
              📢 Message
            </button>
            {cart.length > 0 && (
              <button onClick={sendOrder} style={{
                background: 'var(--brand-primary, #1a1a2e)', color: 'white', border: 'none',
                borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
                fontWeight: 700, fontSize: 14
              }}>
                Send Order
              </button>
            )}
          </div>

          {/* SEPOS-KITCHEN-MSG-002 — the attached kitchen note, shown so the
              waiter can see it's on and edit/remove it. Prints at the bottom
              of the kitchen ticket. */}
          {order?.customer_note && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#FEF3C7', border: '1px solid #F59E0B', borderRadius: 10, padding: '8px 12px', margin: '0 0 10px' }}>
              <span style={{ fontSize: 15 }}>📢</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: '#92400E', wordBreak: 'break-word' }}>Kitchen note: {order.customer_note}</span>
              <button onClick={() => setShowKitchenMsg(true)} style={{ border: 'none', background: 'transparent', color: '#92400E', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Edit</button>
              <button onClick={() => handleSaveKitchenNote('')} title="Remove note" style={{ border: 'none', background: 'transparent', color: '#92400E', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* Course selector */}
          {/* SEPOS-046w — course bar stays visible on bar categories too.
              Hiding it on bar made the whole top section jump out of place,
              and the course concept is independent of bar routing anyway
              (a drink ordered with the mains is still course 2). */}
          <div style={{
            background: '#f8f8f8', padding: '10px 16px', borderBottom: '1px solid #eee',
            display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>Course:</span>
            {[1, 2, 3, 4].map(c => (
              <button key={c} onClick={() => setActiveCourse(c)} style={{
                padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 13,
                background: activeCourse === c ? COURSE_COLORS[c] : '#e0e0e0',
                color: activeCourse === c ? 'white' : '#555',
              }}>
                {c === 1 ? 'Starters' : c === 2 ? 'Mains' : c === 3 ? 'Desserts' : 'Extra'}
              </button>
            ))}
          </div>

          {/* Category tabs */}
          <div style={{
            display: 'flex', gap: 8, padding: '10px 16px', background: 'white',
            borderBottom: '1px solid #eee', overflowX: 'auto', flexShrink: 0
          }}>
            {menu.map(cat => (
              <button key={cat.id} onClick={() => {
                setActiveCategory(cat.id);
                setActiveCourse(cat.default_course || 1);
                setActiveSubcat(null);
              }} style={{
                padding: '10px 20px', borderRadius: 20, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap',
                background: cat.color ? (activeCategory === cat.id ? cat.color : cat.color + 'cc') : (activeCategory === cat.id ? (cat.is_bar ? '#1e40af' : 'var(--brand-primary, #1a1a2e)') : '#f0f0f0'),
                color: cat.color ? textOn(cat.color) : (activeCategory === cat.id ? 'white' : '#555'),
                outline: cat.color && activeCategory === cat.id ? '3px solid #1a1a2e' : 'none',
              }}>
                {cat.name} {cat.is_bar ? '🍹' : ''}
              </button>
            ))}
            {/* SEPOS-MISC-001 — off-menu / special open item, at the right end */}
            <button onClick={() => openMiscPopup()} style={{
              padding: '10px 16px', borderRadius: 20, cursor: 'pointer', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap',
              border: '1.5px dashed #C9A84C', background: '#FBF7EC', color: '#9A7B1F' }}>🍽 Misc item</button>
          </div>

          {/* Sub-category tabs */}
          {activeSubs.length > 0 && (
            <div style={{
              display: 'flex', gap: 6, padding: '8px 16px', background: '#fafafa',
              borderBottom: '1px solid #eee', overflowX: 'auto', flexShrink: 0
            }}>
              <button onClick={() => setActiveSubcat(null)} style={{
                padding: '7px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
                background: !activeSubcat ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0',
                color: !activeSubcat ? 'white' : '#555'
              }}>All</button>
              {activeSubs.map(sub => (
                <button key={sub.id} onClick={() => setActiveSubcat(sub.id)} style={{
                  padding: '7px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
                  background: sub.color ? (activeSubcat === sub.id ? sub.color : sub.color + 'cc') : (activeSubcat === sub.id ? '#3b82f6' : '#e0e0e0'),
                  color: sub.color ? textOn(sub.color) : (activeSubcat === sub.id ? 'white' : '#555'),
                  outline: sub.color && activeSubcat === sub.id ? '3px solid #1a1a2e' : 'none'
                }}>{sub.name}</button>
              ))}
            </div>
          )}

          {/* Menu items grid — extra bottom padding on mobile so the
              last row isn't hidden behind the fixed Menu/Order tab bar
              (with iOS safe-area inset added). */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: 16,
            paddingBottom: isMobile ? 'calc(58px + env(safe-area-inset-bottom, 0px) + 16px)' : 16,
            background: '#f5f5f5'
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
              gap: 12
            }}>
              {activeItems
                .filter(item => !activeSubcat || item.subcategory_id === activeSubcat)
                .map(item => {
                  const inCart = cart.filter(c => c.menu_item_id === item.id);
                  const totalQty = inCart.reduce((s, c) => s + c.quantity, 0);
                  const isBar = activeCatIsBar;
                  return (
                    <div key={item.id} onClick={() => handleItemClick(item)} style={{
                      background: 'white', borderRadius: 14, padding: 16, cursor: 'pointer',
                      border: totalQty > 0 ? `2px solid ${isBar ? '#1e40af' : '#e94560'}` : '2px solid transparent',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.08)', transition: 'transform 0.1s',
                    }}
                      onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.02)'}
                      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                    >
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 4 }}>
                        {item.name}
                      </div>
                      {item.description && (
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                          {item.description}
                        </div>
                      )}
                      {/* SEPOS — UK14 allergen chips. Sits between
                          description and price so it's easy to scan
                          before the waiter taps "add to cart". */}
                      <AllergenChips list={allergensByItemId[item.id]} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: allergensByItemId[item.id] ? 8 : 0 }}>
                        <span style={{ fontSize: 17, fontWeight: 800, color: isBar ? '#1e40af' : '#e94560' }}>
                          £{Number(item.price || 0).toFixed(2)}
                        </span>
                        {totalQty > 0 && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: 'flex', alignItems: 'center',
                              background: 'var(--brand-primary,#0D1B3E)', color: 'var(--brand-accent,#C9A84C)',
                              borderRadius: 16, height: 28, overflow: 'hidden',
                              boxShadow: '0 1px 4px rgba(13,27,62,0.25)',
                            }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); decrementInCart(item); }}
                              style={{
                                background: 'transparent', border: 'none', color: 'var(--brand-accent,#C9A84C)',
                                cursor: 'pointer', width: 28, height: 28,
                                fontWeight: 800, fontSize: 18, lineHeight: 1,
                              }}
                              aria-label="Remove one"
                            >−</button>
                            <span style={{
                              fontWeight: 800, fontSize: 13, minWidth: 18,
                              textAlign: 'center', padding: '0 2px',
                            }}>{totalQty}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); incrementInCart(item); }}
                              style={{
                                background: 'transparent', border: 'none', color: 'var(--brand-accent,#C9A84C)',
                                cursor: 'pointer', width: 28, height: 28,
                                fontWeight: 800, fontSize: 18, lineHeight: 1,
                              }}
                              aria-label="Add one"
                            >+</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
        ) : (
          /* ── DESKTOP — category rail + menu grid (design handoff) ── */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#F4F1EA', fontFamily: "'Archivo', system-ui, sans-serif" }}>
            {/* slim top bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: '#fff', borderBottom: '1px solid #E7E2D6', flexShrink: 0 }}>
              <button onClick={async () => {
                if (!sendBusy) {
                  const allVoided = existingItems.length > 0 && existingItems.every(i => i.voided);
                  const isEmpty = existingItems.length === 0 && cart.length === 0;
                  if (allVoided || isEmpty) await payOrder(orderId, 0, 'cancelled');
                }
                onClose();
              }} style={{ background: '#F4F1EA', border: '1px solid #E7E2D6', borderRadius: 10, padding: '10px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 14, color: 'var(--brand-primary, #1a1a2e)' }}>‹ Tables</button>
              <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 22, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', whiteSpace: 'nowrap' }}>
                {dineTableLabel(order)}
                {(order?.covers || staff?.name) ? <span style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: '#9A9488', marginLeft: 10, fontWeight: 600 }}>{order?.covers ? `${order.covers} covers` : ''}{order?.covers && staff?.name ? ' · ' : ''}{staff?.name || ''}</span> : null}
              </div>
              {/* SEPOS-ORDER-REDESIGN — whole-menu search box */}
              <div style={{ flex: 1, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9A9488', fontSize: 15 }}>🔍</span>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search the whole menu…"
                  style={{ width: '100%', height: 42, padding: '0 12px 0 34px', borderRadius: 10, border: '1px solid #E7E2D6', background: '#fff', fontSize: 15, boxSizing: 'border-box', fontFamily: "'Archivo', sans-serif" }} />
                {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: '#9A9488', fontSize: 16, fontWeight: 700 }}>✕</button>}
              </div>
              <button onClick={() => setShowKitchenMsg(true)} style={{ background: '#fff', color: 'var(--brand-primary,#0D1B3E)', border: '1px solid var(--brand-primary,#0D1B3E)', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap' }}>Message kitchen</button>
              <button onClick={() => openMiscPopup()} style={{ background: '#FBF7EC', color: '#9A7B1F', border: '1.5px dashed #C9A84C', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap' }}>＋ Misc item</button>
            </div>
            {/* menu — full width; category buttons on top, sub-cat tabs below */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
                {/* Category buttons — wrap to multiple rows so every category is visible */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: subTabs.length ? 12 : 18 }}>
                  {menu.map(cat => {
                    const active = activeCategory === cat.id;
                    return (
                      <button key={cat.id} onClick={() => selectCategory(cat)} style={{
                        padding: '12px 26px', borderRadius: 14, cursor: 'pointer', fontWeight: 800, fontSize: 17, whiteSpace: 'nowrap',
                        border: active ? 'none' : (cat.color ? `1.5px solid ${cat.color}` : '1.5px solid #E7E2D6'),
                        background: cat.color ? (active ? cat.color : cat.color + '33') : (active ? (cat.is_bar ? '#1e40af' : 'var(--brand-primary,#0D1B3E)') : '#fff'),
                        color: cat.color ? (active ? textOn(cat.color) : 'var(--brand-primary, #1a1a2e)') : (active ? '#fff' : 'var(--brand-primary, #1a1a2e)'),
                        boxShadow: cat.color && active ? '0 0 0 3px rgba(13,27,62,.35)' : 'none' }}>
                        {cat.name}{cat.is_bar ? ' 🍹' : ''}
                      </button>
                    );
                  })}
                </div>
                {/* Sub-category tabs — shown only when the category has sub-cats
                    (no big "All" list). "General" holds any un-filed items so
                    nothing is ever hidden. The first tab auto-selects on tap. */}
                {/* Sub-category — plain pills (course selector moved to the order panel). */}
                {!searchQ && subTabs.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
                    {subTabs.map(sub => {
                      const active = activeSubcat === sub.id;
                      return (
                        <button key={sub.id} onClick={() => setActiveSubcat(sub.id)} style={{
                          padding: '9px 18px', borderRadius: 20, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                          border: active ? 'none' : (sub.color ? `1px solid ${sub.color}` : '1px solid #E7E2D6'),
                          background: sub.color ? (active ? sub.color : sub.color + '33') : (active ? 'var(--brand-accent,#C9A84C)' : '#fff'),
                          color: sub.color ? (active ? textOn(sub.color) : 'var(--brand-primary, #1a1a2e)') : (active ? '#fff' : '#7C766A'),
                          boxShadow: sub.color && active ? '0 0 0 3px rgba(13,27,62,.35)' : 'none' }}>
                          {sub.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {searchQ && <div style={{ fontSize: 13, color: '#9A9488', marginBottom: 14 }}>{dishesToShow.length} result{dishesToShow.length === 1 ? '' : 's'} for “{search.trim()}”</div>}
                {/* SEPOS-ORDER-ARRANGE — reorder the menu right here (manager-gated). */}
                {!searchQ && (arrangeMode ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 14px', background: '#FBF7EC', border: '1.5px solid #C9A84C', borderRadius: 12 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#9A7B1F' }}>⇅ Drag dishes to reorder {menu.find(c => c.id === activeCategory)?.name}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={cancelArrange} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Cancel</button>
                    <button onClick={saveArrange} disabled={arrangeSaving} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--brand-primary,#0D1B3E)', color: '#fff', cursor: arrangeSaving ? 'wait' : 'pointer', fontWeight: 800, fontSize: 13 }}>{arrangeSaving ? 'Saving…' : '✓ Done'}</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                    <button onClick={openArrange} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #E7E2D6', background: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#7C766A' }}>⇅ Arrange menu</button>
                  </div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 10 }}>
                  {(arrangeMode ? arrangeItems : dishesToShow).map((item, gridIdx) => {
                    const inCart = cart.filter(c => c.menu_item_id === item.id);
                    const totalQty = inCart.reduce((s, c) => s + c.quantity, 0);
                    return (
                      <div key={item.id}
                        draggable={arrangeMode}
                        onClick={arrangeMode ? undefined : () => handleItemClick(item)}
                        onDragStart={arrangeMode ? () => setArrangeDrag(gridIdx) : undefined}
                        onDragOver={arrangeMode ? (e) => e.preventDefault() : undefined}
                        onDrop={arrangeMode ? (e) => { e.preventDefault(); onArrangeDrop(gridIdx); } : undefined}
                        style={{ background: item.color || '#fff', borderRadius: 12, border: arrangeMode ? '1.5px dashed #C9A84C' : `1px solid ${totalQty > 0 ? 'var(--brand-primary,#0D1B3E)' : (item.color ? item.color : '#E7E2D6')}`, padding: '10px 12px', cursor: arrangeMode ? 'grab' : 'pointer', minHeight: 56, display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 1px 2px rgba(13,27,62,.05)', opacity: arrangeDrag === gridIdx ? 0.4 : 1 }}>
                        {/* SEPOS-MENU-COMPACT-001 — no price on the card, half-height row layout */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: item.color ? textOn(item.color) : 'var(--brand-primary, #1a1a2e)', lineHeight: 1.25 }}>{item.name}</div>
                          <AllergenChips list={allergensByItemId[item.id]} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
                          {arrangeMode ? (
                            <span style={{ color: '#C9A84C', fontSize: 20, fontWeight: 800, cursor: 'grab' }} title="Drag to reorder">⣿</span>
                          ) : totalQty > 0 ? (
                            <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', background: 'var(--brand-primary,#0D1B3E)', color: 'var(--brand-accent,#C9A84C)', borderRadius: 10, height: 32 }}>
                              <button onClick={e => { e.stopPropagation(); decrementInCart(item); }} style={{ background: 'transparent', border: 'none', color: 'var(--brand-accent,#C9A84C)', cursor: 'pointer', width: 30, height: 32, fontWeight: 800, fontSize: 18 }}>−</button>
                              <span style={{ fontWeight: 800, fontSize: 14, minWidth: 18, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{totalQty}</span>
                              <button onClick={e => { e.stopPropagation(); incrementInCart(item); }} style={{ background: 'transparent', border: 'none', color: 'var(--brand-accent,#C9A84C)', cursor: 'pointer', width: 30, height: 32, fontWeight: 800, fontSize: 18 }}>+</button>
                            </div>
                          ) : (
                            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--brand-primary,#0D1B3E)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700 }}>+</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════
            RIGHT — Order Summary
            Desktop: fixed 340px, always visible
            Mobile:  full width, visible only on 'order' tab
            ════════════════════════════════ */}
        <div style={{
          width: isMobile ? '100%' : 420,
          flex: isMobile && mobileTab === 'order' ? '1 1 0' : undefined,
          background: 'white',
          borderLeft: isMobile ? 'none' : '1px solid #eee',
          borderTop: isMobile ? '1px solid #eee' : 'none',
          display: isMobile && mobileTab !== 'order' ? 'none' : 'flex',
          flexDirection: 'column',
          flexShrink: isMobile ? undefined : 0
        }}>

          {/* Order Summary Header
              Desktop: simple "Order Summary" label
              Mobile:  shows table number + Send Order button if cart has items */}
          <div style={{
            padding: '14px 20px', borderBottom: '1px solid #eee', flexShrink: 0
          }}>
            {isMobile ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>
                    {dineTableLabel(order)}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>
                    Order #{orderId}{order?.covers ? ` · ${order.covers} covers` : ''}
                  </div>
                </div>
                {cart.length > 0 && (
                  <button onClick={sendOrder} style={{
                    background: 'var(--brand-primary,#0D1B3E)', color: 'white', border: 'none',
                    borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
                    fontWeight: 700, fontSize: 14
                  }}>
                    ✓ Send Order
                  </button>
                )}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>Order · {dineTableLabel(order)}</span>
                  <span style={{ fontSize: 13, color: '#9A9488', fontWeight: 600 }}>{existingItems.filter(i => !i.voided).reduce((s, i) => s + (i.quantity || 0), 0) + cart.reduce((s, c) => s + (c.quantity || 0), 0)} items</span>
                </div>
                {/* Course selector — moved here from the left menu (mockup). */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#9A9488', fontWeight: 600 }}>Send to kitchen as:</span>
                  {[1, 2, 3, 4].map(c => (
                    <button key={c} onClick={() => setActiveCourse(c)} style={{ padding: '7px 14px', borderRadius: 16, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      background: activeCourse === c ? COURSE_COLORS[c] : '#ECE7DA', color: activeCourse === c ? '#fff' : '#7C766A' }}>{COURSE_LABELS[c]}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Scrollable order items */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            // Same fixed-tab-bar offset as the menu side on mobile.
            paddingBottom: isMobile ? 'calc(58px + env(safe-area-inset-bottom, 0px) + 12px)' : '12px'
          }}>

            {/* Bar items in cart */}
            {cartBar.length > 0 && (
              <div style={{
                marginBottom: 14, background: '#eff6ff', borderRadius: 10,
                padding: 10, border: '1px solid #bfdbfe'
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#1e40af',
                  marginBottom: 8, textTransform: 'uppercase'
                }}>🍹 Bar — New</div>
                {cartBar.map((item, idx) => (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', fontSize: 13
                    }}>
                      <span style={{ flex: 1, color: 'var(--brand-primary, #1a1a2e)', fontWeight: 600 }}>
                        {item.quantity}× {item.name}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        <button onClick={() => removeFromCart(item.cartKey, item.item_note)} style={{
                          background: '#fee2e2', border: 'none', borderRadius: 4,
                          width: 22, height: 22, cursor: 'pointer',
                          color: '#ef4444', fontWeight: 700, fontSize: 14
                        }}>−</button>
                      </div>
                    </div>
                    {item.notes && (
                      <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>
                    )}
                    {item.item_note && (
                      <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Existing bar items */}
            {existingBarItems.filter(i => !i.voided).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#1e40af',
                  marginBottom: 6, textTransform: 'uppercase'
                }}>🍹 Bar — Sent</div>
                {existingBarItems.filter(i => !i.voided).map(item => (
                  <div key={item.id} style={{ marginBottom: 6 }}>
                    <div style={{
                      fontSize: 13, color: '#555', display: 'flex',
                      justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <span style={{ flex: 1 }}>
                        {item.status === 'served' ? '✅' : '🍹'} {item.quantity}× {item.name}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        <DiscButton item={item} />
                        <button onClick={() => handleVoidItem(item)} style={{
                          background: '#fee2e2', border: 'none', borderRadius: 4,
                          padding: '2px 6px', cursor: 'pointer', color: '#ef4444',
                          fontSize: 10, fontWeight: 700
                        }}>VOID</button>
                      </div>
                    </div>
                    {item.notes && (
                      <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>
                    )}
                    {item.item_note && (
                      <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>
                    )}
                    {item.discount_value > 0 && (
                      <div style={{ fontSize: 10, color: '#92400e', marginLeft: 16, fontWeight: 700 }}>
                        🏷️ {item.discount_type === 'percent' ? `${item.discount_value}% off` : `£${item.discount_value} off`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Cart items by course */}
            {Object.keys(cartByCourse).sort().map(course => (
              <div key={course} style={{
                marginBottom: 14, background: '#f8f8f8', borderRadius: 10, padding: 10
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: COURSE_COLORS[course] || '#888',
                  marginBottom: 6, textTransform: 'uppercase',
                  display: 'flex', alignItems: 'center', gap: 6
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: COURSE_COLORS[course] || '#888'
                  }} />
                  {COURSE_LABELS[course]} — New
                </div>
                {cartByCourse[course].map((item, idx) => (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', fontSize: 13
                    }}>
                      <span style={{ flex: 1, color: 'var(--brand-primary, #1a1a2e)', fontWeight: 600 }}>
                        {item.quantity}× {item.name}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        <button onClick={() => removeFromCart(item.cartKey, item.item_note)} style={{
                          background: '#fee2e2', border: 'none', borderRadius: 4,
                          width: 22, height: 22, cursor: 'pointer',
                          color: '#ef4444', fontWeight: 700, fontSize: 14
                        }}>−</button>
                      </div>
                    </div>
                    {item.notes && (
                      <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>
                    )}
                    {item.item_note && (
                      <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {/* Existing items by course */}
            {Object.keys(existingByCourse).sort().map(course => {
              const courseItems = existingByCourse[course];
              const unfired = courseItems.filter(i => !i.is_fired && !i.voided);
              const fired = courseItems.filter(i => i.is_fired && !i.voided);
              const voided = courseItems.filter(i => i.voided);
              return (
                <div key={course} style={{ marginBottom: 16 }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 6
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: COURSE_COLORS[course] || '#888',
                      textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6
                    }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: COURSE_COLORS[course] || '#888'
                      }} />
                      {COURSE_LABELS[course]}
                    </div>
                    {unfired.length > 0 && (
                      <button
                        onClick={() => handleFireCourse(Number(course))}
                        disabled={firingCourse === Number(course)}
                        style={{
                          background: COURSE_COLORS[course] || '#888', color: 'white',
                          border: 'none', borderRadius: 8, padding: '6px 14px',
                          cursor: 'pointer', fontWeight: 700, fontSize: 12
                        }}>
                        {firingCourse === Number(course) ? '...' : `🔥 Fire ${COURSE_LABELS[course]}`}
                      </button>
                    )}
                  </div>

                  {/* PENDING / UNFIRED items */}
                  {unfired.map(item => (
                    <div key={item.id} style={{
                      marginBottom: 8, padding: '10px 12px',
                      background: '#fffbeb', borderRadius: 8,
                      border: '2px solid #f59e0b',
                      animation: 'pendingPulse 2s infinite',
                      position: 'relative'
                    }}>
                      <div style={{
                        position: 'absolute', top: -9, right: 8,
                        background: '#f59e0b', color: 'white',
                        fontSize: 9, fontWeight: 800,
                        padding: '2px 8px', borderRadius: 10, letterSpacing: 0.5
                      }}>⏳ PENDING</div>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        fontSize: 13, alignItems: 'center'
                      }}>
                        <span style={{ color: '#92400e', fontWeight: 700, flex: 1 }}>
                          {item.quantity}× {item.name}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#92400e', fontWeight: 600 }}>
                            £{(item.unit_price * item.quantity).toFixed(2)}
                          </span>
                          <DiscButton item={item} />
                          <button onClick={() => handleVoidItem(item)} style={{
                            background: '#fee2e2', border: 'none', borderRadius: 4,
                            padding: '2px 6px', cursor: 'pointer', color: '#ef4444',
                            fontSize: 10, fontWeight: 700
                          }}>VOID</button>
                        </div>
                      </div>
                      {item.notes && (
                        <div style={{ fontSize: 11, color: '#92400e', marginLeft: 8, marginTop: 3 }}>
                          — {item.notes}
                        </div>
                      )}
                      {item.item_note && (
                        <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 8, marginTop: 2 }}>
                          📝 {item.item_note}
                        </div>
                      )}
                      {item.discount_value > 0 && (
                        <div style={{ fontSize: 10, color: '#92400e', marginLeft: 8, marginTop: 2, fontWeight: 700 }}>
                          🏷️ {item.discount_type === 'percent' ? `${item.discount_value}% off` : `£${item.discount_value} off`}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* FIRED items */}
                  {fired.map(item => (
                    <div key={item.id} style={{ marginBottom: 5 }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        fontSize: 13, color: '#555', alignItems: 'center'
                      }}>
                        <span style={{ flex: 1 }}>
                          {item.status === 'cooked' ? '✅' : item.status === 'served' ? '🍽️' : '🔥'} {item.quantity}× {item.name}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                          <DiscButton item={item} />
                          <button onClick={() => handleVoidItem(item)} style={{
                            background: '#fee2e2', border: 'none', borderRadius: 4,
                            padding: '2px 6px', cursor: 'pointer', color: '#ef4444',
                            fontSize: 10, fontWeight: 700
                          }}>VOID</button>
                          <button onClick={() => setResendPopup({ item })} style={{
                            background: '#dbeafe', border: 'none', borderRadius: 4,
                            padding: '2px 6px', cursor: 'pointer', color: '#1e40af',
                            fontSize: 10, fontWeight: 700
                          }}>RESEND</button>
                        </div>
                      </div>
                      {item.notes && (
                        <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>
                      )}
                      {item.item_note && (
                        <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>
                      )}
                      {item.discount_value > 0 && (
                        <div style={{ fontSize: 10, color: '#92400e', marginLeft: 16, fontWeight: 700 }}>
                          🏷️ {item.discount_type === 'percent' ? `${item.discount_value}% off` : `£${item.discount_value} off`}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* VOIDED items */}
                  {voided.map(item => (
                    <div key={item.id} style={{ marginBottom: 4, opacity: 0.4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ textDecoration: 'line-through' }}>{item.quantity}× {item.name}</span>
                        <span style={{ color: '#ef4444', fontSize: 11 }}>Voided</span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}

            {cart.length === 0 && existingItems.length === 0 && (
              <div style={{ textAlign: 'center', color: '#bbb', marginTop: 40, fontSize: 14 }}>
                No items yet — tap menu items to add them
              </div>
            )}
          </div>

          {/* Bottom totals. On mobile this footer is pinned to the panel bottom,
              which sits UNDER the fixed 58px tab bar — so add the same tab-bar
              clearance the scroll area uses, or the "View bill & pay" button
              (the last row) hides behind the Menu/Order tabs. */}
          <div style={{
            padding: '14px 16px',
            paddingBottom: isMobile ? 'calc(58px + env(safe-area-inset-bottom, 0px) + 14px)' : '14px',
            borderTop: '1px solid #eee', flexShrink: 0
          }}>
            {/* SEPOS-QR-ORDER-001 — customer PAID at order time; staff must not
                charge again. The bill closes itself when everything is served. */}
            {order?.source === 'qr' && (order?.payment_status === 'paid' || order?.payment_status === 'mock') && (
              <div style={{
                marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                background: '#dcfce7', border: '2px solid #16a34a',
                color: '#14532d', fontSize: 13, fontWeight: 800, textAlign: 'center',
              }}>
                📱💳 PAID ONLINE{order.payment_status === 'mock' ? ' (demo)' : ''} — do not charge. Closes itself when all items are served.
              </div>
            )}
            <div style={{ marginBottom: 10 }}>
              {order?.discount_value > 0 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8,
                    border: '2px dashed #22c55e', background: '#f0fdf4',
                    color: '#14532d', fontSize: 12, fontWeight: 600, textAlign: 'center'
                  }}>
                    {order.discount_type === 'percent' ? `${order.discount_value}%` : `£${order.discount_value}`} off{scopeLabel(order.discount_scope)} — {order.discount_reason}
                  </div>
                  <button onClick={async () => {
                    // SEPOS-VOUCHER-REMOVE-001 — if the discount is a voucher
                    // we must call the voucher-aware endpoint so the balance
                    // is restored on the voucher itself, not just cleared
                    // from the bill.
                    const isVoucher = order?.discount_reason && order.discount_reason.startsWith('Voucher ');
                    const msg = isVoucher
                      ? 'Remove voucher? Voucher balance will be restored.'
                      : 'Remove discount?';
                    if (!await confirm(msg)) return;
                    // SEPOS-046z — optimistic: totals update instantly,
                    // fetchOrder reconciles or rolls back.
                    setOrder(prev => prev ? { ...prev, discount_type: null, discount_value: 0, discount_reason: null, discount_scope: null } : prev);
                    try {
                      if (isVoucher) assertOk(await removeVoucherFromBill(orderId));
                      else assertOk(await applyDiscount(orderId, null, 0, null));
                      fetchOrder();
                    } catch (e) {
                      alert('Could not remove: ' + (e?.message || 'unknown'));
                      fetchOrder();
                    }
                  }} style={{
                    padding: '8px 12px', borderRadius: 8, border: 'none',
                    background: '#fee2e2', color: '#ef4444', cursor: 'pointer',
                    fontWeight: 700, fontSize: 12
                  }}>
                    Remove
                  </button>
                </div>
              ) : (
                <button onClick={() => {
                  const allowedRoles = ['admin', 'manager', 'supervisor'];
                  if (!allowedRoles.includes(staff?.role) && !staff?.can_discount) {
                    alert('⛔ You don\'t have permission to give discounts.\n\nA manager can enable it for you in Admin → Staff → "Can give discount".');
                    return;
                  }
                  // SEPOS-046z — DiscountModal replaces window.prompt()
                  // (disabled in Electron — this button did nothing on
                  // desktop installs).
                  setDiscountPopup({ scope: 'bill', type: 'percent', value: '10', reason: 'Manager approval', applies: 'all' });
                }} style={{
                  width: '100%', padding: '10px', borderRadius: 8,
                  border: '2px dashed #e94560', background: 'white',
                  color: '#e94560', cursor: 'pointer', fontWeight: 700, fontSize: 13
                }}>
                  + Add Bill Discount
                </button>
              )}
            </div>

            {/* SEPOS-DEPOSIT-ORDER-001 — apply a booking deposit here, like the discount.
                Gated behind deposits_enabled so venues that don't take deposits
                (and tonight's live floors) never see or reach the new path. */}
            {String(settings.deposits_enabled) === '1' && <div style={{ marginBottom: 10 }}>
              {depositApplied.amount > 0 ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <div style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8, border: '2px dashed #3b82f6',
                    background: '#eff6ff', color: '#1e3a8a', fontSize: 12, fontWeight: 600,
                    textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    🧾 Deposit applied −£{depositApplied.amount.toFixed(2)}
                  </div>
                  <button onClick={async () => {
                    if (!await confirm('Remove the deposit from this bill? The deposit keeps its balance for later.')) return;
                    try {
                      const r = await unapplyOrderDeposit(orderId);
                      if (r?.error) throw new Error(r.error);
                      await fetchDepositApplied();
                    } catch (e) { alert('Could not remove the deposit: ' + (e?.message || 'unknown')); }
                  }} style={{ padding: '8px 12px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Remove</button>
                </div>
              ) : (
                <button onClick={openDepositModal} style={{
                  width: '100%', padding: '10px', borderRadius: 8,
                  border: '2px dashed #3b82f6', background: 'white',
                  color: '#2563eb', cursor: 'pointer', fontWeight: 700, fontSize: 13
                }}>
                  + Add Deposit
                </button>
              )}
            </div>}

            {discountAmount > 0 && (
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 13, color: '#22c55e', marginBottom: 4
              }}>
                <span>Discount{scopeLabel(order?.discount_scope)}</span><span>-£{discountAmount.toFixed(2)}</span>
              </div>
            )}

            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 13, color: '#555', marginBottom: 6
            }}>
              <span>Subtotal</span><span>£{afterDiscount.toFixed(2)}</span>
            </div>

            {scEnabled && !isNonDineIn && <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: 10
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: '#555' }}>Service ({parseFloat(settings.service_charge_rate || settings.service_charge_percent || 12.5)}%)</span>
                <button onClick={toggleServiceCharge} style={{
                  background: serviceChargeRemoved ? '#fee2e2' : '#dcfce7',
                  border: 'none', borderRadius: 6, padding: '3px 10px',
                  cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  color: serviceChargeRemoved ? '#ef4444' : '#14532d'
                }}>
                  {serviceChargeRemoved ? 'Removed' : 'Remove'}
                </button>
              </div>
              <span style={{ fontSize: 13 }}>£{serviceChargeAmount.toFixed(2)}</span>
            </div>}

            <div style={{
              display: 'flex', justifyContent: 'space-between',
              marginBottom: depositApplied.amount > 0 ? 6 : 14,
              borderTop: '2px solid #eee', paddingTop: 10
            }}>
              <span style={{ fontSize: 20, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#e94560' }}>
                £{orderTotal.toFixed(2)}
              </span>
            </div>

            {/* SEPOS-DEPOSIT-ORDER-001 — deposit + balance due on the summary. */}
            {depositApplied.amount > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#2563eb', marginBottom: 4 }}>
                  <span>Deposit paid</span><span>-£{depositApplied.amount.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, fontWeight: 800 }}>
                  <span style={{ fontSize: 16 }}>Balance due</span>
                  <span style={{ fontSize: 16, color: '#e94560' }}>£{Math.max(0, orderTotal - depositApplied.amount).toFixed(2)}</span>
                </div>
              </>
            )}

            {/* Send Order — full-width, right above View Bill & Pay (moved out of
                the small header button per operator feedback). Desktop only;
                mobile keeps its own compact Send in the summary header. */}
            {!isMobile && cart.length > 0 && (
              <button onClick={sendOrder} disabled={sendBusy} style={{
                width: '100%', padding: '28px', borderRadius: 14, border: 'none',
                background: sendBusy ? '#9aa0b0' : 'var(--brand-primary, #0D1B3E)', color: 'white',
                fontSize: 24, fontWeight: 800, cursor: sendBusy ? 'wait' : 'pointer',
                marginBottom: 10, boxShadow: '0 8px 18px rgba(13,27,62,.28)'
              }}>
                {sendBusy ? 'Sending…' : `Send to kitchen — ${cart.reduce((s, c) => s + c.quantity, 0)} item${cart.reduce((s, c) => s + c.quantity, 0) > 1 ? 's' : ''}`}
              </button>
            )}

            {/* SEPOS-CLOSE-ZERO 2026-06-02 — if there's at least one item on
                the order and the live bill total is £0 (everything voided OR
                fully discounted), surface a green "Close at £0" button so
                the operator can release the table without payment. */}
            {orderTotal <= 0.01 && existingItems.length > 0 && cart.length === 0 ? (
              <button onClick={async () => {
                if (sendBusy) return alert('Still sending — try again in a second.');
                if (!await confirm('Close this table at £0?\n\nAll items are voided or fully discounted. The order will be closed and the table marked available.')) return;
                try {
                  const r = await closeOrderZero(orderId);
                  if (r && r.success) { onClose(); }
                  else                { alert('Could not close: ' + (r?.error || 'unknown error')); }
                } catch (e) { alert('Could not close: ' + (e?.message || 'unknown error')); }
              }} style={{
                width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                background: '#22c55e', color: 'white', fontSize: 16,
                fontWeight: 800, cursor: 'pointer'
              }}>
                ✓ Close at £0 — Mark table done
              </button>
            ) : (orderTotal > 0 || existingItems.some(i => !i.voided)) && (
              <button
                onClick={() => {
                  // SEPOS-046z — the bill must not open while a send is in
                  // flight, or it could be paid before those items land.
                  if (sendBusy) return;
                  // SEPOS-AUDIT-001 — unsent cart items are NOT on the server
                  // bill: this button's total includes them but BillScreen's
                  // doesn't, so paying now undercharged by the whole cart (and
                  // the items were appended after payment, never fired to the
                  // kitchen). Make staff send first.
                  if (cart.length > 0) {
                    alert(`⚠️ ${cart.reduce((s, c) => s + c.quantity, 0)} item(s) in the cart haven't been sent to the kitchen.\n\nTap "Send to kitchen" first, then take payment — otherwise they'd be missing from the bill.`);
                    return;
                  }
                  setShowBill(true);
                }}
                style={{
                  width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                  background: sendBusy ? '#f3a5b3' : '#e94560', color: 'white', fontSize: 16,
                  fontWeight: 800, cursor: sendBusy ? 'wait' : 'pointer'
                }}>
                {sendBusy ? 'Sending order…' : `View bill & pay — £${orderTotal.toFixed(2)}`}
              </button>
            )}
          </div>
        </div>

        {/* ════════════════════════════════
            MOBILE BOTTOM TAB BAR
            Only rendered on mobile (isMobile)
            Deep Navy active state
            Thai Gold top-border indicator
            Red badge for item count
            Minimum 58px height — easy to tap
            ════════════════════════════════ */}
        {isMobile && (
          <div style={{
            display: 'flex',
            borderTop: '1px solid #e0e0e0',
            background: 'white',
            flexShrink: 0,
            height: 58,
            // Pin to viewport bottom so the Menu/Order toggle is always
            // a thumb-reach away — no scrolling required to find it.
            // env(safe-area-inset-bottom) keeps it above the iOS home
            // indicator / Android nav gesture bar.
            position: 'fixed',
            bottom: 0, left: 0, right: 0,
            zIndex: 100,
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            boxSizing: 'content-box',
            boxShadow: '0 -2px 8px rgba(0,0,0,0.06)'
          }}>

            {/* Menu tab */}
            <button
              onClick={() => setMobileTab('menu')}
              style={{
                flex: 1,
                border: 'none',
                borderTop: mobileTab === 'menu' ? '3px solid var(--brand-accent,#C9A84C)' : '3px solid transparent',
                background: mobileTab === 'menu' ? 'var(--brand-primary,#0D1B3E)' : '#f8f8f8',
                color: mobileTab === 'menu' ? 'white' : '#888',
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'background 0.15s'
              }}
            >
              🍽️ Menu
            </button>

            {/* Order tab */}
            <button
              onClick={() => setMobileTab('order')}
              style={{
                flex: 1,
                border: 'none',
                borderLeft: '1px solid #e0e0e0',
                borderTop: mobileTab === 'order' ? '3px solid var(--brand-accent,#C9A84C)' : '3px solid transparent',
                background: mobileTab === 'order' ? 'var(--brand-primary,#0D1B3E)' : '#f8f8f8',
                color: mobileTab === 'order' ? 'white' : '#888',
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'background 0.15s'
              }}
            >
              📋 Order
              {badgeCount > 0 && (
                <span style={{
                  background: '#e94560',
                  color: 'white',
                  borderRadius: '50%',
                  minWidth: 22,
                  height: 22,
                  fontSize: 11,
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 4px'
                }}>
                  {badgeCount > 99 ? '99+' : badgeCount}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Kitchen message modal — shared so it works on BOTH desktop and mobile
            tills (was inside the mobile-only branch, so the desktop 📢 Message
            button did nothing). */}
        {showKitchenMsg && (
          <KitchenMessageModal
            orderId={orderId}
            tableNumber={order?.table_number}
            customerName={order?.customer_name}
            waiterName={order?.staff_name || ''}
            initialMessage={order?.customer_note || ''}
            onSaveNote={handleSaveKitchenNote}
            onClose={() => setShowKitchenMsg(false)}
          />
        )}

        {/* SEPOS-MISC-001 — MISC ITEM POPUP (off-menu / special open item) */}
        {/* SEPOS-ORDER-ARRANGE — manager PIN to unlock reorder */}
        {arrangePin && (
          <div onClick={() => setArrangePin(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 28, width: 340, maxWidth: '92vw' }}>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--brand-primary,#0D1B3E)', marginBottom: 6 }}>⇅ Arrange menu</h2>
              <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Rearranging changes the menu order on <b>every till</b>. Enter a manager PIN to continue.</p>
              <input type="password" inputMode="numeric" autoFocus value={arrangePin.pin}
                onChange={e => setArrangePin(p => ({ ...p, pin: e.target.value, err: '' }))}
                onKeyDown={e => { if (e.key === 'Enter') verifyArrangePin(); }}
                placeholder="Manager PIN" style={{ width: '100%', height: 48, padding: '0 14px', borderRadius: 10, border: '1px solid #ddd', fontSize: 18, boxSizing: 'border-box', letterSpacing: '4px', textAlign: 'center' }} />
              {arrangePin.err && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{arrangePin.err}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button onClick={() => setArrangePin(null)} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
                <button onClick={verifyArrangePin} disabled={arrangePin.busy || !arrangePin.pin} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: (arrangePin.busy || !arrangePin.pin) ? '#ccc' : 'var(--brand-primary,#0D1B3E)', color: '#fff', cursor: 'pointer', fontWeight: 800 }}>{arrangePin.busy ? 'Checking…' : 'Unlock'}</button>
              </div>
            </div>
          </div>
        )}
        {miscPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 28, width: 420, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto' }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 4 }}>
                🍽 Misc item
              </h2>
              <p style={{ color: '#888', fontSize: 13, marginBottom: 18 }}>Off-menu or special request — type the name and price.</p>

              <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 6 }}>Name</label>
              <input autoFocus value={miscPopup.name} onChange={e => setMiscPopup(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Chef's special soup" style={{ width: '100%', height: 48, padding: '0 14px', borderRadius: 10, border: '1.5px solid #ddd', fontSize: 16, boxSizing: 'border-box', marginBottom: 16 }} />

              <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 6 }}>Price</label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#888' }}>£</span>
                    <input type="number" step="0.01" min="0" value={miscPopup.price} onChange={e => setMiscPopup(p => ({ ...p, price: e.target.value }))}
                      placeholder="0.00" style={{ width: '100%', height: 48, padding: '0 12px 0 24px', borderRadius: 10, border: '1.5px solid #ddd', fontSize: 16, boxSizing: 'border-box' }} />
                  </div>
                </div>
                <div style={{ width: 130 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 6 }}>Qty</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => setMiscPopup(p => ({ ...p, quantity: Math.max(1, (Number(p.quantity) || 1) - 1) }))} style={{ width: 40, height: 48, borderRadius: 10, border: '1.5px solid #ddd', background: '#f7f7f7', cursor: 'pointer', fontSize: 20, fontWeight: 700 }}>−</button>
                    <input type="number" min="1" value={miscPopup.quantity} onChange={e => setMiscPopup(p => ({ ...p, quantity: e.target.value }))}
                      style={{ width: 44, height: 48, textAlign: 'center', borderRadius: 10, border: '1.5px solid #ddd', fontSize: 16, boxSizing: 'border-box' }} />
                    <button onClick={() => setMiscPopup(p => ({ ...p, quantity: (Number(p.quantity) || 1) + 1 }))} style={{ width: 40, height: 48, borderRadius: 10, border: '1.5px solid #ddd', background: '#f7f7f7', cursor: 'pointer', fontSize: 20, fontWeight: 700 }}>+</button>
                  </div>
                </div>
              </div>

              <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#555', marginBottom: 6 }}>Send to (prints with this section's kitchen/bar printer)</label>
              <select value={miscPopup.category_id ?? ''} onChange={e => setMiscPopup(p => ({ ...p, category_id: Number(e.target.value) }))}
                style={{ width: '100%', height: 48, padding: '0 12px', borderRadius: 10, border: '1.5px solid #ddd', fontSize: 16, boxSizing: 'border-box', marginBottom: 22, background: '#fff' }}>
                {menu.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}{cat.is_bar ? ' 🍹' : ''}</option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setMiscPopup(null)} style={{ flex: 1, padding: '14px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>Cancel</button>
                {(() => {
                  const ok = (miscPopup.name || '').trim() && (Number(miscPopup.price) || 0) > 0;
                  return (
                    <button onClick={addMiscToCart} disabled={!ok} style={{ flex: 2, padding: '14px', borderRadius: 10, border: 'none', background: ok ? '#e94560' : '#f3c3cc', color: 'white', cursor: ok ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 15 }}>
                      Add to order{(Number(miscPopup.price) || 0) > 0 ? ` · £${((Number(miscPopup.price) || 0) * Math.max(1, Math.floor(Number(miscPopup.quantity) || 1))).toFixed(2)}` : ''}
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* MODIFIER POPUP */}
        {modifierPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: 'white', borderRadius: 16, padding: 28,
              width: 420, maxWidth: '92vw', maxHeight: '80vh', overflowY: 'auto'
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 8
              }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>
                  {modifierPopup.item.name}
                </h2>
                {modifierPopup.isBar ? (
                  <div style={{
                    background: '#1e40af', color: 'white', fontSize: 11,
                    fontWeight: 700, padding: '3px 10px', borderRadius: 20
                  }}>🍹 Bar</div>
                ) : (
                  <div style={{
                    background: COURSE_COLORS[modifierPopup.course], color: 'white',
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20
                  }}>
                    {modifierPopup.course === 1 ? 'Starter' : modifierPopup.course === 2 ? 'Main' : modifierPopup.course === 3 ? 'Dessert' : 'Extra'}
                  </div>
                )}
              </div>
              <p style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>
                £{Number(modifierPopup.item.price || 0).toFixed(2)}
              </p>
              {modifierPopup.modifiers.map(group => (
                <div key={group.id} style={{ marginBottom: 20 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 8 }}>
                    {group.name}
                    <span style={{ fontWeight: 400, fontSize: 12, color: '#e94560', marginLeft: 8 }}>
                      {group.required ? 'Required' : 'Optional'} · {group.multi_select ? 'Choose multiple' : 'Choose one'}
                    </span>
                  </div>
                  {group.modifiers?.map(opt => {
                    const selected = (selectedModifiers[group.id] || []).find(m => m.id === opt.id);
                    return (
                      <div key={opt.id}
                        onClick={() => handleModifierSelect(group.id, opt, group.multi_select)}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '16px 18px', minHeight: 30, borderRadius: 12, marginBottom: 8, cursor: 'pointer',
                          border: `2px solid ${selected ? '#e94560' : '#eee'}`,
                          background: selected ? '#fff0f3' : 'white',
                        }}>
                        <span style={{ fontSize: 17, fontWeight: selected ? 700 : 500 }}>{opt.name}</span>
                        <span style={{ fontSize: 15, color: opt.extra_price > 0 ? '#e94560' : '#aaa' }}>
                          {opt.extra_price > 0 ? `+£${Number(opt.extra_price).toFixed(2)}` : 'included'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setModifierPopup(null)} style={{
                  flex: 1, padding: '14px', borderRadius: 10, border: 'none',
                  background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
                }}>Cancel</button>
                <button onClick={confirmModifiers} style={{
                  flex: 2, padding: '14px', borderRadius: 10, border: 'none',
                  background: '#e94560', color: 'white', cursor: 'pointer',
                  fontWeight: 700, fontSize: 15
                }}>Next →</button>
              </div>
            </div>
          </div>
        )}

        {/* NOTE POPUP */}
        {notePopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: 'white', borderRadius: 16, padding: 28,
              width: 400, maxWidth: '92vw'
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 12
              }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)' }}>
                  {notePopup.item.name}
                </h2>
                {notePopup.isBar ? (
                  <div style={{
                    background: '#1e40af', color: 'white', fontSize: 11,
                    fontWeight: 700, padding: '3px 10px', borderRadius: 20
                  }}>🍹 Bar</div>
                ) : (
                  <div style={{
                    background: COURSE_COLORS[notePopup.course], color: 'white',
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20
                  }}>
                    {notePopup.course === 1 ? 'Starter' : notePopup.course === 2 ? 'Main' : notePopup.course === 3 ? 'Dessert' : 'Extra'}
                  </div>
                )}
              </div>
              {notePopup.modifiers.length > 0 && (
                <div style={{
                  background: '#f8f8f8', borderRadius: 8, padding: '8px 12px',
                  marginBottom: 16, fontSize: 13, color: '#555'
                }}>
                  {notePopup.modifiers.map(m => m.name).join(', ')}
                </div>
              )}
              {!notePopup.isBar && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{
                    fontSize: 13, fontWeight: 700, color: '#555',
                    display: 'block', marginBottom: 8
                  }}>Course:</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[1, 2, 3, 4].map(c => (
                      <button key={c}
                        onClick={() => setNotePopup({ ...notePopup, course: c })}
                        style={{
                          flex: 1, padding: '10px', borderRadius: 8, border: 'none',
                          cursor: 'pointer', fontWeight: 700, fontSize: 12,
                          background: notePopup.course === c ? COURSE_COLORS[c] : '#f0f0f0',
                          color: notePopup.course === c ? 'white' : '#555',
                        }}>
                        {c === 1 ? 'Starter' : c === 2 ? 'Main' : c === 3 ? 'Dessert' : 'Extra'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* SEPOS-ALLERGEN-OPT-001 — structured dietary/allergen chips (global
                  group). Tap instead of typing into the note — prints with ⚠️. */}
              {Array.isArray(notePopup.dietaryGroups) && notePopup.dietaryGroups.some(g => (g.modifiers || []).length) && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#92400e', display: 'block', marginBottom: 8 }}>
                    ⚠️ Dietary / allergen: <span style={{ fontWeight: 400, color: '#aaa' }}>(tap any that apply)</span>
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {notePopup.dietaryGroups.flatMap(g => g.modifiers || []).map(opt => {
                      const on = (notePopup.dietary || []).some(d => d.id === opt.id);
                      return (
                        <button key={opt.id} onClick={() => toggleDietary(opt)} style={{
                          padding: '11px 14px', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 700,
                          border: on ? '2px solid #b45309' : '1.5px solid #fde68a',
                          background: on ? '#b45309' : '#fffbeb', color: on ? 'white' : '#92400e',
                        }}>{on ? '⚠️ ' : ''}{opt.name}</button>
                      );
                    })}
                  </div>
                </div>
              )}
              <label style={{
                fontSize: 13, fontWeight: 700, color: '#555',
                display: 'block', marginBottom: 8
              }}>
                Special request: <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span>
              </label>
              <textarea
                value={notePopup.note}
                onChange={e => setNotePopup({ ...notePopup, note: e.target.value })}
                placeholder="e.g. No onions, extra spicy... (use the ⚠️ chips above for allergies)"
                rows={3}
                style={{
                  width: '100%', padding: '12px', borderRadius: 8,
                  border: '1px solid #ddd', fontSize: 14,
                  boxSizing: 'border-box', resize: 'none', marginBottom: 16
                }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setNotePopup(null)} style={{
                  flex: 1, padding: '14px', borderRadius: 10, border: 'none',
                  background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
                }}>Cancel</button>
                <button onClick={confirmNote} style={{
                  flex: 2, padding: '14px', borderRadius: 10, border: 'none',
                  background: '#e94560', color: 'white', cursor: 'pointer',
                  fontWeight: 700, fontSize: 16
                }}>Add to Order</button>
              </div>
            </div>
          </div>
        )}

        {/* RESEND POPUP (SEPOS-024) */}
        {resendPopup && (
          <div style={{
            position:'fixed', top:0, left:0, right:0, bottom:0,
            background:'rgba(0,0,0,0.6)', display:'flex',
            alignItems:'center', justifyContent:'center', zIndex:1000
          }}>
            <div style={{ background:'white', borderRadius:16, padding:24, width:400, maxWidth:'92vw' }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>
                Resend to kitchen
              </h2>
              <div style={{ fontSize:14, color:'#555', marginBottom:18 }}>
                {resendPopup.item.quantity}× {resendPopup.item.name} — why is this being resent?
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {RESEND_REASONS.map(r => (
                  <button key={r} onClick={() => confirmResend(r)} style={{
                    padding:'14px 16px', borderRadius:10, border:'2px solid #dbeafe',
                    background:'white', color:'#1e40af', cursor:'pointer',
                    fontWeight:700, fontSize:15, textAlign:'left',
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#dbeafe'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
                  >🔄 {r}</button>
                ))}
              </div>
              <button onClick={() => setResendPopup(null)} style={{
                width:'100%', marginTop:14, padding:'12px', borderRadius:10, border:'none',
                background:'#f0f0f0', cursor:'pointer', fontWeight:700, fontSize:14
              }}>Cancel</button>
            </div>
          </div>
        )}

        {/* DISCOUNT POPUP (SEPOS-046z — replaces window.prompt, disabled in Electron) */}
        {discountPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: 'white', borderRadius: 16, padding: 24,
              width: 380, maxWidth: '92vw'
            }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 6 }}>
                {discountPopup.scope === 'item' ? 'Item discount' : 'Bill discount'}
              </h2>
              {discountPopup.scope === 'item' && (
                <div style={{ fontSize: 14, color: '#555', marginBottom: 16 }}>
                  {discountPopup.item.quantity}× {discountPopup.item.name}
                </div>
              )}
              {discountPopup.scope === 'bill' && (
                // SEPOS-DISCOUNT-SCOPE-001 — Drinks = categories flagged 🍹 Bar
                // (same flag that routes drinks to the bar), Food = the rest.
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                    Applies to
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {[['all', 'All'], ['food', '🍽️ Food'], ['drink', '🍹 Drinks']].map(([k, label]) => (
                      <button key={k}
                        onClick={() => setDiscountPopup({ ...discountPopup, applies: k })}
                        style={{
                          padding: '10px 0', borderRadius: 8,
                          border: '2px solid ' + ((discountPopup.applies || 'all') === k ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0'),
                          background: (discountPopup.applies || 'all') === k ? 'var(--brand-primary, #1a1a2e)' : 'white',
                          color: (discountPopup.applies || 'all') === k ? 'white' : '#555',
                          cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        }}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                  Discount type
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[['percent', '% Percentage'], ['fixed', '£ Fixed amount']].map(([t, label]) => (
                    <button key={t}
                      onClick={() => setDiscountPopup({ ...discountPopup, type: t })}
                      style={{
                        padding: '10px 12px', borderRadius: 8,
                        border: '2px solid ' + (discountPopup.type === t ? 'var(--brand-primary, #1a1a2e)' : '#e0e0e0'),
                        background: discountPopup.type === t ? 'var(--brand-primary, #1a1a2e)' : 'white',
                        color: discountPopup.type === t ? 'white' : '#555',
                        cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      }}>{label}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                  {discountPopup.type === 'percent' ? 'Discount %' : 'Discount £'}
                </label>
                <input
                  type="number" min="0" step={discountPopup.type === 'percent' ? '1' : '0.01'}
                  autoFocus
                  value={discountPopup.value}
                  onChange={(e) => setDiscountPopup({ ...discountPopup, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmDiscount(); }}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 8,
                    border: '1px solid #ddd', fontSize: 16, fontWeight: 700,
                    textAlign: 'center', boxSizing: 'border-box'
                  }}
                />
              </div>
              {discountPopup.scope === 'bill' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                    Reason
                  </label>
                  <input
                    type="text"
                    value={discountPopup.reason || ''}
                    onChange={(e) => setDiscountPopup({ ...discountPopup, reason: e.target.value })}
                    placeholder="e.g. Manager approval, loyalty..."
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box'
                    }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setDiscountPopup(null)} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
                }}>Cancel</button>
                <button onClick={confirmDiscount} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: '#22c55e', color: 'white', cursor: 'pointer',
                  fontWeight: 700, fontSize: 15
                }}>Apply</button>
              </div>
            </div>
          </div>
        )}

        {/* SEPOS-DEPOSIT-ORDER-001 — DEPOSIT POPUP */}
        {depositPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 24, width: 380, maxWidth: '92vw' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 6 }}>Apply deposit</h2>
              <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>Enter or scan the booking deposit code. It reduces the balance the customer pays.</div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>Deposit code</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" autoFocus value={depositPopup.code}
                    onChange={(e) => setDepositPopup({ ...depositPopup, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. DEP-XXXX"
                    style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 16, fontWeight: 700, textAlign: 'center', boxSizing: 'border-box', letterSpacing: '1px' }} />
                  <CodeScanButton onScan={async (v) => {
                    const code = v.toUpperCase();
                    setDepositPopup((p) => p ? { ...p, code } : p);
                    // SEPOS-SCAN-EVERYWHERE-001 — auto-lookup so the flow is
                    // scan → see money → apply. Unknown/external refs stay manual.
                    try {
                      const d = await getVoucher(code);
                      if (d && !d.error && d.type === 'deposit' && d.status === 'active' && Number(d.balance) > 0) {
                        setDepositPopup((p) => p ? { ...p, amount: Number(d.balance).toFixed(2) } : p);
                      }
                    } catch { /* offline — staff type the amount */ }
                  }} />
                </div>
              </div>
              <div style={{ marginBottom: 18 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>Amount £</label>
                <AmountInput value={depositPopup.amount}
                  onChange={(v) => setDepositPopup({ ...depositPopup, amount: v })}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 16, fontWeight: 700, textAlign: 'center', boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setDepositPopup(null)} disabled={depositBusy} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
                }}>Cancel</button>
                <button onClick={confirmDeposit} disabled={depositBusy} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: depositBusy ? '#93c5fd' : '#2563eb', color: 'white',
                  cursor: depositBusy ? 'wait' : 'pointer', fontWeight: 700, fontSize: 15
                }}>{depositBusy ? 'Applying…' : 'Apply deposit'}</button>
              </div>
            </div>
          </div>
        )}

        {/* VOID POPUP */}
        {voidPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: 'white', borderRadius: 16, padding: 24,
              width: 380, maxWidth: '92vw'
            }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brand-primary, #1a1a2e)', marginBottom: 6 }}>
                Void item
              </h2>
              <div style={{ fontSize: 14, color: '#555', marginBottom: 16 }}>
                {voidPopup.item.quantity}× {voidPopup.item.name}
              </div>

              {/* Void type — required (SEPOS-023) */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                  Void type
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {VOID_TYPES.map(t => {
                    const sel = voidPopup.type === t;
                    const isComp = t === 'Comp';
                    return (
                      <button
                        key={t}
                        onClick={() => setVoidPopup({ ...voidPopup, type: t, authError: '' })}
                        style={{
                          padding: '10px 12px', borderRadius: 8,
                          border: '2px solid ' + (sel ? (isComp ? '#8b5cf6' : 'var(--brand-primary, #1a1a2e)') : '#e0e0e0'),
                          background: sel ? (isComp ? '#ede9fe' : 'var(--brand-primary, #1a1a2e)') : 'white',
                          color: sel ? (isComp ? '#5b21b6' : 'white') : '#555',
                          cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        }}>
                        {isComp ? '🎁 ' : ''}{t}
                      </button>
                    );
                  })}
                </div>
                {voidPopup.type === 'Comp' && !MANAGER_ROLES.includes(staff?.role) && (
                  <div style={{ marginTop: 10 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#5b21b6', display: 'block', marginBottom: 4 }}>
                      Manager PIN (Comp requires approval)
                    </label>
                    <input
                      type="password"
                      value={voidPopup.managerPin || ''}
                      onChange={(e) => setVoidPopup({ ...voidPopup, managerPin: e.target.value, authError: '' })}
                      placeholder="••••"
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box'
                      }}
                    />
                  </div>
                )}
              </div>

              {voidPopup.item.quantity > 1 && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                    How many to void? (1 to {voidPopup.item.quantity})
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button onClick={() => setVoidPopup({ ...voidPopup, qty: Math.max(1, Number(voidPopup.qty) - 1) })}
                      style={{
                        width: 38, height: 38, borderRadius: 8, border: '1px solid #ddd',
                        background: '#f0f0f0', cursor: 'pointer', fontWeight: 800, fontSize: 18
                      }}>−</button>
                    <input
                      type="number"
                      min="1"
                      max={voidPopup.item.quantity}
                      value={voidPopup.qty}
                      onChange={(e) => setVoidPopup({
                        ...voidPopup,
                        qty: Math.max(1, Math.min(voidPopup.item.quantity, parseInt(e.target.value, 10) || 1))
                      })}
                      style={{
                        flex: 1, height: 38, padding: '0 12px', borderRadius: 8,
                        border: '1px solid #ddd', fontSize: 16, textAlign: 'center', fontWeight: 700
                      }}
                    />
                    <button onClick={() => setVoidPopup({ ...voidPopup, qty: Math.min(voidPopup.item.quantity, Number(voidPopup.qty) + 1) })}
                      style={{
                        width: 38, height: 38, borderRadius: 8, border: '1px solid #ddd',
                        background: '#f0f0f0', cursor: 'pointer', fontWeight: 800, fontSize: 18
                      }}>+</button>
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 6 }}>
                  Additional notes <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span>
                </label>
                <input
                  type="text"
                  value={voidPopup.reason}
                  onChange={(e) => setVoidPopup({ ...voidPopup, reason: e.target.value })}
                  placeholder="e.g. dropped on floor, customer allergic..."
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 8,
                    border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box'
                  }}
                />
              </div>

              {voidPopup.authError && (
                <div style={{
                  background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                  color: '#ef4444', padding: '8px 12px', borderRadius: 8,
                  fontSize: 13, marginBottom: 12
                }}>{voidPopup.authError}</div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setVoidPopup(null)} style={{
                  flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                  background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15
                }}>Cancel</button>
                <button onClick={confirmVoid}
                  disabled={!voidPopup.type}
                  style={{
                    flex: 1, padding: '12px', borderRadius: 10, border: 'none',
                    background: voidPopup.type ? '#ef4444' : '#fca5a5',
                    color: 'white', cursor: voidPopup.type ? 'pointer' : 'not-allowed',
                    fontWeight: 700, fontSize: 15
                  }}>Void</button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* BILL SCREEN */}
      {showBill && (
        <BillScreen
          orderId={orderId}
          onClose={() => setShowBill(false)}
          onPay={async (total, method, amountPaid, tip, tenders) => {
            // SEPOS-047c — api.js resolves {error} on HTTP 4xx/5xx instead
            // of throwing, so this MUST assertOk: without it a rejected
            // payment (order deleted elsewhere → 404, SQLite 500) fell
            // straight through to "✓ Payment received!" and closed the
            // bill while nothing was recorded. On failure: surface the
            // real error and KEEP the bill open so staff can retry.
            //
            // SEPOS-PAY-ONETAP-001 review C1 — RETURNS true/false. onPay
            // never rejects (failures alert + return), so callers that ran
            // drawer/print/toast after `await onPay(...)` celebrated FAILED
            // payments. Every caller now gates on the boolean.
            try {
              // SEPOS-AUDIT-001 — never silently append unsent cart items at
              // pay time: the payment amount was fixed from the server bill
              // WITHOUT them, so appending here undercharged by the cart value
              // and the items never fired to the kitchen. The View-bill button
              // now blocks on a non-empty cart; this is the belt-and-braces.
              if (cart.length > 0) {
                alert('⚠️ Payment NOT taken — items in the cart were never sent to the kitchen.\n\nClose the bill, tap "Send to kitchen", then pay.');
                return false;
              }
              const payRes = await payOrder(orderId, total, method, tenders);
              // SEPOS-DBLPAY-001 — the server rejects a second payment on an
              // already-closed bill (409 alreadyPaid). That means the payment
              // is ALREADY recorded (a double-tap or another device beat us),
              // so don't error and don't re-charge — just close the bill.
              if (payRes && payRes.alreadyPaid) { onClose(); return true; }
              assertOk(payRes);
            } catch (e) {
              alert(`⚠️ Payment NOT completed — the bill is still open.\n\n${e.message || 'Please try again.'}`);
              return false;
            }
            // Review M3 — no success alert here: the one-tap toast owns the
            // change/tip moment now (double confirmation defeated the point).
            onClose();
            return true;
          }}
        />
      )}
    </>
  );
}