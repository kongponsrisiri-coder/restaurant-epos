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

function Shell({ children }) {
  const user = useAuth();
  const [clientCount, setClientCount] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try { const list = await api.listClients(); if (!stop) setClientCount(list.length); } catch {}
    };
    load();
    const id = setInterval(load, 30000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg }}>
      <Sidebar user={user} clientCount={clientCount} />
      <main style={{ flex: 1, padding: '32px 40px', overflowX: 'hidden' }}>{children}</main>
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
      <Route path="/clients/new" element={<RequireAuth><NewClientWizard /></RequireAuth>} />
      <Route path="/clients/:id" element={<RequireAuth><ClientDetailPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/tickets" element={<RequireAuth><TicketsPage /></RequireAuth>} />
      <Route path="/tickets/:id" element={<RequireAuth><TicketsPage /></RequireAuth>} />
      <Route path="/website" element={<RequireAuth><WebsitePage /></RequireAuth>} />
      <Route path="/finance" element={<RequireAuth><FinancePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
