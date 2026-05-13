import { useState, useEffect } from 'react';
import { getMenu, getOrder, addOrderItems, payOrder, getItemModifiers, voidItem, applyDiscount, fireCourse, resendToKitchen, applyItemDiscount, loginStaff } from '../api';
import BillScreen from './BillScreen';
import DeleteOrderModal from '../components/DeleteOrderModal';

const COURSE_LABELS = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };
const COURSE_COLORS = { 1: '#3b82f6', 2: '#e94560', 3: '#8b5cf6', 4: '#22c55e' };

export default function OrderScreen({ orderId, tableId, staff, onClose }) {
  const [menu, setMenu] = useState([]);
  const [order, setOrder] = useState(null);
  const [cart, setCart] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [activeSubcat, setActiveSubcat] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modifierPopup, setModifierPopup] = useState(null);
  const [selectedModifiers, setSelectedModifiers] = useState({});
  const [notePopup, setNotePopup] = useState(null);
  const [voidPopup, setVoidPopup] = useState(null);
  const [resendPopup, setResendPopup] = useState(null);
  const [showBill, setShowBill] = useState(false);
  const [showDelete, setShowDelete] = useState(false);   // SEPOS-042 — manager-gated order delete
  const [serviceChargeRemoved, setServiceChargeRemoved] = useState(false);
  const [activeCourse, setActiveCourse] = useState(1);
  const [firingCourse, setFiringCourse] = useState(null);

  // ── Sandy: Mobile layout state ──
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mobileTab, setMobileTab] = useState('menu');

  const fetchOrder = async () => {
    const orderData = await getOrder(orderId);
    setOrder(orderData);
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [menuData, orderData] = await Promise.all([getMenu(), getOrder(orderId)]);
        setMenu(menuData);
        setOrder(orderData);
        if (menuData.length > 0) {
          setActiveCategory(menuData[0].id);
          setActiveCourse(menuData[0].default_course || 1);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [orderId]);

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
    const modifiers = await getItemModifiers(item.id);
    const isBar = getItemIsBar(item);
    const cat = menu.find(c => c.id === item.category_id);
    const course = isBar ? 0 : (cat?.default_course || activeCourse);
    if (modifiers && modifiers.length > 0) {
      setSelectedModifiers({});
      setModifierPopup({ item, modifiers, course, isBar });
    } else {
      setNotePopup({ item, modifiers: [], course, isBar, note: '' });
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
    const { item, modifiers, course, isBar } = modifierPopup;
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
    setNotePopup({ item, modifiers: chosen, course, isBar, note: '' });
  };

  const confirmNote = () => {
    const { item, modifiers, course, isBar, note } = notePopup;
    addToCart(item, modifiers, course, isBar, note);
    setNotePopup(null);
  };

  const addToCart = (item, chosenModifiers, course, isBar, note) => {
    const extraPrice = chosenModifiers.reduce((sum, m) => sum + (m.extra_price || 0), 0);
    const modifierNames = chosenModifiers.map(m => m.name).join(', ');
    const cartKey = item.id + '_' + modifierNames + '_' + course;
    setCart(prev => {
      const existing = prev.find(c => c.cartKey === cartKey && c.item_note === note);
      if (existing && !note) {
        return prev.map(c => c.cartKey === cartKey ? { ...c, quantity: c.quantity + 1 } : c);
      }
      return [...prev, {
        cartKey, menu_item_id: item.id, name: item.name,
        unit_price: item.price + extraPrice, quantity: 1,
        notes: modifierNames, item_note: note || '',
        course: isBar ? 0 : course,
        is_bar: isBar ? 1 : 0,
        modifiers: chosenModifiers
      }];
    });
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
    await voidItem(item.id, finalReason, n, type);
    await fetchOrder();
  };

  // SEPOS-024 — resend with reason (Not Cooked / Wrong Item / Missing Item / Remake)
  const RESEND_REASONS = ['Not Cooked', 'Wrong Item', 'Missing Item', 'Remake'];
  const confirmResend = async (reason) => {
    if (!resendPopup) return;
    const { item } = resendPopup;
    setResendPopup(null);
    await resendToKitchen(orderId, [item.id], reason);
    await fetchOrder();
  };

  const sendOrder = async () => {
    if (cart.length === 0) return alert('No items to send!');
    try {
      await addOrderItems(orderId, cart);
      setCart([]);
      await fetchOrder();
      // Sandy: switch to Order tab on mobile so waiter can see items and fire courses
      if (isMobile) setMobileTab('order');
      alert('Order saved! Use 🔥 Fire buttons to send courses to kitchen.');
    } catch (err) {
      alert('Failed to send order.');
    }
  };

  const handleFireCourse = async (course) => {
    setFiringCourse(course);
    try {
      await fireCourse(orderId, course);
      await fetchOrder();
      alert(`🔥 ${COURSE_LABELS[course]} fired to kitchen!`);
    } catch (err) {
      alert('Failed to fire course.');
    } finally {
      setFiringCourse(null);
    }
  };

  // ── Item discount — apply or remove ──
  const handleItemDiscount = async (item) => {
    const allowedRoles = ['admin', 'manager', 'supervisor'];
    if (!allowedRoles.includes(staff?.role)) {
      alert('⛔ Only Admin, Manager or Supervisor can apply discounts!');
      return;
    }
    if (item.discount_value > 0) {
      const remove = window.confirm(
        `This item has a discount:\n${item.discount_type === 'percent' ? item.discount_value + '%' : '£' + item.discount_value} off\n\nOK = Remove discount\nCancel = Change discount`
      );
      if (remove) {
        await applyItemDiscount(item.id, null, 0);
        await fetchOrder();
        return;
      }
    }
    const type = window.confirm('OK = percentage %\nCancel = fixed £ amount') ? 'percent' : 'fixed';
    const value = prompt(type === 'percent' ? 'Discount %:' : 'Discount £:', '10');
    if (!value) return;
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return alert('Invalid value!');
    await applyItemDiscount(item.id, type, num);
    await fetchOrder();
  };

  const cartTotal = cart.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const subtotal = (order?.total || 0) + cartTotal;
  const discountAmount = order?.discount_value > 0
    ? order.discount_type === 'percent' ? subtotal * (order.discount_value / 100) : order.discount_value
    : 0;
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const serviceChargeAmount = serviceChargeRemoved ? 0 : afterDiscount * 0.125;
  const orderTotal = afterDiscount + serviceChargeAmount;

  const activeItems = menu.find(c => c.id === activeCategory)?.items || [];
  const activeSubs = menu.find(c => c.id === activeCategory)?.subcategories || [];
  const activeCatIsBar = !!menu.find(c => c.id === activeCategory)?.is_bar;
  const existingItems = order?.items || [];

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

        {/* ════════════════════════════════
            LEFT — Menu
            Desktop: always visible, flex: 1
            Mobile:  visible only on 'menu' tab
            ════════════════════════════════ */}
        <div style={{
          flex: 1,
          display: isMobile && mobileTab !== 'menu' ? 'none' : 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>

          {/* Top bar */}
          <div style={{
            background: 'white', padding: '14px 20px', borderBottom: '1px solid #eee',
            display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
          }}>
            <button onClick={async () => {
              const allVoided = existingItems.length > 0 && existingItems.every(i => i.voided);
              const isEmpty = existingItems.length === 0 && cart.length === 0;
              if (allVoided || isEmpty) await payOrder(orderId, 0, 'cancelled');
              onClose();
            }} style={{
              background: '#f0f0f0', border: 'none', borderRadius: 10,
              padding: '10px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 15
            }}>
              ← Back
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', flex: 1 }}>
              Table {order?.table_number} — Order #{orderId}
              {order?.covers && (
                <span style={{ fontSize: 14, fontWeight: 400, color: '#888', marginLeft: 8 }}>
                  {order.covers} covers
                </span>
              )}
            </h2>
            {cart.length > 0 && (
              <button onClick={sendOrder} style={{
                background: '#1a1a2e', color: 'white', border: 'none',
                borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
                fontWeight: 700, fontSize: 14
              }}>
                Send Order
              </button>
            )}
            {/* SEPOS-042 — manager-PIN-gated delete for open orders.
                Useful for test rings, mis-keyed tables, etc. */}
            <button
              onClick={() => setShowDelete(true)}
              title="Delete this order (manager PIN required)"
              style={{
                background: 'transparent', border: '1px solid #fecaca', color: '#dc2626',
                borderRadius: 10, padding: '10px 14px', cursor: 'pointer',
                fontWeight: 700, fontSize: 14,
              }}
            >🗑️ Delete</button>
          </div>

          {showDelete && (
            <DeleteOrderModal
              order={order ? { ...order, id: orderId } : { id: orderId }}
              onClose={() => setShowDelete(false)}
              onDeleted={() => { setShowDelete(false); onClose(); }}
            />
          )}

          {/* Course selector */}
          {!activeCatIsBar && (
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
          )}

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
                background: activeCategory === cat.id ? (cat.is_bar ? '#1e40af' : '#1a1a2e') : '#f0f0f0',
                color: activeCategory === cat.id ? 'white' : '#555',
              }}>
                {cat.name} {cat.is_bar ? '🍹' : ''}
              </button>
            ))}
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
                background: !activeSubcat ? '#1a1a2e' : '#e0e0e0',
                color: !activeSubcat ? 'white' : '#555'
              }}>All</button>
              {activeSubs.map(sub => (
                <button key={sub.id} onClick={() => setActiveSubcat(sub.id)} style={{
                  padding: '7px 16px', borderRadius: 16, border: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
                  background: activeSubcat === sub.id ? '#3b82f6' : '#e0e0e0',
                  color: activeSubcat === sub.id ? 'white' : '#555'
                }}>{sub.name}</button>
              ))}
            </div>
          )}

          {/* Menu items grid */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#f5f5f5' }}>
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
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>
                        {item.name}
                      </div>
                      {item.description && (
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                          {item.description}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 17, fontWeight: 800, color: isBar ? '#1e40af' : '#e94560' }}>
                          £{item.price.toFixed(2)}
                        </span>
                        {totalQty > 0 && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: 'flex', alignItems: 'center',
                              background: '#0D1B3E', color: '#C9A84C',
                              borderRadius: 16, height: 28, overflow: 'hidden',
                              boxShadow: '0 1px 4px rgba(13,27,62,0.25)',
                            }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); decrementInCart(item); }}
                              style={{
                                background: 'transparent', border: 'none', color: '#C9A84C',
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
                                background: 'transparent', border: 'none', color: '#C9A84C',
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

        {/* ════════════════════════════════
            RIGHT — Order Summary
            Desktop: fixed 340px, always visible
            Mobile:  full width, visible only on 'order' tab
            ════════════════════════════════ */}
        <div style={{
          width: isMobile ? '100%' : 340,
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
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
                    Table {order?.table_number}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>
                    Order #{orderId}{order?.covers ? ` · ${order.covers} covers` : ''}
                  </div>
                </div>
                {cart.length > 0 && (
                  <button onClick={sendOrder} style={{
                    background: '#0D1B3E', color: 'white', border: 'none',
                    borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
                    fontWeight: 700, fontSize: 14
                  }}>
                    ✓ Send Order
                  </button>
                )}
              </div>
            ) : (
              <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>Order Summary</h3>
            )}
          </div>

          {/* Scrollable order items */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

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
                      <span style={{ flex: 1, color: '#1a1a2e', fontWeight: 600 }}>
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
                      <span style={{ flex: 1, color: '#1a1a2e', fontWeight: 600 }}>
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

          {/* Bottom totals */}
          <div style={{ padding: '14px 16px', borderTop: '1px solid #eee', flexShrink: 0 }}>
            <div style={{ marginBottom: 10 }}>
              {order?.discount_value > 0 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8,
                    border: '2px dashed #22c55e', background: '#f0fdf4',
                    color: '#14532d', fontSize: 12, fontWeight: 600, textAlign: 'center'
                  }}>
                    {order.discount_type === 'percent' ? `${order.discount_value}%` : `£${order.discount_value}`} off — {order.discount_reason}
                  </div>
                  <button onClick={async () => {
                    if (!window.confirm('Remove discount?')) return;
                    await applyDiscount(orderId, null, 0, null);
                    await fetchOrder();
                  }} style={{
                    padding: '8px 12px', borderRadius: 8, border: 'none',
                    background: '#fee2e2', color: '#ef4444', cursor: 'pointer',
                    fontWeight: 700, fontSize: 12
                  }}>
                    Remove
                  </button>
                </div>
              ) : (
                <button onClick={async () => {
                  const allowedRoles = ['admin', 'manager', 'supervisor'];
                  if (!allowedRoles.includes(staff?.role)) {
                    alert('⛔ Only Admin, Manager or Supervisor can apply discounts!\n\nPlease ask a manager to authorise.');
                    return;
                  }
                  const type = window.confirm('OK = percentage\nCancel = fixed amount') ? 'percent' : 'fixed';
                  const value = prompt(type === 'percent' ? 'Enter %:' : 'Enter £:', '10');
                  if (!value) return;
                  const num = parseFloat(value);
                  if (isNaN(num) || num <= 0) return alert('Invalid value!');
                  const reason = prompt('Reason:', 'Manager approval');
                  if (!reason) return;
                  await applyDiscount(orderId, type, num, reason);
                  await fetchOrder();
                }} style={{
                  width: '100%', padding: '10px', borderRadius: 8,
                  border: '2px dashed #e94560', background: 'white',
                  color: '#e94560', cursor: 'pointer', fontWeight: 700, fontSize: 13
                }}>
                  + Add Bill Discount
                </button>
              )}
            </div>

            {discountAmount > 0 && (
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 13, color: '#22c55e', marginBottom: 4
              }}>
                <span>Discount</span><span>-£{discountAmount.toFixed(2)}</span>
              </div>
            )}

            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 13, color: '#555', marginBottom: 6
            }}>
              <span>Subtotal</span><span>£{afterDiscount.toFixed(2)}</span>
            </div>

            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: 10
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: '#555' }}>Service (12.5%)</span>
                <button onClick={() => setServiceChargeRemoved(!serviceChargeRemoved)} style={{
                  background: serviceChargeRemoved ? '#fee2e2' : '#dcfce7',
                  border: 'none', borderRadius: 6, padding: '3px 10px',
                  cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  color: serviceChargeRemoved ? '#ef4444' : '#14532d'
                }}>
                  {serviceChargeRemoved ? 'Removed' : 'Remove'}
                </button>
              </div>
              <span style={{ fontSize: 13 }}>£{serviceChargeAmount.toFixed(2)}</span>
            </div>

            <div style={{
              display: 'flex', justifyContent: 'space-between', marginBottom: 14,
              borderTop: '2px solid #eee', paddingTop: 10
            }}>
              <span style={{ fontSize: 20, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#e94560' }}>
                £{orderTotal.toFixed(2)}
              </span>
            </div>

            {(orderTotal > 0 || existingItems.some(i => !i.voided)) && (
              <button onClick={() => setShowBill(true)} style={{
                width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                background: '#e94560', color: 'white', fontSize: 16,
                fontWeight: 800, cursor: 'pointer'
              }}>
                View Bill & Pay — £{orderTotal.toFixed(2)}
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
            height: 58
          }}>

            {/* Menu tab */}
            <button
              onClick={() => setMobileTab('menu')}
              style={{
                flex: 1,
                border: 'none',
                borderTop: mobileTab === 'menu' ? '3px solid #C9A84C' : '3px solid transparent',
                background: mobileTab === 'menu' ? '#0D1B3E' : '#f8f8f8',
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
                borderTop: mobileTab === 'order' ? '3px solid #C9A84C' : '3px solid transparent',
                background: mobileTab === 'order' ? '#0D1B3E' : '#f8f8f8',
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
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>
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
                £{modifierPopup.item.price.toFixed(2)}
              </p>
              {modifierPopup.modifiers.map(group => (
                <div key={group.id} style={{ marginBottom: 20 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', marginBottom: 8 }}>
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
                          padding: '12px 16px', borderRadius: 10, marginBottom: 6, cursor: 'pointer',
                          border: `2px solid ${selected ? '#e94560' : '#eee'}`,
                          background: selected ? '#fff0f3' : 'white',
                        }}>
                        <span style={{ fontSize: 15, fontWeight: selected ? 700 : 400 }}>{opt.name}</span>
                        <span style={{ fontSize: 14, color: opt.extra_price > 0 ? '#e94560' : '#aaa' }}>
                          {opt.extra_price > 0 ? `+£${opt.extra_price.toFixed(2)}` : 'included'}
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
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>
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
              <label style={{
                fontSize: 13, fontWeight: 700, color: '#555',
                display: 'block', marginBottom: 8
              }}>
                Special request: <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span>
              </label>
              <textarea
                value={notePopup.note}
                onChange={e => setNotePopup({ ...notePopup, note: e.target.value })}
                placeholder="e.g. No onions, extra spicy, allergy — no nuts..."
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
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1a1a2e', marginBottom:6 }}>
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
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 6 }}>
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
                          border: '2px solid ' + (sel ? (isComp ? '#8b5cf6' : '#1a1a2e') : '#e0e0e0'),
                          background: sel ? (isComp ? '#ede9fe' : '#1a1a2e') : 'white',
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
          onPay={async (total, method, amountPaid, tip) => {
            if (cart.length > 0) await addOrderItems(orderId, cart);
            await payOrder(orderId, total, method);
            const change = amountPaid - total;
            if (method === 'Cash' && change > 0) {
              alert(`✓ Payment received!\nChange to give: £${change.toFixed(2)}`);
            } else if (tip > 0) {
              alert(`✓ Payment received!\nTip: £${tip.toFixed(2)} — thank you!`);
            }
            onClose();
          }}
        />
      )}
    </>
  );
}