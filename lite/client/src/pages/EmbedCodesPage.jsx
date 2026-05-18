import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { C, card, btn } from '../theme.js';

export default function EmbedCodesPage({ user }) {
  const [codes, setCodes]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api.getEmbedCodes()
      .then(setCodes)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const copy = (key, text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2500);
    });
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: C.textFaint, fontSize: 14 }}>
      Loading embed codes…
    </div>
  );

  if (error) return (
    <div style={{ background: '#fef2f2', color: '#dc2626', padding: '16px 20px', borderRadius: 12, fontSize: 13 }}>
      {error}
    </div>
  );

  const plan = user?.plan || '';
  const hasBooking  = plan === 'lite_booking'  || plan === 'lite_bundle' || plan === 'pro';
  const hasOrdering = plan === 'lite_ordering' || plan === 'lite_bundle' || plan === 'pro';

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, margin: 0 }}>Embed codes</h1>
        <p style={{ margin: '5px 0 0', color: C.textMuted, fontSize: 14 }}>
          Copy these snippets and paste them into your restaurant's website.
        </p>
      </div>

      {/* How it works */}
      <div style={{ ...card, padding: '20px 24px', marginBottom: 24, background: `${C.navy}08`, border: `1px solid ${C.navy}20` }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: C.navy }}>📋 How to add these to your website</h3>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: C.textMuted, lineHeight: 1.9 }}>
          <li>Copy the widget code you need (booking, ordering, or both).</li>
          <li>Open your website editor (Squarespace, Wix, WordPress, or any HTML editor).</li>
          <li>Add a <strong>Custom HTML / Embed</strong> block to the page where you want the widget to appear.</li>
          <li>Paste the code and save — that's it. The widget loads automatically.</li>
        </ol>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: C.textFaint }}>
          The widgets are hosted by SiamEPOS and update automatically — you never need to touch the code again.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Booking widget */}
        <WidgetCard
          icon="📅"
          title="Online booking widget"
          subtitle="Lets customers reserve a table directly from your website"
          available={hasBooking}
          unavailablePlan={plan}
          feature="Booking"
          code={codes?.booking}
          copied={copied}
          onCopy={text => copy('booking', text)}
          preview="bookings"
        />

        {/* Ordering widget */}
        <WidgetCard
          icon="🥡"
          title="Online ordering widget"
          subtitle="Lets customers place takeaway or delivery orders from your website"
          available={hasOrdering}
          unavailablePlan={plan}
          feature="Ordering"
          code={codes?.takeaway}
          copied={copied}
          onCopy={text => copy('ordering', text)}
          preview="orders"
        />

      </div>

      {/* Tips */}
      <div style={{ marginTop: 28, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {[
          { icon: '📱', title: 'Mobile ready', desc: 'Both widgets are fully responsive and look great on phones and tablets.' },
          { icon: '🎨', title: 'Matches your site', desc: 'The widgets use a neutral style that blends with any website design.' },
          { icon: '🔒', title: 'Secure & reliable', desc: 'Hosted on SiamEPOS infrastructure — no maintenance needed from you.' },
        ].map(tip => (
          <div key={tip.title} style={{ ...card, padding: '16px 18px' }}>
            <div style={{ fontSize: 22, marginBottom: 8 }}>{tip.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>{tip.title}</div>
            <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.6 }}>{tip.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Widget card ──────────────────────────────────────────── */

function WidgetCard({ icon, title, subtitle, available, unavailablePlan, feature, code, copied, onCopy, preview }) {
  const [showCode, setShowCode] = useState(false);

  if (!available) {
    return (
      <div style={{ ...card, padding: '22px 24px', opacity: 0.85 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <span style={{ fontSize: 28, flexShrink: 0 }}>{icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: C.text }}>{title}</h3>
              <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#fef9c3', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Upgrade required
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: C.textMuted }}>{subtitle}</p>
            <p style={{ margin: '12px 0 0', fontSize: 13, color: C.textMuted }}>
              The <strong>{feature}</strong> widget is not included in your current plan.
              Upgrade to <strong>Bundle</strong> or a plan that includes {feature.toLowerCase()} to unlock this widget.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const isCopied = copied === (preview === 'bookings' ? 'booking' : 'ordering');

  return (
    <div style={{ ...card, padding: '22px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <span style={{ fontSize: 28, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: C.text }}>{title}</h3>
            <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, background: '#dcfce7', color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Active
            </span>
          </div>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: C.textMuted }}>{subtitle}</p>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <button
              onClick={() => code && onCopy(code)}
              disabled={!code}
              style={{ ...btn.primary, display: 'flex', alignItems: 'center', gap: 6, opacity: code ? 1 : 0.6 }}
            >
              {isCopied ? '✓ Copied!' : '📋 Copy widget code'}
            </button>
            <button
              onClick={() => setShowCode(s => !s)}
              style={{ ...btn.ghost }}
            >
              {showCode ? 'Hide code' : 'View code'}
            </button>
          </div>

          {/* Code block */}
          {showCode && code && (
            <div style={{ position: 'relative' }}>
              <pre style={{
                margin: 0, padding: '14px 16px', background: C.navy, color: '#e2e8f0',
                borderRadius: 10, fontSize: 12, overflowX: 'auto', lineHeight: 1.6,
                fontFamily: '"SF Mono", "Fira Code", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {code}
              </pre>
              <button
                onClick={() => onCopy(code)}
                style={{
                  position: 'absolute', top: 8, right: 8, padding: '4px 10px',
                  background: isCopied ? C.success : 'rgba(255,255,255,0.12)',
                  color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 700,
                }}
              >
                {isCopied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          )}

          {/* Placeholder if no code returned */}
          {!code && (
            <div style={{ fontSize: 12, color: C.textFaint, fontStyle: 'italic' }}>
              Widget code not available — check your restaurant is fully set up.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
