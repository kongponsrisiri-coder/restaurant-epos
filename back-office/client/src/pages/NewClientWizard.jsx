// SEPOS-029 — New Client Onboarding Wizard.
//
// 5-step form rendered at /clients/new. Each step gates on basic
// validation. Step 5 POSTs to /api/clients/onboard and shows a success
// card with the generated SYNC_SECRET (copy button), an inline checklist
// of automated vs still-manual steps, and a link straight to the new
// client's detail page where the operator works through the rest.

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { C, card, btn, input, label } from '../theme.js';

const TOTAL_STEPS = 5;

const BLANK = {
  // Step 1
  restaurant_name: '',
  owner_name: '',
  owner_email: '',
  phone: '',
  vat_number: '',
  address: '',
  plan: 'trial',
  monthly_fee: '',
  trial_start_date: new Date().toISOString().slice(0, 10),
  // Step 2
  subdomain_slug: '',
  brevo_api_key: '',
  anthropic_api_key: '',
  has_reservations: true,
  has_takeaway: false,
  has_inventory: false,
  // Step 3 — Stripe (placeholder until SEPOS-040)
  // (no fields — Step 3 is informational)
  // Step 4
  owner_pin: '9999',
  chef_pin: '1111',
  waiter_pin: '2222',
};

function autoSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function NewClientWizard() {
  const [step, setStep] = useState(1);
  const [f, setF] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);     // { client, sync_secret, checklist }
  const nav = useNavigate();

  const set = (k, v) => setF(prev => {
    const next = { ...prev, [k]: v };
    // Auto-fill the subdomain slug as the operator types the restaurant
    // name — but only if they haven't manually overridden it.
    if (k === 'restaurant_name' && (!prev.subdomain_slug || prev.subdomain_slug === autoSlug(prev.restaurant_name))) {
      next.subdomain_slug = autoSlug(v);
    }
    return next;
  });

  const errors = useMemo(() => validate(f), [f]);
  const stepErrors = errors[`step${step}`] || [];

  const canAdvance = stepErrors.length === 0;

  const submit = async () => {
    setSaving(true); setErr('');
    try {
      const body = {
        restaurant_name:    f.restaurant_name.trim(),
        owner_name:         f.owner_name.trim() || null,
        owner_email:        f.owner_email.trim() || null,
        phone:              f.phone.trim() || null,
        vat_number:         f.vat_number.trim() || null,
        address:            f.address.trim() || null,
        plan:               f.plan,
        monthly_fee:        f.monthly_fee ? Number(f.monthly_fee) : null,
        trial_start_date:   f.trial_start_date || null,
        subdomain_slug:     f.subdomain_slug.trim() || null,
        brevo_api_key:      f.brevo_api_key.trim() || null,
        anthropic_api_key:  f.anthropic_api_key.trim() || null,
        has_reservations:   !!f.has_reservations,
        has_takeaway:       !!f.has_takeaway,
        has_inventory:      !!f.has_inventory,
        owner_pin:          f.owner_pin || '9999',
        chef_pin:           f.chef_pin || '1111',
        waiter_pin:         f.waiter_pin || '2222',
      };
      const r = await api.onboardClient(body);
      setResult(r);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Success card ────────────────────────────────────────────────
  if (result) {
    return <SuccessCard result={result} onBack={() => nav('/')} />;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <Link to="/" style={{ fontSize: 13, color: C.textMuted, textDecoration: 'none', fontWeight: 600 }}>← Back to dashboard</Link>

      <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 12, marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>
            New client
          </h1>
          <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
            Five quick steps. The first row appears in your dashboard as soon as you finish — manual provisioning happens on the next screen.
          </p>
        </div>
      </div>

      <StepProgress step={step} total={TOTAL_STEPS} />

      <div style={{ ...card, padding: 28, marginTop: 18 }}>
        {step === 1 && <Step1 f={f} set={set} errors={stepErrors} />}
        {step === 2 && <Step2 f={f} set={set} errors={stepErrors} />}
        {step === 3 && <Step3 f={f} set={set} />}
        {step === 4 && <Step4 f={f} set={set} errors={stepErrors} />}
        {step === 5 && <Step5Review f={f} />}

        {err && (
          <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginTop: 16, border: `1px solid ${C.danger}33` }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22, paddingTop: 16, borderTop: `1px solid ${C.borderSoft}` }}>
          {step > 1 && <button onClick={() => setStep(s => s - 1)} style={btn.ghost} disabled={saving}>← Back</button>}
          {step < TOTAL_STEPS && (
            <button
              onClick={() => canAdvance ? setStep(s => s + 1) : null}
              disabled={!canAdvance}
              style={{ ...btn.primary, opacity: canAdvance ? 1 : 0.5 }}
            >
              Next →
            </button>
          )}
          {step === TOTAL_STEPS && (
            <button onClick={submit} disabled={saving} style={{ ...btn.gold, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Creating client…' : '✓ Create + send welcome email'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Validation ──────────────────────────────────────────────────
function validate(f) {
  const out = { step1: [], step2: [], step3: [], step4: [], step5: [] };
  if (!f.restaurant_name.trim())          out.step1.push('Restaurant name is required.');
  if (!f.owner_email.trim())              out.step1.push('Owner email is required (the welcome email goes here).');
  else if (!/^\S+@\S+\.\S+$/.test(f.owner_email)) out.step1.push('Owner email looks invalid.');
  if (!f.subdomain_slug.trim())           out.step2.push('Subdomain slug is required.');
  else if (!/^[a-z0-9-]+$/.test(f.subdomain_slug)) out.step2.push('Slug can only contain lowercase letters, numbers, and dashes.');
  for (const k of ['owner_pin', 'chef_pin', 'waiter_pin']) {
    if (!/^\d{4,6}$/.test(String(f[k] || ''))) out.step4.push(`${k.replace('_', ' ')} must be 4–6 digits.`);
  }
  return out;
}

// ── Progress strip ──────────────────────────────────────────────
function StepProgress({ step, total }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {Array.from({ length: total }).map((_, i) => {
        const n = i + 1;
        const done    = n < step;
        const active  = n === step;
        return (
          <div key={n} style={{
            flex: 1, height: 6, borderRadius: 999,
            background: done ? C.gold : active ? C.navy : C.border,
          }} />
        );
      })}
    </div>
  );
}

// ── Steps ───────────────────────────────────────────────────────
function Step1({ f, set, errors }) {
  return (
    <Stepped title="Step 1 · Restaurant details" subtitle="The basics. Everything here lands on the client row + welcome email.">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Restaurant name *">
          <input value={f.restaurant_name} onChange={(e) => set('restaurant_name', e.target.value)} style={input} />
        </Field>
        <Field label="Plan">
          <select value={f.plan} onChange={(e) => set('plan', e.target.value)} style={input}>
            <option value="trial">Trial</option>
            <option value="starter">Starter</option>
            <option value="cloud">Cloud</option>
            <option value="pro">Pro</option>
          </select>
        </Field>
        <Field label="Owner name">
          <input value={f.owner_name} onChange={(e) => set('owner_name', e.target.value)} style={input} />
        </Field>
        <Field label="Owner email *">
          <input type="email" value={f.owner_email} onChange={(e) => set('owner_email', e.target.value)} style={input} placeholder="owner@restaurant.co.uk" />
        </Field>
        <Field label="Phone">
          <input value={f.phone} onChange={(e) => set('phone', e.target.value)} style={input} />
        </Field>
        <Field label="VAT number">
          <input value={f.vat_number} onChange={(e) => set('vat_number', e.target.value)} style={input} />
        </Field>
        <Field label="Monthly fee (£)">
          <input type="number" step="0.01" value={f.monthly_fee} onChange={(e) => set('monthly_fee', e.target.value)} style={input} />
        </Field>
        <Field label="Trial start">
          <input type="date" value={f.trial_start_date} onChange={(e) => set('trial_start_date', e.target.value)} style={input} />
        </Field>
      </div>
      <Field label="Restaurant address">
        <textarea value={f.address} onChange={(e) => set('address', e.target.value)} style={{ ...input, minHeight: 70, resize: 'vertical' }} />
      </Field>
      <Errors items={errors} />
    </Stepped>
  );
}

function Step2({ f, set, errors }) {
  return (
    <Stepped title="Step 2 · Tech setup" subtitle="What's needed to provision the tenant. The sync key is generated for you on Step 5.">
      <Field label="Subdomain slug *">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input value={f.subdomain_slug} onChange={(e) => set('subdomain_slug', e.target.value.toLowerCase())} style={{ ...input, fontFamily: 'ui-monospace, monospace' }} />
          <span style={{ color: C.textMuted, fontSize: 13 }}>.siamepos.co.uk</span>
        </div>
      </Field>

      <Field label="Brevo API key (for owner-side booking + receipt emails)">
        <input value={f.brevo_api_key} onChange={(e) => set('brevo_api_key', e.target.value)} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder="xkeysib-…" />
      </Field>
      <div style={{ fontSize: 11, color: C.textFaint, marginTop: -8 }}>
        Each tenant uses their OWN Brevo account so emails come from <em>their</em> domain. Skip if they don't have one yet — the dashboard will flag it.
      </div>

      <Field label="Anthropic API key (for AI menu scanner)">
        <input value={f.anthropic_api_key} onChange={(e) => set('anthropic_api_key', e.target.value)} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder="sk-ant-…" />
      </Field>

      <div>
        <label style={label}>Features</label>
        <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
          <Checkbox checked={f.has_reservations} onChange={(v) => set('has_reservations', v)} label="Online reservations" />
          <Checkbox checked={f.has_takeaway}     onChange={(v) => set('has_takeaway', v)}     label="Online takeaway (will need Stripe Connect later)" />
          <Checkbox checked={f.has_inventory}    onChange={(v) => set('has_inventory', v)}    label="Inventory + recipe cost tracking" />
        </div>
      </div>

      <Errors items={errors} />
    </Stepped>
  );
}

function Step3({ f }) {
  return (
    <Stepped title="Step 3 · Stripe Connect" subtitle="Payments. Most restaurants can skip this on day one.">
      {!f.has_takeaway ? (
        <div style={{ ...card, padding: 18, background: C.surfaceAlt, border: 'none' }}>
          <strong>Takeaway is off</strong> for this client, so no Stripe setup is needed right now.
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6 }}>
            They can enable takeaway later from Admin → Settings; we'll send them the Stripe Connect onboarding link when SEPOS-040 ships.
          </div>
        </div>
      ) : (
        <div style={{ ...card, padding: 18, background: '#fef3c7', border: '1px solid #fbbf24' }}>
          <strong>⚠ Stripe Connect setup is manual for now.</strong>
          <div style={{ fontSize: 13, color: C.text, marginTop: 8, lineHeight: 1.6 }}>
            We'll create the client now and add a checklist item on their detail page. Once SEPOS-040 ships you'll be able to send a one-click Stripe Connect link straight from the back office. For today, do this by hand:
            <ol style={{ marginTop: 10, paddingLeft: 22 }}>
              <li>Create a Standard Stripe Connect account for the restaurant.</li>
              <li>Copy their <code>acct_…</code> ID into the client's <strong>Setup → Stripe Connect account ID</strong> field.</li>
              <li>Add <code>STRIPE_PK_LIVE</code> + <code>STRIPE_SK_LIVE</code> to the tenant's Railway env.</li>
            </ol>
          </div>
        </div>
      )}
    </Stepped>
  );
}

function Step4({ f, set, errors }) {
  return (
    <Stepped title="Step 4 · Owner + staff PINs" subtitle="Used to seed the staff table. Owner can change these on first login.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <Field label="Owner PIN (admin) *">
          <input value={f.owner_pin} onChange={(e) => set('owner_pin', e.target.value.replace(/\D/g, ''))} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 18, textAlign: 'center' }} maxLength={6} />
        </Field>
        <Field label="Chef PIN *">
          <input value={f.chef_pin} onChange={(e) => set('chef_pin', e.target.value.replace(/\D/g, ''))} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 18, textAlign: 'center' }} maxLength={6} />
        </Field>
        <Field label="Waiter PIN *">
          <input value={f.waiter_pin} onChange={(e) => set('waiter_pin', e.target.value.replace(/\D/g, ''))} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 18, textAlign: 'center' }} maxLength={6} />
        </Field>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted }}>
        After you finish the wizard you can download the populated <code>staff_seed.sql</code> from the client's Onboarding tab and run it against their Railway Postgres.
      </div>
      <Errors items={errors} />
    </Stepped>
  );
}

function Step5Review({ f }) {
  const items = [
    ['Restaurant',        f.restaurant_name],
    ['Owner',             `${f.owner_name || '—'} · ${f.owner_email}`],
    ['Phone',             f.phone || '—'],
    ['Plan',              `${f.plan}${f.monthly_fee ? ` · £${f.monthly_fee}/mo` : ''}`],
    ['Subdomain',         `${f.subdomain_slug}.siamepos.co.uk`],
    ['Brevo API key',     f.brevo_api_key ? '✓ provided' : '— skipped'],
    ['Anthropic API key', f.anthropic_api_key ? '✓ provided' : '— skipped'],
    ['Features',          [
                            f.has_reservations && 'Reservations',
                            f.has_takeaway     && 'Takeaway',
                            f.has_inventory    && 'Inventory',
                          ].filter(Boolean).join(' · ') || '—'],
    ['Owner PIN',         f.owner_pin],
  ];
  return (
    <Stepped title="Step 5 · Review + send welcome" subtitle="Confirm the details. Hitting the button below creates the client and triggers the welcome email with the SYNC_SECRET and download link.">
      <div style={{ display: 'grid', gap: 0, border: `1px solid ${C.border}`, borderRadius: 10 }}>
        {items.map(([k, v], i) => (
          <div key={k} style={{ display: 'flex', padding: '10px 16px', borderTop: i === 0 ? 'none' : `1px solid ${C.borderSoft}`, fontSize: 14 }}>
            <span style={{ minWidth: 160, color: C.textMuted, fontWeight: 600 }}>{k}</span>
            <span style={{ color: C.text }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.textFaint, marginTop: 10 }}>
        The SYNC_SECRET is generated server-side and shown on the next screen so you can copy it to the owner's desktop install. It's also retrievable later from the client's Onboarding tab.
      </div>
    </Stepped>
  );
}

// ── Success card ────────────────────────────────────────────────
function SuccessCard({ result, onBack }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(result.sync_secret); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch {}
  };
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ ...card, padding: 36, marginTop: 30 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, color: C.text }}>
          {result.client.restaurant_name} is ready
        </h1>
        <p style={{ color: C.textMuted, marginTop: 6, fontSize: 14 }}>
          Welcome email is on its way to <strong>{result.client.email}</strong>. The desktop sync key is below — copy it now and keep it safe.
        </p>

        {/* SYNC_SECRET surface */}
        <div style={{ background: '#0D1B3E', color: 'white', padding: 18, borderRadius: 10, marginTop: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#C9A84C', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
            🔐 SYNC_SECRET — desktop sync key
          </div>
          <div style={{
            fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13,
            background: 'rgba(255,255,255,0.08)', padding: 12, borderRadius: 6,
            wordBreak: 'break-all', lineHeight: 1.5,
          }}>
            {result.sync_secret}
          </div>
          <button onClick={copy} style={{
            background: '#C9A84C', color: '#0D1B3E', border: 'none', padding: '8px 14px',
            borderRadius: 6, marginTop: 12, fontWeight: 800, fontSize: 13, cursor: 'pointer',
          }}>{copied ? '✓ Copied' : '📋 Copy to clipboard'}</button>
        </div>

        {/* Checklist preview */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
            Still to do (manual for now)
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {result.checklist.map(c => (
              <div key={c.key} style={{ fontSize: 13, color: C.textMuted, display: 'flex', gap: 8 }}>
                <span>☐</span><span>{c.label}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: C.textFaint, marginTop: 10 }}>
            Tick each off on the client's Onboarding tab as you finish. Status flips to <strong>live</strong> automatically when every item is done.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <Link to={`/clients/${result.client.id}`} style={{ ...btn.primary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            Open client →
          </Link>
          <button onClick={onBack} style={btn.ghost}>Back to dashboard</button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function Stepped({ title, subtitle, children }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>{title}</h2>
        {subtitle && <p style={{ margin: '4px 0 0', fontSize: 13, color: C.textMuted }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label: lbl, children }) {
  return (
    <div>
      <label style={label}>{lbl}</label>
      {children}
    </div>
  );
}

function Checkbox({ checked, onChange, label: lbl }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: C.text, fontWeight: 600 }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
      {lbl}
    </label>
  );
}

function Errors({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', color: C.danger, fontSize: 12 }}>
      {items.map((e, i) => <li key={i}>{e}</li>)}
    </ul>
  );
}
