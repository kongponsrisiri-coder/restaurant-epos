import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { C, input, btn, card } from '../theme.js';

const STEPS = ['Your restaurant', 'Choose a plan', 'Activate', 'All done'];

export default function OnboardingPage({ onLogin }) {
  const [step, setStep]     = useState(0);
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const navigate             = useNavigate();

  // Form state
  const [profile, setProfile] = useState({ name: '', email: '', password: '', phone: '', address: '' });
  const [plan, setPlan]       = useState('lite_bundle');
  const [plans, setPlans]     = useState(null);
  const [token, setToken]     = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState('');

  const setP = (k, v) => setProfile(prev => ({ ...prev, [k]: v }));

  // ── Step 0: Profile ─────────────────────────────────────────────
  const submitProfile = async (e) => {
    e.preventDefault();
    setError('');
    if (!profile.name || !profile.email || !profile.password) {
      return setError('Name, email and password are required.');
    }
    if (profile.password.length < 8) return setError('Password must be at least 8 characters.');
    setLoading(true);
    try {
      const data = await api.startOnboarding({ ...profile, plan });
      localStorage.setItem('lite_token', data.token);
      setToken(data.token);
      onLogin({ email: profile.email, name: profile.name, restaurantId: data.restaurantId, plan: data.plan, restaurantName: profile.name }, data.token);
      // Load plans for step 1
      const ps = await api.getPlans();
      setPlans(ps);
      setStep(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 1: Plan picker ─────────────────────────────────────────
  const submitPlan = async () => {
    setError(''); setLoading(true);
    try {
      const data = await api.createCheckout(plan);
      setCheckoutUrl(data.url);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Stripe redirect ─────────────────────────────────────
  // User comes back from Stripe with ?subscribed=1 — we skip straight to done
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('subscribed')) {
    if (step !== 3) setStep(3);
  }

  const finish = async () => {
    try { await api.completeOnboarding(); } catch {}
    navigate('/dashboard');
  };

  const planLabels = {
    lite_booking:  { label: 'Booking Only',  price: '£29/mo', colour: '#0ea5e9' },
    lite_ordering: { label: 'Ordering Only', price: '£39/mo', colour: '#22c55e' },
    lite_bundle:   { label: 'Bundle',        price: '£49/mo', colour: C.gold    },
    pro:           { label: 'Pro',           price: '£89/mo', colour: '#a855f7' },
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.navy, letterSpacing: 0.5 }}>SiamEPOS <span style={{ color: C.gold }}>Lite</span></div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Online bookings + takeaway for your restaurant</div>
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 28, alignItems: 'center' }}>
        {STEPS.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: i < step ? C.gold : i === step ? C.navy : C.border,
              color: i <= step ? '#fff' : C.textFaint,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, flexShrink: 0,
            }}>
              {i < step ? '✓' : i + 1}
            </div>
            <span style={{ fontSize: 12, fontWeight: i === step ? 700 : 500, color: i === step ? C.text : C.textMuted, whiteSpace: 'nowrap' }}>{s}</span>
            {i < STEPS.length - 1 && <div style={{ width: 24, height: 2, background: C.border }} />}
          </div>
        ))}
      </div>

      <div style={{ ...card, width: '100%', maxWidth: 520, padding: '32px 28px' }}>
        {error && (
          <div style={{ background: C.dangerBg, color: C.danger, padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 18, border: `1px solid ${C.danger}33` }}>
            {error}
          </div>
        )}

        {/* ── Step 0: Profile ── */}
        {step === 0 && (
          <form onSubmit={submitProfile}>
            <h2 style={{ margin: '0 0 20px', fontSize: 20, fontWeight: 800, color: C.text }}>Tell us about your restaurant</h2>
            <Field label="Restaurant name">
              <input value={profile.name} onChange={e => setP('name', e.target.value)} required style={input} placeholder="Thai Garden" />
            </Field>
            <Field label="Your email (login)">
              <input type="email" value={profile.email} onChange={e => setP('email', e.target.value)} required style={input} placeholder="hello@thaigarden.co.uk" />
            </Field>
            <Field label="Password">
              <input type="password" value={profile.password} onChange={e => setP('password', e.target.value)} required minLength={8} style={input} placeholder="Min 8 characters" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Phone">
                <input value={profile.phone} onChange={e => setP('phone', e.target.value)} style={input} placeholder="020 1234 5678" />
              </Field>
              <Field label="Address">
                <input value={profile.address} onChange={e => setP('address', e.target.value)} style={input} placeholder="1 High St, London" />
              </Field>
            </div>
            <button type="submit" disabled={loading} style={{ ...btn.primary, width: '100%', marginTop: 8, opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Creating account…' : 'Continue →'}
            </button>
          </form>
        )}

        {/* ── Step 1: Plan ── */}
        {step === 1 && (
          <div>
            <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800, color: C.text }}>Choose your plan</h2>
            <p style={{ margin: '0 0 20px', color: C.textMuted, fontSize: 14 }}>You can upgrade or change anytime.</p>
            <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
              {(plans || Object.entries(planLabels).map(([id, p]) => ({ id, label: p.label, price: parseInt(p.price), description: '' }))).map(p => {
                const meta = planLabels[p.id] || {};
                const active = plan === p.id;
                return (
                  <button key={p.id} onClick={() => setPlan(p.id)} style={{
                    textAlign: 'left', padding: '16px 18px', borderRadius: 10,
                    border: `2px solid ${active ? meta.colour || C.navy : C.border}`,
                    background: active ? `${meta.colour || C.navy}0d` : '#fff',
                    cursor: 'pointer',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{p.label}</span>
                      <span style={{ fontSize: 18, fontWeight: 800, color: meta.colour || C.navy }}>{meta.price || `£${p.price}/mo`}</span>
                    </div>
                    {p.description && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{p.description}</div>}
                  </button>
                );
              })}
            </div>
            <button onClick={submitPlan} disabled={loading} style={{ ...btn.gold, width: '100%', opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Preparing payment…' : 'Continue to payment →'}
            </button>
          </div>
        )}

        {/* ── Step 2: Stripe redirect ── */}
        {step === 2 && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>💳</div>
            <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 800, color: C.text }}>Complete payment</h2>
            <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>
              You'll be taken to Stripe's secure checkout. After payment, you'll be redirected back here automatically.
            </p>
            <a href={checkoutUrl} style={{ ...btn.gold, display: 'inline-block', textDecoration: 'none' }}>
              Go to payment →
            </a>
            <div style={{ marginTop: 16, fontSize: 12, color: C.textFaint }}>
              Secure checkout powered by Stripe
            </div>
          </div>
        )}

        {/* ── Step 3: Done ── */}
        {step === 3 && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 800, color: C.text }}>You're all set!</h2>
            <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>
              Your SiamEPOS Lite account is active.
            </p>
            <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 28 }}>
              Head to your dashboard to grab your widget embed codes and get them on your website.
            </p>
            <button onClick={finish} style={{ ...btn.primary, padding: '12px 32px' }}>
              Go to dashboard →
            </button>
          </div>
        )}
      </div>

      <p style={{ marginTop: 20, fontSize: 13, color: C.textMuted }}>
        Already have an account? <a href="/login" style={{ color: C.navy, fontWeight: 700 }}>Sign in</a>
      </p>
    </div>
  );
}

function Field({ label: lbl, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 6 }}>{lbl}</label>
      {children}
    </div>
  );
}
