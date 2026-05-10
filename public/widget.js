/*!
 * SiamEPOS Booking Widget v1.1
/*!
 * SiamEPOS Booking Widget v1.1
 * Drop-in reservation widget for any website
 * Usage: <script src="https://restaurant-epos-production.up.railway.app/widget.js"
 *                data-restaurant="siamepos"
 *                data-color="#1a472a"
 *                data-button-text="Book a Table">
 *        </script>
 */
(function () {
  'use strict';

  const API = 'https://restaurant-epos-production.up.railway.app';
  const script = document.currentScript;

  // ── Config from data attributes ──────────────────────────────
  const RESTAURANT_ID  = script?.getAttribute('data-restaurant') || 'siamepos';
  const BUTTON_TEXT    = script?.getAttribute('data-button-text') || 'Book a Table';
  const OVERRIDE_COLOR = script?.getAttribute('data-color') || null;

  // ── State ────────────────────────────────────────────────────
  let settings = null;
  let ACCENT   = OVERRIDE_COLOR || '#1a472a';
  let step     = 1;
  let selected = { date: '', covers: 2, time: '', slots: [] };

  // ── Helpers ──────────────────────────────────────────────────
  function todayISO() { return new Date().toISOString().split('T')[0]; }

  function maxDateISO() {
    const d = new Date();
    d.setDate(d.getDate() + (settings?.booking_advance_days || 60));
    return d.toISOString().split('T')[0];
  }

  function fmtDate(isoStr) {
    if (!isoStr) return '';
    return new Date(isoStr + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function fmtPhone(phone) {
    const cleaned = phone.replace(/\s/g, '');
    if (cleaned.startsWith('0')) return '+44' + cleaned.slice(1);
    if (cleaned.startsWith('+')) return cleaned;
    return '+44' + cleaned;
  }

  function toMins(t) {
    if (!t) return 0;
    const [h, m] = String(t).slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  }

  function el(id) { return document.getElementById(id); }
  function show(id) { const e = el(id); if (e) e.style.display = ''; }
  function hide(id) { const e = el(id); if (e) e.style.display = 'none'; }

  function showError(msg) {
    const e = el('sw-error');
    if (!e) return;
    e.textContent = '⚠️ ' + msg;
    e.style.display = 'block';
    e.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    const e = el('sw-error');
    if (e) e.style.display = 'none';
  }

  // ── Load restaurant settings ─────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch(`${API}/api/reservations/settings/${RESTAURANT_ID}`);
      if (!r.ok) throw new Error('Restaurant not found');
      settings = await r.json();
      if (!OVERRIDE_COLOR) ACCENT = settings.brand_colour || '#1a472a';
      injectStyles();
      renderButton();
    } catch (err) {
      console.error('[SiamEPOS Widget] Failed to load settings:', err.message);
      injectStyles();
      renderButton();
    }
  }

  // ── Styles ───────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sw-styles')) return;
    const s = document.createElement('style');
    s.id = 'sw-styles';
    s.textContent = `
      #sw-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.65);
        z-index: 2147483647;
        align-items: center;
        justify-content: center;
        padding: 16px;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      }
      #sw-overlay.sw-open { display: flex; }
      #sw-box {
        background: #fff;
        border-radius: 18px;
        overflow: hidden;
        width: 100%;
        max-width: 500px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 24px 80px rgba(0,0,0,0.4);
        animation: swIn 0.28s cubic-bezier(.34,1.56,.64,1);
      }
      @keyframes swIn {
        from { opacity: 0; transform: translateY(32px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      #sw-header {
        background: ${ACCENT};
        padding: 20px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      #sw-header h2 { margin: 0; color: #fff; font-size: 19px; font-weight: 700; }
      #sw-close {
        background: rgba(255,255,255,0.2);
        border: none;
        color: #fff;
        border-radius: 8px;
        width: 34px;
        height: 34px;
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      #sw-close:hover { background: rgba(255,255,255,0.3); }
      #sw-progress {
        display: flex;
        background: #f5f5f5;
        border-bottom: 1px solid #eee;
        flex-shrink: 0;
      }
      .sw-step-tab {
        flex: 1;
        padding: 10px 4px;
        text-align: center;
        font-size: 11px;
        font-weight: 600;
        color: #aaa;
        border-bottom: 3px solid transparent;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .sw-step-tab.active { color: ${ACCENT}; border-bottom-color: ${ACCENT}; }
      .sw-step-tab.done { color: #888; }
      #sw-body { padding: 24px; overflow-y: auto; flex: 1; }
      .sw-label {
        display: block;
        font-size: 13px;
        font-weight: 700;
        color: #444;
        margin-bottom: 7px;
        margin-top: 18px;
      }
      .sw-label:first-child { margin-top: 0; }
      .sw-input {
        width: 100%;
        padding: 12px 14px;
        border: 1.5px solid #ddd;
        border-radius: 10px;
        font-size: 15px;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
        font-family: inherit;
        background: #fff;
        -webkit-appearance: none;
      }
      .sw-input:focus { border-color: ${ACCENT}; box-shadow: 0 0 0 3px ${ACCENT}25; }
      .sw-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .sw-stepper {
        display: flex;
        align-items: center;
        gap: 12px;
        background: #f8f8f8;
        border-radius: 12px;
        padding: 10px 16px;
        width: fit-content;
      }
      .sw-step-btn {
        width: 40px;
        height: 40px;
        border: 2px solid ${ACCENT};
        border-radius: 10px;
        cursor: pointer;
        font-size: 22px;
        font-weight: 700;
        background: #fff;
        color: ${ACCENT};
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        -webkit-user-select: none;
        user-select: none;
        line-height: 1;
      }
      .sw-step-btn:hover { background: ${ACCENT}; color: #fff; }
      .sw-covers-num { font-size: 26px; font-weight: 800; min-width: 40px; text-align: center; color: ${ACCENT}; }
      .sw-covers-label { color: #888; font-size: 14px; }

      /* Service section headings */
      .sw-service-heading {
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: ${ACCENT};
        margin: 16px 0 8px;
        padding: 6px 10px;
        background: ${ACCENT}12;
        border-radius: 6px;
        border-left: 3px solid ${ACCENT};
      }
      .sw-service-heading:first-child { margin-top: 4px; }

      #sw-slots-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-top: 4px;
      }
      .sw-slot {
        padding: 10px 4px;
        text-align: center;
        font-size: 13px;
        font-weight: 700;
        border-radius: 9px;
        cursor: pointer;
        border: 2px solid #e0e0e0;
        background: #fff;
        color: #333;
        transition: all 0.15s;
        -webkit-user-select: none;
        user-select: none;
      }
      .sw-slot:hover:not(.sw-slot-unavail) {
        border-color: ${ACCENT};
        color: ${ACCENT};
        background: ${ACCENT}12;
      }
      .sw-slot.sw-slot-selected { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; }
      .sw-slot-unavail {
        background: #f5f5f5;
        color: #ccc;
        cursor: not-allowed;
        border-color: #eee;
        text-decoration: line-through;
      }
      #sw-slots-loading { text-align: center; color: #888; padding: 32px 0; font-size: 14px; }
      #sw-summary {
        background: ${ACCENT}10;
        border: 1.5px solid ${ACCENT}40;
        border-radius: 12px;
        padding: 14px 18px;
        margin-bottom: 18px;
        font-size: 14px;
        color: #333;
        line-height: 1.7;
      }
      #sw-summary strong { color: ${ACCENT}; }
      .sw-btn {
        width: 100%;
        padding: 15px;
        font-size: 16px;
        font-weight: 700;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        transition: opacity 0.2s, transform 0.1s;
        font-family: inherit;
        margin-top: 18px;
        -webkit-tap-highlight-color: transparent;
      }
      .sw-btn:active { transform: scale(0.98); }
      .sw-btn-primary { background: ${ACCENT}; color: #fff; }
      .sw-btn-primary:hover { opacity: 0.88; }
      .sw-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .sw-btn-back { background: #f0f0f0; color: #555; font-size: 14px; margin-top: 10px; }
      #sw-error {
        display: none;
        background: #fff0f0;
        border: 1.5px solid #f5c6cb;
        border-radius: 10px;
        padding: 12px 16px;
        font-size: 13px;
        color: #c0392b;
        margin-top: 14px;
      }
      #sw-success { text-align: center; padding: 36px 24px; }
      #sw-success .sw-tick {
        font-size: 64px;
        display: block;
        animation: swPop 0.5s cubic-bezier(.34,1.56,.64,1);
      }
      @keyframes swPop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      #sw-success h3 { color: ${ACCENT}; margin: 14px 0 8px; font-size: 22px; }
      #sw-success p { color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
      #sw-open-btn {
        display: inline-block;
        padding: 14px 28px;
        background: ${ACCENT};
        color: #fff;
        font-size: 16px;
        font-weight: 700;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        font-family: inherit;
        transition: opacity 0.2s;
        -webkit-tap-highlight-color: transparent;
      }
      #sw-open-btn:hover { opacity: 0.88; }
      @media (max-width: 480px) {
        #sw-box { border-radius: 12px; max-height: 95vh; }
        #sw-overlay { padding: 8px; align-items: flex-end; }
        #sw-body { padding: 16px; }
        #sw-header { padding: 14px 16px; }
        #sw-header h2 { font-size: 16px; }
        #sw-slots-grid { grid-template-columns: repeat(3, 1fr) !important; gap: 6px; }
        .sw-slot { padding: 8px 2px; font-size: 12px; }
        .sw-row { grid-template-columns: 1fr !important; }
        .sw-btn { padding: 14px; font-size: 15px; }
        .sw-input { font-size: 16px; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Render open button ───────────────────────────────────────
  function renderButton() {
    if (el('sw-open-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'sw-open-btn';
    btn.textContent = BUTTON_TEXT;
    btn.addEventListener('click', openWidget);
    if (script && script.parentNode) {
      script.parentNode.insertBefore(btn, script);
    } else {
      document.body.appendChild(btn);
    }
  }

  // ── Build widget HTML ────────────────────────────────────────
  function buildHTML() {
    if (el('sw-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'sw-overlay';
    overlay.innerHTML = `
      <div id="sw-box">
        <div id="sw-header">
          <h2>🍽️ ${settings?.restaurant_name || 'Book a Table'}</h2>
          <button id="sw-close" title="Close">✕</button>
        </div>
        <div id="sw-progress">
          <div class="sw-step-tab active" id="sw-tab-1">1. When</div>
          <div class="sw-step-tab" id="sw-tab-2">2. Time</div>
          <div class="sw-step-tab" id="sw-tab-3">3. Details</div>
          <div class="sw-step-tab" id="sw-tab-4">✓ Done</div>
        </div>
        <div id="sw-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    el('sw-close').addEventListener('click', closeWidget);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeWidget(); });
  }

  // ── Step rendering ───────────────────────────────────────────
  function renderStep(n) {
    step = n;
    for (let i = 1; i <= 4; i++) {
      const tab = el(`sw-tab-${i}`);
      if (!tab) continue;
      tab.className = 'sw-step-tab' + (i === n ? ' active' : i < n ? ' done' : '');
    }
    if (n === 1) renderStep1();
    if (n === 2) renderStep2();
    if (n === 3) renderStep3();
    if (n === 4) renderStep4();
  }

  // Step 1 — Date + Covers
  function renderStep1() {
    el('sw-body').innerHTML = `
      <label class="sw-label">📅 Select Date</label>
      <input class="sw-input" id="sw-date" type="date"
        min="${todayISO()}" max="${maxDateISO()}"
        value="${selected.date || todayISO()}" />
      <label class="sw-label">👥 Number of Guests</label>
      <div class="sw-stepper">
        <button class="sw-step-btn" id="sw-dec">−</button>
        <span class="sw-covers-num" id="sw-covers-num">${selected.covers}</span>
        <button class="sw-step-btn" id="sw-inc">+</button>
        <span class="sw-covers-label">guests</span>
      </div>
      <div id="sw-error"></div>
      <button class="sw-btn sw-btn-primary" id="sw-next-1">See Available Times →</button>
    `;
    el('sw-dec').addEventListener('click', () => {
      if (selected.covers > 1) { selected.covers--; el('sw-covers-num').textContent = selected.covers; }
    });
    el('sw-inc').addEventListener('click', () => {
      if (selected.covers < 30) { selected.covers++; el('sw-covers-num').textContent = selected.covers; }
    });
    el('sw-next-1').addEventListener('click', () => {
      const dateVal = el('sw-date').value;
      if (!dateVal) { showError('Please select a date'); return; }
      selected.date = dateVal;
      renderStep(2);
    });
  }

  // Step 2 — Time Slots (with lunch/dinner sections if split service)
  async function renderStep2() {
    el('sw-body').innerHTML = `
      <div style="font-size:14px;color:#666;margin-bottom:14px">
        📅 <strong>${fmtDate(selected.date)}</strong>
        &nbsp;·&nbsp;
        👥 <strong>${selected.covers} guest${selected.covers > 1 ? 's' : ''}</strong>
      </div>
      <label class="sw-label">🕐 Choose a Time</label>
      <div id="sw-slots-loading">⏳ Loading available times…</div>
      <div id="sw-slots-container"></div>
      <div id="sw-error"></div>
      <button class="sw-btn sw-btn-back" id="sw-back-2">← Back</button>
    `;
    el('sw-back-2').addEventListener('click', () => renderStep(1));

    try {
      const r = await fetch(
        `${API}/api/reservations/availability?date=${selected.date}&covers=${selected.covers}&restaurant_id=${RESTAURANT_ID}`
      );
      const data = await r.json();
      selected.slots = data.slots || [];

      hide('sw-slots-loading');
      const container = el('sw-slots-container');

      const availableSlots = selected.slots.filter(s => s.available);

      if (availableSlots.length === 0) {
        container.innerHTML = `
          <div style="text-align:center;padding:28px 0;color:#888;">
            <div style="font-size:36px;margin-bottom:8px">😔</div>
            <p style="margin:0;font-size:14px">
              No availability for ${selected.covers} guest${selected.covers > 1 ? 's' : ''} on this date.<br>
              Please try another date.
            </p>
          </div>
        `;
        return;
      }

      // ── Split service: show Lunch & Dinner sections ──────────
      const isSplit = settings?.service_type === 'split';

      if (isSplit) {
        const lunchEnd   = toMins(settings.lunch_service_end   || '14:30');
        const dinnerStart = toMins(settings.dinner_service_start || '17:30');

        const lunchSlots  = availableSlots.filter(s => toMins(s.time) <= lunchEnd);
        const dinnerSlots = availableSlots.filter(s => toMins(s.time) >= dinnerStart);

        if (lunchSlots.length > 0) {
          const heading = document.createElement('div');
          heading.className = 'sw-service-heading';
          heading.textContent = '🍜 Lunch';
          container.appendChild(heading);

          const grid = document.createElement('div');
          grid.id = 'sw-slots-grid';
          lunchSlots.forEach(slot => grid.appendChild(makeSlotBtn(slot)));
          container.appendChild(grid);
        }

        if (dinnerSlots.length > 0) {
          const heading = document.createElement('div');
          heading.className = 'sw-service-heading';
          heading.textContent = '🍷 Dinner';
          container.appendChild(heading);

          const grid = document.createElement('div');
          grid.id = 'sw-slots-grid-dinner';
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:4px;';
          dinnerSlots.forEach(slot => grid.appendChild(makeSlotBtn(slot)));
          container.appendChild(grid);
        }

      } else {
        // ── All day: single grid of available slots ──────────
        const grid = document.createElement('div');
        grid.id = 'sw-slots-grid';
        availableSlots.forEach(slot => grid.appendChild(makeSlotBtn(slot)));
        container.appendChild(grid);
      }

    } catch (err) {
      hide('sw-slots-loading');
      showError('Could not load availability. Please try again.');
      console.error('[SiamEPOS Widget] Availability error:', err);
    }
  }

  function makeSlotBtn(slot) {
    const btn = document.createElement('button');
    btn.className = 'sw-slot';
    btn.textContent = slot.time;
    btn.addEventListener('click', () => {
      selected.time = slot.time;
      renderStep(3);
    });
    return btn;
  }

  // Step 3 — Guest Details
  function renderStep3() {
    el('sw-body').innerHTML = `
      <div id="sw-summary">
        📅 <strong>${fmtDate(selected.date)}</strong><br>
        🕐 <strong>${selected.time}</strong>
        &nbsp;·&nbsp;
        👥 <strong>${selected.covers} guest${selected.covers > 1 ? 's' : ''}</strong>
      </div>
      <label class="sw-label">Your Name *</label>
      <input class="sw-input" id="sw-name" type="text" placeholder="Full name" autocomplete="name" />
      <label class="sw-label">Phone Number *</label>
      <input class="sw-input" id="sw-phone" type="tel" placeholder="e.g. 07700 900000" autocomplete="tel" />
      <label class="sw-label">Email (optional)</label>
      <input class="sw-input" id="sw-email" type="email" placeholder="your@email.com" autocomplete="email" />
      <label class="sw-label">Special Requests (optional)</label>
      <input class="sw-input" id="sw-notes" type="text" placeholder="Allergies, highchair, anniversary…" />
      <div id="sw-error"></div>
      <button class="sw-btn sw-btn-primary" id="sw-submit">Confirm Booking</button>
      <button class="sw-btn sw-btn-back" id="sw-back-3">← Back</button>
    `;
    el('sw-back-3').addEventListener('click', () => renderStep(2));
    el('sw-submit').addEventListener('click', submitBooking);
    setTimeout(() => { const n = el('sw-name'); if (n) n.focus(); }, 100);
  }

  // Step 4 — Success
  function renderStep4(bookingData) {
    el('sw-progress').style.display = 'none';
    el('sw-body').innerHTML = `
      <div id="sw-success">
        <span class="sw-tick">🎉</span>
        <h3>Booking Request Sent!</h3>
        <p>
          <strong>${selected.covers} guest${selected.covers > 1 ? 's' : ''}</strong>
          on <strong>${fmtDate(selected.date)}</strong>
          at <strong>${selected.time}</strong><br><br>
          ${bookingData?.customer_email
            ? 'A confirmation has been sent to your email.'
            : 'The restaurant will be in touch to confirm your booking.'}
        </p>
        <button class="sw-btn sw-btn-primary" id="sw-done-btn">Done</button>
      </div>
    `;
    el('sw-done-btn').addEventListener('click', closeWidget);
  }

  // ── Submit booking ───────────────────────────────────────────
  async function submitBooking() {
    hideError();
    const name  = el('sw-name')?.value.trim() || '';
    const phone = el('sw-phone')?.value.trim() || '';
    const email = el('sw-email')?.value.trim() || '';
    const notes = el('sw-notes')?.value.trim() || '';
    if (!name)  { showError('Please enter your name'); return; }
    if (!phone) { showError('Please enter your phone number'); return; }
    const btn = el('sw-submit');
    btn.disabled = true;
    btn.textContent = '⏳ Confirming…';
    try {
      const r = await fetch(`${API}/api/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurant_id: RESTAURANT_ID, customer_name: name,
          customer_phone: fmtPhone(phone), customer_email: email || null,
          covers: selected.covers, reservation_date: selected.date,
          reservation_time: selected.time, notes: notes || null, source: 'widget',
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        showError(data.error || 'Something went wrong. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Confirm Booking';
        return;
      }
      renderStep(4, { ...data.reservation, customer_email: email });
    } catch (err) {
      showError('Connection error. Please check your internet and try again.');
      btn.disabled = false;
      btn.textContent = 'Confirm Booking';
      console.error('[SiamEPOS Widget] Submit error:', err);
    }
  }

  // ── Open / Close ─────────────────────────────────────────────
  function openWidget() {
    buildHTML();
    selected = { date: todayISO(), covers: 2, time: '', slots: [] };
    renderStep(1);
    el('sw-progress').style.display = '';
    el('sw-overlay').classList.add('sw-open');
    document.body.style.overflow = 'hidden';
  }

  function closeWidget() {
    const overlay = el('sw-overlay');
    if (overlay) overlay.classList.remove('sw-open');
    document.body.style.overflow = '';
  }

  // ── Init ─────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSettings);
  } else {
    loadSettings();
  }

})();