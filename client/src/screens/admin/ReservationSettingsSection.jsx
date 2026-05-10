import { useState, useEffect } from 'react';
import { SERVER_URL } from '../../api';

const RESTAURANT_ID = 'siamepos';

const inp = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
  fontFamily: 'inherit', color: '#1a1a2e',
};
const lbl = {
  fontSize: 13, fontWeight: 600, color: '#555',
  display: 'block', marginBottom: 6,
};
const hint = {
  fontSize: 12, color: '#aaa', marginTop: 4,
};

function Field({ label, hint: hintText, children }) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      {children}
      {hintText && <p style={hint}>{hintText}</p>}
    </div>
  );
}

function Card({ title, emoji, children }) {
  return (
    <div style={{ background: 'white', borderRadius: 14, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', marginBottom: 20, marginTop: 0 }}>
        {emoji} {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {children}
      </div>
    </div>
  );
}

export default function ReservationSettingsSection() {
  const [settings, setSettings] = useState({
    restaurant_name:     '',
    brand_colour:        '#C9A84C',
    opening_time:        '11:00',
    last_booking_time:   '21:30',
    slot_interval_mins:  15,
    max_covers_per_slot: 20,
    booking_lead_hours:  1,
    booking_advance_days: 60,
    is_active:           true,
  });
  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [saved,   setSaved]     = useState(false);
  const [error,   setError]     = useState(null);

  useEffect(() => {
    fetch(`${SERVER_URL}/api/reservations/settings/${RESTAURANT_ID}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setSettings(prev => ({ ...prev, ...data }));
      })
      .catch(() => {
        // Settings may not exist yet — use defaults
      })
      .finally(() => setLoading(false));
  }, []);

  const set = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/reservations/settings/${RESTAURANT_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!data.success && !res.ok) throw new Error(data.error || 'Save failed');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, color: '#888', fontSize: 14 }}>Loading reservation settings…</div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e', marginBottom: 6 }}>
        Reservation Settings
      </h1>
      <p style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>
        Configure your online booking widget and availability rules.
      </p>

      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#991b1b' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Online Booking Toggle */}
      <Card title="Online Booking" emoji="🌐">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: settings.is_active ? '#f0fdf4' : '#fef2f2', borderRadius: 10, padding: '14px 18px', border: `1.5px solid ${settings.is_active ? '#86efac' : '#fca5a5'}` }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: settings.is_active ? '#166534' : '#991b1b' }}>
              {settings.is_active ? '✅ Online booking is ACTIVE' : '🔴 Online booking is DISABLED'}
            </div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
              {settings.is_active ? 'Customers can make reservations via the booking widget' : 'No new bookings will be accepted through the widget'}
            </div>
          </div>
          <button
            onClick={() => set('is_active', !settings.is_active)}
            style={{
              padding: '8px 20px', borderRadius: 8, border: 'none',
              background: settings.is_active ? '#ef4444' : '#22c55e',
              color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {settings.is_active ? 'Disable' : 'Enable'}
          </button>
        </div>
      </Card>

      {/* Restaurant Info */}
      <Card title="Restaurant Info" emoji="🏢">
        <Field label="Restaurant Name" hint="Shown on the booking confirmation email">
          <input value={settings.restaurant_name} onChange={e => set('restaurant_name', e.target.value)} placeholder="e.g. Siam Thai Restaurant" style={inp} />
        </Field>
        <Field label="Brand Colour" hint="Used as the accent colour in the booking widget">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="color" value={settings.brand_colour} onChange={e => set('brand_colour', e.target.value)}
              style={{ width: 48, height: 40, border: '1px solid #ddd', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
            <input value={settings.brand_colour} onChange={e => set('brand_colour', e.target.value)}
              placeholder="#C9A84C" style={{ ...inp, flex: 1 }} />
          </div>
        </Field>
      </Card>

      {/* Opening Hours */}
      <Card title="Booking Hours" emoji="🕐">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="First booking slot" hint="Earliest time customers can book">
            <input type="time" value={settings.opening_time} onChange={e => set('opening_time', e.target.value)} style={inp} />
          </Field>
          <Field label="Last booking slot" hint="Latest time customers can book">
            <input type="time" value={settings.last_booking_time} onChange={e => set('last_booking_time', e.target.value)} style={inp} />
          </Field>
        </div>
        <Field label="Time slot interval" hint="How often booking slots appear (e.g. every 15 minutes)">
          <select value={settings.slot_interval_mins} onChange={e => set('slot_interval_mins', parseInt(e.target.value))} style={inp}>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every 60 minutes</option>
          </select>
        </Field>
      </Card>

      {/* Capacity */}
      <Card title="Capacity & Availability" emoji="👥">
        <Field label="Maximum covers per slot" hint="Total restaurant capacity — how many covers can be seated at the same time across all tables">
          <input
            type="number" min={1} max={500}
            value={settings.max_covers_per_slot}
            onChange={e => set('max_covers_per_slot', parseInt(e.target.value) || 1)}
            style={inp}
          />
        </Field>

        {/* Visual capacity summary */}
        <div style={{ background: '#f8f8f8', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#555', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>How this works with Dining Duration:</div>
          <div>1–4 covers → 90 min sitting → blocks slot + next 6 slots</div>
          <div>5–8 covers → 120 min sitting → blocks slot + next 8 slots</div>
          <div>9+ covers → 150 min sitting → blocks slot + next 10 slots</div>
          <div style={{ marginTop: 8, color: '#C9A84C', fontWeight: 600 }}>
            Edit dining duration times in Admin → Table Plan (right panel)
          </div>
        </div>
      </Card>

      {/* Booking Rules */}
      <Card title="Booking Rules" emoji="📋">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Booking lead time (hours)" hint="Minimum notice required — e.g. 2 = cannot book less than 2 hours ahead">
            <input
              type="number" min={0} max={72}
              value={settings.booking_lead_hours}
              onChange={e => set('booking_lead_hours', parseInt(e.target.value) || 0)}
              style={inp}
            />
          </Field>
          <Field label="Advance booking (days)" hint="How far ahead customers can book — e.g. 60 = up to 2 months ahead">
            <input
              type="number" min={1} max={365}
              value={settings.booking_advance_days}
              onChange={e => set('booking_advance_days', parseInt(e.target.value) || 1)}
              style={inp}
            />
          </Field>
        </div>
      </Card>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%', padding: '16px', borderRadius: 12, border: 'none',
          background: saved ? '#22c55e' : saving ? '#9ca3af' : '#1a1a2e',
          color: 'white', cursor: saving ? 'not-allowed' : 'pointer',
          fontWeight: 800, fontSize: 16, transition: 'background .2s',
        }}
      >
        {saving ? 'Saving…' : saved ? '✓ Settings Saved!' : 'Save Reservation Settings'}
      </button>
    </div>
  );
}
