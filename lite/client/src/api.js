const BASE = import.meta.env.VITE_LITE_API || 'http://localhost:3003';

function tokenHeader() {
  const t = localStorage.getItem('lite_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...tokenHeader() },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login:        (email, password)   => req('POST', '/api/auth/login', { email, password }),
  me:           ()                  => req('GET',  '/api/auth/me'),

  // Onboarding
  startOnboarding: (body)           => req('POST', '/api/onboarding/start', body),
  completeOnboarding: ()            => req('PATCH', '/api/onboarding/complete'),

  // Restaurant
  getRestaurant:    ()              => req('GET',  '/api/restaurant'),
  updateRestaurant: (body)          => req('PATCH', '/api/restaurant', body),
  getSettings:      ()              => req('GET',  '/api/restaurant/settings'),
  updateSettings:   (body)          => req('PATCH', '/api/restaurant/settings', body),
  getEmbedCodes:    ()              => req('GET',  '/api/restaurant/embed-codes'),
  getBookings:      (params = {})   => req('GET',  '/api/restaurant/bookings?' + new URLSearchParams(params)),
  getOrders:        (params = {})   => req('GET',  '/api/restaurant/orders?'   + new URLSearchParams(params)),
  getStats:         ()              => req('GET',  '/api/restaurant/stats'),

  // Stripe
  getPlans:         ()              => req('GET',  '/api/stripe/plans'),
  createCheckout:   (plan)          => req('POST', '/api/stripe/create-checkout', { plan }),
  openBillingPortal: ()             => req('POST', '/api/stripe/portal'),
};
