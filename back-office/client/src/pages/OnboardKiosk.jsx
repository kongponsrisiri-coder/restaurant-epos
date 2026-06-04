// BO-ONBOARD-001 — Client Signup Kiosk.
// Shown at /onboard — no sidebar, no nav, just the wizard.
// Korakot opens this on his tablet when signing up a new client face-to-face.
// The client fills in their details, picks a plan, and pays by card.

import { useEffect, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements, CardElement, useStripe, useElements,
} from '@stripe/react-stripe-js';
import { api } from '../api.js';
import { C } from '../theme.js';

// ── tiny helpers ────────────────────────────────────────────────────────────

const inp = {
  width: '100%', padding: '14px 16px', fontSize: 16, borderRadius: 10,
  border: `1.5px solid ${C.border}`, background: '#fff',
  color: C.text, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', transition: 'border-color 0.15s',
};

const lbl = {
  display: 'block', fontSize: 13, fontWeight: 700, color: C.textMuted,
  marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5,
};

const goldBtn = {
  background: C.gold, color: C.navy, border: 'none', borderRadius: 10,
  padding: '16px 28px', fontSize: 16, fontWeight: 800, cursor: 'pointer',
  fontFamily: 'inherit', width: '100%', marginTop: 8,
  transition: 'opacity 0.15s',
};

const ghostBtn = {
  background: 'transparent', color: C.textMuted, border: `1.5px solid ${C.border}`,
  borderRadius: 10, padding: '14px 24px', fontSize: 15, fontWeight: 700,
  cursor: 'pointer', fontFamily: 'inherit',
};

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {label && <label style={lbl}>{label}</label>}
      {children}
      {hint && <div style={{ fontSize: 12, color: C.textFaint, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function Err({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      background: '#fef2f2', color: '#991b1b', padding: '12px 16px',
      borderRadius: 8, fontSize: 14, border: '1px solid #fecaca', marginTop: 12,
    }}>
      {msg}
    </div>
  );
}

// ── Progress bar ────────────────────────────────────────────────────────────
function Progress({ step, total }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 32 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          flex: 1, height: 5, borderRadius: 999,
          background: i < step ? C.gold : i === step ? C.navy : C.border,
          transition: 'background 0.3s',
        }} />
      ))}
    </div>
  );
}

// ── Plan data ───────────────────────────────────────────────────────────────
const RESTAURANT_PLANS = [
  {
    key: 'pro', name: 'SiamEPOS Pro', price: '£89/mo',
    features: ['Full EPOS — dine-in & takeaway', 'Kitchen display system', 'Online reservations', 'Online ordering widget', 'Desktop app (works offline)', 'Customer CRM & campaigns', 'Staff management & reports'],
    highlight: true,
  },
  {
    key: 'lite_bundle', name: 'SiamEPOS Lite — Bundle', price: '£49/mo',
    features: ['Online booking widget', 'Online ordering widget', 'Customer CRM', 'Embed on any website'],
    highlight: false,
  },
  {
    key: 'lite_booking', name: 'SiamEPOS Lite — Booking only', price: '£29/mo',
    features: ['Online booking widget', 'Customer CRM', 'Embed on any website'],
    highlight: false,
  },
  {
    key: 'lite_ordering', name: 'SiamEPOS Lite — Ordering only', price: '£39/mo',
    features: ['Online ordering widget', 'Customer CRM', 'Embed on any website'],
    highlight: false,
  },
];

const SPA_PLANS = [
  {
    key: 'spa', name: 'SiamSpa', price: '£49/mo',
    features: ['Appointment booking system', 'Therapist & room management', 'Online booking widget', 'Client CRM & history', 'Gift vouchers', 'Reports & Z-report'],
    highlight: true,
  },
];

// ── Main wizard ─────────────────────────────────────────────────────────────
const TOTAL_STEPS = 5; // 0:product 1:details 2:address 3:plan 4:payment

export default function OnboardKiosk() {
  const [stripePromise, setStripePromise] = useState(null);
  const [noStripe, setNoStripe] = useState(false);

  useEffect(() => {
    api.kioskGetStripeKey()
      .then(({ publishableKey }) => setStripePromise(loadStripe(publishableKey)))
      .catch(() => setNoStripe(true)); // key not configured — kiosk still works without payment
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fb', padding: '32px 16px 64px' }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 800 }}>
          <span style={{ color: C.navy }}>Siam</span>
          <span style={{ color: C.gold }}>EPOS</span>
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 4 }}>
          New client signup
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        {/* Always wrap in Elements — null stripe is valid and just means "not loaded yet".
            This prevents useStripe()/useElements() from throwing when step 4 renders
            before the key API call has resolved. */}
        <Elements stripe={stripePromise}>
          <Wizard noStripe={noStripe} />
        </Elements>
      </div>
    </div>
  );
}

function Wizard({ noStripe }) {
  const [step, setStep]   = useState(0);
  const [form, setForm]   = useState({
    product: '', businessName: '', ownerName: '', email: '',
    phone: '', address: '', plan: '',
  });
  const [done, setDone]   = useState(null); // { clientName }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const next = () => setStep(s => Math.min(s + 1, TOTAL_STEPS - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  if (done) return <ConfirmScreen name={done.clientName} />;

  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', boxShadow: '0 2px 24px rgba(15,23,42,0.08)' }}>
      <Progress step={step} total={TOTAL_STEPS} />

      {step === 0 && <StepProduct  form={form} set={set} onNext={next} />}
      {step === 1 && <StepDetails  form={form} set={set} onNext={next} onBack={back} />}
      {step === 2 && <StepAddress  form={form} set={set} onNext={next} onBack={back} />}
      {step === 3 && <StepPlan     form={form} set={set} onNext={next} onBack={back} />}
      {step === 4 && (
        <StepPayment
          form={form}
          noStripe={noStripe}
          onBack={back}
          onDone={(clientName) => setDone({ clientName })}
        />
      )}
    </div>
  );
}

// ── Step 0: Product ─────────────────────────────────────────────────────────
function StepProduct({ form, set, onNext }) {
  const products = [
    {
      key: 'restaurant', emoji: '🍽', title: 'Restaurant EPOS',
      desc: 'Full point-of-sale system for dine-in, takeaway, kitchen display, reservations, and CRM.',
      bg: '#f0fdf4', border: '#86efac', text: '#166534',
    },
    {
      key: 'spa', emoji: '🌿', title: 'Spa Management',
      desc: 'Appointment booking, therapist scheduling, rooms, vouchers, Treatwell integration.',
      bg: '#fdf4ff', border: '#d8b4fe', text: '#7e22ce',
    },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px' }}>Welcome to SiamEPOS</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>What are you setting up today?</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
        {products.map(p => {
          const chosen = form.product === p.key;
          return (
            <div key={p.key} onClick={() => set('product', p.key)} style={{
              border: `2px solid ${chosen ? p.border : C.border}`,
              borderRadius: 14, padding: 20, cursor: 'pointer',
              background: chosen ? p.bg : '#fff',
              boxShadow: chosen ? `0 0 0 3px ${p.border}55` : 'none',
              transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>{p.emoji}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: chosen ? p.text : C.text, marginBottom: 4 }}>{p.title}</div>
              <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>{p.desc}</div>
              {chosen && (
                <div style={{ marginTop: 10, display: 'inline-block', background: p.border, color: p.text, fontSize: 11, fontWeight: 800, padding: '2px 10px', borderRadius: 999 }}>
                  ✓ Selected
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={onNext} disabled={!form.product} style={{ ...goldBtn, opacity: form.product ? 1 : 0.4, cursor: form.product ? 'pointer' : 'not-allowed' }}>
        Continue →
      </button>
    </div>
  );
}

// ── Step 1: Details ─────────────────────────────────────────────────────────
function StepDetails({ form, set, onNext, onBack }) {
  const isSpa = form.product === 'spa';
  const nameLbl = isSpa ? 'Spa name' : 'Restaurant name';
  const canNext = form.businessName.trim() && form.email.trim() && /\S+@\S+\.\S+/.test(form.email);

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px' }}>Your details</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>Tell us a bit about your business.</p>

      <Field label={`${nameLbl} *`}>
        <input value={form.businessName} onChange={e => set('businessName', e.target.value)} style={inp} placeholder={isSpa ? 'e.g. Baan Siam Spa' : 'e.g. Baan Siam Restaurant'} />
      </Field>
      <Field label="Your name">
        <input value={form.ownerName} onChange={e => set('ownerName', e.target.value)} style={inp} placeholder="Owner / manager name" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Email address *">
          <input type="email" value={form.email} onChange={e => set('email', e.target.value)} style={inp} placeholder="you@restaurant.co.uk" />
        </Field>
        <Field label="Phone number">
          <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} style={inp} placeholder="07…" />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button onClick={onNext} disabled={!canNext} style={{ ...goldBtn, opacity: canNext ? 1 : 0.4, cursor: canNext ? 'pointer' : 'not-allowed', marginTop: 0, flex: 1 }}>
          Continue →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Address ─────────────────────────────────────────────────────────
function StepAddress({ form, set, onNext, onBack }) {
  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px' }}>Business address</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>Used for your invoices and HMRC records.</p>

      <Field label="Full address">
        <textarea
          value={form.address}
          onChange={e => set('address', e.target.value)}
          style={{ ...inp, minHeight: 100, resize: 'vertical' }}
          placeholder={'123 High Street\nLondon\nW1A 1AA'}
        />
      </Field>

      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button onClick={onNext} style={{ ...goldBtn, marginTop: 0, flex: 1 }}>
          Continue →
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Plan ─────────────────────────────────────────────────────────────
function StepPlan({ form, set, onNext, onBack }) {
  const plans = form.product === 'spa' ? SPA_PLANS : RESTAURANT_PLANS;

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px' }}>Choose your plan</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>All plans include free setup support. Cancel anytime.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        {plans.map(p => {
          const chosen = form.plan === p.key;
          return (
            <div key={p.key} onClick={() => set('plan', p.key)} style={{
              border: `2px solid ${chosen ? C.gold : C.border}`,
              borderRadius: 14, padding: '18px 20px', cursor: 'pointer',
              background: chosen ? '#fffbeb' : '#fff',
              boxShadow: chosen ? `0 0 0 3px ${C.gold}44` : 'none',
              transition: 'all 0.15s',
              position: 'relative',
            }}>
              {p.highlight && !chosen && (
                <div style={{ position: 'absolute', top: -10, right: 16, background: C.navy, color: 'white', fontSize: 10, fontWeight: 800, padding: '3px 10px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Most popular
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: chosen ? C.navy : C.text }}>{p.name}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: chosen ? C.gold : C.text, flexShrink: 0, marginLeft: 12 }}>{p.price}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {p.features.map(f => (
                  <div key={f} style={{ fontSize: 13, color: C.textMuted, display: 'flex', gap: 6 }}>
                    <span style={{ color: chosen ? C.gold : '#86efac', fontWeight: 700 }}>✓</span> {f}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button onClick={onNext} disabled={!form.plan} style={{ ...goldBtn, opacity: form.plan ? 1 : 0.4, cursor: form.plan ? 'pointer' : 'not-allowed', marginTop: 0, flex: 1 }}>
          Continue →
        </button>
      </div>
    </div>
  );
}

// ── Step 4: Payment ──────────────────────────────────────────────────────────
function StepPayment({ form, noStripe, onBack, onDone }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [agreed, setAgreed]   = useState(false);
  const [paying, setPaying]   = useState(false);
  const [err, setErr]         = useState('');

  const PLAN_PRICE_LABEL = {
    pro: '£89', lite_booking: '£29', lite_ordering: '£39',
    lite_bundle: '£49', spa: '£49',
  };

  const handlePay = async () => {
    if (noStripe) {
      // Stripe not configured — create client without payment (for testing)
      setPaying(true);
      try {
        const r = await api.kioskComplete({ subscriptionId: 'test', formData: form });
        onDone(r.clientName);
      } catch (e) { setErr(e.message); }
      finally { setPaying(false); }
      return;
    }

    if (!stripe || !elements) { setErr('Stripe is loading, please try again.'); return; }
    setPaying(true); setErr('');

    try {
      // 1. Create Stripe subscription
      const { clientSecret, subscriptionId } = await api.kioskStartPayment({
        email: form.email,
        name:  form.businessName,
        plan:  form.plan,
      });

      // 2. Confirm card payment
      const { error: stripeErr } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card: elements.getElement(CardElement),
          billing_details: {
            name:  form.ownerName || form.businessName,
            email: form.email,
          },
        },
      });

      if (stripeErr) { setErr(stripeErr.message); return; }

      // 3. Complete — creates client record + emails Korakot
      const result = await api.kioskComplete({ subscriptionId, formData: form });
      onDone(result.clientName);
    } catch (e) {
      setErr(e.message || 'Payment failed — please try again.');
    } finally {
      setPaying(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px' }}>Payment details</h2>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 4 }}>
        Starting your <strong>{form.businessName}</strong> subscription at{' '}
        <strong>{PLAN_PRICE_LABEL[form.plan] || '?'}/month</strong>.
      </p>
      <p style={{ color: C.textFaint, fontSize: 13, marginBottom: 24 }}>Cancel anytime from your account settings.</p>

      {noStripe ? (
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 10, padding: '14px 18px', marginBottom: 20, fontSize: 14 }}>
          ⚠️ Stripe is not configured on this service. In test mode — no card will be charged.
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <label style={lbl}>Card details</label>
          <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', background: '#fff' }}>
            <CardElement options={{
              hidePostalCode: true,
              style: {
                base: { fontSize: '16px', color: C.text, fontFamily: 'inherit', '::placeholder': { color: '#94a3b8' } },
                invalid: { color: '#ef4444' },
              },
            }} />
          </div>
        </div>
      )}

      {/* T&C checkbox */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, margin: '20px 0', padding: '16px', background: '#f8f9fb', borderRadius: 10 }}>
        <input
          type="checkbox" id="terms" checked={agreed} onChange={e => setAgreed(e.target.checked)}
          style={{ width: 20, height: 20, marginTop: 2, accentColor: C.gold, cursor: 'pointer', flexShrink: 0 }}
        />
        <label htmlFor="terms" style={{ fontSize: 14, color: C.text, lineHeight: 1.6, cursor: 'pointer' }}>
          I have read and agree to the{' '}
          <a href="https://siamepos.co.uk/terms" target="_blank" rel="noopener noreferrer"
            style={{ color: C.navy, fontWeight: 700 }}>
            SiamEPOS Terms and Conditions
          </a>
          . I understand this is a monthly subscription billed automatically.
        </label>
      </div>

      <Err msg={err} />

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button onClick={onBack} disabled={paying} style={{ ...ghostBtn, opacity: paying ? 0.5 : 1 }}>← Back</button>
        <button
          onClick={handlePay}
          disabled={!agreed || paying || (!noStripe && (!stripe || !elements))}
          style={{
            ...goldBtn, marginTop: 0, flex: 1,
            opacity: agreed && !paying ? 1 : 0.4,
            cursor: agreed && !paying ? 'pointer' : 'not-allowed',
          }}
        >
          {paying ? '⏳ Processing…' : `Start subscription — ${PLAN_PRICE_LABEL[form.plan] || '?'}/month`}
        </button>
      </div>

      <div style={{ textAlign: 'center', fontSize: 12, color: C.textFaint, marginTop: 14 }}>
        🔒 Secure payment by Stripe. Your card details are never stored by SiamEPOS.
      </div>
    </div>
  );
}

// ── Confirmation ─────────────────────────────────────────────────────────────
function ConfirmScreen({ name }) {
  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: '40px 28px', boxShadow: '0 2px 24px rgba(15,23,42,0.08)', textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
      <h2 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: '0 0 12px' }}>
        You're all set, {name}!
      </h2>
      <p style={{ fontSize: 16, color: C.textMuted, lineHeight: 1.7, maxWidth: 440, margin: '0 auto 24px' }}>
        We'll have your system ready within <strong>24 hours</strong>. You'll receive an email with your login details and a quick-start guide.
      </p>
      <p style={{ fontSize: 15, color: C.textMuted, marginBottom: 28 }}>
        In the meantime, message us on LINE if you have any questions.
      </p>
      <div style={{
        display: 'inline-block', background: C.navy, color: 'white',
        padding: '6px 20px', borderRadius: 10, fontSize: 14, fontWeight: 700,
      }}>
        LINE: @siamepos
      </div>
    </div>
  );
}
