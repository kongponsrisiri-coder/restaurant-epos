// SEPOS-041 — JWT middleware. The frontend stores the token in localStorage
// and sends it on every request as `Authorization: Bearer <token>`.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PROD';
if (JWT_SECRET === 'CHANGE_ME_IN_PROD') {
  console.warn('[ops-auth] WARNING: JWT_SECRET not set — using insecure default. Set JWT_SECRET in Railway env.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authRequired(req, res, next) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { signToken, authRequired, adminOnly, JWT_SECRET };
