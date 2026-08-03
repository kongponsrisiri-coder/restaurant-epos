/* SiamEPOS marketing site — AI sales concierge "Tara" (replaces the WhatsApp float).
   Answers SiamEPOS questions (features/pricing/setup) from the sales concierge on
   the main cloud; a human can take over from the Control Room. Navy/gold brand. */
(function () {
  var API = 'https://restaurant-epos-production.up.railway.app/api/saleschat/message';
  var API_POLL = 'https://restaurant-epos-production.up.railway.app/api/saleschat/poll';
  var GREETING = "Sawasdee ka 🙏 I'm Tara, the SiamEPOS assistant. Ask me anything about SiamEPOS — features, pricing or how it fits your restaurant or spa. I reply in English or Thai 😊";

  var css = ''
    + '#se-fab{position:fixed;right:24px;bottom:24px;z-index:99990;height:56px;border-radius:28px;background:#C9A84C;box-shadow:0 8px 24px rgba(201,168,76,.4);border:none;cursor:pointer;display:flex;align-items:center;gap:9px;padding:0 20px 0 16px;transition:transform .15s;font-family:inherit}'
    + '#se-fab:hover{transform:translateY(-2px)}'
    + '#se-fab svg{width:26px;height:26px;fill:#0D1B3E;flex:none}'
    + '#se-fab span{color:#0D1B3E;font-weight:800;font-size:14.5px;white-space:nowrap}'
    + '#se-panel{position:fixed;right:24px;bottom:92px;z-index:99991;width:374px;max-width:calc(100vw - 24px);height:566px;max-height:calc(100vh - 120px);background:#FDFAF4;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.4);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}'
    + '#se-panel.se-open{display:flex}'
    + '#se-head{background:#0D1B3E;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px}'
    + '#se-head .se-ava{width:40px;height:40px;border-radius:50%;background:#C9A84C;display:flex;align-items:center;justify-content:center;flex:none;color:#0D1B3E;font-weight:800;font-size:18px}'
    + '#se-head .se-nm{flex:1;min-width:0}'
    + '#se-head .se-t{font-weight:700;font-size:15px;line-height:1.2}'
    + '#se-head .se-s{font-size:12px;color:#C9A84C}'
    + '#se-close{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:4px 8px;line-height:1}'
    + '#se-msgs{flex:1;overflow-y:auto;padding:16px 13px;display:flex;flex-direction:column;gap:9px;background:#FDFAF4}'
    + '.se-b{max-width:82%;padding:9px 13px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;color:#0D1B3E}'
    + '.se-ai{background:#fff;align-self:flex-start;border:1px solid #efe7d4;border-top-left-radius:3px}'
    + '.se-me{background:#F1E6C6;align-self:flex-end;border-top-right-radius:3px}'
    + '.se-typing{display:inline-flex;gap:4px;align-items:center;padding:13px 15px}'
    + '.se-typing i{width:7px;height:7px;border-radius:50%;background:#C9A84C;display:inline-block;animation:seB 1.2s infinite}'
    + '.se-typing i:nth-child(2){animation-delay:.2s}.se-typing i:nth-child(3){animation-delay:.4s}'
    + '@keyframes seB{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}'
    + '#se-inrow{display:flex;gap:8px;padding:11px;background:#F3ECDD;align-items:flex-end}'
    + '#se-in{flex:1;border:1px solid #e2d7bd;border-radius:20px;padding:11px 14px;font-size:14px;outline:none;resize:none;max-height:96px;font-family:inherit;color:#0D1B3E;background:#fff}'
    + '#se-send{width:44px;height:44px;border-radius:50%;background:#0D1B3E;border:none;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center}'
    + '#se-send svg{width:20px;height:20px;fill:#C9A84C;margin-left:2px}'
    + '#se-send:disabled{opacity:.5;cursor:default}'
    + '@media(max-width:480px){#se-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}#se-fab{right:16px;bottom:16px}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var chatIcon = '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.58 2 11c0 2.05.98 3.9 2.6 5.3-.13 1.13-.6 2.4-1.36 3.32-.2.24-.03.6.28.57 1.9-.22 3.4-.86 4.44-1.5 1.06.33 2.2.51 3.44.51 5.5 0 10-3.58 10-8s-4.5-8-10-8m-3.5 9a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4m3.5 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4m3.5 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4"/></svg>';
  var sendIcon = '<svg viewBox="0 0 24 24"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  var fab = document.createElement('button');
  fab.id = 'se-fab'; fab.setAttribute('aria-label', 'Chat with the SiamEPOS assistant');
  fab.innerHTML = chatIcon + '<span>Chat with us</span>';

  var panel = document.createElement('div');
  panel.id = 'se-panel';
  panel.innerHTML = ''
    + '<div id="se-head"><div class="se-ava">✦</div>'
    + '<div class="se-nm"><div class="se-t">SiamEPOS</div><div class="se-s">Tara · here to help ✨</div></div>'
    + '<button id="se-close" aria-label="Close chat">&times;</button></div>'
    + '<div id="se-msgs"></div>'
    + '<div id="se-inrow"><textarea id="se-in" rows="1" placeholder="Type a message…"></textarea>'
    + '<button id="se-send" aria-label="Send">' + sendIcon + '</button></div>';

  document.body.appendChild(fab); document.body.appendChild(panel);

  var msgsEl = panel.querySelector('#se-msgs'), inEl = panel.querySelector('#se-in'), sendEl = panel.querySelector('#se-send');
  var history = [];
  try { history = JSON.parse(sessionStorage.getItem('se-history') || '[]'); } catch (e) {}
  var sid = '';
  try { sid = sessionStorage.getItem('se-sid') || '';
    if (!sid) { sid = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('se-sid', sid); }
  } catch (e) { sid = 'w-' + Math.random().toString(36).slice(2, 12); }
  function save() { try { sessionStorage.setItem('se-history', JSON.stringify(history.slice(-24))); } catch (e) {} }

  var polled = -1, pollTimer = null;
  function pollOnce() {
    if (!panel.classList.contains('se-open') || history.length === 0) return;
    fetch(API_POLL + '?session_id=' + encodeURIComponent(sid) + '&after=' + (polled < 0 ? 99999 : polled))
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d || typeof d.total !== 'number') return;
        if (polled < 0) { polled = d.total; return; }
        (d.messages || []).forEach(function (m) { history.push({ role: 'assistant', content: m }); bubble('assistant', m); });
        save(); polled = d.total;
      }).catch(function () {});
  }
  function startPolling() { if (!pollTimer) pollTimer = setInterval(pollOnce, 4000); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function bubble(role, text) {
    var b = document.createElement('div'); b.className = 'se-b ' + (role === 'user' ? 'se-me' : 'se-ai');
    String(text).split(/(https?:\/\/[^\s]+)/g).forEach(function (part) {
      if (/^https?:\/\//.test(part)) { var a = document.createElement('a'); a.href = part; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = part; a.style.cssText = 'color:#0D1B3E;font-weight:700;text-decoration:underline'; b.appendChild(a); }
      else if (part) { b.appendChild(document.createTextNode(part)); }
    });
    msgsEl.appendChild(b); msgsEl.scrollTop = msgsEl.scrollHeight; return b;
  }
  function typing() { var b = document.createElement('div'); b.className = 'se-b se-ai se-typing'; b.innerHTML = '<i></i><i></i><i></i>';
    msgsEl.appendChild(b); msgsEl.scrollTop = msgsEl.scrollHeight; return b; }
  function render() { msgsEl.innerHTML = ''; bubble('assistant', GREETING); history.forEach(function (m) { bubble(m.role, m.content); }); }

  function send() {
    var text = inEl.value.trim(); if (!text || sendEl.disabled) return;
    inEl.value = ''; inEl.style.height = 'auto';
    history.push({ role: 'user', content: text }); save(); bubble('user', text);
    sendEl.disabled = true; var t = typing();
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sid, message: text }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        t.remove();
        var reply = (d && d.reply) || null;
        if (reply) { history.push({ role: 'assistant', content: reply }); save(); bubble('assistant', reply); if (polled >= 0) polled += 0; }
        sendEl.disabled = false; inEl.focus();
      }).catch(function () { t.remove(); bubble('assistant', 'Sorry — I can’t connect right now. Please try again in a moment.'); sendEl.disabled = false; });
  }

  fab.addEventListener('click', function () { var open = panel.classList.toggle('se-open');
    if (open) { render(); inEl.focus(); polled = -1; pollOnce(); startPolling(); } else stopPolling(); });
  panel.querySelector('#se-close').addEventListener('click', function () { panel.classList.remove('se-open'); stopPolling(); });
  sendEl.addEventListener('click', send);
  inEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  inEl.addEventListener('input', function () { inEl.style.height = 'auto'; inEl.style.height = Math.min(inEl.scrollHeight, 96) + 'px'; });
  // Public opener so any "Chat with us" CTA on the page can open the chat (opens only; never closes)
  window.openSiamChat = function () { if (!panel.classList.contains('se-open')) fab.click(); };
})();
