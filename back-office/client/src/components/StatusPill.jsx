import { STATUS_STYLE } from '../theme.js';

export default function StatusPill({ status }) {
  const st = STATUS_STYLE[status] || STATUS_STYLE.setup;
  return (
    <span style={{
      background: st.bg, color: st.color, fontSize: 11, fontWeight: 700,
      padding: '4px 10px', borderRadius: 999, letterSpacing: 0.4,
      textTransform: 'uppercase', display: 'inline-block',
    }}>{st.label}</span>
  );
}
