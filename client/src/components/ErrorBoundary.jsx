import { Component } from 'react';

// Top-level React error boundary. A render crash anywhere in the tree (e.g. a
// .toFixed on an unexpected string after a bill is deleted) used to unmount the
// whole app and leave the operator stuck on a blank white screen with no way
// out but force-quitting. This catches the crash and shows a recoverable card
// with a Reload button instead, so the till is never bricked mid-service.
//
// Brand CI: Thai Gold var(--brand-accent,#C9A84C) on Deep Navy var(--brand-primary,#0D1B3E).
const NAVY = 'var(--brand-primary,#0D1B3E)', GOLD = 'var(--brand-accent,#C9A84C)';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: (error && (error.message || String(error))) || '' };
  }

  componentDidCatch(error, info) {
    // Keep a breadcrumb in the console for support, but never re-throw.
    try { console.error('App render error:', error, info); } catch {}
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        minHeight: '100dvh', background: NAVY, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: '24px 18px',
        fontFamily: 'system-ui, -apple-system, sans-serif', textAlign: 'center',
      }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>⚠️</div>
        <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 800, margin: '0 0 8px' }}>
          Something went wrong
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, maxWidth: 360, margin: '0 0 24px', lineHeight: 1.5 }}>
          The app hit an unexpected error. Your data is safe — just reload to carry on.
        </p>
        <button
          onClick={() => { try { window.location.reload(); } catch {} }}
          style={{
            background: GOLD, color: NAVY, border: 'none', borderRadius: 12,
            padding: '14px 32px', fontWeight: 800, fontSize: 16, cursor: 'pointer',
          }}>
          Reload
        </button>
        {this.state.message && (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 20, maxWidth: 360, wordBreak: 'break-word' }}>
            {this.state.message}
          </div>
        )}
      </div>
    );
  }
}
