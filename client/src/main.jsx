import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { authHeaders, SERVER_URL } from './api.js'

// SEPOS-SEC-002 — ensure every call to OUR API carries the staff login token,
// including legacy raw fetch() calls that bypass the api.js helpers (staff
// delete, order delete, menu import, table/inventory/reservation writes…).
// ADDITIVE + backward-compatible: the backend currently ignores the header, so
// behaviour is identical today — this simply prepares every write for the
// forthcoming auth gate. Only requests to our own API are touched; everything
// else (Stripe, fonts, etc.) passes through untouched, and pre-login calls
// (no token yet) are unaffected.
{
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
      if ((SERVER_URL && url.startsWith(SERVER_URL)) || url.startsWith('/api/')) {
        const auth = authHeaders();
        if (auth.Authorization) init = { ...init, headers: { ...(init.headers || {}), ...auth } };
      }
    } catch { /* never let auth injection break a request */ }
    return _origFetch(input, init);
  };
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('SW registration failed:', err);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
