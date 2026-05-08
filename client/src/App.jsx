import { useState, useEffect } from 'react';
import { startMonitoring, onStatusChange, getServerStatus } from './utils/serverDetect';
import LoginScreen from './screens/LoginScreen';
import TableMapScreen from './screens/TableMapScreen';
import OrderScreen from './screens/OrderScreen';
import KitchenScreen from './screens/KitchenScreen';
import AdminScreen from './screens/AdminScreen';
import BarScreen from './screens/BarScreen';
import ReservationsScreen from './screens/ReservationsScreen';
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

export default function App() {
  const [staff, setStaff]               = useState(null);
  const [screen, setScreen]             = useState('tables');
  const [activeOrder, setActiveOrder]   = useState(null);
  const [menuOpen, setMenuOpen]         = useState(false);
  const [serverStatus, setServerStatus] = useState(getServerStatus());
  const isMobile = window.innerWidth < 768;

  useEffect(() => {
    startMonitoring();
    return onStatusChange((status) => setServerStatus(status));
  }, []);

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

  if (!staff) return <LoginScreen onLogin={setStaff} />;
  if (staff.role === 'kitchen') return <KitchenScreen />;
  if (staff.role === 'bar') return <BarScreen />;

  // ── Order screen ──────────────────────────────────────────────
  if (screen === 'order' && activeOrder) {
    return (
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
  }

  // ── Nav items ─────────────────────────────────────────────────
  const navItems = [
    { key: 'tables',       label: '🗺️ Tables' },
    { key: 'reservations', label: '🗓️ Reservations' },
    ...(staff.role === 'admin' || staff.role === 'manager' || staff.role === 'supervisor'
      ? [{ key: 'admin', label: '⚙️ Admin' }]
      : []),
    { key: 'kitchen', label: '🍳 Kitchen' },
    { key: 'bar',     label: '🍹 Bar' },
  ];

  // ── Main layout ───────────────────────────────────────────────
  return (
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
        {screen === 'reservations' && <ReservationsScreen />}
        {screen === 'kitchen'      && <KitchenScreen />}
        {screen === 'bar'          && <BarScreen />}
        {screen === 'admin'        && <AdminScreen />}
      </main>
    </div>
  );
}