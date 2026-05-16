import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { getSettings, updateSettings, getDiscountReasons, addDiscountReason, deleteDiscountReason, getCategories, updateCategoryBar, updateCategoryDefaultCourse, getNetworkInfo, testNetworkPrinter } from '../../api';
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

// SEPOS-025/026 — Network printer setup (ESC/POS over TCP port 9100).
// Works from ANY device on the same Wi-Fi — iPad, browser, Electron.
// The printer gets its own IP via a USB print server (e.g. WAVLINK) or
// a built-in LAN port. IP stored in the shared settings table so all
// devices know where to print.
function NetworkPrinterCard({ cardStyle, settings, setSettings }) {
  const [testStates, setTestStates] = useState({});  // { receipt|kitchen|bar: idle|testing|ok|fail }

  const setTest = (key, state) => setTestStates(prev => ({ ...prev, [key]: state }));

  const testPrinter = async (key, ipKey, portKey) => {
    const ip   = settings[ipKey];
    const port = settings[portKey] || 9100;
    if (!ip) return;
    setTest(key, 'testing');
    try {
      const r = await testNetworkPrinter(ip, port);
      setTest(key, r && r.success ? 'ok' : 'fail');
    } catch { setTest(key, 'fail'); }
    setTimeout(() => setTest(key, 'idle'), 3000);
  };

  const inputStyle = { width:160, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 };
  const portStyle  = { width:80,  padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 };

  const printerRow = (label, ipKey, portKey, testKey) => {
    const state = testStates[testKey] || 'idle';
    const testLabel = state === 'testing' ? 'Testing…'
                    : state === 'ok'      ? '✓ OK'
                    : state === 'fail'    ? '✗ Failed'
                    : 'Test';
    const testBg = state === 'ok' ? '#22c55e' : state === 'fail' ? '#ef4444' : '#f0f0f0';
    const testColor = state === 'ok' || state === 'fail' ? 'white' : '#555';

    return (
      <div style={{ marginBottom:20 }}>
        <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:8 }}>{label}</label>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:11, color:'#aaa', marginBottom:4 }}>IP Address</div>
            <input
              value={settings[ipKey] || ''}
              onChange={e => setSettings(s => ({ ...s, [ipKey]: e.target.value }))}
              placeholder="192.168.1.100"
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize:11, color:'#aaa', marginBottom:4 }}>Port</div>
            <input
              value={settings[portKey] || '9100'}
              onChange={e => setSettings(s => ({ ...s, [portKey]: e.target.value }))}
              placeholder="9100"
              style={portStyle}
              type="number"
            />
          </div>
          {settings[ipKey] && (
            <div style={{ marginTop:18 }}>
              <button
                onClick={() => testPrinter(testKey, ipKey, portKey)}
                disabled={state === 'testing'}
                style={{ padding:'8px 16px', borderRadius:8, border:'none', background:testBg, color:testColor, fontWeight:700, fontSize:13, cursor:'pointer' }}
              >{testLabel}</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:4 }}>🌐 Network Printers</h2>
      <p style={{ fontSize:13, color:'#888', marginBottom:20, lineHeight:1.6 }}>
        Enter the IP address of each printer (via a USB print server or built-in LAN port).
        Once set, <strong>all devices on the same Wi-Fi</strong> — including iPads — print
        silently with no dialog. Port 9100 is the standard RAW print port. <strong>Save Settings</strong> after entering IPs.
      </p>

      {printerRow('🧾 Receipt Printer', 'printer_receipt_ip', 'printer_receipt_port', 'receipt')}
      {printerRow('🍳 Kitchen Printer', 'printer_kitchen_ip', 'printer_kitchen_port', 'kitchen')}
      {printerRow('🍹 Bar Printer',     'printer_bar_ip',     'printer_bar_port',     'bar')}

      {settings.printer_kitchen_ip && (
        <div style={{ marginTop:-8, marginBottom:16 }}>
          <label style={{ fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:8 }}>Kitchen copies per ticket</label>
          <div style={{ display:'flex', gap:8 }}>
            {[1, 2, 3].map(n => (
              <button key={n} onClick={() => setSettings(s => ({ ...s, printer_kitchen_copies: String(n) }))}
                style={{ width:56, height:44, borderRadius:8, border:'none', fontWeight:700, fontSize:15, cursor:'pointer',
                  background: (settings.printer_kitchen_copies || '1') === String(n) ? '#1a1a2e' : '#f0f0f0',
                  color:      (settings.printer_kitchen_copies || '1') === String(n) ? 'white'   : '#555',
                }}>
                {n}×
              </button>
            ))}
          </div>
          <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>
            Prints this many tickets per course fire. Use 2× if you have a chef and a sous chef.
          </div>
        </div>
      )}

      {/* Kitchen Output Mode — Print / KDS only / Both */}
      <div style={{ marginBottom:16 }}>
        <label style={{ fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:8 }}>
          🖨️ Kitchen Output Mode
        </label>
        <div style={{ display:'flex', gap:8 }}>
          {[
            { value: 'print', label: '🖨️ Print only' },
            { value: 'kds',   label: '📺 KDS only' },
            { value: 'both',  label: '🖨️ + 📺 Both' },
          ].map(opt => (
            <button key={opt.value}
              onClick={() => setSettings(s => ({ ...s, kitchen_print_mode: opt.value }))}
              style={{
                flex:1, height:44, borderRadius:8, border:'none', fontWeight:700, fontSize:13, cursor:'pointer',
                background: (settings.kitchen_print_mode || 'print') === opt.value ? '#1a1a2e' : '#f0f0f0',
                color:      (settings.kitchen_print_mode || 'print') === opt.value ? 'white'   : '#555',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>
          <strong>Print only</strong> — no KDS, tickets go straight to paper. &nbsp;
          <strong>KDS only</strong> — no printer needed, tickets show on screen. &nbsp;
          <strong>Both</strong> — print AND show on KDS.
        </div>
      </div>

      {/* Kitchen Ticket Language */}
      <div style={{ marginBottom:16 }}>
        <label style={{ fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:8 }}>
          🌐 Kitchen Ticket Language
        </label>
        <div style={{ display:'flex', gap:8 }}>
          {[
            { value: 'en_th', label: '1st + 2nd Language' },
            { value: 'en',    label: '1st Language only' },
          ].map(opt => (
            <button key={opt.value}
              onClick={() => setSettings(s => ({ ...s, kitchen_language: opt.value }))}
              style={{
                flex:1, height:44, borderRadius:8, border:'none', fontWeight:700, fontSize:13, cursor:'pointer',
                background: (settings.kitchen_language || 'en_th') === opt.value ? '#1a1a2e' : '#f0f0f0',
                color:      (settings.kitchen_language || 'en_th') === opt.value ? 'white'   : '#555',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>
          <strong>EN + Thai</strong> — prints course name in English and Thai (กับแกล้ม / อาหารหลัก). &nbsp;
          <strong>English only</strong> — English course names only. Use this if Thai characters appear garbled on your printer.
        </div>
      </div>

      <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#0369a1' }}>
        💡 <strong>How to find your printer's IP:</strong> Log into your router admin page (usually 192.168.1.1) and look for the WAVLINK print server in the connected devices list. Give it a fixed/static IP so it never changes.
      </div>
    </div>
  );
}

// SEPOS-025/026 — printer selection. Per-device (the picked printer is
// physically wired to THIS machine), so the choice lives in localStorage,
// not the shared settings table. Silent printing only works inside the
// SiamEPOS desktop app; a plain browser falls back to the print dialog.
function PrinterCard({ cardStyle }) {
  const isElectron = !!(typeof window !== 'undefined' && window.siamepos && window.siamepos.isElectron && window.siamepos.printHtml);
  const [printers, setPrinters]           = useState([]);
  const [receiptName, setReceiptName]     = useState(() => localStorage.getItem('receipt_printer_name') || '');
  const [kitchenName, setKitchenName]     = useState(() => localStorage.getItem('kitchen_printer_name') || '');
  const [kitchenCopies, setKitchenCopies] = useState(() => parseInt(localStorage.getItem('kitchen_print_copies') || '1', 10) || 1);
  const [autoKitchen, setAutoKitchen]     = useState(() => localStorage.getItem('kitchen_auto_print') !== '0');
  const [barName, setBarName]             = useState(() => localStorage.getItem('bar_printer_name') || '');
  const [testState, setTestState]         = useState('idle'); // idle | printing | ok | fail

  useEffect(() => {
    if (!isElectron) return;
    window.siamepos.listPrinters()
      .then(list => setPrinters(Array.isArray(list) ? list : []))
      .catch(() => setPrinters([]));
  }, [isElectron]);

  const saveReceipt = (v) => { setReceiptName(v); localStorage.setItem('receipt_printer_name', v); };
  const saveKitchen = (v) => { setKitchenName(v); localStorage.setItem('kitchen_printer_name', v); };
  const saveKitchenCopies = (v) => { setKitchenCopies(v); localStorage.setItem('kitchen_print_copies', String(v)); };
  const saveAuto    = (v) => { setAutoKitchen(v); localStorage.setItem('kitchen_auto_print', v ? '1' : '0'); };
  const saveBar     = (v) => { setBarName(v); localStorage.setItem('bar_printer_name', v); };

  const testPrint = async () => {
    setTestState('printing');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:'Courier New',Courier,monospace;font-size:12px;color:#000;width:80mm;padding:4mm 2mm;text-align:center;}
      @media print{@page{margin:0;size:80mm auto;}}
      </style></head><body>
      <div style="font-size:16px;font-weight:900;letter-spacing:1px;">SiamEPOS</div>
      <div style="border-top:1px dashed #999;margin:6px 0;"></div>
      <div style="font-weight:700;">Printer test successful ✓</div>
      <div style="font-size:10px;color:#555;margin-top:6px;">${new Date().toLocaleString('en-GB')}</div>
      <div style="height:12mm;"></div>
      </body></html>`;
    try {
      const r = await window.siamepos.printHtml({ html, deviceName: receiptName || undefined });
      setTestState(r && r.success ? 'ok' : 'fail');
      if (r && !r.success) console.error('[printer] test print failed:', r.error);
    } catch (e) {
      setTestState('fail');
    }
    setTimeout(() => setTestState('idle'), 3000);
  };

  const selectStyle = { width:'100%', maxWidth:380, padding:'10px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, background:'white' };
  const testLabel = testState === 'printing' ? 'Printing…'
                  : testState === 'ok'       ? '✓ Sent to printer'
                  : testState === 'fail'     ? '✗ Failed — check printer'
                  : 'Test print';

  const sectionDivider = { borderTop:'1px solid #f0f0f0', margin:'20px 0' };

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:6 }}>🖨️ Printer (this device)</h2>
      {!isElectron ? (
        <p style={{ fontSize:13, color:'#888', lineHeight:1.6, margin:0 }}>
          Direct printer selection is available in the <strong>SiamEPOS desktop app</strong>.
          In a web browser, receipts print through the normal print dialog — pick your
          thermal printer there. To print silently and send tickets to the kitchen
          automatically, run the desktop app on the till connected to the printer.
        </p>
      ) : (
        <>
          <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>
            Choose the printers wired to this machine. Selected printers print silently — no dialog.
          </p>

          {/* ── Receipt printer ── */}
          <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Receipt printer</label>
          <select value={receiptName} onChange={e => saveReceipt(e.target.value)} style={selectStyle}>
            <option value="">— Don't auto-print (use print dialog) —</option>
            {printers.map(p => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
          </select>

          <div style={sectionDivider} />

          {/* ── Kitchen printer ── */}
          <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Kitchen printer</label>
          <select value={kitchenName} onChange={e => saveKitchen(e.target.value)} style={selectStyle}>
            <option value="">— No kitchen printer —</option>
            {printers.map(p => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
          </select>

          {kitchenName && (
            <>
              <label style={{ fontSize:13, fontWeight:600, color:'#555', display:'block', margin:'14px 0 8px' }}>Copies per ticket</label>
              <div style={{ display:'flex', gap:8 }}>
                {[1, 2, 3].map(n => (
                  <button key={n} onClick={() => saveKitchenCopies(n)} style={{
                    width:56, height:44, borderRadius:8, border:'none', fontWeight:700, fontSize:15, cursor:'pointer',
                    background: kitchenCopies === n ? '#1a1a2e' : '#f0f0f0',
                    color:       kitchenCopies === n ? 'white'   : '#555',
                  }}>
                    {n}×
                  </button>
                ))}
              </div>
              <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>
                {kitchenCopies === 1 ? 'One ticket per course fire' : `${kitchenCopies} copies printed per course fire`}
              </div>

              <label style={{ display:'flex', alignItems:'center', gap:8, marginTop:14, fontSize:14, color:'#555', cursor:'pointer' }}>
                <input type="checkbox" checked={autoKitchen} onChange={e => saveAuto(e.target.checked)}
                  style={{ width:16, height:16 }} />
                Auto-print a kitchen ticket when items are sent to the kitchen
              </label>
            </>
          )}

          <div style={sectionDivider} />

          {/* ── Bar printer ── */}
          <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Bar printer</label>
          <select value={barName} onChange={e => saveBar(e.target.value)} style={selectStyle}>
            <option value="">— No bar printer —</option>
            {printers.map(p => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (default)' : ''}</option>)}
          </select>
          {barName && (
            <div style={{ fontSize:11, color:'#aaa', marginTop:6 }}>
              Bar tickets will print silently to this printer when drinks are ordered.
            </div>
          )}

          <div style={sectionDivider} />

          {/* ── Test print ── */}
          <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <button onClick={testPrint} disabled={testState==='printing'} style={{
              padding:'10px 20px', borderRadius:8, border:'none',
              background: testState==='ok' ? '#22c55e' : testState==='fail' ? '#ef4444' : '#0D1B3E',
              color:'white', fontWeight:700, fontSize:13,
              cursor: testState==='printing' ? 'wait' : 'pointer', transition:'background 0.2s',
            }}>{testLabel}</button>
            <span style={{ fontSize:12, color:'#aaa' }}>
              {printers.length} printer{printers.length === 1 ? '' : 's'} found on this machine
            </span>
          </div>
        </>
      )}
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
    kitchen_print_mode:      'print',   // 'print' | 'kds' | 'both'
    kitchen_language:        'en_th',  // 'en_th' | 'en'
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
              <div style={{ width:160, height:140, borderRadius:10, border:'2px dashed #ddd', display:'flex', alignItems:'center', justifyContent:'center', background:'#fafafa', flexShrink:0, overflow:'hidden', padding:8 }}>
                {logoPreview
                  ? <img src={logoPreview} alt="Logo" style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }} />
                  : <span style={{ fontSize:36 }}>🏪</span>
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
                <img src={logoPreview} alt="Logo" style={{ maxWidth:220, maxHeight:100, objectFit:'contain' }} />
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

      {/* ── Delivery (SEPOS-DELIVERY-002) ── */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'#1a1a2e', marginBottom:16 }}>🚗 Online Delivery</h2>
        <div style={{ fontSize:12, color:'#888', marginBottom:16 }}>
          Set both fields to offer delivery on the takeaway widget. The widget checks each customer's postcode against this radius — anyone outside is offered collection instead. Leave blank to keep takeaway collection-only.
        </div>
        <div style={{ display:'flex', gap:20, flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Restaurant postcode</label>
            <input
              value={settings.restaurant_postcode || ''}
              onChange={e => setSettings({ ...settings, restaurant_postcode: e.target.value.toUpperCase() })}
              placeholder="e.g. SW1A 1AA"
              style={{ width:160, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14, textTransform:'uppercase' }}
            />
          </div>
          <div>
            <label style={{ fontSize:14, fontWeight:600, color:'#555', display:'block', marginBottom:6 }}>Delivery radius (miles)</label>
            <input
              value={settings.delivery_radius_miles || ''}
              onChange={e => setSettings({ ...settings, delivery_radius_miles: e.target.value })}
              type="number" step="0.5" min="0" max="20"
              placeholder="e.g. 3"
              style={{ width:120, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}
            />
          </div>
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:10 }}>
          Distance is straight-line ("as the crow flies"). 3 miles is a sensible starting radius for most UK Thai restaurants.
        </div>
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

      {/* ── Network Printers (SEPOS-025/026) — iPad-friendly ESC/POS over TCP ── */}
      <NetworkPrinterCard
        cardStyle={cardStyle}
        settings={settings}
        setSettings={setSettings}
      />

      {/* ── Electron Printer (this device only, desktop app) ── */}
      <PrinterCard cardStyle={cardStyle} />
    </div>
  );
}
