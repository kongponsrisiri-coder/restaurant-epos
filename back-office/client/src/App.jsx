import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import ClientDetailPage from './pages/ClientDetailPage.jsx';
import TeamPage from './pages/TeamPage.jsx';
import TicketsPage from './pages/TicketsPage.jsx';
import WebsitePage from './pages/WebsitePage.jsx';
import NewClientWizard from './pages/NewClientWizard.jsx';
import FinancePage from './pages/FinancePage.jsx';
import OnboardKiosk from './pages/OnboardKiosk.jsx';
import { C } from './theme.js';
import { api } from './api.js';

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

function useMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

function Shell({ children }) {
  const user = useAuth();
  const isMobile = useMobile();
  const [clientCount, setClientCount] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try { const list = await api.listClients(); if (!stop) setClientCount(list.length); } catch {}
    };
    load();
    const id = setInterval(load, 30000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // Auto-close sidebar when screen grows to desktop
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg }}>

      {/* ── Mobile backdrop ── */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.6)',
            backdropFilter: 'blur(2px)',
            zIndex: 150,
          }}
        />
      )}

      <Sidebar
        user={user}
        clientCount={clientCount}
        isMobile={isMobile}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* ── Content column ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

        {/* Mobile top bar */}
        {isMobile && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '0 16px', height: 56, flexShrink: 0,
            background: C.navy,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}>
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              style={{
                background: 'transparent', border: 'none',
                color: 'white', fontSize: 24, cursor: 'pointer',
                padding: '4px 6px', borderRadius: 6, lineHeight: 1,
              }}
            >
              ☰
            </button>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 19, fontWeight: 800, lineHeight: 1 }}>
              <span style={{ color: 'white' }}>Siam</span>
              <span style={{ color: C.gold }}>EPOS</span>
            </div>
            <div style={{
              fontSize: 10, color: 'rgba(255,255,255,0.5)',
              letterSpacing: 1.4, textTransform: 'uppercase', marginTop: 2,
            }}>
              Back Office
            </div>
          </div>
        )}

        <main style={{
          flex: 1,
          padding: isMobile ? '20px 16px 32px' : '32px 40px',
          overflowX: 'hidden',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}

function RequireAuth({ children }) {
  const token = localStorage.getItem('ops_token');
  const loc = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Shell>{children}</Shell>;
}

// Kiosk wrapper — auth still required (Korakot is logged in on his tablet)
// but no shell at all. Clean full-page layout for client-facing signup.
function RequireAuthKiosk({ children }) {
  const token = localStorage.getItem('ops_token');
  const loc = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/clients/new" element={<RequireAuth><NewClientWizard /></RequireAuth>} />
      <Route path="/clients/:id" element={<RequireAuth><ClientDetailPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/tickets" element={<RequireAuth><TicketsPage /></RequireAuth>} />
      <Route path="/tickets/:id" element={<RequireAuth><TicketsPage /></RequireAuth>} />
      <Route path="/website" element={<RequireAuth><WebsitePage /></RequireAuth>} />
      <Route path="/finance" element={<RequireAuth><FinancePage /></RequireAuth>} />
      {/* BO-ONBOARD-001 — clean kiosk, no sidebar, no nav */}
      <Route path="/onboard" element={<RequireAuthKiosk><OnboardKiosk /></RequireAuthKiosk>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
