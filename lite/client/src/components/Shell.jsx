import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { C } from '../theme.js';

const NAV = [
  { to: '/dashboard',   icon: '📊', label: 'Dashboard' },
  { to: '/bookings',    icon: '📅', label: 'Bookings' },
  { to: '/orders',      icon: '🥡', label: 'Orders' },
  { to: '/revenue',     icon: '💷', label: 'Revenue' },
  { to: '/embed-codes', icon: '🔗', label: 'Embed Codes' },
  { to: '/settings',    icon: '⚙️', label: 'Settings' },
];

export default function Shell({ user, onLogout }) {
  const navigate = useNavigate();

  const handleLogout = () => { onLogout(); navigate('/login'); };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg }}>
      {/* Sidebar */}
      <aside style={{
        width: 220, flexShrink: 0, background: C.navy,
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
      }}>
        {/* Logo */}
        <div style={{ padding: '24px 20px 16px' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.gold, letterSpacing: 0.5 }}>SiamEPOS</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>Lite</div>
        </div>

        {/* Restaurant name */}
        <div style={{ margin: '0 12px 16px', padding: '10px 12px', background: 'rgba(255,255,255,0.07)', borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Restaurant</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{user?.restaurantName || '—'}</div>
          <PlanBadge plan={user?.plan} />
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '0 10px' }}>
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 8, marginBottom: 2,
              textDecoration: 'none',
              background:  isActive ? 'rgba(201,168,76,0.18)' : 'transparent',
              color:       isActive ? C.gold : 'rgba(255,255,255,0.72)',
              fontWeight:  isActive ? 700 : 500,
              fontSize:    14,
            })}>
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User + logout */}
        <div style={{ padding: '12px 14px 20px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>{user?.email}</div>
          <button onClick={handleLogout} style={{
            width: '100%', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)',
            color: 'rgba(255,255,255,0.55)', borderRadius: 7, padding: '7px 0',
            fontSize: 12, cursor: 'pointer', fontWeight: 600,
          }}>Log out</button>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: '32px 36px', minWidth: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}

function PlanBadge({ plan }) {
  const labels = {
    lite_booking:  { label: 'Booking',  bg: '#1e3a5f', color: '#7dd3fc' },
    lite_ordering: { label: 'Ordering', bg: '#1e3a5f', color: '#86efac' },
    lite_bundle:   { label: 'Bundle',   bg: '#3b2f0a', color: C.gold },
    pro:           { label: 'Pro',      bg: '#2d1b69', color: '#c084fc' },
  };
  const p = labels[plan] || { label: plan || 'Free', bg: '#1e293b', color: '#94a3b8' };
  return (
    <span style={{ display: 'inline-block', marginTop: 6, padding: '2px 8px', borderRadius: 99, background: p.bg, color: p.color, fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
      {p.label}
    </span>
  );
}
