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
import { getSettings, updateSettings, testNetworkPrinter, cupsQueueForIp, printerHealth, printerGetMac, printerDiscover, printerThaiTest, getPrintTestBuffer, getPrinters, createPrinter, updatePrinter, deletePrinter, testPrinter, setPrinterDefault, getCategories, setCategoryPrinter, scanPrinters } from '../../api';
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
        Add every printer here — your main till printers <em>and</em> any extra stations (wok,
        grill, pass). Enter its IP (via a USB print server or built-in LAN port; default RAW
        port 9100, older WAVLINK-style servers auto-fall-back to LPR 515), tick what it prints,
        and <strong>Save</strong>. Once set, <strong>all devices on the same Wi-Fi</strong> —
        including iPads — print silently with no dialog. Leave IP blank and use the name for a
        USB/CUPS printer.
      </p>

      {discoverToast && (
        <div style={{ background:'#dcfce7', color:'#15803d', padding:'10px 14px', borderRadius:8, fontSize:13, marginBottom:14, fontWeight:600 }}>
          ↻ {discoverToast}
        </div>
      )}

      {/* SEPOS-PRINT-UNIFY-001 — one flexible list (main printers + extra stations),
          role toggles + per-printer copies + default. Replaces the 3 fixed rows. */}
      <StationsCard bare />

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

// ── SEPOS-STATION-001 — extra printer stations (Wok / Grill / Cold …) ──
// Beyond the built-in Receipt/Kitchen/Bar above, add as many station printers
// as the kitchen has. Categories are pointed at a station in Admin → Menu; a
// category with no station falls back to the default kitchen/bar routing.
function StationsCard({ cardStyle, bare }) {
  const [list, setList]   = useState([]);
  const [defs, setDefs]   = useState({});     // { receipt, kitchen, bar } → printer id
  const [cats, setCats]   = useState([]);     // menu categories (carry printer_id routing)
  const [draft, setDraft] = useState({ name: '', ip: '', port: '9100', copies: '1', role_receipt: false, role_kitchen: true, role_bar: false });
  const [busy, setBusy]   = useState(false);
  const [tState, setTState] = useState({});   // { id: idle|testing|ok|fail }
  const [scanning, setScanning] = useState(false);
  const [scanRes, setScanRes]   = useState(null);   // {local, printers[], message?}

  const refresh = async () => {
    try {
      const r = await getPrinters(); setList(Array.isArray(r) ? r : []);
      const s = await getSettings();
      setDefs({ receipt: s?.default_receipt_printer_id, kitchen: s?.default_kitchen_printer_id, bar: s?.default_bar_printer_id });
      const c = await getCategories(); setCats(Array.isArray(c) ? c : []);
    } catch {}
  };
  // Route a menu category to this printer (or null to unassign) — the "point"
  // that decides which food prints here, editable without leaving this page.
  const assignCat = async (catId, printerId) => { await setCategoryPrinter(catId, printerId); await refresh(); };
  const scan = async () => { setScanning(true); setScanRes(null); try { setScanRes(await scanPrinters()); } catch (e) { setScanRes({ error: e.message }); } finally { setScanning(false); } };
  const addFound = async (ip) => { if (list.some(p => p.ip === ip)) return; await createPrinter({ name: ip, ip, port: 9100, copies: 1, role_kitchen: 1 }); setScanRes(null); await refresh(); };
  useEffect(() => { refresh(); }, []);

  const ROLES = [['receipt', '🧾 Bills'], ['kitchen', '🍳 Kitchen'], ['bar', '🍹 Bar']];
  const roleBody = (p) => ({ role_receipt: p.role_receipt ? 1 : 0, role_kitchen: p.role_kitchen ? 1 : 0, role_bar: p.role_bar ? 1 : 0 });
  const savePrinter = (p) => updatePrinter(p.id, { name: p.name, ip: p.ip || null, port: Number(p.port) || 9100, mac: p.mac || null, copies: Number(p.copies) || 1, ...roleBody(p) });

  const add = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    try { await createPrinter({ name: draft.name.trim(), ip: draft.ip.trim() || null, port: Number(draft.port) || 9100, copies: Number(draft.copies) || 1, role_receipt: draft.role_receipt ? 1 : 0, role_kitchen: draft.role_kitchen ? 1 : 0, role_bar: draft.role_bar ? 1 : 0 });
      setDraft({ name: '', ip: '', port: '9100', copies: '1', role_receipt: false, role_kitchen: true, role_bar: false }); await refresh(); }
    finally { setBusy(false); }
  };
  // SEPOS-PRINT-NAME-001 — saving a row edit was completely SILENT: no
  // feedback on success, no feedback on failure (api helpers resolve with
  // {error} rather than throwing), and pressing Enter in the name/IP fields
  // did NOTHING — an operator naturally types a printer name and hits Enter,
  // believes it saved, and later finds the old name back. Save is now loud:
  // per-row Saving… / ✓ Saved / ✕ error states, Enter-to-save on every row
  // field, and the Save button highlights when the row has unsaved edits.
  const [sState, setSState] = useState({});   // { id: saving|ok|fail }
  const [dirty, setDirty]   = useState({});   // { id: true } — unsaved edits
  const saveRow = async (p) => {
    setSState(s => ({ ...s, [p.id]: 'saving' }));
    try {
      const r = await savePrinter(p);
      const ok = r && r.success !== false && !r.error;
      setSState(s => ({ ...s, [p.id]: ok ? 'ok' : 'fail' }));
      if (ok) setDirty(d => ({ ...d, [p.id]: false }));
      if (!ok) console.warn('[printers] save failed:', r?.error);
    } catch (e) {
      setSState(s => ({ ...s, [p.id]: 'fail' }));
      console.warn('[printers] save error:', e?.message);
    }
    await refresh();
    setTimeout(() => setSState(s => ({ ...s, [p.id]: undefined })), 2500);
  };
  const toggleRole = async (p, role) => { const np = { ...p, [`role_${role}`]: p[`role_${role}`] ? 0 : 1 }; setList(l => l.map(x => x.id === p.id ? np : x)); await savePrinter(np); await refresh(); };
  const makeDefault = async (role, id) => { await setPrinterDefault(role, id); await refresh(); };
  const removeRow = async (p) => { if (!window.confirm(`Remove printer "${p.name}"? Any category pointed here reverts to the default.`)) return; await deletePrinter(p.id); await refresh(); };
  const test = async (p) => {
    setTState(s => ({ ...s, [p.id]: 'testing' }));
    try { const r = await testPrinter(p.id); setTState(s => ({ ...s, [p.id]: (r && r.success) ? 'ok' : 'fail' })); }
    catch { setTState(s => ({ ...s, [p.id]: 'fail' })); }
    setTimeout(() => setTState(s => ({ ...s, [p.id]: 'idle' })), 3000);
  };
  const patch = (id, k, v) => { setDirty(d => ({ ...d, [id]: true })); setList(l => l.map(p => p.id === id ? { ...p, [k]: v } : p)); };
  const inp = { padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };

  const body = (
    <>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>Add every printer here — main tills and extra stations (wok, grill, pass). Tick which tickets each one prints — <b>Bills</b>, <b>Kitchen</b>, <b>Bar</b> — set its <b>copies</b>, and ⭐ marks the default for that role. Point a menu category at a specific printer in Admin → Menu; anything unrouted goes to the ⭐ default.</div>

      {list.map(p => (
        <div key={p.id} style={{ padding: '12px 0', borderTop: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={p.name || ''} onChange={e => patch(p.id, 'name', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveRow(p); }} placeholder="Name" style={{ ...inp, flex: '1 1 120px' }} />
            <input value={p.ip || ''} onChange={e => patch(p.id, 'ip', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveRow(p); }} placeholder="IP (blank = by name)" style={{ ...inp, flex: '1 1 110px' }} />
            <input value={p.port || 9100} onChange={e => patch(p.id, 'port', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveRow(p); }} placeholder="Port" style={{ ...inp, width: 70 }} />
            <input value={p.copies || 1} onChange={e => patch(p.id, 'copies', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveRow(p); }} type="number" min="1" max="5" title="Copies" style={{ ...inp, width: 56 }} />
            <button onClick={() => saveRow(p)} disabled={sState[p.id] === 'saving'} style={{ ...inp, border: 'none',
              background: sState[p.id] === 'ok' ? '#16a34a' : sState[p.id] === 'fail' ? '#dc2626' : dirty[p.id] ? '#C9A84C' : 'var(--brand-primary,#0D1B3E)',
              color: dirty[p.id] && !sState[p.id] ? '#0D1B3E' : '#fff', fontWeight: 700, cursor: 'pointer', minWidth: 84 }}>
              {sState[p.id] === 'saving' ? 'Saving…' : sState[p.id] === 'ok' ? '✓ Saved' : sState[p.id] === 'fail' ? '✕ Failed' : dirty[p.id] ? 'Save ●' : 'Save'}
            </button>
            <button onClick={() => test(p)} style={{ ...inp, border: '1px solid #ddd', background: tState[p.id] === 'ok' ? '#dcfce7' : tState[p.id] === 'fail' ? '#fee2e2' : '#fff', cursor: 'pointer', fontWeight: 700 }}>{tState[p.id] === 'testing' ? '…' : tState[p.id] === 'ok' ? '✓' : tState[p.id] === 'fail' ? '✕' : 'Test'}</button>
            <button onClick={() => removeRow(p)} style={{ ...inp, border: 'none', background: '#fee2e2', color: '#dc2626', cursor: 'pointer', fontWeight: 700 }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#aaa', marginRight: 2 }}>Prints:</span>
            {ROLES.map(([role, label]) => {
              const on = !!Number(p[`role_${role}`]);
              const isDefault = String(defs[role] ?? '') === String(p.id);
              return (
                <span key={role} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <button onClick={() => toggleRole(p, role)} style={{ padding: '5px 10px', borderRadius: 14, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    border: on ? 'none' : '1px solid #ddd', background: on ? 'var(--brand-primary,#0D1B3E)' : '#fff', color: on ? '#fff' : '#888' }}>{label}</button>
                  {on && (
                    <button onClick={() => makeDefault(role, p.id)} title={isDefault ? 'Default for this role' : 'Make default for this role'}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, padding: '0 2px', color: isDefault ? '#C9A84C' : '#ccc' }}>{isDefault ? '⭐' : '☆'}</button>
                  )}
                </span>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#aaa', marginRight: 2 }}>Sends:</span>
            {cats.filter(c => String(c.printer_id ?? '') === String(p.id)).map(c => (
              <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 12, background: '#eef2ff', color: '#3730a3', fontSize: 12, fontWeight: 600 }}>
                {c.name}
                <button onClick={() => assignCat(c.id, null)} title="Stop sending this category here" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#6366f1', fontWeight: 700, padding: 0, fontSize: 13 }}>✕</button>
              </span>
            ))}
            <select value="" onChange={e => { if (e.target.value) assignCat(Number(e.target.value), p.id); }} style={{ padding: '4px 8px', borderRadius: 10, border: '1px solid #ddd', fontSize: 12, color: '#555' }}>
              <option value="">+ send a category here…</option>
              {cats.filter(c => String(c.printer_id ?? '') !== String(p.id)).map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.printer_id ? ' (move from other)' : ''}</option>
              ))}
            </select>
          </div>
        </div>
      ))}

      {/* Scan the local network for printers (works on the till/desktop app; the
          cloud/web version can't reach a private LAN — it returns local:false). */}
      <div style={{ paddingTop: 14, marginTop: 8, borderTop: '1px dashed #e5e5e5' }}>
        <button onClick={scan} disabled={scanning} style={{ ...inp, border: '1.5px solid var(--brand-primary,#0D1B3E)', background: '#fff', color: 'var(--brand-primary,#0D1B3E)', fontWeight: 700, cursor: scanning ? 'wait' : 'pointer' }}>
          {scanning ? '🔍 Scanning…' : '🔍 Scan for printers'}
        </button>
        {scanRes && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {scanRes.error ? (
              <div style={{ color: '#dc2626' }}>Scan failed: {scanRes.error}</div>
            ) : scanRes.local === false ? (
              <div style={{ color: '#888' }}>{scanRes.message}</div>
            ) : (scanRes.printers && scanRes.printers.length) ? (
              <div>
                <div style={{ color: '#555', marginBottom: 6 }}>Found on {scanRes.subnet}:</div>
                {scanRes.printers.map(p => {
                  const already = list.some(x => x.ip === p.ip);
                  return (
                    <div key={p.ip} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                      <span style={{ fontFamily: 'monospace' }}>{p.ip}:{p.port}</span>
                      {already
                        ? <span style={{ color: '#16a34a', fontSize: 12 }}>✓ already added</span>
                        : <button onClick={() => addFound(p.ip)} style={{ ...inp, padding: '4px 10px', border: 'none', background: 'var(--brand-accent,#C9A84C)', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>+ Add</button>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ color: '#888' }}>No printers found on {scanRes.subnet || 'this network'}. Enter the IP manually below.</div>
            )}
          </div>
        )}
      </div>

      <div style={{ paddingTop: 14, marginTop: 8, borderTop: '2px solid #eee' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="New printer name" style={{ ...inp, flex: '1 1 120px' }} />
          <input value={draft.ip} onChange={e => setDraft({ ...draft, ip: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="IP" style={{ ...inp, flex: '1 1 110px' }} />
          <input value={draft.port} onChange={e => setDraft({ ...draft, port: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="Port" style={{ ...inp, width: 70 }} />
          <input value={draft.copies} onChange={e => setDraft({ ...draft, copies: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') add(); }} type="number" min="1" max="5" title="Copies" style={{ ...inp, width: 56 }} />
          <button onClick={add} disabled={busy || !draft.name.trim()} style={{ ...inp, border: 'none', background: draft.name.trim() ? 'var(--brand-accent,#C9A84C)' : '#eee', color: draft.name.trim() ? '#fff' : '#aaa', fontWeight: 800, cursor: draft.name.trim() ? 'pointer' : 'not-allowed' }}>+ Add printer</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#aaa', marginRight: 2 }}>Prints:</span>
          {ROLES.map(([role, label]) => {
            const on = !!draft[`role_${role}`];
            return (
              <button key={role} onClick={() => setDraft(d => ({ ...d, [`role_${role}`]: !d[`role_${role}`] }))} style={{ padding: '5px 10px', borderRadius: 14, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                border: on ? 'none' : '1px solid #ddd', background: on ? 'var(--brand-primary,#0D1B3E)' : '#fff', color: on ? '#fff' : '#888' }}>{label}</button>
            );
          })}
        </div>
      </div>
    </>
  );
  return bare ? body : (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--brand-primary,#1a1a2e)', marginBottom: 6 }}>🖨️ Printers</h2>
      {body}
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

      {/* Print text size (SEPOS-PRINT-FONT-001) — a printer setting, so it lives here. */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:16 }}>🔠 Print text size</h2>
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          {[['Kitchen ticket text','kitchen_font_scale','large'],
            ['Receipt text','receipt_font_scale','normal'],
            ['Bar ticket text','bar_font_scale','large']].map(([label,key,def]) => (
            <div key={key} style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <label style={{ fontSize:14, fontWeight:600, color:'#555', minWidth:150 }}>{label}</label>
              <select value={settings[key] || def} onChange={e => setSettings({...settings, [key]:e.target.value})} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', fontSize:14 }}>
                <option value="normal">Normal</option>
                <option value="medium">Medium (taller — fills the paper, no cut-off)</option>
                <option value="large">Large</option>
                <option value="xlarge">Extra-large</option>
              </select>
            </div>
          ))}
        </div>
        <div style={{ fontSize:12, color:'#aaa', marginTop:8 }}>Bigger = easier to read on a busy line, but fewer characters fit per row. Applies to kitchen / bar tickets and the customer receipt on every printer (thermal + built-in).</div>
      </div>

      {/* SEPOS-DRAWER-001 — open the cash drawer on payment (default ON). */}
      <div style={cardStyle}>
        <h2 style={{ fontSize:16, fontWeight:700, color:'var(--brand-primary, #1a1a2e)', marginBottom:6 }}>💵 Cash drawer</h2>
        {(() => { const on = settings.open_drawer_on_payment !== '0'; return (
          <div onClick={() => setSettings(s => ({ ...s, open_drawer_on_payment: (s.open_drawer_on_payment !== '0') ? '0' : '1' }))}
            style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', cursor:'pointer' }}>
            <div style={{ width:44, height:26, borderRadius:13, background: on ? 'var(--brand-primary,#0D1B3E)' : '#cbd5e1', position:'relative', transition:'background .15s', flexShrink:0 }}>
              <div style={{ position:'absolute', top:3, left: on ? 21 : 3, width:20, height:20, borderRadius:'50%', background:'#fff', transition:'left .15s' }} />
            </div>
            <div>
              <div style={{ fontSize:14, fontWeight:700, color:'var(--brand-primary,#0D1B3E)' }}>Open the cash drawer on every payment</div>
              <div style={{ fontSize:12, color:'#888', marginTop:2 }}>Kicks the drawer wired to the receipt printer each time a payment closes. Needs a drawer connected to a network/built-in ESC/POS receipt printer — it won't fire on the browser-print (web) path. Turn off for a till with no drawer.</div>
            </div>
          </div>
        ); })()}
      </div>

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
