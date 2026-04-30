import { useState, useEffect } from 'react';
import { getMenu, getOrder, addOrderItems, payOrder, getItemModifiers, voidItem, applyDiscount, fireCourse } from '../api';
import BillScreen from './BillScreen';

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
  const [showBill, setShowBill] = useState(false);
  const [serviceChargeRemoved, setServiceChargeRemoved] = useState(false);
  const [activeCourse, setActiveCourse] = useState(1);
  const [firingCourse, setFiringCourse] = useState(null);

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
        if (menuData.length > 0) setActiveCategory(menuData[0].id);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [orderId]);

  const getItemIsBar = (item) => {
    const cat = menu.find(c => c.id === item.category_id);
    return cat?.is_bar === 1;
  };

  const handleItemClick = async (item) => {
    const modifiers = await getItemModifiers(item.id);
    const isBar = getItemIsBar(item);
    const cat = menu.find(c => c.id === item.category_id);
    const course = isBar ? 0 : (cat?.course || activeCourse);
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

  const sendOrder = async () => {
    if (cart.length === 0) return alert('No items to send!');
    try {
      await addOrderItems(orderId, cart);
      setCart([]);
      await fetchOrder();
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
  const activeCatIsBar = menu.find(c => c.id === activeCategory)?.is_bar === 1;
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

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{ fontSize: 18, color: '#888' }}>Loading order...</div>
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', height: '100%', width: '100%' }}>

        {/* LEFT — Menu */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Top bar */}
          <div style={{ background: 'white', padding: '14px 20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <button onClick={async () => {
              const allVoided = existingItems.length > 0 && existingItems.every(i => i.voided);
              const isEmpty = existingItems.length === 0 && cart.length === 0;
              if (allVoided || isEmpty) await payOrder(orderId, 0, 'cancelled');
              onClose();
            }} style={{ background: '#f0f0f0', border: 'none', borderRadius: 10, padding: '10px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>
              ← Back
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', flex: 1 }}>
              Table {order?.table_number} — Order #{orderId}
              {order?.covers && <span style={{ fontSize: 14, fontWeight: 400, color: '#888', marginLeft: 8 }}>{order.covers} covers</span>}
            </h2>
            {cart.length > 0 && (
              <button onClick={sendOrder} style={{ background: '#1a1a2e', color: 'white', border: 'none', borderRadius: 10, padding: '10px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                Send Order
              </button>
            )}
          </div>

          {/* Course selector */}
          {!activeCatIsBar && (
            <div style={{ background: '#f8f8f8', padding: '10px 16px', borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
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
          <div style={{ display: 'flex', gap: 8, padding: '10px 16px', background: 'white', borderBottom: '1px solid #eee', overflowX: 'auto', flexShrink: 0 }}>
            {menu.map(cat => (
              <button key={cat.id} onClick={() => {
                setActiveCategory(cat.id);
                setActiveCourse(cat.course || 1);
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
            <div style={{ display: 'flex', gap: 6, padding: '8px 16px', background: '#fafafa', borderBottom: '1px solid #eee', overflowX: 'auto', flexShrink: 0 }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
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
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>{item.name}</div>
                      {item.description && <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>{item.description}</div>}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 17, fontWeight: 800, color: isBar ? '#1e40af' : '#e94560' }}>£{item.price.toFixed(2)}</span>
                        {totalQty > 0 && (
                          <span style={{ background: isBar ? '#1e40af' : '#e94560', color: 'white', borderRadius: '50%', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>
                            {totalQty}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>

        {/* RIGHT — Order summary */}
        <div style={{ width: 340, background: 'white', borderLeft: '1px solid #eee', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #eee', flexShrink: 0 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>Order Summary</h3>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

            {/* Bar items in cart */}
            {cartBar.length > 0 && (
              <div style={{ marginBottom: 14, background: '#eff6ff', borderRadius: 10, padding: 10, border: '1px solid #bfdbfe' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1e40af', marginBottom: 8, textTransform: 'uppercase' }}>🍹 Bar — New</div>
                {cartBar.map((item, idx) => (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ flex: 1, color: '#1a1a2e', fontWeight: 600 }}>{item.quantity}× {item.name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        <button onClick={() => removeFromCart(item.cartKey, item.item_note)} style={{ background: '#fee2e2', border: 'none', borderRadius: 4, width: 22, height: 22, cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14 }}>−</button>
                      </div>
                    </div>
                    {item.notes && <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>}
                    {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Existing bar items */}
            {existingBarItems.filter(i => !i.voided).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1e40af', marginBottom: 6, textTransform: 'uppercase' }}>🍹 Bar — Sent</div>
                {existingBarItems.filter(i => !i.voided).map(item => (
                  <div key={item.id} style={{ marginBottom: 5, fontSize: 13, color: '#555', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{item.status === 'served' ? '✅' : '🍹'} {item.quantity}× {item.name}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                      <button onClick={async () => {
                        const reason = prompt('Void reason:', 'Customer changed mind');
                        if (!reason) return;
                        await voidItem(item.id, reason);
                        await fetchOrder();
                      }} style={{ background: '#fee2e2', border: 'none', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: 10, fontWeight: 700 }}>VOID</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Cart items by course */}
            {Object.keys(cartByCourse).sort().map(course => (
              <div key={course} style={{ marginBottom: 14, background: '#f8f8f8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: COURSE_COLORS[course] || '#888', marginBottom: 6, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: COURSE_COLORS[course] || '#888' }} />
                  {COURSE_LABELS[course]} — New
                </div>
                {cartByCourse[course].map((item, idx) => (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ flex: 1, color: '#1a1a2e', fontWeight: 600 }}>{item.quantity}× {item.name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                        <button onClick={() => removeFromCart(item.cartKey, item.item_note)} style={{ background: '#fee2e2', border: 'none', borderRadius: 4, width: 22, height: 22, cursor: 'pointer', color: '#ef4444', fontWeight: 700, fontSize: 14 }}>−</button>
                      </div>
                    </div>
                    {item.notes && <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>}
                    {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>}
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: COURSE_COLORS[course] || '#888', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: COURSE_COLORS[course] || '#888' }} />
                      {COURSE_LABELS[course]}
                    </div>
                    {unfired.length > 0 && (
                      <button onClick={() => handleFireCourse(Number(course))} disabled={firingCourse === Number(course)} style={{
                        background: COURSE_COLORS[course] || '#888', color: 'white',
                        border: 'none', borderRadius: 8, padding: '6px 14px',
                        cursor: 'pointer', fontWeight: 700, fontSize: 12
                      }}>
                        {firingCourse === Number(course) ? '...' : `🔥 Fire ${COURSE_LABELS[course]}`}
                      </button>
                    )}
                  </div>

                  {unfired.map(item => (
                    <div key={item.id} style={{ marginBottom: 5, padding: '8px 10px', background: '#fef9c3', borderRadius: 8, border: '1px solid #eab308' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ color: '#713f12', fontWeight: 600 }}>⏳ {item.quantity}× {item.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#713f12' }}>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                          <button onClick={async () => {
                            const reason = prompt('Void reason:', 'Customer changed mind');
                            if (!reason) return;
                            await voidItem(item.id, reason);
                            await fetchOrder();
                          }} style={{ background: '#fee2e2', border: 'none', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: 10, fontWeight: 700 }}>VOID</button>
                        </div>
                      </div>
                      {item.notes && <div style={{ fontSize: 11, color: '#92400e', marginLeft: 8 }}>— {item.notes}</div>}
                      {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 8 }}>📝 {item.item_note}</div>}
                    </div>
                  ))}

                  {fired.map(item => (
                    <div key={item.id} style={{ marginBottom: 5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555' }}>
                        <span style={{ flex: 1 }}>
                          {item.status === 'cooked' ? '✅' : item.status === 'served' ? '🍽️' : '🔥'} {item.quantity}× {item.name}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>£{(item.unit_price * item.quantity).toFixed(2)}</span>
                          <button onClick={async () => {
                            const reason = prompt('Void reason:', 'Customer changed mind');
                            if (!reason) return;
                            await voidItem(item.id, reason);
                            await fetchOrder();
                          }} style={{ background: '#fee2e2', border: 'none', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: 10, fontWeight: 700 }}>VOID</button>
                        </div>
                      </div>
                      {item.notes && <div style={{ fontSize: 11, color: '#aaa', marginLeft: 16 }}>— {item.notes}</div>}
                      {item.item_note && <div style={{ fontSize: 11, color: '#3b82f6', marginLeft: 16 }}>📝 {item.item_note}</div>}
                    </div>
                  ))}

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

            {/* Discount */}
            <div style={{ marginBottom: 10 }}>
              {order?.discount_value > 0 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '2px dashed #22c55e', background: '#f0fdf4', color: '#14532d', fontSize: 12, fontWeight: 600, textAlign: 'center' }}>
                    {order.discount_type === 'percent' ? `${order.discount_value}%` : `£${order.discount_value}`} off — {order.discount_reason}
                  </div>
                  <button onClick={async () => {
                    if (!window.confirm('Remove discount?')) return;
                    await applyDiscount(orderId, null, 0, null);
                    await fetchOrder();
                  }} style={{ padding: '8px 12px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>
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
}} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '2px dashed #e94560', background: 'white', color: '#e94560', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
  + Add Discount
</button>
              )}
            </div>

            {discountAmount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#22c55e', marginBottom: 4 }}>
                <span>Discount</span><span>-£{discountAmount.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', marginBottom: 6 }}>
              <span>Subtotal</span><span>£{afterDiscount.toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: '#555' }}>Service (12.5%)</span>
                <button onClick={() => setServiceChargeRemoved(!serviceChargeRemoved)} style={{
                  background: serviceChargeRemoved ? '#fee2e2' : '#dcfce7',
                  border: 'none', borderRadius: 6, padding: '3px 10px',
                  cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  color: serviceChargeRemoved ? '#ef4444' : '#14532d'
                }}>{serviceChargeRemoved ? 'Removed' : 'Remove'}</button>
              </div>
              <span style={{ fontSize: 13 }}>£{serviceChargeAmount.toFixed(2)}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, borderTop: '2px solid #eee', paddingTop: 10 }}>
              <span style={{ fontSize: 20, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#e94560' }}>£{orderTotal.toFixed(2)}</span>
            </div>

            {(orderTotal > 0 || existingItems.some(i => !i.voided)) && (
  <button onClick={() => setShowBill(true)} style={{
                width: '100%', padding: '14px', borderRadius: 12, border: 'none',
                background: '#e94560', color: 'white', fontSize: 16, fontWeight: 800, cursor: 'pointer'
              }}>
                View Bill & Pay — £{orderTotal.toFixed(2)}
              </button>
            )}
          </div>
        </div>

        {/* MODIFIER POPUP */}
        {modifierPopup && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 28, width: 420, maxHeight: '80vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>{modifierPopup.item.name}</h2>
                {modifierPopup.isBar ? (
                  <div style={{ background: '#1e40af', color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🍹 Bar</div>
                ) : (
                  <div style={{ background: COURSE_COLORS[modifierPopup.course], color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>
                    {modifierPopup.course === 1 ? 'Starter' : modifierPopup.course === 2 ? 'Main' : modifierPopup.course === 3 ? 'Dessert' : 'Extra'}
                  </div>
                )}
              </div>
              <p style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>£{modifierPopup.item.price.toFixed(2)}</p>
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
                      <div key={opt.id} onClick={() => handleModifierSelect(group.id, opt, group.multi_select)} style={{
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
                <button onClick={() => setModifierPopup(null)} style={{ flex: 1, padding: '14px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>Cancel</button>
                <button onClick={confirmModifiers} style={{ flex: 2, padding: '14px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>Next →</button>
              </div>
            </div>
          </div>
        )}

        {/* NOTE POPUP */}
        {notePopup && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 28, width: 400 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>{notePopup.item.name}</h2>
                {notePopup.isBar ? (
                  <div style={{ background: '#1e40af', color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🍹 Bar</div>
                ) : (
                  <div style={{ background: COURSE_COLORS[notePopup.course], color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>
                    {notePopup.course === 1 ? 'Starter' : notePopup.course === 2 ? 'Main' : notePopup.course === 3 ? 'Dessert' : 'Extra'}
                  </div>
                )}
              </div>
              {notePopup.modifiers.length > 0 && (
                <div style={{ background: '#f8f8f8', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 13, color: '#555' }}>
                  {notePopup.modifiers.map(m => m.name).join(', ')}
                </div>
              )}
              {!notePopup.isBar && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 8 }}>Course:</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[1, 2, 3, 4].map(c => (
                      <button key={c} onClick={() => setNotePopup({ ...notePopup, course: c })} style={{
                        flex: 1, padding: '10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                        fontWeight: 700, fontSize: 12,
                        background: notePopup.course === c ? COURSE_COLORS[c] : '#f0f0f0',
                        color: notePopup.course === c ? 'white' : '#555',
                      }}>
                        {c === 1 ? 'Starter' : c === 2 ? 'Main' : c === 3 ? 'Dessert' : 'Extra'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label style={{ fontSize: 13, fontWeight: 700, color: '#555', display: 'block', marginBottom: 8 }}>
                Special request: <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span>
              </label>
              <textarea
                value={notePopup.note}
                onChange={e => setNotePopup({ ...notePopup, note: e.target.value })}
                placeholder="e.g. No onions, extra spicy, allergy — no nuts..."
                rows={3}
                style={{ width: '100%', padding: '12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box', resize: 'none', marginBottom: 16 }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setNotePopup(null)} style={{ flex: 1, padding: '14px', borderRadius: 10, border: 'none', background: '#f0f0f0', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>Cancel</button>
                <button onClick={confirmNote} style={{ flex: 2, padding: '14px', borderRadius: 10, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 16 }}>Add to Order</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* BILL SCREEN — outside the flex div, renders on top of everything */}
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