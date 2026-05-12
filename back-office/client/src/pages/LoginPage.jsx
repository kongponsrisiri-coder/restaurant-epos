import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      const { token, user } = await api.login(email, password);
      localStorage.setItem('ops_token', token);
      localStorage.setItem('ops_user', JSON.stringify(user));
      nav('/', { replace: true });
    } catch (e) {
      setErr(e.message || 'Login failed');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0D1B3E', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onSubmit={submit} style={{ background: 'white', padding: 36, borderRadius: 16, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 1 }}>
            <span style={{ color: '#0D1B3E' }}>Siam</span>
            <span style={{ color: '#C9A84C' }}>EPOS</span>
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Back Office</div>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', marginTop: 4, marginBottom: 14, fontSize: 14 }} />
        <label style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', marginTop: 4, marginBottom: 18, fontSize: 14 }} />
        {err && <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>{err}</div>}
        <button type="submit" disabled={loading} style={{
          width: '100%', padding: 12, background: '#0D1B3E', color: 'white', border: 'none',
          borderRadius: 8, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', fontSize: 15
        }}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
