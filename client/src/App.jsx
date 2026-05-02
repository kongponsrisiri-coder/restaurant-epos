import { useState, useEffect } from 'react';
import LoginScreen from './screens/LoginScreen';
import TableMapScreen from './screens/TableMapScreen';
import OrderScreen from './screens/OrderScreen';
import KitchenScreen from './screens/KitchenScreen';
import AdminScreen from './screens/AdminScreen';
import BarScreen from './screens/BarScreen';
import './App.css';

export default function App() {
  const [staff, setStaff] = useState(null);
  const [screen, setScreen] = useState('tables');
  const [activeOrder, setActiveOrder] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = window.innerWidth < 768;

  if (!staff) return <LoginScreen onLogin={setStaff} />;
  if (staff.role === 'kitchen') return <KitchenScreen />;
  if (staff.role === 'bar') return <BarScreen />;

  if (screen === 'order' && activeOrder) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f5f5f5' }}>
        <nav className="navbar">
          <span className="navbar-brand">
  <svg width="20" height="14" viewBox="0 0 32 22" style={{marginRight:3, verticalAlign:'middle'}}>
    <rect width="32" height="22" fill="#A51931" rx="2"/>
    <rect y="3.5" width="32" height="15" fill="white"/>
    <rect y="7" width="32" height="8" fill="#2D2A4A"/>
  </svg>
  <svg width="20" height="14" viewBox="0 0 60 40" style={{marginRight:6, verticalAlign:'middle'}}>
    <rect width="60" height="40" fill="#012169" rx="2"/>
    <path d="M0,0 L60,40 M60,0 L0,40" stroke="white" strokeWidth="8"/>
    <path d="M0,0 L60,40 M60,0 L0,40" stroke="#C8102E" strokeWidth="5"/>
    <path d="M30,0 L30,40 M0,20 L60,20" stroke="white" strokeWidth="13"/>
    <path d="M30,0 L30,40 M0,20 L60,20" stroke="#C8102E" strokeWidth="8"/>
  </svg>
  Siam<span style={{ color: '#C9A84C' }}>EPOS</span>
</span>
          <div className="navbar-user">
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

  return (
    <div className="app">
      <nav className="navbar">
        <span className="navbar-brand">Siam<span style={{ color: '#C9A84C' }}>EPOS</span></span>

        {/* Desktop nav */}
        <div className="navbar-links" style={{ display: isMobile ? 'none' : 'flex' }}>
          <button className={screen === 'tables' ? 'active' : ''} onClick={() => setScreen('tables')}>Tables</button>
          {(staff.role === 'admin' || staff.role === 'manager' || staff.role === 'supervisor') && (
            <button className={screen === 'admin' ? 'active' : ''} onClick={() => setScreen('admin')}>Admin</button>
          )}
          <button className={screen === 'kitchen' ? 'active' : ''} onClick={() => setScreen('kitchen')}>Kitchen view</button>
          <button className={screen === 'bar' ? 'active' : ''} onClick={() => setScreen('bar')}>Bar</button>
        </div>

        {/* Mobile hamburger */}
        {isMobile && (
          <button onClick={() => setMenuOpen(!menuOpen)} style={{
            background: 'none', border: 'none', color: 'white',
            fontSize: 24, cursor: 'pointer', padding: '0 8px'
          }}>☰</button>
        )}

        <div className="navbar-user">
          <span style={{ fontSize: isMobile ? 12 : 14 }}>{staff.name}</span>
          <button className="logout-btn" onClick={() => setStaff(null)}>Log out</button>
        </div>
      </nav>

      {/* Mobile dropdown menu */}
      {isMobile && menuOpen && (
        <div style={{
          background: '#1a1a2e', padding: '8px 16px',
          display: 'flex', flexDirection: 'column', gap: 4,
          borderBottom: '2px solid rgba(201,168,76,0.3)'
        }}>
          {[
            { key: 'tables', label: '🗺️ Tables' },
            ...(staff.role === 'admin' || staff.role === 'manager' || staff.role === 'supervisor' ? [{ key: 'admin', label: '⚙️ Admin' }] : []),
            { key: 'kitchen', label: '🍳 Kitchen' },
            { key: 'bar', label: '🍹 Bar' },
          ].map(item => (
            <button key={item.key} onClick={() => { setScreen(item.key); setMenuOpen(false); }} style={{
              background: screen === item.key ? 'rgba(201,168,76,0.2)' : 'transparent',
              border: 'none', color: screen === item.key ? '#C9A84C' : 'rgba(255,255,255,0.8)',
              padding: '12px 16px', borderRadius: 8,
              textAlign: 'left', fontSize: 15, fontWeight: 600, cursor: 'pointer'
            }}>
              {item.label}
            </button>
          ))}
        </div>
      )}

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
        {screen === 'kitchen' && <KitchenScreen />}
        {screen === 'bar' && <BarScreen />}
        {screen === 'admin' && <AdminScreen />}
      </main>
    </div>
  );
}