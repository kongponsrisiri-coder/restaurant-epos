import { initials, C } from '../theme.js';

const palette = ['#C9A84C', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#f59e0b', '#0ea5e9'];
function colorFor(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return palette[Math.abs(h) % palette.length];
}

export default function Avatar({ name, size = 36 }) {
  const bg = colorFor(name);
  return (
    <div style={{
      width: size, height: size, borderRadius: size,
      background: bg, color: 'white', fontWeight: 800,
      fontSize: Math.floor(size * 0.42),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      letterSpacing: 0.5, flexShrink: 0,
    }}>{initials(name)}</div>
  );
}
