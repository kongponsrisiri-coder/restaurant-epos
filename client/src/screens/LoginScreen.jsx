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
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#1a1a2e' }}>
      <div style={{ background:'white', borderRadius:20, padding:'40px 36px', width:300, display:'flex', flexDirection:'column', alignItems:'center', gap:24 }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:28, fontWeight:700, color:'#1a1a2e' }}>SiamEPOS</div>
          <div style={{ color:'#888', fontSize:14 }}>Enter your PIN</div>
        </div>

        <div style={{ display:'flex', gap:12 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ width:14, height:14, borderRadius:'50%', background: pin.length > i ? '#e94560' : '#ddd' }} />
          ))}
        </div>

        {error && <div style={{ color:'#e94560', fontSize:14 }}>{error}</div>}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, width:'100%' }}>
          {buttons.map(btn => (
            <button key={btn} onClick={() => {
              if (btn === 'C') handleClear();
              else if (btn === '✓') handleLogin();
              else handleNumber(btn);
            }}
            style={{
              height:56, borderRadius:10, border:'none', fontSize:20,
              fontWeight:600, cursor:'pointer',
              background: btn === '✓' ? '#e94560' : btn === 'C' ? '#eee' : '#f8f8f8',
              color: btn === '✓' ? 'white' : '#1a1a2e'
            }}>
              {loading && btn === '✓' ? '...' : btn}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}