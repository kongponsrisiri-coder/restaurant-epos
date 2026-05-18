import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { C, card } from '../theme.js';

export default function DashboardPage({ user }) {
  const [stats, setStats]   = useState(null);
  const [bookings, setBookings] = useState([]);
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getBookings({ limit: 5 }),
      api.getOrders({ status: 'open', limit: 5 }),
    ]).then(([s, b, o]) => {
      setStats(s); setBookings(b); setOrders(o);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const subscribed = new URLSearchParams(window.location.search).get('subscribed');

  return (
    <div>
      {/* Welcome banner */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: 0 }}>
          Welcome back{user?.restaurantName ? `, ${user.restaurantName}` : ''} 👋
        </h1>
        <p style={{ margin: '6px 0 0', color: C.textMuted, fontSize: 14 }}>Here's what's happening today.</p>
      </div>

      {subscribed && (
        <div style={{ background: C.successBg, color: C.success, padding: '12px 18px', borderRadius: 10, marginBottom: 20, border: `1px solid ${C.success}33`, fontSize: 14, fontWeight: 600 }}>
          🎉 Subscription activated! You're all set — grab your embed codes below.
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        <StatCard icon="📅" label="Bookings today"  value={loading ? '—' : stats?.bookings_today ?? 0} to="/bookings" />
        <StatCard icon="🥡" label="Orders today"    value={loading ? '—' : stats?.orders_today   ?? 0} to="/orders"  />
        <StatCard icon="💷" label="Revenue today"   value={loading ? '—' : `£${Number(stats?.revenue_today ?? 0).toFixed(2)}`} to="/revenue" />
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        <QuickLink to="/embed-codes" icon="🔗" title="Embed codes" desc="Copy-paste widgets onto your website" colour="#7c3aed" />
        <QuickLink to="/bookings"    icon="📅" title="Bookings"    desc="View and manage reservations"        colour="#0ea5e9" />
        <QuickLink to="/orders"      icon="🥡" title="Orders"      desc="Open takeaway and delivery orders"   colour="#16a34a" />
        <QuickLink to="/settings"    icon="⚙️" title="Settings"    desc="Hours, logo, service charge"         colour="#64748b" />
      </div>

      {/* Recent bookings + orders */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <RecentList title="Recent bookings" items={bookings} emptyMsg="No bookings yet today." renderItem={b => (
          <div key={b.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: C.text }}>{b.customer_name} · {b.party_size} guests</div>
            <div style={{ color: C.textMuted, marginTop: 2 }}>{formatDate(b.reservation_date)} · {b.status}</div>
          </div>
        )} link="/bookings" />
        <RecentList title="Open orders" items={orders} emptyMsg="No open orders right now." renderItem={o => (
          <div key={o.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: C.text }}>{o.customer_name || 'Online order'} · {o.order_type === 'delivery' ? '🚗 Delivery' : '🥡 Collection'}</div>
            <div style={{ color: C.textMuted, marginTop: 2 }}>£{Number(o.total_amount || 0).toFixed(2)} · {formatTime(o.created_at)}</div>
          </div>
        )} link="/orders" />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, to }) {
  const inner = (
    <div style={{ ...card, padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 16 }}>
      <span style={{ fontSize: 28 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, fontWeight: 600 }}>{label}</div>
      </div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{inner}</Link> : inner;
}

function QuickLink({ to, icon, title, desc, colour }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div style={{ ...card, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14, transition: 'box-shadow .15s' }}>
        <div style={{ width: 42, height: 42, borderRadius: 10, background: colour + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>
          {icon}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{title}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{desc}</div>
        </div>
      </div>
    </Link>
  );
}

function RecentList({ title, items, emptyMsg, renderItem, link }) {
  return (
    <div style={{ ...card, padding: '20px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: C.text }}>{title}</h3>
        <Link to={link} style={{ fontSize: 12, color: C.navy, fontWeight: 700 }}>View all →</Link>
      </div>
      {items.length === 0
        ? <div style={{ color: C.textFaint, fontSize: 13, padding: '12px 0' }}>{emptyMsg}</div>
        : items.map(renderItem)}
    </div>
  );
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
