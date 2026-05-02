import { useState } from 'react';
import { loginStaff } from '../api';

export default function LoginScreen({ onLogin }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleNumber = (num) => {
    if (pin.length < 4) setPin(prev => prev + num);
  };

  const handleClear = () => { setPin(''); setError(''); };

  const handleLogin = async () => {
    if (pin.length < 4) return;
    setLoading(true);
    setError('');
    try {
      const data = await loginStaff(pin);
      if (data.error) { setError('Wrong PIN. Try again.'); setPin(''); }
      else onLogin(data);
    } catch { setError('Wrong PIN. Try again.'); setPin(''); }
    finally { setLoading(false); }
  };

  const buttons = ['1','2','3','4','5','6','7','8','9','C','0','✓'];

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(160deg, #0D1B3E 0%, #1A2F6B 60%, #0A2456 100%)',
      position: 'relative',
      overflow: 'hidden',
      fontFamily: "'Sarabun', sans-serif"
    }}>
      {/* Background pattern */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'repeating-linear-gradient(45deg, rgba(201,168,76,0.03) 0px, rgba(201,168,76,0.03) 1px, transparent 1px, transparent 60px), repeating-linear-gradient(-45deg, rgba(201,168,76,0.03) 0px, rgba(201,168,76,0.03) 1px, transparent 1px, transparent 60px)'
      }} />

      {/* Glow */}
      <div style={{
        position: 'absolute',
        width: 400, height: 400,
        background: 'radial-gradient(circle, rgba(201,168,76,0.1) 0%, transparent 70%)',
        top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        borderRadius: '50%'
      }} />

      <div style={{
        background: 'rgba(255,255,255,0.97)',
        borderRadius: 24,
        padding: '40px 36px',
        width: 320,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 24,
        position: 'relative',
        boxShadow: '0 40px 80px rgba(0,0,0,0.4)',
        border: '1px solid rgba(201,168,76,0.2)'
      }}>

        {/* Logo */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 64, height: 64,
            background: 'linear-gradient(135deg, #0D1B3E, #1A2F6B)',
            borderRadius: 18,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 30, margin: '0 auto 14px',
            boxShadow: '0 8px 24px rgba(13,27,62,0.3)'
          }}>🍜</div>
          <div style={{
            fontSize: 30, fontWeight: 800,
            color: '#0D1B3E',
            letterSpacing: 1,
            fontFamily: 'Georgia, serif'
          }}>
            Siam<span style={{ color: '#C9A84C' }}>EPOS</span>
          </div>
          <div style={{
            color: '#888', fontSize: 13, marginTop: 6,
            letterSpacing: 2, textTransform: 'uppercase',
            fontWeight: 600
          }}>Enter your PIN</div>
        </div>

        {/* PIN dots */}
        <div style={{ display: 'flex', gap: 14 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{
              width: 16, height: 16,
              borderRadius: '50%',
              background: pin.length > i
                ? 'linear-gradient(135deg, #C9A84C, #E8C96A)'
                : '#E8E8E8',
              transition: 'all 0.2s',
              boxShadow: pin.length > i ? '0 2px 8px rgba(201,168,76,0.4)' : 'none'
            }} />
          ))}
        </div>

        {error && (
          <div style={{
            color: '#e94560', fontSize: 13, fontWeight: 600,
            background: '#fff0f3', padding: '8px 16px',
            borderRadius: 8, border: '1px solid #fecdd3'
          }}>{error}</div>
        )}

        {/* Numpad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, width: '100%' }}>
          {buttons.map(btn => (
            <button key={btn} onClick={() => {
              if (btn === 'C') handleClear();
              else if (btn === '✓') handleLogin();
              else handleNumber(btn);
            }}
            style={{
              height: 60, borderRadius: 14, border: 'none', fontSize: 22,
              fontWeight: 700, cursor: 'pointer',
              background: btn === '✓'
                ? 'linear-gradient(135deg, #C9A84C, #E8C96A)'
                : btn === 'C'
                  ? '#FEE2E2'
                  : '#F8F8F8',
              color: btn === '✓' ? '#0D1B3E' : btn === 'C' ? '#EF4444' : '#1a1a2e',
              boxShadow: btn === '✓' ? '0 4px 12px rgba(201,168,76,0.3)' : 'none',
              transition: 'transform 0.1s',
            }}
            onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
            onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
            >
              {loading && btn === '✓' ? '...' : btn}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, color: '#bbb', textAlign: 'center' }}>
          Powered by SiamEPOS · siamepos.co.uk
        </div>
      </div>
    </div>
  );
}