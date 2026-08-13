/*
 * SiamEPOS Gift Voucher Widget — SEPOS-VOUCHER-001
 * Public voucher purchase widget for embedding on the restaurant's website.
 *
 *   <script src="https://app.siamepos.co.uk/voucher-widget.js"
 *           data-restaurant="baan-siam"></script>
 *   <div id="siamepos-voucher"></div>
 *   — or —
 *   <button data-siamepos-voucher>Buy a Gift Voucher</button>
 *   — or open from JS:  SiamEPOSVoucher.open()
 *
 * Flow:
 *   1. Amount        (£25/50/100/150 presets + custom £10–£500)
 *   2. Personalise   (recipient name/email + sender + message + delivery)
 *   3. Pay           (Stripe Elements if STRIPE_PUBLISHABLE_KEY set,
 *                     otherwise a one-click mock-pay for demos)
 *   4. Success       (voucher code revealed + email-sent note)
 */
(function () {
  'use strict';

  const SELF_SCRIPT = (function () {
    try {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        if ((scripts[i].src || '').indexOf('voucher-widget.js') !== -1) return scripts[i];
      }
    } catch (e) {}
    return null;
  })();

  const API = (function () {
    try { if (SELF_SCRIPT && SELF_SCRIPT.src) return new URL(SELF_SCRIPT.src).origin; }
    catch (e) {}
    return 'https://restaurant-epos-production.up.railway.app';
  })();

  const RESTAURANT_ID = (SELF_SCRIPT && SELF_SCRIPT.getAttribute('data-restaurant')) || 'siamepos';

  // ── Styles ──────────────────────────────────────────────────────
  const css = `
    .vw-overlay { position:fixed; inset:0; background:rgba(13,27,62,0.7); z-index:99998;
      display:flex; align-items:center; justify-content:center; padding:0;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif; }
    .vw-modal { background:#fff; width:100%; max-width:520px; max-height:92vh;
      border-radius:16px; overflow:hidden; display:flex; flex-direction:column;
      box-shadow:0 30px 80px rgba(0,0,0,0.35); }
    @media(max-width:560px) { .vw-modal { max-width:100%; max-height:100vh; height:100vh; border-radius:0; } }
    .vw-header { background:linear-gradient(135deg,#1e3a6e,#2a4d8a); padding:18px 22px;
      display:flex; align-items:center; justify-content:space-between; }
    .vw-title { color:#fff; font-family:Georgia,serif; font-size:20px; font-weight:400; }
    .vw-title small { display:block; color:#C9A84C; font-size:11px; letter-spacing:2px;
      text-transform:uppercase; margin-bottom:3px; font-family:system-ui,sans-serif; font-weight:600; }
    .vw-close { background:transparent; border:none; color:#fff; font-size:28px;
      cursor:pointer; padding:0; line-height:1; opacity:0.7; }
    .vw-close:hover { opacity:1; }
    .vw-body { padding:24px 22px; overflow-y:auto; flex:1; color:#1a1a2e; }
    .vw-steps { display:flex; gap:6px; padding:14px 22px 0; }
    .vw-step { flex:1; height:4px; background:#eee; border-radius:2px; }
    .vw-step.active { background:#C9A84C; }
    .vw-h { font-size:18px; font-weight:700; margin:0 0 14px; }
    .vw-h small { display:block; font-size:13px; font-weight:400; color:#777; margin-top:3px; }
    .vw-amounts { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
    .vw-amt { padding:18px 8px; border:2px solid #e0e0e0; border-radius:10px; background:#fff;
      color:#1a1a2e; font-weight:700; font-size:17px; cursor:pointer; transition:all 0.15s; }
    .vw-amt:hover { border-color:#C9A84C; }
    .vw-amt.selected { border-color:#1e3a6e; background:#fdf6ec; color:#1e3a6e; }
    .vw-custom { display:flex; align-items:center; gap:10px; padding:14px;
      border:2px dashed #e0e0e0; border-radius:10px; margin-bottom:8px; }
    .vw-custom-label { font-size:13px; color:#666; font-weight:600; }
    .vw-custom input { flex:1; padding:10px 12px; border:1px solid #ccc; border-radius:6px;
      font-size:16px; font-weight:700; -webkit-appearance:none; }
    .vw-hint { font-size:12px; color:#888; margin-top:6px; }
    .vw-err  { font-size:13px; color:#b91c1c; background:#fee2e2; padding:10px 12px;
      border-radius:8px; margin-bottom:12px; }
    label { display:block; margin-bottom:12px; }
    label > span { display:block; font-size:12px; color:#555; font-weight:600;
      margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px; }
    label input, label textarea { width:100%; padding:11px 12px; border:1px solid #ccc;
      border-radius:8px; font-size:15px; box-sizing:border-box; font-family:inherit;
      -webkit-appearance:none; }
    label textarea { min-height:80px; resize:vertical; }
    .vw-actions { display:flex; gap:10px; padding:16px 22px; border-top:1px solid #eee;
      background:#fafaf7; }
    .vw-btn { flex:1; padding:14px; border-radius:10px; border:none; cursor:pointer;
      font-weight:700; font-size:15px; transition:all 0.15s; }
    .vw-btn.primary { background:#C9A84C; color:#1a1a2e; }
    .vw-btn.primary:hover:not(:disabled) { background:#d5b85e; }
    .vw-btn.ghost { background:#fff; border:1px solid #ccc; color:#555; flex:0 0 auto; padding:14px 20px; }
    .vw-btn:disabled { opacity:0.45; cursor:not-allowed; }
    .vw-summary { background:#fdf6ec; border-left:3px solid #C9A84C; padding:14px 16px;
      border-radius:0 8px 8px 0; margin-bottom:18px; font-size:14px; color:#5b4a2a; }
    .vw-summary strong { color:#1e3a6e; }
    .vw-pay-mode { font-size:11px; padding:4px 8px; border-radius:4px; display:inline-block;
      margin-bottom:10px; font-weight:600; }
    .vw-pay-mode.real { background:#dcfce7; color:#15803d; }
    .vw-pay-mode.mock { background:#fef3c7; color:#92400e; }
    .vw-success-box { text-align:center; padding:20px 0; }
    .vw-success-box .check { font-size:44px; color:#22c55e; }
    .vw-code { background:linear-gradient(135deg,#1e3a6e,#2a4d8a); color:#fff; padding:22px;
      border-radius:12px; margin:18px 0; text-align:center; }
    .vw-code .amt { color:#C9A84C; font-size:14px; letter-spacing:2px;
      text-transform:uppercase; margin-bottom:4px; font-weight:600; }
    .vw-code .val { font-size:38px; font-weight:700; margin-bottom:14px; }
    .vw-code .code { background:rgba(255,255,255,0.1); border:1px dashed rgba(255,255,255,0.35);
      border-radius:8px; padding:12px; font-family:Menlo,Consolas,monospace; font-size:20px;
      letter-spacing:3px; font-weight:700; }
    .vw-fab { position:fixed; bottom:24px; right:24px; background:#C9A84C; color:#0D1B3E;
      border:none; border-radius:30px; padding:14px 22px; font-weight:800; font-size:14px;
      cursor:pointer; box-shadow:0 6px 20px rgba(13,27,62,0.35); z-index:99997;
      font-family:system-ui,-apple-system,sans-serif; }
    .vw-fab:hover { background:#d5b85e; }
    #vw-stripe-payment-element { padding:10px 0 14px; }
  `;

  // ── State ───────────────────────────────────────────────────────
  let modalEl = null;
  let config  = null;
  let stripe  = null;
  let elements = null;
  let state = null;

  function freshState() {
    return {
      step: 1, // 1 amount, 2 details, 3 pay, 4 success
      amount: null,
      recipient_name:  '',
      recipient_email: '',
      sender_name:     '',
      message:         '',
      delivery_date:   todayIso(),
      pi: null,            // { payment_intent_id, client_secret, mode, publishable_key }
      voucher: null,       // success state
      err: '',
      submitting: false,
    };
  }

  function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  // ── Open / close ────────────────────────────────────────────────
  async function open() {
    if (modalEl) return;
    state = freshState();
    injectStyles();
    if (!config) {
      try {
        const r = await fetch(API + '/api/widget/voucher/config');
        config = await r.json();
      } catch (e) {
        config = { min: 10, max: 500, expiry_months: 24, stripe_enabled: false };
      }
    }
    mountModal();
    render();
  }

  function close() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    stripe = null;
    elements = null;
  }

  function injectStyles() {
    if (document.getElementById('vw-styles')) return;
    const s = document.createElement('style');
    s.id = 'vw-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function mountModal() {
    modalEl = document.createElement('div');
    modalEl.className = 'vw-overlay';
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) close(); });
    document.body.appendChild(modalEl);
  }

  // ── Render ──────────────────────────────────────────────────────
  function render() {
    if (!modalEl) return;
    const stepActive = (n) => n <= state.step && state.step !== 4;
    modalEl.innerHTML = `
      <div class="vw-modal">
        <div class="vw-header">
          <div class="vw-title"><small>Gift Voucher</small>${escapeHtml(config.restaurant_name || 'Restaurant')}</div>
          <button class="vw-close" type="button">×</button>
        </div>
        ${state.step < 4 ? `
          <div class="vw-steps">
            <div class="vw-step ${stepActive(1) ? 'active' : ''}"></div>
            <div class="vw-step ${stepActive(2) ? 'active' : ''}"></div>
            <div class="vw-step ${stepActive(3) ? 'active' : ''}"></div>
          </div>` : ''}
        <div class="vw-body">${bodyHtml()}</div>
        ${footerHtml()}
      </div>`;
    modalEl.querySelector('.vw-close').addEventListener('click', close);
    bindBody();
    bindFooter();
    if (state.step === 3 && state.pi && state.pi.mode === 'stripe') {
      mountStripeElements();
    }
  }

  function bodyHtml() {
    if (state.err) return `<div class="vw-err">${escapeHtml(state.err)}</div>` + innerBody();
    return innerBody();
  }

  function innerBody() {
    if (state.step === 1) {
      const presets = [25, 50, 100, 150];
      return `
        <h2 class="vw-h">Choose an amount<small>£${config.min} minimum · £${config.max} maximum</small></h2>
        <div class="vw-amounts">
          ${presets.map(a => `<button class="vw-amt ${state.amount === a ? 'selected' : ''}" data-amt="${a}">£${a}</button>`).join('')}
        </div>
        <div class="vw-custom">
          <span class="vw-custom-label">£ Custom</span>
          <input type="number" min="${config.min}" max="${config.max}" step="1" placeholder="Other amount"
                 value="${state.amount && ![25,50,100,150].includes(state.amount) ? state.amount : ''}" id="vw-custom-input"/>
        </div>
        <div class="vw-hint">Valid for ${config.expiry_months || 24} months · digital delivery by email</div>
      `;
    }
    if (state.step === 2) {
      return `
        <div class="vw-summary">Gifting <strong>£${state.amount}</strong> voucher</div>
        <label><span>Recipient's name</span>
          <input id="vw-rname" type="text" maxlength="80" value="${escapeAttr(state.recipient_name)}"/></label>
        <label><span>Recipient's email *</span>
          <input id="vw-remail" type="email" maxlength="120" required value="${escapeAttr(state.recipient_email)}"/></label>
        <label><span>Your name (from)</span>
          <input id="vw-sname" type="text" maxlength="80" value="${escapeAttr(state.sender_name)}"/></label>
        <label><span>Message (optional)</span>
          <textarea id="vw-message" maxlength="400">${escapeHtml(state.message)}</textarea></label>
        <label><span>Delivery date</span>
          <input id="vw-ddate" type="date" min="${todayIso()}" value="${state.delivery_date || todayIso()}"/></label>
      `;
    }
    if (state.step === 3) {
      const isMock = !state.pi || state.pi.mode === 'mock';
      return `
        <div class="vw-summary">£${state.amount} voucher for <strong>${escapeHtml(state.recipient_name || state.recipient_email)}</strong></div>
        ${isMock
          ? `<div class="vw-pay-mode mock">Demo mode (no real charge)</div>
             <p style="font-size:14px;color:#666;line-height:1.5">Stripe isn't configured on this site — click <strong>Pay</strong> to simulate the purchase end-to-end. The voucher + gift email will still be created.</p>`
          : `<div class="vw-pay-mode real">Secure payment via Stripe</div>
             <div id="vw-stripe-payment-element"></div>`}
      `;
    }
    if (state.step === 4) {
      const v = state.voucher;
      return `
        <div class="vw-success-box">
          <div class="check">✓</div>
          <h2 class="vw-h" style="margin:8px 0 0">Voucher created</h2>
          <p style="font-size:14px;color:#666;margin:6px 0 0">${v.recipient_name ? 'A gift email is on its way to ' : 'The voucher code is ready for '}<strong>${escapeHtml(state.recipient_email)}</strong>.</p>
        </div>
        <div class="vw-code">
          <div class="amt">Voucher Value</div>
          <div class="val">£${Number(v.original_amount).toFixed(2)}</div>
          <div class="code">${v.code}</div>
        </div>
        <p style="font-size:12px;color:#888;text-align:center">Valid until ${new Date(String(v.expires_at).slice(0,10)+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})} · keep this code safe</p>
      `;
    }
    return '';
  }

  function footerHtml() {
    if (state.step === 4) {
      return `<div class="vw-actions"><button class="vw-btn primary" id="vw-close-2">Done</button></div>`;
    }
    const back = state.step > 1 ? `<button class="vw-btn ghost" id="vw-back">← Back</button>` : '';
    const next = state.step === 3
      ? `<button class="vw-btn primary" id="vw-pay" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Processing…' : (state.pi && state.pi.mode === 'mock' ? 'Pay (demo)' : 'Pay £' + state.amount)}</button>`
      : `<button class="vw-btn primary" id="vw-next">Continue →</button>`;
    return `<div class="vw-actions">${back}${next}</div>`;
  }

  // ── Bindings ────────────────────────────────────────────────────
  function bindBody() {
    if (state.step === 1) {
      modalEl.querySelectorAll('.vw-amt').forEach(b => b.addEventListener('click', () => {
        state.amount = Number(b.dataset.amt);
        state.err = '';
        render();
      }));
      const ci = modalEl.querySelector('#vw-custom-input');
      ci && ci.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        state.amount = Number.isFinite(v) ? v : null;
      });
    }
    if (state.step === 2) {
      const bind = (id, key) => {
        const el = modalEl.querySelector(id);
        if (el) el.addEventListener('input', (e) => { state[key] = e.target.value; });
      };
      bind('#vw-rname',  'recipient_name');
      bind('#vw-remail', 'recipient_email');
      bind('#vw-sname',  'sender_name');
      bind('#vw-message','message');
      bind('#vw-ddate',  'delivery_date');
    }
  }

  function bindFooter() {
    const back = modalEl.querySelector('#vw-back');
    back && back.addEventListener('click', () => { state.err = ''; state.step--; render(); });
    const next = modalEl.querySelector('#vw-next');
    next && next.addEventListener('click', onNext);
    const pay  = modalEl.querySelector('#vw-pay');
    pay  && pay.addEventListener('click', onPay);
    const done = modalEl.querySelector('#vw-close-2');
    done && done.addEventListener('click', close);
  }

  // ── Step transitions ────────────────────────────────────────────
  async function onNext() {
    state.err = '';
    if (state.step === 1) {
      const n = Number(state.amount);
      if (!Number.isFinite(n) || n < config.min) return setErr(`Minimum £${config.min}`);
      if (n > config.max) return setErr(`Maximum £${config.max}`);
      state.step = 2;
      return render();
    }
    if (state.step === 2) {
      if (!state.recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.recipient_email)) {
        return setErr('Please enter a valid recipient email');
      }
      // Create the PI now so step 3 can mount Stripe Elements immediately.
      state.submitting = true; render();
      try {
        const r = await fetch(API + '/api/widget/voucher/purchase', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: state.amount }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to start payment');
        state.pi = data;
        state.step = 3;
      } catch (e) { state.err = e.message; }
      state.submitting = false;
      render();
    }
  }

  async function onPay() {
    state.err = '';
    state.submitting = true; render();
    try {
      if (state.pi.mode === 'stripe') {
        if (!stripe || !elements) throw new Error('Payment not ready — please wait a moment');
        const { error } = await stripe.confirmPayment({
          elements, redirect: 'if_required',
          confirmParams: { return_url: window.location.href },
        });
        if (error) throw new Error(error.message || 'Payment failed');
      }
      // Confirm with backend — verifies PI server-side, creates voucher, sends email
      const r = await fetch(API + '/api/widget/voucher/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_intent_id: state.pi.payment_intent_id,
          amount: state.amount,
          recipient_name:  state.recipient_name,
          recipient_email: state.recipient_email,
          sender_name:     state.sender_name,
          message:         state.message,
          delivery_date:   state.delivery_date,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to create voucher');
      state.voucher = data.voucher;
      state.step = 4;
    } catch (e) { state.err = e.message; }
    state.submitting = false;
    render();
  }

  function setErr(msg) {
    state.err = msg;
    render();
  }

  async function mountStripeElements() {
    if (stripe) return; // already mounted
    if (!window.Stripe) {
      await loadScript('https://js.stripe.com/v3/');
    }
    // SIAMPAY-002 — platform mode: the PI lives on the client's connected
    // account, so Stripe.js must be scoped to it.
    stripe = state.pi.stripe_account
      ? window.Stripe(state.pi.publishable_key, { stripeAccount: state.pi.stripe_account })
      : window.Stripe(state.pi.publishable_key);
    elements = stripe.elements({
      clientSecret: state.pi.client_secret,
      appearance: { theme: 'stripe', variables: { colorPrimary: '#1e3a6e' } },
    });
    const el = elements.create('payment');
    el.mount('#vw-stripe-payment-element');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ── Auto-mount ──────────────────────────────────────────────────
  function autoMount() {
    document.querySelectorAll('[data-siamepos-voucher]').forEach((el) => {
      el.addEventListener('click', open);
    });
    document.querySelectorAll('#siamepos-voucher').forEach((el) => {
      if (el.dataset.vwMounted) return;
      el.dataset.vwMounted = '1';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '🎁 Buy a Gift Voucher';
      b.className = 'vw-fab';
      b.style.position = 'static';
      b.style.borderRadius = '10px';
      b.style.padding = '14px 24px';
      b.addEventListener('click', open);
      el.appendChild(b);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();

  window.SiamEPOSVoucher = { open, close };
})();
