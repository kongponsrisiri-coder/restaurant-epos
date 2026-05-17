import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api.js';
import LoginPage       from './pages/LoginPage.jsx';
import OnboardingPage  from './pages/OnboardingPage.jsx';
import DashboardPage   from './pages/DashboardPage.jsx';
import BookingsPage    from './pages/BookingsPage.jsx';
import OrdersPage      from './pages/OrdersPage.jsx';
import SettingsPage    from './pages/SettingsPage.jsx';
import EmbedCodesPage  from './pages/EmbedCodesPage.jsx';
import Shell           from './components/Shell.jsx';

export default function App() {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('lite_token');
    if (!token) { setLoading(false); return; }
    api.me()
      .then(u => setUser(u))
      .catch(() => localStorage.removeItem('lite_token'))
      .finally(() => setLoading(false));
  }, []);

  const login = (userData, token) => {
    localStorage.setItem('lite_token', token);
    setUser(userData);
  };
  const logout = () => {
    localStorage.removeItem('lite_token');
    setUser(null);
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#64748b', fontSize: 14 }}>
      Loading…
    </div>
  );

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={
          user ? <Navigate to="/dashboard" replace /> : <LoginPage onLogin={login} />
        } />
        <Route path="/onboarding" element={
          user ? <Navigate to="/dashboard" replace /> : <OnboardingPage onLogin={login} />
        } />

        {/* Protected routes inside the shell */}
        <Route element={user ? <Shell user={user} onLogout={logout} /> : <Navigate to="/login" replace />}>
          <Route path="/dashboard"   element={<DashboardPage  user={user} />} />
          <Route path="/bookings"    element={<BookingsPage />} />
          <Route path="/orders"      element={<OrdersPage />} />
          <Route path="/settings"    element={<SettingsPage   user={user} setUser={setUser} />} />
          <Route path="/embed-codes" element={<EmbedCodesPage user={user} />} />
        </Route>

        <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
