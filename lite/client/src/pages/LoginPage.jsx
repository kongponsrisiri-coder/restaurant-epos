import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { C, input, btn } from '../theme.js';

export default function LoginPage({ onLogin }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const navigate                = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const data = await api.login(email.trim(), password);
      onLogin(data.user, data.token);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.gold, letterSpacing: 0.5 }}>SiamEPOS</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 4, letterSpacing: 1, textTransform: 'uppercase' }}>Lite Dashboard</div>
        </div>

        <form onSubmit={submit} style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
          <h2 style={{ margin: '0 0 24px', fontSize: 20, fontWeight: 800, color: C.text }}>Sign in</h2>

          {error && (
            <div style={{ background: C.dangerBg, color: C.danger, padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 6 }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={input} placeholder="hello@yourrestaurant.com" />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 6 }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required style={input} placeholder="••••••••" />
          </div>

          <button type="submit" disabled={loading} style={{ ...btn.primary, width: '100%', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <p style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: C.textMuted }}>
            New to SiamEPOS Lite? <Link to="/onboarding" style={{ color: C.navy, fontWeight: 700 }}>Get started →</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
