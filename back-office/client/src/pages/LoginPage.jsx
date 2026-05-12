import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { C, btn, input, label } from '../theme.js';

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
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, position: 'relative', overflow: 'hidden',
      background: `linear-gradient(135deg, ${C.navyDeep} 0%, ${C.navy} 100%)`,
    }}>
      {/* Soft gold glow */}
      <div style={{
        position: 'absolute', width: 600, height: 600, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(201,168,76,0.20) 0%, transparent 60%)',
        top: -200, right: -100, pointerEvents: 'none',
      }} />

      <form onSubmit={submit} style={{
        background: 'white', padding: 40, borderRadius: 18, width: 400,
        boxShadow: '0 25px 60px rgba(0,0,0,0.35)', position: 'relative', zIndex: 1,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 800, letterSpacing: 1 }}>
            <span style={{ color: C.navy }}>Siam</span>
            <span style={{ color: C.gold }}>EPOS</span>
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, letterSpacing: 2.5, textTransform: 'uppercase' }}>
            Back Office
          </div>
        </div>

        <label style={label}>Email</label>
        <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
          style={{ ...input, marginBottom: 16 }} />

        <label style={label}>Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
          style={{ ...input, marginBottom: 20 }} />

        {err && (
          <div style={{
            background: C.dangerBg, color: '#991b1b',
            padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
            border: `1px solid ${C.danger}33`,
          }}>{err}</div>
        )}

        <button type="submit" disabled={loading} style={{
          ...btn.primary, width: '100%', padding: 13, fontSize: 15,
          cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1,
        }}>{loading ? 'Signing in…' : 'Sign in'}</button>

        <div style={{ marginTop: 22, textAlign: 'center', fontSize: 12, color: C.textFaint }}>
          Internal access · SiamEPOS team only
        </div>
      </form>
    </div>
  );
}
