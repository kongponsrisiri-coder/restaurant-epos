// SEPOS-PRINT-TAB-001 — dedicated Printers tab.
//
// Hoists the two printer cards that used to live inside Settings into
// their own tab so operators have a clear home for IP/queue config,
// the reachability badge, and per-device (Electron) print routing.
//
// Each card is self-contained — they were already factored as separate
// components inside SettingsSection. This file just composes them
// alongside a Save button so the operator doesn't have to switch tabs
// to persist changes.

import { useState, useEffect } from 'react';
import { getSettings, updateSettings, testNetworkPrinter, cupsQueueForIp, printerHealth, printerGetMac, printerDiscover, printerThaiTest, getPrintTestBuffer } from '../../api';
import { isNativeApp, sendRawToPrinter } from '../../native/printer'; // SEPOS-ANDROID-001

// ── Network Printers card (IP-based, RAW + LPR + CUPS fallback chain) ──
function NetworkPrinterCard({ cardStyle, settings, setSettings }) {
  const [testStates, setTestStates] = useState({});  // { receipt|kitchen|bar: idle|testing|ok|fail }
  // SEPOS-ANDROID-001 — which device auto-prints incoming online orders (native app).
  const [onlinePrint, setOnlinePrint] = useState(() => {
    try { return localStorage.getItem('print_online_orders') === '1'; } catch { return false; }
  });
  const toggleOnlinePrint = () => setOnlinePrint(v => {
    const next = !v;
    try { localStorage.setItem('print_online_orders', next ? '1' : '0'); } catch {}
    return next;
  });
  // SEPOS-PRINT-HEALTH-001 — per-printer reachability cache. Auto-checks
  // on settings load + on manual refresh, so the operator sees online /
  // slow / offline status BEFORE firing a test print.
  // shape: { receipt: { status: 'checking'|'online'|'slow'|'offline', latency_ms, error } }
  const [healthStates, setHealthStates] = useState({});
  const setHealth = (key, payload) => setHealthStates(prev => ({ ...prev, [key]: payload }));
  // SEPOS-PRINT-MAC-001 — surface a brief toast in the corner when an
  // auto-rediscovery moves a printer to a new IP. Cleared after 6s.
  const [discoverToast, setDiscoverToast] = useState('');

  const setTest = (key, state) => setTestStates(prev => ({ ...prev, [key]: state }));

  // SEPOS-PRINT-HEALTH-001 — TCP probe (no ESC/POS bytes sent).
  // Thresholds: <100 ms green, 100-800 ms amber, 800+ ms or no
  // response = red. 800 ms is the "you'll wait so long for a job
  // that operators will assume it's broken" empirical cutoff.
  //
  // SEPOS-PRINT-MAC-001 — on success, silently capture and store the
  // printer's MAC (one-shot, if not already stored) so we have an
  // anchor for future rediscovery. On failure, if a MAC is stored,
  // try to rediscover the printer at a new IP via the server's ARP
  // cache and silently update settings.printer_*_ip.
  const checkHealth = async (key, ipKey, portKey, macKey) => {
    const ip   = settings[ipKey];
    const port = settings[portKey] || 9100;
    const mac  = settings[macKey];
    if (!ip) { setHealth(key, null); return; }
    setHealth(key, { status: 'checking' });
    try {
      const r = await printerHealth(ip, port);
      if (!r || r.ok !== true) {
        // Offline at the stored IP — try MAC-based rediscovery if we
        // know one. If we find the printer at a new IP, update settings
        // and re-probe.
        if (mac) {
          try {
            const d = await printerDiscover(mac);
            if (d?.ok && d.ip && d.ip !== ip) {
              setSettings(s => ({ ...s, [ipKey]: d.ip }));
              setDiscoverToast(`Printer moved to ${d.ip} — settings auto-updated`);
              setTimeout(() => setDiscoverToast(''), 6000);
              // re-probe at the new IP; state will be updated by the
              // effect that watches settings[ipKey].
              return;
            }
          } catch { /* no-op — fall through to offline */ }
        }
        setHealth(key, { status: 'offline', latency_ms: r?.latency_ms, error: r?.error });
        return;
      }
      // Online — bucket by latency.
      if (r.latency_ms < 100)      setHealth(key, { status: 'online', latency_ms: r.latency_ms });
      else if (r.latency_ms < 800) setHealth(key, { status: 'slow',   latency_ms: r.latency_ms });
      else                         setHealth(key, { status: 'offline', latency_ms: r.latency_ms, error: 'very slow' });

      // Capture MAC once (silent — operator never sees it). Stored
      // alongside IP in settings so the next "where did it go?" probe
      // has an anchor.
      if (!mac && macKey) {
        try {
          const m = await printerGetMac(ip);
          if (m?.ok && m.mac) {
            setSettings(s => ({ ...s, [macKey]: m.mac }));
          }
        } catch { /* no-op */ }
      }
    } catch (e) {
      setHealth(key, { status: 'offline', error: e?.message || 'error' });
    }
  };

  // Auto-check all configured printers once settings have loaded.
  useEffect(() => {
    if (!settings || Object.keys(settings).length === 0) return;
    [['receipt', 'printer_receipt_ip', 'printer_receipt_port', 'printer_receipt_mac'],
     ['kitchen', 'printer_kitchen_ip', 'printer_kitchen_port', 'printer_kitchen_mac'],
     ['bar',     'printer_bar_ip',     'printer_bar_port',     'printer_bar_mac']].forEach(([k, ipK, portK, macK]) => {
      if (settings[ipK]) checkHealth(k, ipK, portK, macK);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.printer_receipt_ip, settings.printer_kitchen_ip, settings.printer_bar_ip]);

  const testPrinter = async (key, ipKey, portKey, nameKey) => {
    const ip   = settings[ipKey];
    const port = settings[portKey] || 9100;
    const name = settings[nameKey];
    if (!ip && !name) return;
    setTest(key, 'testing');
    try {
      if (isNativeApp() && ip) {
        // SEPOS-ANDROID-001 — on the Android app the cloud can't reach a LAN
        // printer, so fetch the server's ESC/POS test page and send it ourselves.
        const buf = await getPrintTestBuffer();
        const r = await sendRawToPrinter(ip, port, buf.data);
        setTest(key, r && r.ok ? 'ok' : 'fail');
      } else {
        const r = await testNetworkPrinter(ip || '', port, name || '');
        setTest(key, r && r.success ? 'ok' : 'fail');
      }
    } catch { setTest(key, 'fail'); }
    setTimeout(() => setTest(key, 'idle'), 3000);
  };

  const inputStyle = { width:160, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 };
  const portStyle  = { width:80,  padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 };

  const printerRow = (label, ipKey, portKey, testKey, nameKey, macKey) => {
    const state = testStates[testKey] || 'idle';
    const testLabel = state === 'testing' ? 'Testing…'
                    : state === 'ok'      ? '✓ OK'
                    : state === 'fail'    ? '✗ Failed'
                    : 'Test';
    const testBg = state === 'ok' ? '#22c55e' : state === 'fail' ? '#ef4444' : '#f0f0f0';
    const testColor = state === 'ok' || state === 'fail' ? 'white' : '#555';

    // SEPOS-PRINT-HEALTH-001 — health badge next to the printer label.
    const h = healthStates[testKey];
    const badge = (() => {
      if (!settings[ipKey]) return null;
      if (!h)                    return { color:'#888', bg:'#f0f0f0', text:'…' };
      if (h.status === 'checking') return { color:'#888', bg:'#f0f0f0', text:'Checking…' };
      if (h.status === 'online')   return { color:'#15803d', bg:'#dcfce7', text:`🟢 Online (${h.latency_ms} ms)` };
      if (h.status === 'slow')     return { color:'#92400e', bg:'#fef3c7', text:`🟡 Slow (${h.latency_ms} ms)` };
      return { color:'#991b1b', bg:'#fee2e2', text:`🔴 Offline${h.error ? ' — ' + h.error : ''}` };
    })();

    return (
      <div style={{ marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:8 }}>
          <label style={{ fontSize:14, fontWeight:600, color:'#555' }}>{label}</label>
          {badge && (
            <>
              <span style={{ fontSize:12, fontWeight:700, color:badge.color, background:badge.bg, padding:'4px 10px', borderRadius:12 }}>{badge.text}</span>
              <button onClick={() => checkHealth(testKey, ipKey, portKey, macKey)}
                title="Re-check printer reachability (+ auto-rediscover by MAC if stored)"
                style={{ padding:'4px 8px', borderRadius:6, border:'1px solid #ddd', background:'white', cursor:'pointer', fontSize:12 }}>
                ↻
              </button>
              {macKey && settings[macKey] && (
                <span title={`Anchored MAC: ${settings[macKey]} — IP will auto-update if this printer moves`}
                  style={{ fontSize:10, color:'#94a3b8', fontFamily:'Menlo,Consolas,monospace' }}>
                  🔗 {settings[macKey]}
                </span>
              )}
            </>
          )}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:11, color:'#aaa', marginBottom:4 }}>IP Address</div>
            <input
              value={settings[ipKey] || ''}
              onChange={e => setSettings(s => ({ ...s, [ipKey]: e.target.value }))}
              onBlur={async (e) => {
                // Auto-detect: if operator just typed an IP and CUPS-name
                // field is empty, ask the backend to look up the matching
                // queue via `lpstat -v`. Pre-fills the CUPS name field so
                // they never have to know macOS's auto-naming convention.
                const ip = e.target.value.trim();
                if (!ip || settings[nameKey]) return;
                try {
                  const r = await cupsQueueForIp(ip);
                  if (r && r.queue) {
                    setSettings(s => ({ ...s, [nameKey]: r.queue }));
                  }
                } catch (err) { /* silent — operator can fill manually */ }
              }}
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
          <div>
            <div style={{ fontSize:11, color:'#aaa', marginBottom:4 }} title="CUPS printer name for WAVLINK-style fallback (macOS/Linux only). Set this only if RAW 9100 + LPR 515 both fail — usually leave blank.">CUPS name <span style={{ color:'#ccc' }}>(optional)</span></div>
            <input
              value={settings[nameKey] || ''}
              onChange={e => setSettings(s => ({ ...s, [nameKey]: e.target.value }))}
              placeholder="POS80"
              style={inputStyle}
            />
          </div>
          {(settings[ipKey] || settings[nameKey]) && (
            <div style={{ marginTop:18 }}>
              <button
                onClick={() => testPrinter(testKey, ipKey, portKey, nameKey)}
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
      <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:4 }}>🌐 Network Printers</h2>
      <p style={{ fontSize:13, color:'#888', marginBottom:20, lineHeight:1.6 }}>
        Enter the IP address of each printer (via a USB print server or built-in LAN port).
        Once set, <strong>all devices on the same Wi-Fi</strong> — including iPads — print
        silently with no dialog. Default RAW port 9100; older WAVLINK-style servers will
        auto-fall-back to LPR port 515. <strong>Save</strong> after entering IPs.
        Once a printer responds, its MAC is captured silently — if it later gets a
        new IP from DHCP, the EPOS auto-finds it without operator help.
      </p>

      {discoverToast && (
        <div style={{ background:'#dcfce7', color:'#15803d', padding:'10px 14px', borderRadius:8, fontSize:13, marginBottom:14, fontWeight:600 }}>
          ↻ {discoverToast}
        </div>
      )}

      {printerRow('🧾 Receipt Printer', 'printer_receipt_ip', 'printer_receipt_port', 'receipt', 'printer_receipt_name', 'printer_receipt_mac')}
      {printerRow('🍳 Kitchen Printer', 'printer_kitchen_ip', 'printer_kitchen_port', 'kitchen', 'printer_kitchen_name', 'printer_kitchen_mac')}
      {printerRow('🍹 Bar Printer',     'printer_bar_ip',     'printer_bar_port',     'bar',     'printer_bar_name',     'printer_bar_mac')}

      {/* SEPOS-ANDROID-001 — auto-print online orders (Android app only). Turn ON for the ONE device at the kitchen/counter so each online order prints once. */}
      {isNativeApp() && (
        <div onClick={toggleOnlinePrint} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', margin:'4px 0 16px',
          border:'1px solid var(--border)', borderRadius:10, cursor:'pointer', background: onlinePrint ? '#ecfeff' : 'transparent' }}>
          <div style={{ width:44, height:26, borderRadius:13, background: onlinePrint ? '#0891b2' : '#cbd5e1', position:'relative', transition:'background .15s', flexShrink:0 }}>
            <div style={{ position:'absolute', top:3, left: onlinePrint ? 21 : 3, width:20, height:20, borderRadius:'50%', background:'#fff', transition:'left .15s' }} />
          </div>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--brand-primary,#0D1B3E)' }}>🥡 Auto-print online orders on this device</div>
            <div style={{ fontSize:12, color:'#64748b', marginTop:2 }}>Turn ON for one device only — incoming website orders print to the kitchen printer automatically.</div>
          </div>
        </div>
      )}

      {settings.printer_kitchen_ip && (
        <div style={{ marginTop:-8, marginBottom:16 }}>
          <label style={{ fontSize:13, fontWeight:600, color:'#555', display:'block', marginBottom:8 }}>Kitchen copies per ticket</label>
          <div style={{ display:'flex', gap:8 }}>
            {[1, 2, 3].map(n => (
              <button key={n} onClick={() => setSettings(s => ({ ...s, printer_kitchen_copies: String(n) }))}
                style={{ width:56, height:44, borderRadius:8, border:'none', fontWeight:700, fontSize:15, cursor:'pointer',
                  background: (settings.printer_kitchen_copies || '1') === String(n) ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0',
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
                background: (settings.kitchen_print_mode || 'print') === opt.value ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0',
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
                background: (settings.kitchen_language || 'en_th') === opt.value ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0',
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

      {/* SEPOS-PRINT-THAI-PROBE 2026-06-02 — when Thai bilingual is on but
          nothing prints, the printer's codepage ID for Thai is different
          from the default 30. This test prints "ทดสอบ" under every common
          codepage so the operator can visually pick the right one. */}
      {(settings.kitchen_language || 'en_th') === 'en_th' && (
        <div style={{ marginBottom:16, padding:14, background:'#fef3c7', border:'1px solid #fcd34d', borderRadius:10 }}>
          <label style={{ fontSize:13, fontWeight:700, color:'#92400e', display:'block', marginBottom:4 }}>
            🌶️ Thai Codepage
          </label>
          <p style={{ fontSize:12, color:'#92400e', margin:'0 0 10px', lineHeight:1.4 }}>
            If Thai prints as blank or garbage, your printer uses a different codepage ID than the default (30). Tap below to print a test ticket showing "ทดสอบ" (test) under each common codepage. Find the row that prints correctly, then enter that number here.
          </p>
          <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <input
              type="number"
              value={settings.kitchen_thai_codepage || ''}
              onChange={e => setSettings(s => ({ ...s, kitchen_thai_codepage: e.target.value }))}
              placeholder="30 (default)"
              style={{ width:120, padding:'8px 12px', borderRadius:8, border:'1px solid #fcd34d', fontSize:14, background:'white' }}
            />
            <button
              onClick={async () => {
                const cp = (settings.kitchen_thai_codepage || '').toString().trim();
                if (!cp) return alert('Type a codepage number first');
                try {
                  const r = await printerThaiTest(Number(cp), (typeof localStorage !== 'undefined' && (localStorage.getItem('receipt_printer_name') || localStorage.getItem('kitchen_printer_name'))) || undefined);
                  if (!r?.success) alert('Print failed: ' + (r?.error || r?.reason || 'unknown'));
                } catch (e) { alert('Print failed: ' + e?.message); }
              }}
              style={{ padding:'8px 14px', borderRadius:8, border:'1px solid #92400e', background:'white', color:'#92400e', fontWeight:700, fontSize:13, cursor:'pointer' }}
            >
              🎯 Test this codepage
            </button>
            <button
              onClick={async () => {
                try {
                  const r = await printerThaiTest(null, (typeof localStorage !== 'undefined' && (localStorage.getItem('receipt_printer_name') || localStorage.getItem('kitchen_printer_name'))) || undefined);
                  if (!r?.success) alert('Print failed: ' + (r?.error || r?.reason || 'unknown'));
                } catch (e) { alert('Print failed: ' + e?.message); }
              }}
              style={{ padding:'8px 14px', borderRadius:8, border:'none', background:'#92400e', color:'white', fontWeight:700, fontSize:13, cursor:'pointer' }}
            >
              🖨️ Sweep all codepages
            </button>
          </div>
          <div style={{ fontSize:11, color:'#92400e', marginTop:8, opacity:0.85, lineHeight:1.5 }}>
            Common IDs: <strong>30</strong> Epson/Star CP874 · <strong>21</strong> Star alt · <strong>17</strong> some clones · <strong>50-52</strong> cnfujun mid · <strong>244, 250, 252, 255</strong> cnfujun high range.
            <br />
            Sweep prints all ~28 candidates on one ticket; Test prints just the one you typed (big, easy to read).
          </div>
        </div>
      )}

      <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#0369a1' }}>
        💡 <strong>How to find your printer's IP:</strong> Log into your router admin page (usually 192.168.1.1) and look for the WAVLINK print server in the connected devices list. Give it a fixed/static IP so it never changes.
      </div>
    </div>
  );
}

// SEPOS-025/026 — per-device printer selection (Electron only). The picked
// printer is physically wired to THIS machine, so the choice lives in
// localStorage, not the shared settings table. Silent printing only works
// inside the SiamEPOS desktop app; a plain browser falls back to the
// print dialog.
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
      if (r && !r.success) {
        const reason = r.error || 'Unknown error';
        console.error('[printer] test print failed:', reason);
        // Show the reason so the operator can act on it — the red button
        // only lasts 3s and gives no detail.
        alert(
          `Print failed: "${reason}"\n\n` +
          `Troubleshooting steps:\n` +
          `1. Press the Windows key → search "Printers & scanners" → click POS-80M\n` +
          `2. Click "Open print queue" — cancel any stuck jobs\n` +
          `3. Right-click the printer → "See what's printing" — if it says Offline or Error, click "Use Printer Online"\n` +
          `4. Make sure the printer is plugged in and has paper loaded shiny-side up\n` +
          `5. Try the test again`
        );
      }
    } catch (e) {
      setTestState('fail');
      console.error('[printer] testPrint threw:', e);
      alert('Print error: ' + e.message);
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
      <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>🖨️ Printer (this device)</h2>
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
                    background: kitchenCopies === n ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0',
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
              background: testState==='ok' ? '#22c55e' : testState==='fail' ? '#ef4444' : 'var(--brand-primary,#0D1B3E)',
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

// ── Wrapper: loads settings, renders both printer cards, owns Save ──
// SEPOS-ANDROID-002 — per-route print destination chooser. Each till decides
// where each ticket type prints: the built-in (Sunmi) printer, a network
// printer, or off. So one site prints Bill only, another Bar + Bill, etc.
function PrintRoutingCard({ cardStyle, settings, setSettings }) {
  const routes = [
    ['receipt', '🧾 Bill / Receipt'],
    ['kitchen', '🍳 Kitchen ticket'],
    ['bar',     '🍹 Bar ticket'],
  ];
  const opts = [
    ['off',     'Off'],
    ['builtin', '🖨️ Built-in'],
    ['network', '🌐 Network'],
  ];
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:4 }}>🧭 Print Routing</h2>
      <p style={{ fontSize:13, color:'#888', marginBottom:16 }}>
        Choose where each ticket prints on <strong>this till</strong>. <strong>Built-in</strong> = the till's own printer ·
        <strong> Network</strong> = a LAN printer (set its IP below) · <strong>Off</strong> = don't print.
      </p>
      {routes.map(([key, label]) => {
        const cur = settings[`print_target_${key}`] || 'auto';
        return (
          <div key={key} style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12, flexWrap:'wrap' }}>
            <div style={{ width:150, fontSize:14, fontWeight:600, color:'#555' }}>{label}</div>
            <div style={{ display:'flex', gap:8 }}>
              {opts.map(([val, txt]) => (
                <button key={val} onClick={() => setSettings(s => ({ ...s, [`print_target_${key}`]: val }))}
                  style={{ padding:'8px 14px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:600,
                    background: cur === val ? 'var(--brand-primary, #1a1a2e)' : '#f0f0f0', color: cur === val ? 'white' : '#555' }}>
                  {txt}
                </button>
              ))}
            </div>
            {cur === 'auto' && <span style={{ fontSize:12, color:'#aaa' }}>auto — built-in, then network</span>}
          </div>
        );
      })}

    </div>
  );
}

export default function PrintersSection() {
  const [settings, setSettings] = useState({});
  const [loaded, setLoaded]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    getSettings().then(s => { setSettings(s || {}); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const cardStyle = { background:'white', borderRadius:12, padding:24, marginBottom:20, boxShadow:'0 1px 3px rgba(0,0,0,0.05)' };

  if (!loaded) {
    return <div style={{ padding:30, color:'#888' }}>Loading…</div>;
  }

  return (
    <div style={{ padding:30, maxWidth:900 }}>
      <h1 style={{ fontSize:24, fontWeight:800, color:'var(--brand-primary, #1a1a2e)', marginBottom:24 }}>🖨️ Printers</h1>

      <PrintRoutingCard cardStyle={cardStyle} settings={settings} setSettings={setSettings} />
      <NetworkPrinterCard cardStyle={cardStyle} settings={settings} setSettings={setSettings} />
      <PrinterCard cardStyle={cardStyle} />

      <button onClick={handleSave} disabled={saving}
        style={{ width:'100%', padding:'14px', borderRadius:10, border:'none',
                 background: saved ? '#22c55e' : 'var(--brand-primary, #1a1a2e)', color:'white',
                 cursor:'pointer', fontWeight:700, fontSize:16,
                 transition:'background 0.3s' }}>
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Printer Settings'}
      </button>
    </div>
  );
}
