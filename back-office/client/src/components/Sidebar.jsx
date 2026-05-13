import { Link, useLocation, useNavigate } from 'react-router-dom';
import { C, initials } from '../theme.js';

function Item({ to, icon, label, badge, active }) {
  return (
    <Link to={to} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', margin: '2px 10px', borderRadius: 8,
      color: active ? C.gold : 'rgba(255,255,255,0.78)',
      background: active ? 'rgba(201,168,76,0.10)' : 'transparent',
      textDecoration: 'none', fontWeight: 600, fontSize: 14,
      transition: 'background 0.12s, color 0.12s',
    }}>
      <span style={{ fontSize: 18, width: 20, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && (
        <span style={{
          fontSize: 11, fontWeight: 800, color: active ? C.navy : 'rgba(255,255,255,0.85)',
          background: active ? C.gold : 'rgba(255,255,255,0.12)',
          padding: '2px 8px', borderRadius: 999,
        }}>{badge}</span>
      )}
    </Link>
  );
}

export default function Sidebar({ user, clientCount }) {
  const loc = useLocation();
  const nav = useNavigate();
  const isActive = (path) =>
    path === '/' ? loc.pathname === '/' : loc.pathname === path || loc.pathname.startsWith(path + '/');

  const logout = () => {
    localStorage.removeItem('ops_token');
    localStorage.removeItem('ops_user');
    nav('/login');
  };

  return (
    <aside style={{
      width: 240, minHeight: '100vh', background: C.navy, color: 'white',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      borderRight: '1px solid rgba(255,255,255,0.06)',
    }}>
      {/* Brand */}
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 800, letterSpacing: 0.5 }}>
          <span style={{ color: 'white' }}>Siam</span>
          <span style={{ color: C.gold }}>EPOS</span>
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 4, letterSpacing: 1.5, textTransform: 'uppercase' }}>
          Back Office
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: '14px 0', flex: 1 }}>
        <Item to="/" icon="🏠" label="Clients" badge={clientCount} active={isActive('/')} />
        <Item to="/website" icon="🌐" label="Website" active={isActive('/website')} />
        <Item to="/tickets" icon="🎟" label="Tickets" active={isActive('/tickets')} />
        {user?.role === 'admin' && (
          <Item to="/team" icon="👥" label="Team" active={isActive('/team')} />
        )}
      </nav>

      {/* User card at bottom */}
      <div style={{ padding: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 36,
            background: C.gold, color: C.navy, fontWeight: 800, fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{initials(user?.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name || 'User'}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
              {user?.role}
            </div>
          </div>
          <button onClick={logout} title="Sign out" style={{
            background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)',
            cursor: 'pointer', fontSize: 16, padding: 6, borderRadius: 6,
          }}>↩</button>
        </div>
      </div>
    </aside>
  );
}
