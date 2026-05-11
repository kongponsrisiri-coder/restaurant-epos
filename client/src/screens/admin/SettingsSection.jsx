import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { getSettings, updateSettings, getDiscountReasons, addDiscountReason, deleteDiscountReason, getCategories, updateCategoryBar, updateCategoryDefaultCourse, getNetworkInfo } from '../../api';
import DiningDurationSettings from './DiningDurationSettings';

// Network setup panel — shows the desktop's LAN URL + a scannable QR so
// kitchen / bar tablets can be pointed at this server without typing.
// Replaces the old auto-popup that used to fire on first Electron launch.
function NetworkSetupCard({ cardStyle }) {
  const [info, setInfo] = useState(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [testState, setTestState] = useState('idle'); // idle | testing | ok | fail

  useEffect(() => {
    let cancelled = false;
    getNetworkInfo()
      .then(async (n) => {
        if (cancelled || !n?.url) return;
        setInfo(n);
        try {
          const dataUrl = await QRCode.toDataURL(n.url, {
            width: 220, margin: 1, errorCorrectionLevel: 'M',
            color: { dark: '#0D1B3E', light: '#FFFFFF' },
          });
          if (!cancelled) setQr(dataUrl);
        } catch (err) { console.warn('[network-setup] QR failed:', err); }
      })
      .catch((err) => console.warn('[network-setup] info failed:', err));
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Probes the LAN URL — confirms the server answers on the same address
  // that's printed in the QR. Doesn't guarantee an iPad on another segment
  // can reach it (firewall / VLAN), but catches typos and stopped servers.
  const testConnection = async () => {
    setTestState('testing');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(info.url + '/api/sync-status', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      setTestState(r.ok ? 'ok' : 'fail');
    } catch {
      setTestState('fail');
    }
    setTimeout(() => setTestState('idle'), 3000);
  };

  const testLabel = testState === 'testing' ? 'Testing…'
                  : testState === 'ok'      ? '✓ Reachable'
                  : testState === 'fail'    ? '✗ No response'
                  : 'Test connection';
  const testBg    = testState === 'ok'   ? '#22c55e'
                  : testState === 'fail' ? '#ef4444'
                  : 'rgba(255,255,255,0)';
  const testColor = testState === 'ok' || testState === 'fail' ? 'white' : '#0D1B3E';
  const testBorder = testState === 'ok' || testState === 'fail' ? 'none' : '1px solid #0D1B3E';

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:6 }}>📱 Network Setup</h2>
      <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>
        Connect kitchen and bar tablets on the same Wi-Fi.
      </p>
      <div style={{ display:'flex', gap:20, alignItems:'flex-start', flexWrap:'wrap' }}>
        <div style={{ flex:1, minWidth:240 }}>
          <div style={{
            background:'#0D1B3E', color:'#C9A84C', padding:'14px 18px',
            borderRadius:10, fontFamily:'Menlo, Consolas, monospace',
            fontSize:16, fontWeight:800, textAlign:'center',
            marginBottom:12, userSelect:'text', wordBreak:'break-all'
          }}>
            {info.url}
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={copy} style={{
              padding:'10px 20px', borderRadius:8, border:'none',
              background: copied ? '#22c55e' : '#C9A84C',
              color: copied ? 'white' : '#0D1B3E',
              fontWeight:700, cursor:'pointer', fontSize:13
            }}>
              {copied ? '✓ Copied' : 'Copy URL'}
            </button>
            <button onClick={testConnection} disabled={testState==='testing'} style={{
              padding:'10px 20px', borderRadius:8,
              border: testBorder, background: testBg,
              color: testColor, fontWeight:700,
              cursor: testState==='testing' ? 'wait' : 'pointer',
              fontSize:13, transition:'background 0.2s, color 0.2s',
            }}>
              {testLabel}
            </button>
          </div>
          <div style={{ fontSize:12, color:'#888', marginTop:12, lineHeight:1.5 }}>
            On each tablet: open Camera, scan the QR, tap the SiamEPOS link in Safari.
            Then Share → <strong>Add to Home Screen</strong> for one-tap access.
          </div>
        </div>
        {qr && (
          <div style={{ background:'white', padding:10, borderRadius:10, border:'1px solid #eee', flexShrink:0 }}>
            <img src={qr} alt={`QR code for ${info.url}`}
                 style={{ width:200, height:200, display:'block' }} />
          </div>
        )}
      </div>
    </div>
  );
}

function BarCategoryManager() {
  const [categories, setCategories] = useState([]);
  useEffect(() => { getCategories().then(setCategories); }, []);

  const toggleBar = async (cat) => { await updateCategoryBar(cat.id, cat.is_bar ? 0 : 1); getCategories().then(setCategories); };
  const setDefaultCourse = async (cat, course) => { await updateCategoryDefaultCourse(cat.id, course); getCategories().then(setCategories); };
  const courseColors = { 1:'#3b82f6', 2:'#e94560', 3:'#8b5cf6', 4:'#22c55e' };
  const courseLabels = { 1:'Starters', 2:'Mains', 3:'Desserts', 4:'Extra' };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ background:'#f8f8f8', borderRadius:10, padding:'12px 16px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:cat.is_bar?0:10 }}>
            <span style={{ fontSize:14, fontWeight:700, color:'#1a1a2e' }}>{cat.name}</span>
            <button onClick={() => toggleBar(cat)} style={{ padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:600, fontSize:12, background:cat.is_bar?'#dbeafe':'#f0f0f0', color:cat.is_bar?'#1e40af':'#555' }}>{cat.is_bar?'🍹 Bar ✓':'Not bar'}</button>
          </div>
          {!cat.is_bar && (
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:'#888', marginBottom:6, textTransform:'uppercase' }}>Default course when ordering:</div>
              <div style={{ display:'flex', gap:6 }}>
                {[1,2,3,4].map(c => (
                  <button key={c} onClick={() => setDefaultCourse(cat,c)} style={{ padding:'6px 14px', borderRadius:8, border:'none', cursor:'pointer', fontWeight:700, fontSize:12, background:(cat.default_course||1)===c?courseColors[c]:'#e0e0e0', color:(cat.default_course||1)===c?'white':'#555' }}>{courseLabels[c]}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function SettingsSection() {
  const [settings, setSettings] = useState({
    company_name:            '',
    company_address:         '',
    company_phone:           '',
    company_email:           '',
    company_vat:             '',
    company_logo:            '',
    google_review_url:       '',
    receipt_footer:          'Thank you for dining with us!',
    service_charge_rate:     '12.5',
    service_charge_enabled:  '1',
  });
  const [reasons, setReasons]     = useState([]);
  const [newReason, setNewReason] = useState('');
  const [saved, setSaved]         = useState(false);
  const [logoPreview, setLogoPreview] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    getSettings().then(s => {
      // Support both old key (service_charge_percent) and new key (service_charge_rate)
      const rate = s.service_charge_rate || s.service_charge_percent || '12.5';
      setSettings(prev => ({ ...prev, ...s, service_charge_rate: rate }));
      if (s.company_logo) setLogoPreview(s.company_logo);
    });
    getDiscountReasons().then(setReasons);
  }, []);

  const handleSave = async () => {
    await updateSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Warn if too large (over 200KB uncompressed)
    if (file.size > 500000) {
      alert('Logo file is large. For best results use a PNG under 200KB.');
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      setLogoPreview(dataUrl);
      setSettings(prev => ({ ...prev, company_logo: dataUrl }));
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoPreview('');
    setSettings(prev => ({ ...prev, company_logo: '' }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const inputStyle = { width:'100%', padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, boxSizing:'border-box' };
  const labelStyle = { fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:6 };
  const cardStyle  = { background:'white', borderRadius:12, padding:24, marginBottom:20, boxShadow:'0 1px 4px rgba(0,0,0,0.08)' };

  return (
    <div style={{ padding:24, maxWidth:640 }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:'#1a1a2e', marginBottom:24 }}>Settings</h1>

      {/* ── Business Details ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🏢 Business Details</h2>
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Logo upload */}
          <div>
            <label style={labelStyle}>Restaurant Logo</label>
            <div style={{ display:'flex', alignItems:'flex-start', gap:16 }}>
              {/* Preview box */}
              <div style={{ width:100, height:100, borderRadius:10, border:'2px dashed #ddd', display:'flex', alignItems:'center', justifyContent:'center', background:'#fafafa', flexShrink:0, overflow:'hidden' }}>
                {logoPreview
                  ? <img src={logoPreview} alt="Logo" style={{ width:'100%', height:'100%', objectFit:'contain' }} />
                  : <span style={{ fontSize:28 }}>🏪</span>
                }
              </div>
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={handleLogoUpload}
                  style={{ display:'none' }}
                  id="logo-upload"
                />
                <label htmlFor="logo-upload" style={{ display:'inline-block', padding:'10px 16px', borderRadius:8, border:'2px solid #1a1a2e', background:'white', color:'#1a1a2e', fontSize:13, fontWeight:700, cursor:'pointer', textAlign:'center' }}>
                  📁 Choose Logo File
                </label>
                {logoPreview && (
                  <button onClick={handleRemoveLogo} style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#fee2e2', color:'#ef4444', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                    🗑 Remove Logo
                  </button>
                )}
                <div style={{ fontSize:11, color:'#aaa', lineHeight:1.5 }}>
                  PNG, JPG or SVG · Max 500KB<br/>
                  Appears at the top of printed receipts
                </div>
              </div>
            </div>
          </div>

          <div><label style={labelStyle}>Restaurant Name</label><input value={settings.company_name||''} onChange={e => setSettings({...settings, company_name:e.target.value})} placeholder="e.g. The Golden Spoon" style={inputStyle} /></div>
          <div><label style={labelStyle}>Address</label><input value={settings.company_address||''} onChange={e => setSettings({...settings, company_address:e.target.value})} placeholder="123 High Street, London, W1A 1AA" style={inputStyle} /></div>
          <div><label style={labelStyle}>Phone Number</label><input value={settings.company_phone||''} onChange={e => setSettings({...settings, company_phone:e.target.value})} placeholder="+44 20 1234 5678" style={inputStyle} /></div>
          <div><label style={labelStyle}>Email</label><input value={settings.company_email||''} onChange={e => setSettings({...settings, company_email:e.target.value})} placeholder="hello@myrestaurant.co.uk" style={inputStyle} /></div>
          <div><label style={labelStyle}>VAT Number</label><input value={settings.company_vat||''} onChange={e => setSettings({...settings, company_vat:e.target.value})} placeholder="e.g. GB123456789" style={inputStyle} /></div>
          <div>
            <label style={labelStyle}>Receipt Footer Message</label>
            <input value={settings.receipt_footer||''} onChange={e => setSettings({...settings, receipt_footer:e.target.value})} placeholder="Thank you for dining with us!" style={inputStyle} />
            <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>Appears at the bottom of every printed receipt</div>
          </div>
          <div>
            <label style={labelStyle}>Google Review Link</label>
            <input value={settings.google_review_url||''} onChange={e => setSettings({...settings, google_review_url:e.target.value})} placeholder="https://g.page/r/your-google-review-link" style={inputStyle} />
            <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>If set, a QR code linking to this URL prints at the bottom of every receipt</div>
          </div>
        </div>
      </div>

      {/* ── Receipt Preview ── */}
      {(settings.company_name || logoPreview) && (
        <div style={cardStyle}>
          <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🖨️ Receipt Preview</h2>
          <div style={{ background:'white', border:'1px solid #e5e7eb', borderRadius:8, padding:'16px 20px', maxWidth:300, margin:'0 auto', fontFamily:'Courier New, monospace', fontSize:12 }}>
            {logoPreview && (
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <img src={logoPreview} alt="Logo" style={{ maxWidth:160, maxHeight:60, objectFit:'contain' }} />
              </div>
            )}
            <div style={{ textAlign:'center', fontWeight:900, fontSize:14, marginBottom:2 }}>{settings.company_name||'Restaurant Name'}</div>
            {settings.company_address && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:2 }}>{settings.company_address}</div>}
            {settings.company_phone   && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:2 }}>Tel: {settings.company_phone}</div>}
            {settings.company_vat     && <div style={{ textAlign:'center', fontSize:10, color:'#555', marginBottom:4 }}>VAT: {settings.company_vat}</div>}
            <div style={{ borderTop:'1px dashed #ccc', margin:'6px 0' }} />
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2 }}><span>1x Pad Thai</span><span>£12.50</span></div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:2 }}><span>1x Green Curry</span><span>£13.00</span></div>
            <div style={{ borderTop:'1px dashed #ccc', margin:'6px 0' }} />
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}><span>Subtotal</span><span>£25.50</span></div>
            {settings.service_charge_enabled==='1' && <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}><span>Service ({settings.service_charge_rate||12.5}%)</span><span>£{(25.50*(parseFloat(settings.service_charge_rate||12.5)/100)).toFixed(2)}</span></div>}
            <div style={{ display:'flex', justifyContent:'space-between', fontWeight:900, fontSize:13, marginTop:4 }}><span>TOTAL</span><span>£{(25.50*(1+(parseFloat(settings.service_charge_enabled==='1'?settings.service_charge_rate||12.5:0)/100))).toFixed(2)}</span></div>
            <div style={{ borderTop:'1px solid #000', margin:'6px 0' }} />
            <div style={{ textAlign:'center', fontSize:10, color:'#555', marginTop:6 }}>{settings.receipt_footer||'Thank you for dining with us!'}</div>
            {settings.google_review_url && <div style={{ textAlign:'center', fontSize:9, color:'#aaa', marginTop:4 }}>📱 Scan QR code to leave a review</div>}
          </div>
        </div>
      )}

      {/* ── Service Charge ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>💳 Service Charge</h2>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:16 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:14 }}>
            <input type="checkbox" checked={settings.service_charge_enabled==='1'} onChange={e => setSettings({...settings, service_charge_enabled:e.target.checked?'1':'0'})} />
            Enable automatic service charge
          </label>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555' }}>Service charge %</label>
          <input value={settings.service_charge_rate||'12.5'} onChange={e => setSettings({...settings, service_charge_rate:e.target.value})} type="number" step="0.5" min="0" max="30" style={{ width:100, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }} />
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:8 }}>Standard UK rate is 12.5%. This is optional and always shown separately on the bill.</div>
      </div>

      {/* ── Save ── */}
      <button onClick={handleSave} style={{ width:'100%', padding:'14px', borderRadius:10, border:'none', background:saved?'#22c55e':'#1a1a2e', color:'white', cursor:'pointer', fontWeight:700, fontSize:16, marginBottom:20, transition:'background 0.3s' }}>
        {saved ? '✓ Saved!' : 'Save All Settings'}
      </button>

      {/* ── Discount Reasons ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🏷️ Discount Reasons</h2>
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:16 }}>
          {reasons.map(r => (
            <div key={r.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', background:'#f8f8f8', borderRadius:8 }}>
              <span style={{ fontSize:14 }}>{r.reason}</span>
              <button onClick={async () => { await deleteDiscountReason(r.id); getDiscountReasons().then(setReasons); }} style={{ background:'#fee2e2', border:'none', borderRadius:6, padding:'4px 10px', cursor:'pointer', color:'#ef4444', fontSize:12, fontWeight:600 }}>Remove</button>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <input value={newReason} onChange={e => setNewReason(e.target.value)} onKeyDown={e => { if(e.key==='Enter'&&newReason){addDiscountReason(newReason).then(()=>{setNewReason('');getDiscountReasons().then(setReasons);}); }}} placeholder="Add new discount reason..." style={{ flex:1, padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }} />
          <button onClick={async () => { if(!newReason) return; await addDiscountReason(newReason); setNewReason(''); getDiscountReasons().then(setReasons); }} style={{ padding:'10px 20px', borderRadius:8, border:'none', background:'#e94560', color:'white', cursor:'pointer', fontWeight:600 }}>Add</button>
        </div>
      </div>

      {/* ── Bar Categories ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:8 }}>🍹 Bar Categories</h2>
        <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>Select which categories show on the Bar screen</p>
        <BarCategoryManager />
      </div>

      {/* ── Dining Durations ── */}
      <div style={{ marginTop:20 }}>
        <DiningDurationSettings />
      </div>

      {/* ── Network Setup (QR for iPads) ── */}
      <NetworkSetupCard cardStyle={cardStyle} />
    </div>
  );
}
