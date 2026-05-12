import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import ClientDetailPage from './pages/ClientDetailPage.jsx';
import TeamPage from './pages/TeamPage.jsx';

function useAuth() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ops_user') || 'null'); } catch { return null; }
  });
  useEffect(() => {
    const handler = () => {
      try { setUser(JSON.parse(localStorage.getItem('ops_user') || 'null')); } catch { setUser(null); }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  return user;
}

function Shell({ children }) {
  const user = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const tab = (path, label) => (
    <Link to={path} style={{
      padding: '10px 16px', borderRadius: 8, color: 'white', textDecoration: 'none',
      fontWeight: 600, fontSize: 14,
      background: loc.pathname === path || (path !== '/' && loc.pathname.startsWith(path)) ? '#C9A84C' : 'transparent',
    }}>{label}</Link>
  );
  return (
    <div>
      <nav style={{
        background: '#0D1B3E', color: 'white', padding: '12px 24px',
        display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
      }}>
        <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: 1 }}>
          <span style={{ color: 'white' }}>Siam</span>
          <span style={{ color: '#C9A84C' }}>EPOS</span>
          <span style={{ fontWeight: 400, marginLeft: 10, opacity: 0.7, fontSize: 13 }}>Back Office</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 18 }}>
          {tab('/', 'Clients')}
          {user?.role === 'admin' && tab('/team', 'Team')}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {user && (
            <>
              <span style={{ fontSize: 13, opacity: 0.85 }}>{user.name} <span style={{ opacity: 0.5 }}>· {user.role}</span></span>
              <button onClick={() => {
                localStorage.removeItem('ops_token');
                localStorage.removeItem('ops_user');
                nav('/login');
              }} style={{
                background: 'transparent', color: 'white', border: '1px solid rgba(255,255,255,0.3)',
                padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13
              }}>Sign out</button>
            </>
          )}
        </div>
      </nav>
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px' }}>{children}</main>
    </div>
  );
}

function RequireAuth({ children }) {
  const token = localStorage.getItem('ops_token');
  const loc = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/clients/:id" element={<RequireAuth><ClientDetailPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
