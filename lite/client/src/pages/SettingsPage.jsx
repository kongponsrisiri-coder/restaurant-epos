import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn, input, label } from '../theme.js';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

const DEFAULT_HOURS = Object.fromEntries(
  DAYS.map(d => [d.toLowerCase(), { open: '12:00', close: '22:00', closed: false, session2: false, open2: '17:00', close2: '22:00' }])
);

export default function SettingsPage({ user, setUser }) {
  // Profile
  const [profile, setProfile]   = useState({ name: '', email: '', phone: '', address: '' });
  const [profSaved, setProfSaved] = useState(false);
  const [profLoading, setProfLoading] = useState(false);
  const [profError, setProfError] = useState('');

  // Settings (hours, service charge, delivery)
  const [hours, setHours]               = useState(DEFAULT_HOURS);
  const [serviceChargeEnabled, setSCEnabled] = useState(false);
  const [serviceChargeRate, setSCRate]  = useState('12.5');
  const [deliveryEnabled, setDelivEnabled] = useState(false);
  const [deliveryRadius, setDelivRadius] = useState('5');
  const [minOrderAmount, setMinOrder]   = useState('15');
  const [settSaved, setSettSaved]       = useState(false);
  const [settLoading, setSettLoading]   = useState(false);
  const [settError, setSettError]       = useState('');

  // Billing
  const [billingLoading, setBillingLoading] = useState(false);

  useEffect(() => {
    api.getRestaurant().then(r => {
      setProfile({ name: r.name || '', email: r.email || '', phone: r.phone || '', address: r.address || '' });
    }).catch(() => {});

    api.getSettings().then(s => {
      if (s.opening_hours) {
        try { setHours({ ...DEFAULT_HOURS, ...JSON.parse(s.opening_hours) }); } catch {}
      }
      setSCEnabled(s.service_charge_enabled === '1' || s.service_charge_enabled === true);
      setSCRate(s.service_charge_rate || '12.5');
      setDelivEnabled(s.delivery_enabled === '1' || s.delivery_enabled === true);
      setDelivRadius(s.delivery_radius_miles || '5');
      setMinOrder(s.min_order_amount || '15');
    }).catch(() => {});
  }, []);

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfLoading(true); setProfError(''); setProfSaved(false);
    try {
      const updated = await api.updateRestaurant(profile);
      if (setUser) setUser(u => ({ ...u, restaurantName: profile.name }));
      setProfSaved(true);
      setTimeout(() => setProfSaved(false), 3000);
    } catch (err) {
      setProfError(err.message);
    } finally {
      setProfLoading(false);
    }
  };

  const saveSettings = async (e) => {
    e.preventDefault();
    setSettLoading(true); setSettError(''); setSettSaved(false);
    try {
      await api.updateSettings({
        opening_hours:          JSON.stringify(hours),
        service_charge_enabled: serviceChargeEnabled ? '1' : '0',
        service_charge_rate:    serviceChargeRate,
        delivery_enabled:       deliveryEnabled ? '1' : '0',
        delivery_radius_miles:  deliveryRadius,
        min_order_amount:       minOrderAmount,
      });
      setSettSaved(true);
      setTimeout(() => setSettSaved(false), 3000);
    } catch (err) {
      setSettError(err.message);
    } finally {
      setSettLoading(false);
    }
  };

  const openBillingPortal = async () => {
    setBillingLoading(true);
    try {
      const data = await api.openBillingPortal();
      window.location.href = data.url;
    } catch (err) {
      alert('Could not open billing portal: ' + err.message);
    } finally {
      setBillingLoading(false);
    }
  };

  const setHour = (day, field, val) => setHours(h => ({ ...h, [day]: { ...h[day], [field]: val } }));

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Settings</h1>
        <p style={{ margin: '5px 0 0', color: C.textMuted, fontSize: 14 }}>Manage your restaurant profile and widget configuration.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Restaurant profile */}
          <Section title="Restaurant profile" icon="🏪">
            <form onSubmit={saveProfile}>
              {profError && <ErrorBanner msg={profError} />}
              <Field label="Restaurant name">
                <input value={profile.name} onChange={e => setProfile(p => ({...p, name: e.target.value}))} style={input} placeholder="Thai Garden" />
              </Field>
              <Field label="Email address">
                <input type="email" value={profile.email} onChange={e => setProfile(p => ({...p, email: e.target.value}))} style={input} placeholder="hello@thaigarden.co.uk" />
              </Field>
              <Field label="Phone number">
                <input value={profile.phone} onChange={e => setProfile(p => ({...p, phone: e.target.value}))} style={input} placeholder="020 1234 5678" />
              </Field>
              <Field label="Address">
                <input value={profile.address} onChange={e => setProfile(p => ({...p, address: e.target.value}))} style={input} placeholder="1 High Street, London" />
              </Field>
              <SaveBar loading={profLoading} saved={profSaved} />
            </form>
          </Section>

          {/* Billing */}
          <Section title="Subscription & billing" icon="💳">
            <p style={{ fontSize: 13, color: C.textMuted, marginTop: 0, marginBottom: 16, lineHeight: 1.6 }}>
              Manage your SiamEPOS Lite subscription, update payment details, or download invoices via the Stripe billing portal.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <PlanBadge plan={user?.plan} />
              <button onClick={openBillingPortal} disabled={billingLoading} style={{ ...btn.ghost, opacity: billingLoading ? 0.7 : 1 }}>
                {billingLoading ? 'Opening…' : 'Manage billing →'}
              </button>
            </div>
          </Section>

        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Opening hours */}
          <Section title="Opening hours" icon="🕐">
            <form onSubmit={saveSettings}>
              {settError && <ErrorBanner msg={settError} />}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                {DAYS.map(day => {
                  const key = day.toLowerCase();
                  const h = hours[key] || { open: '12:00', close: '22:00', closed: false, session2: false, open2: '17:00', close2: '22:00' };
                  const timeInput = { ...input, width: 90, padding: '5px 8px', fontSize: 12 };
                  return (
                    <div key={day} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>

                      {/* Session 1 row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, width: 34, flexShrink: 0 }}>
                          {day.slice(0,3)}
                        </span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.text, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!h.closed} onChange={e => setHour(key, 'closed', !e.target.checked)} style={{ width: 14, height: 14 }} />
                          Open
                        </label>
                        {!h.closed ? (
                          <>
                            <input type="time" value={h.open}  onChange={e => setHour(key, 'open',  e.target.value)} style={timeInput} />
                            <span style={{ fontSize: 11, color: C.textMuted }}>to</span>
                            <input type="time" value={h.close} onChange={e => setHour(key, 'close', e.target.value)} style={timeInput} />
                            {!h.session2 && (
                              <button type="button" onClick={() => setHour(key, 'session2', true)}
                                style={{ fontSize: 11, color: C.gold, background: 'none', border: `1px solid ${C.gold}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontWeight: 700 }}>
                                + 2nd session
                              </button>
                            )}
                          </>
                        ) : (
                          <span style={{ fontSize: 12, color: C.textFaint, fontStyle: 'italic' }}>Closed</span>
                        )}
                      </div>

                      {/* Session 2 row */}
                      {!h.closed && h.session2 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 42, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: C.textMuted, width: 34, flexShrink: 0 }}>2nd</span>
                          <input type="time" value={h.open2  || '17:00'} onChange={e => setHour(key, 'open2',  e.target.value)} style={timeInput} />
                          <span style={{ fontSize: 11, color: C.textMuted }}>to</span>
                          <input type="time" value={h.close2 || '22:00'} onChange={e => setHour(key, 'close2', e.target.value)} style={timeInput} />
                          <button type="button" onClick={() => setHour(key, 'session2', false)}
                            style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontWeight: 700 }}>
                            ×
                          </button>
                        </div>
                      )}

                    </div>
                  );
                })}
              </div>

              {/* Service charge */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18, marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Service charge</span>
                  <Toggle checked={serviceChargeEnabled} onChange={setSCEnabled} />
                </div>
                {serviceChargeEnabled && (
                  <Field label="Rate (%)">
                    <input type="number" value={serviceChargeRate} onChange={e => setSCRate(e.target.value)}
                      min="0" max="30" step="0.5" style={{ ...input, width: 100 }} />
                  </Field>
                )}
              </div>

              {/* Delivery */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Delivery</span>
                  <Toggle checked={deliveryEnabled} onChange={setDelivEnabled} />
                </div>
                {deliveryEnabled && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Max radius (miles)">
                      <input type="number" value={deliveryRadius} onChange={e => setDelivRadius(e.target.value)}
                        min="0" max="50" step="0.5" style={input} />
                    </Field>
                    <Field label="Min order (£)">
                      <input type="number" value={minOrderAmount} onChange={e => setMinOrder(e.target.value)}
                        min="0" step="0.5" style={input} />
                    </Field>
                  </div>
                )}
              </div>

              <SaveBar loading={settLoading} saved={settSaved} label="Save settings" />
            </form>
          </Section>

        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

function Section({ title, icon, children }) {
  return (
    <div style={{ ...card, padding: '22px 24px' }}>
      <h2 style={{ margin: '0 0 18px', fontSize: 15, fontWeight: 800, color: C.text }}>
        <span style={{ marginRight: 8 }}>{icon}</span>{title}
      </h2>
      {children}
    </div>
  );
}

function Field({ label: lbl, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={label}>{lbl}</label>
      {children}
    </div>
  );
}

function SaveBar({ loading, saved, label: lbl = 'Save changes' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="submit" disabled={loading} style={{ ...btn.primary, opacity: loading ? 0.7 : 1 }}>
        {loading ? 'Saving…' : lbl}
      </button>
      {saved && (
        <span style={{ fontSize: 13, color: C.success, fontWeight: 700 }}>✓ Saved</span>
      )}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} style={{
      width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
      background: checked ? C.success : C.border,
      position: 'relative', transition: 'background 0.2s', flexShrink: 0,
    }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
}

function ErrorBanner({ msg }) {
  return (
    <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14, border: '1px solid #fca5a533' }}>
      {msg}
    </div>
  );
}

function PlanBadge({ plan }) {
  const map = {
    lite_booking:  { label: 'Booking Only',  color: '#0ea5e9', bg: '#e0f2fe' },
    lite_ordering: { label: 'Ordering Only', color: '#16a34a', bg: '#dcfce7' },
    lite_bundle:   { label: 'Bundle',        color: '#a16207', bg: '#fef9c3' },
    pro:           { label: 'Pro',           color: '#7e22ce', bg: '#f3e8ff' },
  };
  const p = map[plan] || { label: plan || 'Free', color: C.textMuted, bg: C.surfaceAlt };
  return (
    <span style={{ padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700, background: p.bg, color: p.color }}>
      {p.label}
    </span>
  );
}
