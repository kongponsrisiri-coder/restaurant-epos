// SEPOS-LITE-002 — shown when a Lite customer opens a feature their
// plan doesn't include. A friendly upsell, not a dead end / blank screen.
export default function UpgradeLocked({ feature }) {
  const name = feature || 'This feature';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center',
      padding: '48px 24px', minHeight: 320, color: '#1a1a2e',
    }}>
      <div style={{ fontSize: 56, marginBottom: 12 }}>🔒</div>
      <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 8px' }}>
        {name} isn’t in your plan
      </h2>
      <p style={{ fontSize: 15, color: '#666', maxWidth: 440, lineHeight: 1.6, margin: '0 0 22px' }}>
        Your current SiamEPOS plan doesn’t include {name.toLowerCase()}.
        Upgrade to unlock it — along with the rest of the full SiamEPOS system.
      </p>
      <div style={{
        background: '#0D1B3E', color: '#C9A84C',
        padding: '12px 22px', borderRadius: 10, fontWeight: 700, fontSize: 14,
      }}>
        Contact us at info@siamepos.co.uk to upgrade
      </div>
    </div>
  );
}
