/*
 * SiamEPOS Takeaway Widget — SEPOS-034
 * Public ordering widget for embedding on the restaurant's website.
 *
 *   <script src="https://app.siamepos.co.uk/takeaway-widget.js"></script>
 *   <button data-siamepos-takeaway>Order Takeaway</button>
 *
 * Click the button → opens a modal with the full ordering flow:
 *   1. Pickup time   (ASAP or scheduled)
 *   2. Menu + cart
 *   3. Customer details
 *   4. Mock payment  (no Stripe yet — SEPOS-040)
 *   5. Success       (order number + confirmation note)
 */
(function () {
  'use strict';

  const API = (function () {
    // Use the host this widget was served from. Same fallback as the
    // booking widget so we work from any embedding domain.
    try {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src || '';
        if (src.indexOf('takeaway-widget.js') !== -1) {
          return new URL(src).origin;
        }
      }
    } catch (e) {}
    return 'https://restaurant-epos-production.up.railway.app';
  })();

  // ── Styles ──────────────────────────────────────────────────────
  const css = `
    .tw-fab { position:fixed; bottom:24px; right:24px;
      background:#C9A84C; color:#0D1B3E; border:none; border-radius:30px;
      padding:14px 24px; font-weight:800; font-size:15px; cursor:pointer;
      box-shadow:0 6px 18px rgba(13,27,62,0.3); z-index:9998;
      font-family:system-ui,-apple-system,sans-serif;
    }
    .tw-fab:hover { background:#d5b85e; }
    .tw-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999;
      display:flex; align-items:center; justify-content:center; padding:0;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    }
    .tw-modal { background:white; border-radius:18px; width:100%; max-width:920px;
      max-height:92vh; overflow:hidden; display:flex; flex-direction:column;
      box-shadow:0 12px 40px rgba(0,0,0,0.4);
    }
    @media (max-width: 760px) { .tw-modal { max-width:100%; max-height:100vh; border-radius:0; } }
    .tw-header { background:#0D1B3E; color:white; padding:18px 24px;
      display:flex; align-items:center; justify-content:space-between;
    }
    .tw-title { font-family:Georgia,serif; font-size:20px; font-weight:700; color:#C9A84C; }
    .tw-close { background:transparent; border:none; color:white; font-size:24px;
      cursor:pointer; line-height:1; padding:0 6px;
    }
    .tw-progress { display:flex; gap:6px; padding:12px 24px; background:#f8f8f8; }
    .tw-step { flex:1; height:4px; border-radius:2px; background:#e0e0e0; }
    .tw-step.active { background:#C9A84C; }
    .tw-step.done   { background:#22c55e; }
    .tw-body { flex:1; overflow:auto; padding:24px; }
    .tw-h2 { font-size:18px; font-weight:700; color:#1a1a2e; margin:0 0 12px; }
    .tw-help { color:#888; font-size:13px; margin-bottom:18px; line-height:1.5; }

    .tw-row { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .tw-btn { padding:14px 18px; border-radius:10px; border:2px solid transparent;
      background:white; color:#1a1a2e; font-weight:700; font-size:14px;
      cursor:pointer; transition:background 0.15s, border-color 0.15s;
      font-family:inherit;
    }
    .tw-btn-primary { background:#0D1B3E; color:white; border-color:#0D1B3E; }
    .tw-btn-primary:hover { background:#1a2a55; }
    .tw-btn-gold { background:#C9A84C; color:#0D1B3E; border-color:#C9A84C; }
    .tw-btn-gold:hover { background:#d5b85e; }
    .tw-btn-ghost { background:white; border-color:#e0e0e0; color:#555; }
    .tw-btn-ghost:hover { background:#f5f5f5; }
    .tw-btn[disabled] { opacity:0.5; cursor:not-allowed; }
    .tw-btn.tw-selected { border-color:#C9A84C; background:#fef9eb; color:#1a1a2e; }

    .tw-input { width:100%; padding:12px 14px; border-radius:10px;
      border:1px solid #ddd; font-size:15px; box-sizing:border-box; font-family:inherit;
    }
    .tw-input:focus { outline:none; border-color:#C9A84C; }
    .tw-label { display:block; font-size:12px; font-weight:700; color:#888;
      text-transform:uppercase; letter-spacing:0.05em; margin:14px 0 6px;
    }
    .tw-error { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35);
      color:#991b1b; padding:10px 14px; border-radius:8px;
      font-size:13px; margin-bottom:14px;
    }

    /* Menu / cart split layout */
    .tw-split { display:flex; gap:20px; align-items:flex-start; }
    @media (max-width: 760px) { .tw-split { flex-direction:column; } }
    .tw-menu { flex:1; min-width:0; }
    .tw-cats { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
    .tw-cat { padding:8px 14px; border-radius:20px; border:1px solid #e0e0e0;
      background:white; cursor:pointer; font-size:13px; font-weight:600; color:#555;
    }
    .tw-cat.active { background:#0D1B3E; color:white; border-color:#0D1B3E; }
    .tw-items { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media (max-width: 480px) { .tw-items { grid-template-columns:1fr; } }
    .tw-item { background:white; border:1px solid #eee; border-radius:12px;
      padding:14px; cursor:pointer; transition:border-color 0.15s, transform 0.1s;
    }
    .tw-item:hover { border-color:#C9A84C; transform:translateY(-1px); }
    .tw-item-name { font-weight:700; color:#1a1a2e; margin-bottom:4px; }
    .tw-item-desc { font-size:12px; color:#888; margin-bottom:8px; line-height:1.4;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    }
    .tw-item-foot { display:flex; justify-content:space-between; align-items:center; }
    .tw-item-price { font-weight:800; color:#e94560; }
    .tw-item-add { background:#0D1B3E; color:#C9A84C; border:none; border-radius:50%;
      width:30px; height:30px; font-size:18px; font-weight:800; cursor:pointer;
    }

    .tw-cart { width:300px; flex-shrink:0; background:#f8f8f8; border-radius:14px;
      padding:14px; position:sticky; top:0;
    }
    @media (max-width: 760px) { .tw-cart { width:100%; position:static; } }
    .tw-cart-title { font-size:12px; font-weight:700; color:#888;
      text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px;
    }
    .tw-cart-empty { color:#bbb; text-align:center; padding:30px 0; font-size:13px; }
    .tw-cart-row { display:flex; align-items:center; gap:8px; padding:8px 0; font-size:13px;
      border-bottom:1px solid #eee;
    }
    .tw-cart-row:last-of-type { border-bottom:none; }
    .tw-cart-name { flex:1; color:#1a1a2e; font-weight:600; }
    .tw-cart-qtypill { display:flex; align-items:center; background:#0D1B3E;
      color:#C9A84C; border-radius:14px; height:24px; overflow:hidden;
    }
    .tw-cart-qtypill button { background:transparent; color:#C9A84C; border:none;
      width:24px; cursor:pointer; font-weight:800;
    }
    .tw-cart-qtypill span { padding:0 6px; font-weight:800; min-width:14px; text-align:center; }
    .tw-cart-price { min-width:50px; text-align:right; color:#555; }
    .tw-cart-total { display:flex; justify-content:space-between;
      font-size:16px; font-weight:800; margin-top:14px; padding-top:14px;
      border-top:2px solid #ddd;
    }
    .tw-cart-total-amount { color:#e94560; }

    .tw-foot { padding:18px 24px; border-top:1px solid #eee; display:flex;
      gap:10px; justify-content:flex-end; background:white;
    }
    .tw-success { text-align:center; padding:40px 24px; }
    .tw-success-tick { font-size:64px; margin-bottom:14px; }
    .tw-success-num { font-size:32px; font-weight:800; color:#C9A84C;
      font-family:'SF Mono',Menlo,monospace; letter-spacing:2px; margin:14px 0;
    }
  `;
  function injectStyles() {
    if (document.getElementById('tw-styles')) return;
    const s = document.createElement('style');
    s.id = 'tw-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── State ───────────────────────────────────────────────────────
  let state = {
    step: 1,            // 1 pickup, 2 menu, 3 details, 4 pay, 5 success
    settings: null,
    menu: [],
    activeCategory: null,
    cart: [],           // [{ menu_item_id, name, unit_price, quantity }]
    pickupKind: 'asap',
    pickupISO: null,
    customer: { name:'', phone:'', email:'' },
    error: '',
    orderResult: null,
  };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return '£' + Number(n || 0).toFixed(2); }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function cartTotal() {
    return state.cart.reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0);
  }
  function addToCart(item) {
    const existing = state.cart.find(c => c.menu_item_id === item.id);
    if (existing) existing.quantity += 1;
    else state.cart.push({ menu_item_id: item.id, name: item.name, unit_price: Number(item.price || 0), quantity: 1 });
    render();
  }
  function changeQty(menu_item_id, delta) {
    const it = state.cart.find(c => c.menu_item_id === menu_item_id);
    if (!it) return;
    it.quantity += delta;
    if (it.quantity <= 0) state.cart = state.cart.filter(c => c.menu_item_id !== menu_item_id);
    render();
  }

  // Compute pickup time ISO from kind + offset
  function computePickupISO() {
    const d = new Date();
    if (state.pickupKind === 'asap') {
      d.setMinutes(d.getMinutes() + 25);  // assume 25 min prep
    } else {
      // pickupISO is set by the time-picker step directly
      return state.pickupISO;
    }
    return d.toISOString();
  }

  // ── Steps ───────────────────────────────────────────────────────
  function renderStep1() {
    const opening  = state.settings?.opening_time      || '11:00';
    const closing  = state.settings?.last_booking_time || '21:30';
    const today    = new Date();
    const minTime  = new Date(today.getTime() + 25 * 60 * 1000);  // 25 min from now
    const slots = [];
    const [oh, om] = String(opening).slice(0,5).split(':').map(Number);
    const [ch, cm] = String(closing).slice(0,5).split(':').map(Number);
    const cur = new Date(today); cur.setHours(oh, om, 0, 0);
    const close = new Date(today); close.setHours(ch, cm, 0, 0);
    while (cur <= close) {
      if (cur >= minTime) {
        const iso = cur.toISOString();
        const lbl = cur.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
        slots.push({ iso, lbl });
      }
      cur.setMinutes(cur.getMinutes() + 15);
    }

    return `
      <h2 class="tw-h2">When would you like to collect?</h2>
      <div class="tw-help">Open ${String(opening).slice(0,5)} – ${String(closing).slice(0,5)} today. Allow ~25 min preparation time.</div>
      <div class="tw-row">
        <button class="tw-btn ${state.pickupKind==='asap' ? 'tw-btn-gold' : 'tw-btn-ghost'}" id="tw-asap">⚡ ASAP (~25 min)</button>
        <button class="tw-btn ${state.pickupKind==='scheduled' ? 'tw-btn-gold' : 'tw-btn-ghost'}" id="tw-sched">🕐 Pick a time</button>
      </div>
      ${state.pickupKind === 'scheduled' ? `
        <div style="margin-top:10px; max-height:240px; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(80px,1fr)); gap:6px;">
          ${slots.length === 0 ? '<div style="color:#888;font-size:13px;">No slots left today — pick ASAP.</div>' :
            slots.map(s => `<button class="tw-btn ${state.pickupISO===s.iso ? 'tw-btn-gold' : 'tw-btn-ghost'} tw-slot" data-iso="${s.iso}" style="padding:10px;font-size:13px;">${s.lbl}</button>`).join('')}
        </div>
      ` : ''}
      ${state.error ? `<div class="tw-error" style="margin-top:14px;">${escapeHtml(state.error)}</div>` : ''}
    `;
  }

  function renderStep2() {
    if (state.menu.length === 0) {
      return `<div style="text-align:center;padding:60px 0;color:#888;">Loading menu…</div>`;
    }
    const active = state.menu.find(c => c.id === state.activeCategory) || state.menu[0];
    state.activeCategory = active.id;
    return `
      <div class="tw-split">
        <div class="tw-menu">
          <div class="tw-cats">
            ${state.menu.map(c => `
              <button class="tw-cat ${c.id===state.activeCategory ? 'active' : ''}" data-cat="${c.id}">${escapeHtml(c.name)}</button>
            `).join('')}
          </div>
          <div class="tw-items">
            ${(active.items || []).filter(i => i.is_available).map(i => `
              <div class="tw-item" data-add="${i.id}">
                <div class="tw-item-name">${escapeHtml(i.name)}</div>
                ${i.description ? `<div class="tw-item-desc">${escapeHtml(i.description)}</div>` : ''}
                <div class="tw-item-foot">
                  <span class="tw-item-price">${fmt(i.price)}</span>
                  <button class="tw-item-add">+</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="tw-cart">
          <div class="tw-cart-title">🛒 Your order</div>
          ${state.cart.length === 0
            ? '<div class="tw-cart-empty">Tap items to add them to your cart</div>'
            : state.cart.map(c => `
              <div class="tw-cart-row">
                <span class="tw-cart-name">${escapeHtml(c.name)}</span>
                <span class="tw-cart-qtypill">
                  <button data-dec="${c.menu_item_id}">−</button>
                  <span>${c.quantity}</span>
                  <button data-inc="${c.menu_item_id}">+</button>
                </span>
                <span class="tw-cart-price">${fmt(c.unit_price * c.quantity)}</span>
              </div>
            `).join('')}
          <div class="tw-cart-total"><span>Total</span><span class="tw-cart-total-amount">${fmt(cartTotal())}</span></div>
        </div>
      </div>
    `;
  }

  function renderStep3() {
    return `
      <h2 class="tw-h2">Your contact details</h2>
      <div class="tw-help">We need a name and phone to call out when your order's ready. Email is optional but lets us send a confirmation.</div>
      <label class="tw-label">Name *</label>
      <input class="tw-input" id="tw-name" type="text" value="${escapeHtml(state.customer.name)}" autocomplete="name" />
      <label class="tw-label">Phone *</label>
      <input class="tw-input" id="tw-phone" type="tel" value="${escapeHtml(state.customer.phone)}" autocomplete="tel" />
      <label class="tw-label">Email (optional)</label>
      <input class="tw-input" id="tw-email" type="email" value="${escapeHtml(state.customer.email)}" autocomplete="email" />
      ${state.error ? `<div class="tw-error" style="margin-top:14px;">${escapeHtml(state.error)}</div>` : ''}
    `;
  }

  function renderStep4() {
    return `
      <h2 class="tw-h2">Review & pay</h2>
      <div class="tw-help">For this demo we're skipping real card processing. Click "Pay" to confirm the order and send it through to the kitchen.</div>
      <div style="background:#f8f8f8; border-radius:12px; padding:16px; margin-bottom:14px;">
        ${state.cart.map(c => `
          <div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;">
            <span>${c.quantity}× ${escapeHtml(c.name)}</span>
            <span>${fmt(c.unit_price * c.quantity)}</span>
          </div>
        `).join('')}
        <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;border-top:2px solid #ddd;padding-top:10px;margin-top:10px;">
          <span>Total</span><span style="color:#e94560;">${fmt(cartTotal())}</span>
        </div>
      </div>
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:10px;padding:12px 14px;font-size:13px;color:#92400e;line-height:1.5;margin-bottom:14px;">
        <strong>🧪 Demo mode</strong><br>No card details collected — clicking Pay submits the order with mock payment.
      </div>
      ${state.error ? `<div class="tw-error">${escapeHtml(state.error)}</div>` : ''}
    `;
  }

  function renderStep5() {
    const r = state.orderResult || {};
    return `
      <div class="tw-success">
        <div class="tw-success-tick">🥡</div>
        <h2 class="tw-h2">Order confirmed!</h2>
        <div class="tw-help" style="margin-bottom:8px;">Your order number is</div>
        <div class="tw-success-num">${escapeHtml(r.order_number || '—')}</div>
        <p style="color:#555;font-size:14px;line-height:1.6;">
          Please quote this number when collecting.
          ${state.customer.email ? '<br>A confirmation email has been sent.' : ''}
        </p>
        <p style="color:#888;font-size:12px;margin-top:20px;">
          Pickup time: <strong style="color:#1a1a2e;">${new Date(computePickupISO()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</strong>
        </p>
      </div>
    `;
  }

  // ── Footer buttons per step ─────────────────────────────────────
  function renderFooter() {
    if (state.step === 5) {
      return `<button class="tw-btn tw-btn-primary" id="tw-done">Done</button>`;
    }
    const backBtn = state.step > 1 ? `<button class="tw-btn tw-btn-ghost" id="tw-back">← Back</button>` : '';
    let nextLabel = 'Next →';
    let nextEnabled = true;
    if (state.step === 1) {
      nextEnabled = state.pickupKind === 'asap' || !!state.pickupISO;
    } else if (state.step === 2) {
      nextEnabled = state.cart.length > 0;
      nextLabel = `Checkout · ${fmt(cartTotal())}`;
    } else if (state.step === 3) {
      nextLabel = 'Continue to payment';
    } else if (state.step === 4) {
      nextLabel = `Pay ${fmt(cartTotal())}`;
    }
    return `${backBtn}<button class="tw-btn ${state.step===4 ? 'tw-btn-gold' : 'tw-btn-primary'}" id="tw-next" ${nextEnabled ? '' : 'disabled'}>${nextLabel}</button>`;
  }

  // ── Master render ───────────────────────────────────────────────
  function render() {
    const root = $('tw-root');
    if (!root) return;
    const body = state.step === 1 ? renderStep1()
              : state.step === 2 ? renderStep2()
              : state.step === 3 ? renderStep3()
              : state.step === 4 ? renderStep4()
              : renderStep5();
    root.innerHTML = `
      <div class="tw-header">
        <div class="tw-title">🥡 Order Takeaway</div>
        <button class="tw-close" id="tw-close">×</button>
      </div>
      <div class="tw-progress">
        ${[1,2,3,4].map(n => `<div class="tw-step ${state.step > n ? 'done' : state.step === n ? 'active' : ''}"></div>`).join('')}
      </div>
      <div class="tw-body">${body}</div>
      ${state.step !== 5 ? '' : ''}
      <div class="tw-foot">${renderFooter()}</div>
    `;
    bindHandlers();
  }

  function bindHandlers() {
    const onClose = () => closeWidget();
    $('tw-close')?.addEventListener('click', onClose);

    if (state.step === 1) {
      $('tw-asap')?.addEventListener('click', () => { state.pickupKind = 'asap'; state.pickupISO = null; state.error = ''; render(); });
      $('tw-sched')?.addEventListener('click', () => { state.pickupKind = 'scheduled'; state.error = ''; render(); });
      document.querySelectorAll('.tw-slot').forEach(b => {
        b.addEventListener('click', () => { state.pickupISO = b.getAttribute('data-iso'); render(); });
      });
    }

    if (state.step === 2) {
      document.querySelectorAll('.tw-cat').forEach(b => {
        b.addEventListener('click', () => { state.activeCategory = Number(b.getAttribute('data-cat')); render(); });
      });
      document.querySelectorAll('.tw-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = Number(el.getAttribute('data-add'));
          const cat = state.menu.find(c => c.id === state.activeCategory);
          const item = cat?.items.find(i => i.id === id);
          if (item) addToCart(item);
        });
      });
      document.querySelectorAll('[data-inc]').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); changeQty(Number(b.getAttribute('data-inc')), 1); });
      });
      document.querySelectorAll('[data-dec]').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); changeQty(Number(b.getAttribute('data-dec')), -1); });
      });
    }

    $('tw-back')?.addEventListener('click', () => { state.step -= 1; state.error = ''; render(); });

    $('tw-next')?.addEventListener('click', async () => {
      state.error = '';
      if (state.step === 1) {
        if (state.pickupKind === 'scheduled' && !state.pickupISO) { state.error = 'Pick a time slot.'; render(); return; }
        state.step = 2;
        if (state.menu.length === 0) await loadMenu();
        render();
      } else if (state.step === 2) {
        if (state.cart.length === 0) { state.error = 'Add some items first.'; render(); return; }
        state.step = 3; render();
      } else if (state.step === 3) {
        state.customer.name  = $('tw-name')?.value.trim() || '';
        state.customer.phone = $('tw-phone')?.value.trim() || '';
        state.customer.email = $('tw-email')?.value.trim() || '';
        if (!state.customer.name)  { state.error = 'Name is required.';  render(); return; }
        if (!state.customer.phone) { state.error = 'Phone is required.'; render(); return; }
        state.step = 4; render();
      } else if (state.step === 4) {
        await submitOrder();
      }
    });

    $('tw-done')?.addEventListener('click', onClose);
  }

  // ── Data + submit ───────────────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch(API + '/api/takeaway/settings');
      if (r.ok) state.settings = await r.json();
    } catch (e) { /* widget still works with defaults */ }
  }
  async function loadMenu() {
    try {
      const r = await fetch(API + '/api/menu/all');
      if (r.ok) {
        const data = await r.json();
        state.menu = Array.isArray(data) ? data : [];
        if (state.menu.length > 0 && !state.activeCategory) {
          state.activeCategory = state.menu[0].id;
        }
      }
    } catch (e) {
      state.error = 'Could not load menu — please try again.';
    }
  }

  async function submitOrder() {
    const btn = $('tw-next');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    try {
      const r = await fetch(API + '/api/takeaway/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name:  state.customer.name,
          customer_phone: state.customer.phone,
          customer_email: state.customer.email || null,
          pickup_time:    computePickupISO(),
          items: state.cart.map(c => ({
            menu_item_id: c.menu_item_id,
            quantity:     c.quantity,
            unit_price:   c.unit_price,
            name:         c.name,
          })),
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        state.error = data.error || 'Something went wrong. Please try again.';
        render();
        return;
      }
      state.orderResult = data;
      state.step = 5;
      render();
    } catch (e) {
      state.error = 'Connection error — please try again.';
      render();
    }
  }

  // ── Open / close ────────────────────────────────────────────────
  function openWidget() {
    // Reset state on open so a second open doesn't show the last order.
    state = {
      step: 1, settings: state.settings, menu: state.menu, activeCategory: null,
      cart: [], pickupKind: 'asap', pickupISO: null,
      customer: { name:'', phone:'', email:'' },
      error: '', orderResult: null,
    };
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'tw-overlay';
    overlay.id = 'tw-overlay';
    overlay.innerHTML = '<div class="tw-modal" id="tw-root"></div>';
    document.body.appendChild(overlay);
    if (!state.settings) loadSettings();
    render();
  }
  function closeWidget() {
    const o = document.getElementById('tw-overlay');
    if (o) o.remove();
  }

  // ── Wire up triggers + the floating button ──────────────────────
  function init() {
    injectStyles();
    document.querySelectorAll('[data-siamepos-takeaway]').forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); openWidget(); });
    });
    // If no manual triggers found, drop a floating action button as a fallback.
    if (document.querySelectorAll('[data-siamepos-takeaway]').length === 0) {
      const fab = document.createElement('button');
      fab.className = 'tw-fab';
      fab.textContent = '🥡 Order Takeaway';
      fab.addEventListener('click', openWidget);
      document.body.appendChild(fab);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose minimal API in case the embedder wants to trigger programmatically.
  window.SiamEPOSTakeaway = { open: openWidget, close: closeWidget };
})();
