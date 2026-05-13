import { C } from '../theme.js';
import WebsiteBuilderPanel from '../components/WebsiteBuilderPanel.jsx';

export default function WebsitePage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text, letterSpacing: -0.5 }}>
          Website Builder
        </h1>
        <p style={{ margin: '4px 0 0', color: C.textMuted, fontSize: 14 }}>
          Build the SiamEPOS marketing demo site. Edit fields, drop in photos, pick a colour, then download the standalone HTML.
        </p>
      </div>
      <WebsiteBuilderPanel scope={{ kind: 'global' }} />
    </div>
  );
}
