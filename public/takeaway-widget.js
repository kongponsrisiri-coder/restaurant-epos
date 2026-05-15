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
    /* ── FAB ── */
    .tw-fab {
      position:fixed; bottom:24px; right:24px;
      background:#C9A84C; color:#0D1B3E; border:none; border-radius:30px;
      padding:16px 26px; font-weight:800; font-size:15px; cursor:pointer;
      box-shadow:0 6px 20px rgba(13,27,62,0.35); z-index:9998;
      font-family:system-ui,-apple-system,sans-serif; letter-spacing:0.02em;
    }
    .tw-fab:hover { background:#d5b85e; }

    /* ── Overlay + modal ── */
    .tw-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9999;
      display:flex; align-items:center; justify-content:center; padding:0;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    }
    .tw-modal {
      background:white; border-radius:20px; width:100%; max-width:920px;
      max-height:92vh; overflow:hidden; display:flex; flex-direction:column;
      box-shadow:0 20px 60px rgba(0,0,0,0.45);
    }
    @media(max-width:760px) {
      .tw-modal { max-width:100%; max-height:100dvh; border-radius:0; }
    }

    /* ── Header ── */
    .tw-header {
      background:#0D1B3E; color:white; padding:16px 20px;
      display:flex; align-items:center; justify-content:space-between;
      flex-shrink:0;
    }
    .tw-title { font-family:Georgia,serif; font-size:19px; font-weight:700; color:#C9A84C; }
    .tw-close {
      background:rgba(255,255,255,0.12); border:none; color:white; font-size:22px;
      cursor:pointer; line-height:1; padding:0; width:36px; height:36px;
      border-radius:50%; display:flex; align-items:center; justify-content:center;
    }
    .tw-close:hover { background:rgba(255,255,255,0.2); }

    /* ── Step indicator ── */
    .tw-steps {
      display:flex; background:#f4f4f4; border-bottom:1px solid #eaeaea;
      flex-shrink:0; overflow:hidden;
    }
    .tw-step-item {
      flex:1; display:flex; flex-direction:column; align-items:center;
      padding:10px 4px 9px; font-size:10px; font-weight:700; color:#bbb;
      text-transform:uppercase; letter-spacing:0.05em; gap:4px; position:relative;
    }
    .tw-step-item::after {
      content:''; position:absolute; bottom:0; left:0; right:0; height:3px;
      background:#e0e0e0;
    }
    .tw-step-item.active { color:#0D1B3E; }
    .tw-step-item.active::after { background:#C9A84C; }
    .tw-step-item.done { color:#22c55e; }
    .tw-step-item.done::after { background:#22c55e; }
    .tw-step-num {
      width:22px; height:22px; border-radius:50%; background:#e0e0e0;
      display:flex; align-items:center; justify-content:center; font-size:12px;
      font-weight:800; color:#999;
    }
    .tw-step-item.active .tw-step-num { background:#C9A84C; color:#0D1B3E; }
    .tw-step-item.done .tw-step-num { background:#22c55e; color:white; }
    @media(max-width:400px) {
      .tw-step-item { font-size:9px; padding:8px 2px 7px; }
    }

    /* ── Body ── */
    .tw-body { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
    .tw-body-inner { padding:20px; }
    @media(max-width:760px) { .tw-body-inner { padding:16px; } }

    .tw-h2 { font-size:18px; font-weight:700; color:#1a1a2e; margin:0 0 8px; }
    .tw-help { color:#888; font-size:13px; margin-bottom:18px; line-height:1.5; }

    /* ── Buttons ── */
    .tw-btn {
      padding:14px 20px; border-radius:12px; border:2px solid transparent;
      background:white; color:#1a1a2e; font-weight:700; font-size:15px;
      cursor:pointer; transition:all 0.15s; font-family:inherit;
      min-height:48px; display:inline-flex; align-items:center; justify-content:center;
    }
    .tw-btn-primary { background:#0D1B3E; color:white; border-color:#0D1B3E; }
    .tw-btn-primary:hover { background:#1a2a55; }
    .tw-btn-gold { background:#C9A84C; color:#0D1B3E; border-color:#C9A84C; }
    .tw-btn-gold:hover { background:#d5b85e; }
    .tw-btn-ghost { background:white; border-color:#ddd; color:#555; }
    .tw-btn-ghost:hover { background:#f5f5f5; }
    .tw-btn[disabled] { opacity:0.45; cursor:not-allowed; }
    .tw-btn.tw-selected { border-color:#C9A84C; background:#fef9eb; color:#1a1a2e; }

    /* ── Inputs ── */
    .tw-input {
      width:100%; padding:14px 16px; border-radius:12px;
      border:1.5px solid #ddd; font-size:16px; box-sizing:border-box;
      font-family:inherit; -webkit-appearance:none;
    }
    .tw-input:focus { outline:none; border-color:#C9A84C; box-shadow:0 0 0 3px rgba(201,168,76,0.15); }
    .tw-label {
      display:block; font-size:12px; font-weight:700; color:#888;
      text-transform:uppercase; letter-spacing:0.06em; margin:16px 0 6px;
    }
    .tw-error {
      background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3);
      color:#991b1b; padding:12px 14px; border-radius:10px;
      font-size:13px; margin-top:14px; line-height:1.5;
    }

    /* ── Step 1: Pickup time ── */
    .tw-pickup-row { display:flex; gap:10px; margin-bottom:18px; }
    .tw-pickup-btn {
      flex:1; padding:18px 14px; border-radius:14px; border:2px solid #e0e0e0;
      background:white; cursor:pointer; font-family:inherit; text-align:center;
      transition:all 0.15s;
    }
    .tw-pickup-btn:hover { border-color:#C9A84C; }
    .tw-pickup-btn.active { border-color:#C9A84C; background:#fef9eb; }
    .tw-pickup-icon { font-size:28px; display:block; margin-bottom:6px; }
    .tw-pickup-label { font-weight:800; font-size:15px; color:#1a1a2e; display:block; }
    .tw-pickup-sub { font-size:12px; color:#888; display:block; margin-top:3px; }

    .tw-slots-label { font-size:12px; font-weight:700; color:#888;
      text-transform:uppercase; letter-spacing:0.06em; margin-bottom:10px; }
    .tw-slots {
      display:grid; grid-template-columns:repeat(4,1fr); gap:8px;
    }
    @media(max-width:480px) { .tw-slots { grid-template-columns:repeat(3,1fr); } }
    .tw-slot {
      padding:12px 6px; border-radius:10px; border:1.5px solid #e0e0e0;
      background:white; cursor:pointer; font-family:inherit;
      font-size:14px; font-weight:700; color:#444; text-align:center;
      min-height:44px; transition:all 0.15s;
    }
    .tw-slot:hover { border-color:#C9A84C; background:#fef9eb; }
    .tw-slot.active { border-color:#C9A84C; background:#C9A84C; color:#0D1B3E; }

    /* ── Step 2: Menu ── */
    .tw-split { display:flex; gap:16px; align-items:flex-start; }
    .tw-menu-col { flex:1; min-width:0; }

    /* Category tabs — horizontal scroll on mobile */
    .tw-cats {
      display:flex; gap:8px; margin-bottom:14px;
      overflow-x:auto; -webkit-overflow-scrolling:touch;
      scrollbar-width:none; padding-bottom:4px;
    }
    .tw-cats::-webkit-scrollbar { display:none; }
    .tw-cat {
      flex-shrink:0; padding:10px 16px; border-radius:22px;
      border:1.5px solid #e0e0e0; background:white; cursor:pointer;
      font-size:13px; font-weight:700; color:#555; white-space:nowrap;
      min-height:40px; display:inline-flex; align-items:center;
    }
    .tw-cat.active { background:#0D1B3E; color:white; border-color:#0D1B3E; }

    /* Menu items — 1 col on mobile, 2 col on desktop */
    .tw-items { display:flex; flex-direction:column; gap:10px; }
    @media(min-width:600px) {
      .tw-items { display:grid; grid-template-columns:1fr 1fr; }
    }
    .tw-item {
      background:white; border:1.5px solid #eee; border-radius:14px;
      padding:14px 14px 12px; cursor:pointer;
      transition:border-color 0.15s, box-shadow 0.15s;
      display:flex; flex-direction:column;
    }
    .tw-item:active { border-color:#C9A84C; box-shadow:0 2px 8px rgba(201,168,76,0.2); }
    @media(pointer:fine) { .tw-item:hover { border-color:#C9A84C; box-shadow:0 2px 8px rgba(201,168,76,0.15); } }
    .tw-item-name { font-weight:700; color:#1a1a2e; font-size:15px; margin-bottom:4px; }
    .tw-item-desc {
      font-size:12px; color:#888; margin-bottom:10px; line-height:1.45; flex:1;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    }
    .tw-item-foot { display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .tw-item-price { font-weight:800; color:#1a1a2e; font-size:16px; }
    .tw-item-add {
      background:#0D1B3E; color:#C9A84C; border:none; border-radius:50%;
      width:40px; height:40px; font-size:22px; font-weight:700; cursor:pointer;
      flex-shrink:0; display:flex; align-items:center; justify-content:center;
      line-height:1;
    }
    .tw-item-add:active { background:#1a2a55; }

    /* Desktop cart sidebar */
    .tw-cart-sidebar {
      width:280px; flex-shrink:0; background:#f8f8f8; border-radius:16px;
      padding:16px; position:sticky; top:0; max-height:calc(92vh - 180px);
      overflow-y:auto; display:flex; flex-direction:column;
    }
    @media(max-width:760px) { .tw-cart-sidebar { display:none; } }

    .tw-cart-title {
      font-size:12px; font-weight:700; color:#888;
      text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px;
    }
    .tw-cart-empty { color:#bbb; text-align:center; padding:30px 0 20px; font-size:13px; }
    .tw-cart-row {
      display:flex; align-items:center; gap:8px; padding:9px 0; font-size:13px;
      border-bottom:1px solid #eee;
    }
    .tw-cart-row:last-of-type { border-bottom:none; }
    .tw-cart-name { flex:1; color:#1a1a2e; font-weight:600; line-height:1.3; }
    .tw-cart-qtypill {
      display:flex; align-items:center; background:#0D1B3E;
      color:#C9A84C; border-radius:16px; height:28px; overflow:hidden; flex-shrink:0;
    }
    .tw-cart-qtypill button {
      background:transparent; color:#C9A84C; border:none;
      width:28px; height:28px; cursor:pointer; font-weight:800; font-size:16px;
      display:flex; align-items:center; justify-content:center;
    }
    .tw-cart-qtypill span {
      padding:0 6px; font-weight:800; min-width:16px; text-align:center; font-size:13px;
    }
    .tw-cart-price { min-width:50px; text-align:right; color:#555; font-weight:600; }
    .tw-cart-total {
      display:flex; justify-content:space-between; font-size:16px; font-weight:800;
      margin-top:14px; padding-top:14px; border-top:2px solid #ddd;
    }

    /* Mobile sticky cart bar — shows when cart has items */
    .tw-cart-bar {
      display:none; position:sticky; bottom:0; left:0; right:0;
      background:#0D1B3E; color:white; padding:14px 20px;
      align-items:center; justify-content:space-between; gap:10px;
      border-top:2px solid #C9A84C; z-index:10; flex-shrink:0;
    }
    @media(max-width:760px) { .tw-cart-bar { display:flex; } }
    .tw-cart-bar-info { display:flex; flex-direction:column; }
    .tw-cart-bar-count { font-size:12px; color:#C9A84C; font-weight:700; }
    .tw-cart-bar-total { font-size:18px; font-weight:800; color:white; }
    .tw-cart-bar-btn {
      background:#C9A84C; color:#0D1B3E; border:none; border-radius:12px;
      padding:12px 20px; font-weight:800; font-size:15px; cursor:pointer;
      font-family:inherit; white-space:nowrap; flex-shrink:0;
    }
    .tw-cart-bar.hidden { display:none !important; }

    /* ── Footer ── */
    .tw-foot {
      padding:14px 20px; border-top:1px solid #eee;
      display:flex; gap:10px; justify-content:flex-end;
      background:white; flex-shrink:0;
    }
    .tw-foot-full { width:100%; }
    @media(max-width:760px) {
      .tw-foot { padding:12px 16px; }
      .tw-foot .tw-btn { flex:1; }
    }

    /* ── Step 4: Review ── */
    .tw-review-row {
      display:flex; justify-content:space-between; align-items:center;
      font-size:14px; padding:10px 0; border-bottom:1px solid #f0f0f0;
    }
    .tw-review-row:last-of-type { border:none; }
    .tw-review-qty { color:#888; margin-right:6px; }
    .tw-review-total {
      display:flex; justify-content:space-between; align-items:center;
      font-size:18px; font-weight:800; border-top:2px solid #ddd;
      padding-top:12px; margin-top:4px;
    }

    /* ── Success ── */
    .tw-success { text-align:center; padding:40px 24px 32px; }
    .tw-success-tick { font-size:72px; margin-bottom:12px; }
    .tw-success-h { font-size:22px; font-weight:800; color:#1a1a2e; margin-bottom:8px; }
    .tw-success-num {
      font-size:36px; font-weight:800; color:#C9A84C;
      font-family:'SF Mono',Menlo,monospace; letter-spacing:3px;
      margin:16px 0; background:#fef9eb; display:inline-block;
      padding:10px 24px; border-radius:12px;
    }
  `;

  function injectStyles() {
    if (document.getElementById('tw-styles')) return;
    const s = document.createElement('style');
    s.id = 'tw-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────
  let state = {
    step: 1,
    settings: null,
    menu: [],
    activeCategory: null,
    cart: [],
    pickupKind: 'asap',
    pickupISO: null,
    customer: { name:'', phone:'', email:'' },
    error: '',
    orderResult: null,
  };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return '£' + Number(n || 0).toFixed(2); }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function cartCount() { return state.cart.reduce((s, i) => s + i.quantity, 0); }
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
  function computePickupISO() {
    if (state.pickupKind === 'asap') {
      const d = new Date();
      d.setMinutes(d.getMinutes() + 25);
      return d.toISOString();
    }
    return state.pickupISO;
  }

  // ── Step renderers ───────────────────────────────────────────────
  function renderStep1() {
    const opening = state.settings?.opening_time      || '11:00';
    const closing = state.settings?.last_booking_time || '21:30';
    const today   = new Date();
    const minTime = new Date(today.getTime() + 25 * 60 * 1000);
    const slots   = [];
    const [oh, om] = String(opening).slice(0,5).split(':').map(Number);
    const [ch, cm] = String(closing).slice(0,5).split(':').map(Number);
    const cur   = new Date(today); cur.setHours(oh, om, 0, 0);
    const close = new Date(today); close.setHours(ch, cm, 0, 0);
    while (cur <= close) {
      if (cur >= minTime) {
        slots.push({
          iso: cur.toISOString(),
          lbl: cur.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
        });
      }
      cur.setMinutes(cur.getMinutes() + 15);
    }

    return `
      <h2 class="tw-h2">When would you like to collect?</h2>
      <div class="tw-help">Open ${String(opening).slice(0,5)} – ${String(closing).slice(0,5)}. We need ~25 min to prepare your order.</div>

      <div class="tw-pickup-row">
        <button class="tw-pickup-btn ${state.pickupKind==='asap' ? 'active' : ''}" id="tw-asap">
          <span class="tw-pickup-icon">⚡</span>
          <span class="tw-pickup-label">ASAP</span>
          <span class="tw-pickup-sub">Ready in ~25 min</span>
        </button>
        <button class="tw-pickup-btn ${state.pickupKind==='scheduled' ? 'active' : ''}" id="tw-sched">
          <span class="tw-pickup-icon">🕐</span>
          <span class="tw-pickup-label">Schedule</span>
          <span class="tw-pickup-sub">Pick a time</span>
        </button>
      </div>

      ${state.pickupKind === 'scheduled' ? `
        <div class="tw-slots-label">Choose a pickup time</div>
        <div class="tw-slots">
          ${slots.length === 0
            ? '<div style="color:#888;font-size:13px;grid-column:1/-1;">No slots left today — choose ASAP.</div>'
            : slots.map(s => `
                <button class="tw-slot ${state.pickupISO===s.iso ? 'active' : ''} tw-slot-btn" data-iso="${s.iso}">${s.lbl}</button>
              `).join('')}
        </div>
      ` : `
        <div style="background:#f0f7ee;border:1.5px solid #86efac;border-radius:12px;padding:14px 16px;">
          <div style="font-weight:700;color:#166534;margin-bottom:3px;">✓ Earliest pickup</div>
          <div style="font-size:15px;color:#166534;">${new Date(Date.now()+25*60000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} today</div>
        </div>
      `}
      ${state.error ? `<div class="tw-error">${esc(state.error)}</div>` : ''}
    `;
  }

  function renderCartRows() {
    if (state.cart.length === 0) return `<div class="tw-cart-empty">Tap any dish to add it ✨</div>`;
    return state.cart.map(c => `
      <div class="tw-cart-row">
        <span class="tw-cart-name">${esc(c.name)}</span>
        <span class="tw-cart-qtypill">
          <button data-dec="${c.menu_item_id}">−</button>
          <span>${c.quantity}</span>
          <button data-inc="${c.menu_item_id}">+</button>
        </span>
        <span class="tw-cart-price">${fmt(c.unit_price * c.quantity)}</span>
      </div>
    `).join('') + `
      <div class="tw-cart-total"><span>Total</span><span>${fmt(cartTotal())}</span></div>
    `;
  }

  function renderStep2() {
    if (state.menu.length === 0) {
      return `<div style="text-align:center;padding:60px 0;color:#888;font-size:15px;">Loading menu…</div>`;
    }
    const active = state.menu.find(c => c.id === state.activeCategory) || state.menu[0];
    state.activeCategory = active.id;
    const count = cartCount();
    return `
      <div class="tw-split">
        <div class="tw-menu-col">
          <div class="tw-cats">
            ${state.menu.map(c => `
              <button class="tw-cat ${c.id===active.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>
            `).join('')}
          </div>
          <div class="tw-items">
            ${(active.items || []).filter(i => i.is_available).map(i => `
              <div class="tw-item" data-add="${i.id}">
                <div class="tw-item-name">${esc(i.name)}</div>
                ${i.description ? `<div class="tw-item-desc">${esc(i.description)}</div>` : ''}
                <div class="tw-item-foot">
                  <span class="tw-item-price">${fmt(i.price)}</span>
                  <button class="tw-item-add" aria-label="Add ${esc(i.name)}">+</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Desktop sidebar cart -->
        <div class="tw-cart-sidebar">
          <div class="tw-cart-title">🛒 Your order</div>
          ${renderCartRows()}
        </div>
      </div>

      <!-- Mobile sticky cart bar -->
      <div class="tw-cart-bar ${count === 0 ? 'hidden' : ''}" id="tw-cart-bar">
        <div class="tw-cart-bar-info">
          <span class="tw-cart-bar-count">${count} item${count!==1?'s':''}</span>
          <span class="tw-cart-bar-total">${fmt(cartTotal())}</span>
        </div>
        <button class="tw-cart-bar-btn" id="tw-cart-bar-btn">View cart →</button>
      </div>
    `;
  }

  function renderStep3() {
    return `
      <h2 class="tw-h2">Your details</h2>
      <div class="tw-help">We'll call out your name when your order's ready. Email is optional for a confirmation.</div>
      <label class="tw-label">Your name *</label>
      <input class="tw-input" id="tw-name" type="text" inputmode="text"
        value="${esc(state.customer.name)}" placeholder="e.g. Sarah" autocomplete="name" />
      <label class="tw-label">Phone number *</label>
      <input class="tw-input" id="tw-phone" type="tel" inputmode="tel"
        value="${esc(state.customer.phone)}" placeholder="e.g. 07700 900 123" autocomplete="tel" />
      <label class="tw-label">Email (optional)</label>
      <input class="tw-input" id="tw-email" type="email" inputmode="email"
        value="${esc(state.customer.email)}" placeholder="for order confirmation" autocomplete="email" />
      ${state.error ? `<div class="tw-error">${esc(state.error)}</div>` : ''}
    `;
  }

  function renderStep4() {
    const pTime = new Date(computePickupISO()).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    return `
      <h2 class="tw-h2">Review your order</h2>
      <div style="background:#f8f8f8;border-radius:14px;padding:16px;margin-bottom:16px;">
        ${state.cart.map(c => `
          <div class="tw-review-row">
            <span><span class="tw-review-qty">${c.quantity}×</span>${esc(c.name)}</span>
            <span style="font-weight:700;">${fmt(c.unit_price * c.quantity)}</span>
          </div>
        `).join('')}
        <div class="tw-review-total">
          <span>Total</span>
          <span style="color:#C9A84C;">${fmt(cartTotal())}</span>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:12px;background:#f0f7ee;border:1.5px solid #86efac;border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <span style="font-size:24px;">🕐</span>
        <div>
          <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.05em;">Pickup time</div>
          <div style="font-weight:800;color:#166534;font-size:16px;">${pTime} today</div>
        </div>
      </div>

      <div style="background:#fef9eb;border:1.5px solid #f0d070;border-radius:12px;padding:14px 16px;font-size:13px;color:#92400e;line-height:1.5;">
        🧪 <strong>Demo mode</strong> — No card details collected. Clicking Pay sends the order straight to the kitchen.
      </div>
      ${state.error ? `<div class="tw-error">${esc(state.error)}</div>` : ''}
    `;
  }

  function renderStep5() {
    const r = state.orderResult || {};
    return `
      <div class="tw-success">
        <div class="tw-success-tick">🥡</div>
        <div class="tw-success-h">Order confirmed!</div>
        <div style="color:#888;font-size:14px;">Your order number is</div>
        <div class="tw-success-num">${esc(r.order_number || '—')}</div>
        <p style="color:#555;font-size:14px;line-height:1.6;max-width:300px;margin:0 auto 20px;">
          Please show this number when you collect.
          ${state.customer.email ? '<br>A confirmation email is on its way.' : ''}
        </p>
        <p style="color:#aaa;font-size:12px;">
          Pickup: <strong style="color:#1a1a2e;">${new Date(computePickupISO()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</strong>
        </p>
      </div>
    `;
  }

  // ── Step labels ──────────────────────────────────────────────────
  const STEP_LABELS = ['Time', 'Menu', 'Details', 'Pay'];

  // ── Footer ───────────────────────────────────────────────────────
  function renderFooter() {
    if (state.step === 5) {
      return `<button class="tw-btn tw-btn-primary tw-foot-full" id="tw-done">Close</button>`;
    }
    const back = state.step > 1
      ? `<button class="tw-btn tw-btn-ghost" id="tw-back">← Back</button>`
      : '';
    let nextLabel = 'Next →';
    let nextEnabled = true;
    if (state.step === 1) {
      nextEnabled = state.pickupKind === 'asap' || !!state.pickupISO;
      nextLabel = 'Choose dishes →';
    } else if (state.step === 2) {
      nextEnabled = state.cart.length > 0;
      nextLabel = `Checkout · ${fmt(cartTotal())}`;
    } else if (state.step === 3) {
      nextLabel = 'Review order →';
    } else if (state.step === 4) {
      nextLabel = `✓ Place order · ${fmt(cartTotal())}`;
    }
    const cls = state.step === 4 ? 'tw-btn-gold' : 'tw-btn-primary';
    // On mobile step 2, the cart bar handles checkout — hide the footer next button
    const hideNext = state.step === 2 ? 'style="display:none" class="tw-btn ' + cls + ' tw-next-hidden"' : `class="tw-btn ${cls}"`;
    return `${back}<button ${state.step === 2 ? `class="tw-btn ${cls}" style="display:none"` : `class="tw-btn ${cls}"`} id="tw-next" ${nextEnabled ? '' : 'disabled'}>${nextLabel}</button>`;
  }

  // ── Master render ─────────────────────────────────────────────────
  function render() {
    const root = $('tw-root');
    if (!root) return;

    const stepsHtml = [1,2,3,4].map((n, idx) => {
      const cls = state.step > n ? 'done' : state.step === n ? 'active' : '';
      const icon = state.step > n ? '✓' : n;
      return `
        <div class="tw-step-item ${cls}">
          <div class="tw-step-num">${icon}</div>
          <span>${STEP_LABELS[idx]}</span>
        </div>`;
    }).join('');

    const body = state.step === 1 ? renderStep1()
               : state.step === 2 ? renderStep2()
               : state.step === 3 ? renderStep3()
               : state.step === 4 ? renderStep4()
               : renderStep5();

    root.innerHTML = `
      <div class="tw-header">
        <div class="tw-title">🥡 Order Takeaway</div>
        <button class="tw-close" id="tw-close" aria-label="Close">✕</button>
      </div>
      ${state.step <= 4 ? `<div class="tw-steps">${stepsHtml}</div>` : ''}
      <div class="tw-body">
        <div class="tw-body-inner">${body}</div>
      </div>
      <div class="tw-foot">${renderFooter()}</div>
    `;

    // Show the "Next" button on desktop for step 2, hide on mobile (cart bar handles it)
    if (state.step === 2) {
      const nextBtn = $('tw-next');
      if (nextBtn) {
        // Show on desktop, hide on mobile via CSS isn't available for dynamic elements —
        // use a data attr and an injected rule instead
        nextBtn.style.display = '';
      }
    }

    bindHandlers();
  }

  function bindHandlers() {
    $('tw-close')?.addEventListener('click', closeWidget);

    if (state.step === 1) {
      $('tw-asap')?.addEventListener('click', () => {
        state.pickupKind = 'asap'; state.pickupISO = null; state.error = ''; render();
      });
      $('tw-sched')?.addEventListener('click', () => {
        state.pickupKind = 'scheduled'; state.error = ''; render();
      });
      document.querySelectorAll('.tw-slot-btn').forEach(b => {
        b.addEventListener('click', () => { state.pickupISO = b.dataset.iso; render(); });
      });
    }

    if (state.step === 2) {
      document.querySelectorAll('.tw-cat').forEach(b => {
        b.addEventListener('click', () => {
          state.activeCategory = Number(b.dataset.cat); render();
        });
      });
      document.querySelectorAll('.tw-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('tw-item-add') ||
              e.target.closest('.tw-cart-qtypill')) return;
          const id = Number(el.dataset.add);
          const cat = state.menu.find(c => c.id === state.activeCategory);
          const item = cat?.items.find(i => i.id === id);
          if (item) addToCart(item);
        });
      });
      document.querySelectorAll('.tw-item-add').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = Number(btn.closest('.tw-item')?.dataset.add);
          const cat = state.menu.find(c => c.id === state.activeCategory);
          const item = cat?.items.find(i => i.id === id);
          if (item) addToCart(item);
        });
      });
      document.querySelectorAll('[data-inc]').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); changeQty(Number(b.dataset.inc), 1); });
      });
      document.querySelectorAll('[data-dec]').forEach(b => {
        b.addEventListener('click', (e) => { e.stopPropagation(); changeQty(Number(b.dataset.dec), -1); });
      });
      // Mobile cart bar → go to checkout
      $('tw-cart-bar-btn')?.addEventListener('click', () => {
        if (state.cart.length > 0) { state.step = 3; render(); }
      });
    }

    $('tw-back')?.addEventListener('click', () => { state.step -= 1; state.error = ''; render(); });

    $('tw-next')?.addEventListener('click', async () => {
      state.error = '';
      if (state.step === 1) {
        if (state.pickupKind === 'scheduled' && !state.pickupISO) {
          state.error = 'Please pick a time slot.'; render(); return;
        }
        state.step = 2;
        if (state.menu.length === 0) await loadMenu();
        render();
      } else if (state.step === 2) {
        if (state.cart.length === 0) { state.error = 'Add some items first.'; render(); return; }
        state.step = 3; render();
      } else if (state.step === 3) {
        state.customer.name  = $('tw-name')?.value.trim()  || '';
        state.customer.phone = $('tw-phone')?.value.trim() || '';
        state.customer.email = $('tw-email')?.value.trim() || '';
        if (!state.customer.name)  { state.error = 'Name is required.';         render(); return; }
        if (!state.customer.phone) { state.error = 'Phone number is required.'; render(); return; }
        state.step = 4; render();
      } else if (state.step === 4) {
        await submitOrder();
      }
    });

    $('tw-done')?.addEventListener('click', closeWidget);
  }

  // ── Data + submit ────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch(API + '/api/takeaway/settings');
      if (r.ok) state.settings = await r.json();
    } catch (e) {}
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
    if (btn) { btn.disabled = true; btn.textContent = 'Placing order…'; }
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
        state.error = data.error || 'Something went wrong — please try again.';
        render(); return;
      }
      state.orderResult = data;
      state.step = 5;
      render();
    } catch (e) {
      state.error = 'Connection error — please try again.';
      render();
    }
  }

  // ── Open / close ─────────────────────────────────────────────────
  function openWidget() {
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
    // Close on backdrop tap
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWidget(); });
    if (!state.settings) loadSettings();
    render();
  }
  function closeWidget() {
    document.getElementById('tw-overlay')?.remove();
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    document.querySelectorAll('[data-siamepos-takeaway]').forEach(b => {
      b.addEventListener('click', (e) => { e.preventDefault(); openWidget(); });
    });
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

  window.SiamEPOSTakeaway = { open: openWidget, close: closeWidget };
})();
