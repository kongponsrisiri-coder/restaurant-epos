// Shared design tokens for the back-office UI. Inline styles still — but
// pulled from these constants so the palette stays cohesive.

export const C = {
  navy:        '#0D1B3E',
  navyDeep:    '#070E20',
  navyHover:   '#1a2a52',
  gold:        '#C9A84C',
  goldLight:   '#E0BE5A',

  bg:          '#f6f7fb',
  surface:     '#ffffff',
  surfaceAlt:  '#f8fafc',
  border:      '#e2e8f0',
  borderSoft:  '#f1f5f9',

  text:        '#0f172a',
  textMuted:   '#64748b',
  textFaint:   '#94a3b8',

  success:     '#22c55e',
  successBg:   '#dcfce7',
  warning:     '#f59e0b',
  warningBg:   '#fef3c7',
  danger:      '#ef4444',
  dangerBg:    '#fee2e2',
  info:        '#3b82f6',
  infoBg:      '#dbeafe',
};

export const card = {
  background: C.surface,
  borderRadius: 14,
  boxShadow: '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
  border: `1px solid ${C.border}`,
};

export const btn = {
  primary: {
    background: C.navy,
    color: 'white',
    border: 'none',
    padding: '9px 18px',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    letterSpacing: 0.2,
  },
  gold: {
    background: C.gold,
    color: C.navy,
    border: 'none',
    padding: '9px 18px',
    borderRadius: 8,
    fontWeight: 800,
    fontSize: 14,
    cursor: 'pointer',
    letterSpacing: 0.2,
  },
  ghost: {
    background: 'transparent',
    color: C.textMuted,
    border: `1px solid ${C.border}`,
    padding: '8px 14px',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
};

export const input = {
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  fontSize: 14,
  color: C.text,
  background: C.surface,
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

export const label = {
  fontSize: 11,
  fontWeight: 700,
  color: C.textMuted,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 6,
  display: 'block',
};

export const STATUS_STYLE = {
  setup:   { bg: '#fef3c7', color: '#92400e', label: 'Setup' },
  active:  { bg: '#dcfce7', color: '#166534', label: 'Active' },
  trial:   { bg: '#dbeafe', color: '#1e40af', label: 'Trial' },
  churned: { bg: '#fee2e2', color: '#991b1b', label: 'Churned' },
  paused:  { bg: '#f1f5f9', color: '#475569', label: 'Paused' },
};

export const PLAN_LABEL = { trial: 'Trial', cloud: 'Cloud', pro: 'Pro' };

// Helpers
export function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase()).join('') || '?';
}

export function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function fmtMoney(v) {
  const n = Number(v) || 0;
  return `£${n.toFixed(2)}`;
}
