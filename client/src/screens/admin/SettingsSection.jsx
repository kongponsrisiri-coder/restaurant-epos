import { useState, useEffect } from 'react';
import { getSettings, updateSettings, getDiscountReasons, addDiscountReason, deleteDiscountReason, getCategories, updateCategoryBar, updateCategoryDefaultCourse } from '../../api';
import DiningDurationSettings from './DiningDurationSettings';

function BarCategoryManager() {
  const [categories, setCategories] = useState([]);
  useEffect(() => { getCategories().then(setCategories); }, []);

  const toggleBar = async (cat) => { await updateCategoryBar(cat.id, cat.is_bar ? 0 : 1); getCategories().then(setCategories); };
  const setDefaultCourse = async (cat, course) => { await updateCategoryDefaultCourse(cat.id, course); getCategories().then(setCategories); };

  const courseColors = { 1: '#3b82f6', 2: '#e94560', 3: '#8b5cf6', 4: '#22c55e' };
  const courseLabels = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extra' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ background: '#f8f8f8', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: cat.is_bar ? 0 : 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>{cat.name}</span>
            <button onClick={() => toggleBar(cat)} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: cat.is_bar ? '#dbeafe' : '#f0f0f0', color: cat.is_bar ? '#1e40af' : '#555' }}>{cat.is_bar ? '🍹 Bar ✓' : 'Not bar'}</button>
          </div>
          {!cat.is_bar && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase' }}>Default course when ordering:</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[1, 2, 3, 4].map(c => (
                  <button key={c} onClick={() => setDefaultCourse(cat, c)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12, background: (cat.default_course || 1) === c ? courseColors[c] : '#e0e0e0', color: (cat.default_course || 1) === c ? 'white' : '#555' }}>{courseLabels[c]}</button>
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
  const [settings, setSettings] = useState({ service_charge_percent: '12.5', service_charge_enabled: '1', company_name: '', company_address: '', company_phone: '', company_email: '', company_vat: '', receipt_footer: 'Thank you for dining with us!' });
  const [reasons, setReasons]   = useState([]);
  const [newReason, setNewReason] = useState('');
  const [saved, setSaved]       = useState(false);

  useEffect(() => { getSettings().then(s => setSettings(prev => ({ ...prev, ...s }))); getDiscountReasons().then(setReasons); }, []);

  const handleSaveSettings = async () => { await updateSettings(settings); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 };

  return (
    <div style={{ padding: 24, maxWidth: 600 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 24 }}>Settings</h1>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>🏢 Business Details</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><label style={labelStyle}>Restaurant Name</label><input value={settings.company_name} onChange={e => setSettings({ ...settings, company_name: e.target.value })} placeholder="e.g. The Golden Spoon" style={inputStyle} /></div>
          <div><label style={labelStyle}>Address</label><input value={settings.company_address} onChange={e => setSettings({ ...settings, company_address: e.target.value })} style={inputStyle} /></div>
          <div><label style={labelStyle}>Phone Number</label><input value={settings.company_phone} onChange={e => setSettings({ ...settings, company_phone: e.target.value })} style={inputStyle} /></div>
          <div><label style={labelStyle}>Email</label><input value={settings.company_email} onChange={e => setSettings({ ...settings, company_email: e.target.value })} style={inputStyle} /></div>
          <div><label style={labelStyle}>VAT Number</label><input value={settings.company_vat} onChange={e => setSettings({ ...settings, company_vat: e.target.value })} placeholder="e.g. GB123456789" style={inputStyle} /></div>
          <div><label style={labelStyle}>Receipt Footer</label><input value={settings.receipt_footer} onChange={e => setSettings({ ...settings, receipt_footer: e.target.value })} style={inputStyle} /></div>
        </div>
      </div>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>💳 Service Charge</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" checked={settings.service_charge_enabled === '1'} onChange={e => setSettings({ ...settings, service_charge_enabled: e.target.checked ? '1' : '0' })} /> Enable automatic service charge
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 14, fontWeight: 600, color: '#555' }}>Service charge %</label>
          <input value={settings.service_charge_percent} onChange={e => setSettings({ ...settings, service_charge_percent: e.target.value })} type="number" step="0.5" style={{ width: 100, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
        </div>
      </div>
      <button onClick={handleSaveSettings} style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: saved ? '#22c55e' : '#1a1a2e', color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 16, marginBottom: 20 }}>{saved ? '✓ Saved!' : 'Save All Settings'}</button>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 16 }}>🏷️ Discount Reasons</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {reasons.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8f8f8', borderRadius: 8 }}>
              <span style={{ fontSize: 14 }}>{r.reason}</span>
              <button onClick={async () => { await deleteDiscountReason(r.id); getDiscountReasons().then(setReasons); }} style={{ background: '#fee2e2', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#ef4444', fontSize: 12, fontWeight: 600 }}>Remove</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="Add new discount reason..." style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }} />
          <button onClick={async () => { if (!newReason) return; await addDiscountReason(newReason); setNewReason(''); getDiscountReasons().then(setReasons); }} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#e94560', color: 'white', cursor: 'pointer', fontWeight: 600 }}>Add</button>
        </div>
      </div>
      <div style={{ background: 'white', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 8 }}>🍹 Bar Categories</h2>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>Select which categories show on the Bar screen</p>
        <BarCategoryManager />
      </div>
      <div style={{ marginTop: 20 }}>
        <DiningDurationSettings />
      </div>
    </div>
  );
}
