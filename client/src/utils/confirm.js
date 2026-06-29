// Shared confirm dialog — drop-in replacement for window.confirm().
// BUG-EPOS-004 + BUG-EPOS-006: window.confirm()'s native style sticks
// out against the navy/gold SiamEPOS UI and is disabled in Electron
// from v22+. This utility renders a brand-aligned modal and returns
// a Promise<boolean>, so call sites just become:
//
//   if (!await confirm('Are you sure?')) return;
//
// or for binary picks:
//
//   const type = (await confirm('OK = percent\nCancel = fixed')) ? 'percent' : 'fixed';
//
// Options:
//   okLabel      — text on the confirm button   (default 'OK')
//   cancelLabel  — text on the cancel button    (default 'Cancel')
//   danger       — paints the OK button red     (for destructive ops)

const Z = 10000;

export function confirm(message, options = {}) {
  return new Promise((resolve) => {
    const okLabel     = options.okLabel     || 'OK';
    const cancelLabel = options.cancelLabel || 'Cancel';
    const danger      = !!options.danger;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(13,27,62,0.55);
      z-index:${Z}; display:flex; align-items:center; justify-content:center;
      font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding:20px; box-sizing:border-box;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background:white; border-radius:16px; padding:24px 24px 18px;
      max-width:440px; width:100%;
      box-shadow:0 24px 60px rgba(0,0,0,0.35);
      animation: spConfirmIn 180ms ease-out;
    `;
    // Inject keyframes once.
    if (!document.getElementById('confirm-modal-keyframes')) {
      const style = document.createElement('style');
      style.id = 'confirm-modal-keyframes';
      style.textContent = '@keyframes spConfirmIn { from { opacity:0; transform: translateY(-8px) scale(0.98); } to { opacity:1; transform: translateY(0) scale(1); } }';
      document.head.appendChild(style);
    }

    const msg = document.createElement('div');
    msg.textContent = String(message ?? '');
    msg.style.cssText = `
      font-size:15px; color:#0D1B3E; line-height:1.5;
      white-space:pre-wrap; margin-bottom:22px;
    `;

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText = `
      padding:10px 18px; border:1px solid #d4d4d8; border-radius:8px;
      background:white; color:#555; font-size:14px; font-weight:600;
      cursor:pointer; font-family:inherit;
    `;

    const okBtn = document.createElement('button');
    okBtn.textContent = okLabel;
    okBtn.style.cssText = `
      padding:10px 20px; border:none; border-radius:8px;
      background:${danger ? '#dc2626' : '#0D1B3E'};
      color:white; font-size:14px; font-weight:700;
      cursor:pointer; font-family:inherit;
    `;

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter')  { e.preventDefault(); close(true); }
    }

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    window.addEventListener('keydown', onKey, true);

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    modal.appendChild(msg);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setTimeout(() => okBtn.focus(), 30);
  });
}
