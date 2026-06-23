import { useState, useEffect } from 'react';
import { startMonitoring, onStatusChange, getServerStatus } from './utils/serverDetect';
import { getRestaurant, getLicenseState } from './api';
import { canAccessReservations, canAccessKitchen, canAccessFullEPOS } from './utils/plan';
import UpgradeLocked from './components/UpgradeLocked';
import LoginScreen from './screens/LoginScreen';
import TableMapScreen from './screens/TableMapScreen';
import OrderScreen from './screens/OrderScreen';
import KitchenScreen from './screens/KitchenScreen';
import AdminScreen from './screens/AdminScreen';
import BarScreen from './screens/BarScreen';
import ReservationsScreen from './screens/ReservationsScreen';
import CounterScreen from './screens/CounterScreen';
import SyncQueuePill from './components/SyncQueuePill';
import LockScreen from './screens/LockScreen';
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
  const [staff, setStaff]               = useState(() => {
    // SEPOS-LITE-003 — restore a persisted email-login session (14-day
    // token) so a Lite owner isn't asked to sign in every day.
    try {
      const raw = localStorage.getItem('siamepos_auth');
      if (raw) {
        const a = JSON.parse(raw);
        if (a && a.staff && a.expires_at && a.expires_at > Date.now()) return a.staff;
        localStorage.removeItem('siamepos_auth');
      }
    } catch {}
    return null;
  });
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

  // SEPOS-PRO-004 — desktop auto-update: main.js fires 'siamepos:update-ready'
  // once electron-updater has downloaded a new version. Show a banner so staff
  // can restart and apply it now instead of waiting for an incidental restart.
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (window.siamepos && window.siamepos.onUpdateReady) {
      window.siamepos.onUpdateReady(() => setUpdateReady(true));
    }
  }, []);

  // SEPOS-060 phase 2 — desktop offline license lock. Poll the local license
  // state; if the subscription has lapsed (grace expired / clock rollback) the
  // till is locked. Fails open everywhere else (cloud, or until the signing key
  // is deployed), so this never blocks a paying till or the web POS.
  const [licenseLock, setLicenseLock] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const st = await getLicenseState();
        if (alive) setLicenseLock(st && st.locked ? st : null);
      } catch { /* unreachable → leave as-is (don't lock on a failed poll) */ }
    };
    poll();
    const id = setInterval(poll, 5 * 60 * 1000); // re-check every 5 min for the banner/unlock
    return () => { alive = false; clearInterval(id); };
  }, []);

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

  // SEPOS-LITE-001/002 — load the restaurant's subscription plan, then
  // land on a screen the plan can actually use. Fail-safe: any error
  // leaves plan = 'pro' so the full EPOS still renders. Locked screens
  // stay reachable — they show an upgrade panel, not a blank page.
  useEffect(() => {
    getRestaurant()
      .then((r) => {
        const p = (r && r.plan) || 'pro';
        setPlan(p);
        setScreen((cur) => {
          if (cur === 'counter' && !canAccessFullEPOS(p)) {
            return canAccessReservations(p) ? 'tables' : canAccessKitchen(p) ? 'kitchen' : 'admin';
          }
          if (cur === 'tables' && !canAccessReservations(p) && !canAccessFullEPOS(p)) {
            return canAccessKitchen(p) ? 'kitchen' : 'admin';
          }
          return cur;
        });
      })
      .catch(() => {});
  }, []);

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

  // SEPOS-LITE-003 — log out: clear any persisted email-login session.
  const logout = () => {
    try { localStorage.removeItem('siamepos_auth'); } catch {}
    setStaff(null);
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

  // SEPOS-060 phase 2 — a lapsed till is fully locked: the lock screen overrides
  // login and every screen until the subscription is reactivated (or the cloud
  // re-issues a valid token). Only ever set on a desktop till past its grace.
  if (licenseLock) {
    return <LockScreen state={licenseLock} onUnlocked={() => setLicenseLock(null)} />;
  }

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
            <button className="logout-btn" onClick={logout}>Log out</button>
          </div>
        </nav>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {canAccessFullEPOS(plan) ? (
            <OrderScreen
              orderId={activeOrder.orderId}
              tableId={activeOrder.tableId}
              staff={staff}
              onClose={() => {
                setActiveOrder(null);
                setScreen('tables');
              }}
            />
          ) : (
            <UpgradeLocked feature="Dine-in Ordering" />
          )}
        </div>
      </div>
    );
  } else {
    // ── Nav items ─────────────────────────────────────────────────
    // SEPOS-045 — in counter mode the home tab is the till; in floor mode
    // it's the table map. The other tabs (Kitchen / Bar / Reservations /
    // Admin) are always available regardless of mode.
    // SEPOS-LITE-002 — capability gates for this restaurant's plan.
    const caps = {
      reservations: canAccessReservations(plan),  // also unlocks the table plan
      kitchen:      canAccessKitchen(plan),
      fullEPOS:     canAccessFullEPOS(plan),       // dine-in ordering/billing, Counter, Bar
    };
    // Counter mode is a dine-in (full EPOS) feature.
    const effectiveCounter = counterMode && caps.fullEPOS;
    const homeItem = effectiveCounter
      ? { key: 'counter', label: '🛒 Counter', locked: false }
      : { key: 'tables',  label: '🗺️ Tables',  locked: !(caps.reservations || caps.fullEPOS) };
    // Every tab still shows; tabs the plan doesn't include are marked
    // locked and open a friendly "upgrade" panel when clicked.
    const navItems = [
      homeItem,
      { key: 'reservations', label: '🗓️ Reservations', locked: !caps.reservations },
      ...(staff.role === 'admin' || staff.role === 'manager' || staff.role === 'supervisor'
        ? [{ key: 'admin', label: '⚙️ Admin', locked: false }]
        : []),
      { key: 'kitchen', label: '🍳 Kitchen', locked: !caps.kitchen },
      { key: 'bar',     label: '🍹 Bar',     locked: !caps.fullEPOS },
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
                style={item.locked ? { opacity: 0.5 } : undefined}
                title={item.locked ? 'Not in your plan — upgrade to unlock' : undefined}
              >
                {item.label}{item.locked ? ' 🔒' : ''}
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
            {/* SEPOS-045 — counter/floor mode toggle. Per-device flag.
                SEPOS-LITE-002 — dine-in only, hidden for lite plans. */}
            {caps.fullEPOS && (
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
            )}
            <span style={{ fontSize: isMobile ? 12 : 14 }}>{staff.name}</span>
            <button className="logout-btn" onClick={logout}>Log out</button>
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
                  opacity: item.locked ? 0.5 : 1,
                }}
              >
                {item.label}{item.locked ? ' 🔒' : ''}
              </button>
            ))}
          </div>
        )}

        {/* Screen content */}
        <main className="main-content">
          {screen === 'tables' && (
            (caps.reservations || caps.fullEPOS)
              ? <TableMapScreen
                  staff={staff}
                  onOpenOrder={(orderId, tableId) => {
                    setActiveOrder({ orderId, tableId });
                    setScreen('order');
                  }}
                />
              : <UpgradeLocked feature="Table Plan" />
          )}
          {screen === 'counter'      && (caps.fullEPOS ? <CounterScreen staff={staff} /> : <UpgradeLocked feature="Counter" />)}
          {screen === 'reservations' && (caps.reservations ? <ReservationsScreen /> : <UpgradeLocked feature="Reservations" />)}
          {screen === 'kitchen'      && (caps.kitchen ? <KitchenScreen /> : <UpgradeLocked feature="Kitchen" />)}
          {screen === 'bar'          && (caps.fullEPOS ? <BarScreen /> : <UpgradeLocked feature="Bar" />)}
          {screen === 'admin'        && <AdminScreen plan={plan} />}
        </main>
      </div>
    );
  }

  // SEPOS-PRO-005 — hold the "Restart to update" banner back during active
  // service. A restart nag over the live floor/order/kitchen/bar screens is
  // disruptive mid-shift, so only surface it on the safe, between-service
  // moments: the login screen (shift change) and the Admin back office. The
  // update is already downloaded either way — it also applies on the next
  // natural restart, and a manager can always restart on demand from
  // Settings → App & Updates. Kitchen/bar role users (always on a service
  // screen) get prompted at their next login.
  const updateBannerAllowed = !staff || screen === 'admin';

  return (
    <>
      {body}
      <InstallBanner />
      {updateReady && updateBannerAllowed && (
        <div style={{
          position: 'fixed', bottom: 16, left: 16, right: 16, maxWidth: 460, margin: '0 auto',
          zIndex: 100001, background: '#0D1B3E', color: 'white', borderRadius: 12,
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
        }}>
          <div style={{ flex: 1, fontSize: 14, lineHeight: 1.4 }}>
            <strong>✨ Update ready</strong><br />
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>A new version of SiamEPOS has downloaded.</span>
          </div>
          <button onClick={() => { window.siamepos && window.siamepos.restartToUpdate && window.siamepos.restartToUpdate(); }}
            style={{ background: '#C9A84C', color: '#0D1B3E', border: 'none', borderRadius: 8, padding: '10px 16px', fontWeight: 800, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Restart now
          </button>
          <button onClick={() => setUpdateReady(false)} aria-label="Dismiss"
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', padding: '0 2px' }}>×</button>
        </div>
      )}
    </>
  );
}
