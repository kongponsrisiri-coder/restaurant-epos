import { useState, useEffect } from 'react';
import { startMonitoring, onStatusChange, getServerStatus } from './utils/serverDetect';
import { getRestaurant } from './api';
import { planCaps } from './utils/plan';
import LoginScreen from './screens/LoginScreen';
import TableMapScreen from './screens/TableMapScreen';
import OrderScreen from './screens/OrderScreen';
import KitchenScreen from './screens/KitchenScreen';
import AdminScreen from './screens/AdminScreen';
import BarScreen from './screens/BarScreen';
import ReservationsScreen from './screens/ReservationsScreen';
import CounterScreen from './screens/CounterScreen';
import SyncQueuePill from './components/SyncQueuePill';
import './App.css';

// ── Sandy: Lotus badge logo mark — replaces SVG flags ─────────────
// Used in both navbars (order screen + main layout)
// Brand CI: Thai Gold #C9A84C on Deep Navy #0D1B3E
const LogoBrand = () => (
  <span className="navbar-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    {/* Lotus badge icon mark */}
    <svg
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 32, height: 32, flexShrink: 0 }}
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8"/>
      <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" strokeWidth="0.6" opacity="0.28"/>
      <g transform="translate(50,50)">
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
        <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
        <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
      </g>
    </svg>
    {/* Wordmark */}
    <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px' }}>
      <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#C9A84C' }}>EPOS</span>
    </span>
  </span>
);

const INSTALL_DISMISSED_KEY = 'siamepos-install-dismissed';

// SEPOS-045 — per-device counter mode. Stored in localStorage so the till
// iPad stays in counter mode across restarts while floor iPads stay normal.
const COUNTER_MODE_KEY = 'siamepos-counter-mode';
function readCounterMode() {
  try { return localStorage.getItem(COUNTER_MODE_KEY) === '1'; } catch { return false; }
}

export default function App() {
  const [staff, setStaff]               = useState(null);
  const [counterMode, setCounterMode]   = useState(readCounterMode);
  const [screen, setScreen]             = useState(() => readCounterMode() ? 'counter' : 'tables');
  // SEPOS-LITE-001 — subscription plan drives which screens are shown.
  // Defaults to 'pro' so a Pro install renders fully even before the
  // fetch resolves (and if the fetch ever fails).
  const [plan, setPlan]                 = useState('pro');
  const [activeOrder, setActiveOrder]   = useState(null);
  const [menuOpen, setMenuOpen]         = useState(false);
  const [serverStatus, setServerStatus] = useState(getServerStatus());
  const [installPrompt, setInstallPrompt]   = useState(null);
  const [installDismissed, setInstallDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'
  );
  const isMobile = window.innerWidth < 768;

  useEffect(() => {
    startMonitoring();
    return onStatusChange((status) => setServerStatus(status));
  }, []);

  useEffect(() => {
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // SEPOS-LITE-001 — load the restaurant's subscription plan. Fail-safe:
  // any error leaves plan = 'pro' so the full EPOS still renders.
  useEffect(() => {
    getRestaurant()
      .then((r) => { if (r && r.plan) setPlan(r.plan); })
      .catch(() => {});
  }, []);

  // Keep the active screen valid for the plan — a lite restaurant has no
  // Tables / Counter / Bar, so redirect off them to the first allowed screen.
  useEffect(() => {
    if (!staff) return;
    const caps = planCaps(plan);
    const allowed = new Set(['admin']);
    if (caps.dineIn)     { allowed.add('tables'); allowed.add('counter'); allowed.add('order'); allowed.add('bar'); }
    if (caps.reservations) allowed.add('reservations');
    if (caps.kitchen)      allowed.add('kitchen');
    if (!allowed.has(screen)) {
      setScreen(caps.kitchen ? 'kitchen' : caps.reservations ? 'reservations' : 'admin');
    }
  }, [plan, staff, screen]);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const handleDismissInstall = () => {
    setInstallDismissed(true);
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, '1'); } catch {}
  };

  // ── Status badge ──────────────────────────────────────────────
  const StatusBadge = () => (
    <span style={{
      fontSize: 11, fontWeight: 700,
      padding: '3px 8px', borderRadius: 10,
      background: serverStatus === 'cloud' ? '#22c55e' : serverStatus === 'local' ? '#f59e0b' : '#ef4444',
      color: 'white', cursor: 'default',
    }}>
      {serverStatus === 'cloud' ? '🟢 Cloud' : serverStatus === 'local' ? '🟡 Local' : '🔴 Offline'}
    </span>
  );

  // ── Install banner ────────────────────────────────────────────
  const InstallBanner = () => {
    if (!installPrompt || installDismissed) return null;
    return (
      <div style={{
        position: 'fixed', bottom: 16, left: 16, right: 16,
        maxWidth: 480, margin: '0 auto',
        background: '#1a1a2e', color: 'white',
        padding: '12px 16px', borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        border: '1px solid rgba(201,168,76,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, zIndex: 9999,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          Install SiamEPOS for faster access?
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={handleInstall} style={{
            background: '#C9A84C', color: '#0D1B3E', border: 'none',
            padding: '6px 14px', borderRadius: 6,
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>Install</button>
          <button onClick={handleDismissInstall} aria-label="Dismiss" style={{
            background: 'transparent', color: 'rgba(255,255,255,0.7)',
            border: 'none', padding: '4px 8px', fontSize: 20, cursor: 'pointer', lineHeight: 1,
          }}>×</button>
        </div>
      </div>
    );
  };

  // ── Determine body ────────────────────────────────────────────
  let body;

  if (!staff) {
    body = <LoginScreen onLogin={setStaff} />;
  } else if (staff.role === 'kitchen') {
    body = <KitchenScreen />;
  } else if (staff.role === 'bar') {
    body = <BarScreen />;
  } else if (screen === 'order' && activeOrder) {
    body = (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f5f5f5' }}>
        <nav className="navbar">
          <LogoBrand />
          <div className="navbar-user">
            <StatusBadge />
            <span style={{ fontSize: isMobile ? 12 : 14 }}>{staff.name}</span>
            <button className="logout-btn" onClick={() => setStaff(null)}>Log out</button>
          </div>
        </nav>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <OrderScreen
            orderId={activeOrder.orderId}
            tableId={activeOrder.tableId}
            staff={staff}
            onClose={() => {
              setActiveOrder(null);
              setScreen('tables');
            }}
          />
        </div>
      </div>
    );
  } else {
    // ── Nav items ─────────────────────────────────────────────────
    // SEPOS-045 — in counter mode the home tab is the till; in floor mode
    // it's the table map. The other tabs (Kitchen / Bar / Reservations /
    // Admin) are always available regardless of mode.
    const homeItem = counterMode
      ? { key: 'counter', label: '🛒 Counter' }
      : { key: 'tables',  label: '🗺️ Tables'  };
    // SEPOS-LITE-001 — gate nav by plan. Pro shows all; lite plans drop
    // the dine-in screens (Tables/Counter, Bar) and keep only the
    // booking / KDS screens their tier includes.
    const caps = planCaps(plan);
    const navItems = [
      ...(caps.dineIn ? [homeItem] : []),
      ...(caps.reservations ? [{ key: 'reservations', label: '🗓️ Reservations' }] : []),
      ...(staff.role === 'admin' || staff.role === 'manager' || staff.role === 'supervisor'
        ? [{ key: 'admin', label: '⚙️ Admin' }]
        : []),
      ...(caps.kitchen ? [{ key: 'kitchen', label: '🍳 Kitchen' }] : []),
      ...(caps.dineIn ? [{ key: 'bar', label: '🍹 Bar' }] : []),
    ];

    const toggleCounterMode = () => {
      const next = !counterMode;
      try { localStorage.setItem(COUNTER_MODE_KEY, next ? '1' : '0'); } catch {}
      setCounterMode(next);
      setScreen(next ? 'counter' : 'tables');
    };

    // ── Main layout ───────────────────────────────────────────────
    body = (
      <div className="app">
        <nav className="navbar">
          <LogoBrand />

          {/* Desktop nav */}
          <div className="navbar-links" style={{ display: isMobile ? 'none' : 'flex' }}>
            {navItems.map(item => (
              <button
                key={item.key}
                className={screen === item.key ? 'active' : ''}
                onClick={() => setScreen(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Mobile hamburger */}
          {isMobile && (
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              style={{ background: 'none', border: 'none', color: 'white', fontSize: 24, cursor: 'pointer', padding: '0 8px' }}
            >
              ☰
            </button>
          )}

          <div className="navbar-user">
            <StatusBadge />
            {/* SEPOS-044 — always-visible pill when anything is queued. */}
            <SyncQueuePill compact={isMobile} />
            {/* SEPOS-045 — counter/floor mode toggle. Per-device flag. */}
            <button
              onClick={toggleCounterMode}
              title={counterMode ? 'Switch to floor (dine-in) mode' : 'Switch to counter (till) mode'}
              style={{
                background: counterMode ? '#C9A84C' : 'rgba(255,255,255,0.12)',
                color: counterMode ? '#0D1B3E' : 'white',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 6, padding: isMobile ? '5px 9px' : '6px 12px',
                fontSize: isMobile ? 11 : 12, fontWeight: 800, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {counterMode ? '🛒 Counter' : '🏠 Floor'}
            </button>
            <span style={{ fontSize: isMobile ? 12 : 14 }}>{staff.name}</span>
            <button className="logout-btn" onClick={() => setStaff(null)}>Log out</button>
          </div>
        </nav>

        {/* Mobile dropdown */}
        {isMobile && menuOpen && (
          <div style={{
            background: '#1a1a2e', padding: '8px 16px',
            display: 'flex', flexDirection: 'column', gap: 4,
            borderBottom: '2px solid rgba(201,168,76,0.3)',
          }}>
            {navItems.map(item => (
              <button
                key={item.key}
                onClick={() => { setScreen(item.key); setMenuOpen(false); }}
                style={{
                  background: screen === item.key ? 'rgba(201,168,76,0.2)' : 'transparent',
                  border: 'none',
                  color: screen === item.key ? '#C9A84C' : 'rgba(255,255,255,0.8)',
                  padding: '12px 16px', borderRadius: 8,
                  textAlign: 'left', fontSize: 15, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {/* Screen content */}
        <main className="main-content">
          {screen === 'tables' && (
            <TableMapScreen
              staff={staff}
              onOpenOrder={(orderId, tableId) => {
                setActiveOrder({ orderId, tableId });
                setScreen('order');
              }}
            />
          )}
          {screen === 'counter'      && <CounterScreen staff={staff} />}
          {screen === 'reservations' && <ReservationsScreen />}
          {screen === 'kitchen'      && <KitchenScreen />}
          {screen === 'bar'          && <BarScreen />}
          {screen === 'admin'        && <AdminScreen plan={plan} />}
        </main>
      </div>
    );
  }

  return (
    <>
      {body}
      <InstallBanner />
    </>
  );
}
