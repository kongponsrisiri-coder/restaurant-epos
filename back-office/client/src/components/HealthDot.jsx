import { C } from '../theme.js';

export default function HealthDot({ online, size = 10, pulsing = false }) {
  const color = online === null || online === undefined ? C.textFaint
              : online ? C.success
              : C.danger;
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: size,
      background: color, boxShadow: pulsing ? `0 0 0 4px ${color}33` : 'none',
      flexShrink: 0,
    }} />
  );
}
