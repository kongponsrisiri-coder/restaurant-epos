import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// SEPOS-ANDROID-001 — big Sunmi tills report a small CSS viewport (high device
// pixel ratio), so the UI renders oversized and tall screens (login) overflow +
// need scrolling. Force a comfortable landscape-tablet logical width so the app
// sizes correctly. Gated to native + physically-large screens, so web / iPad /
// desktop / phones are untouched.
try {
  if (window.Capacitor?.isNativePlatform?.()) {
    const physW = (window.innerWidth || 0) * (window.devicePixelRatio || 1);
    if (physW >= 1280) {
      document.querySelector('meta[name="viewport"]')
        ?.setAttribute('content', 'width=1280, viewport-fit=cover');
    }
  }
} catch {}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('SW registration failed:', err);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
