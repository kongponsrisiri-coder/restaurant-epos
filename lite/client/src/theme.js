// SiamEPOS Lite — design tokens (matches back-office palette)
export const C = {
  navy:       '#0D1B3E',
  gold:       '#C9A84C',
  bg:         '#f6f7fb',
  surface:    '#ffffff',
  surfaceAlt: '#f1f3f8',
  border:     '#e2e6ef',
  borderSoft: '#eef0f6',
  text:       '#1a1f36',
  textMuted:  '#64748b',
  textFaint:  '#94a3b8',
  danger:     '#dc2626',
  dangerBg:   '#fef2f2',
  success:    '#16a34a',
  successBg:  '#f0fdf4',
  info:       '#0ea5e9',
};

export const card = {
  background:   C.surface,
  border:       `1px solid ${C.border}`,
  borderRadius: 14,
  boxShadow:    '0 1px 4px rgba(0,0,0,0.06)',
};

export const btn = {
  primary: {
    background:   C.navy,
    color:        '#fff',
    border:       'none',
    borderRadius: 8,
    padding:      '10px 20px',
    fontWeight:   700,
    fontSize:     14,
    cursor:       'pointer',
  },
  gold: {
    background:   C.gold,
    color:        '#1a1a1a',
    border:       'none',
    borderRadius: 8,
    padding:      '10px 20px',
    fontWeight:   700,
    fontSize:     14,
    cursor:       'pointer',
  },
  ghost: {
    background:   'transparent',
    color:        C.navy,
    border:       `1px solid ${C.border}`,
    borderRadius: 8,
    padding:      '9px 18px',
    fontWeight:   600,
    fontSize:     14,
    cursor:       'pointer',
  },
};

export const input = {
  width:        '100%',
  padding:      '9px 12px',
  border:       `1px solid ${C.border}`,
  borderRadius: 8,
  fontSize:     14,
  color:        C.text,
  background:   '#fff',
  outline:      'none',
};

export const label = {
  display:      'block',
  fontSize:     12,
  fontWeight:   700,
  color:        C.textMuted,
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};
