// Routes pool.query()/pool.connect() calls to either the cloud Postgres backend
// (src/db/database.js) or the local SQLite backend (src/db/localDatabase.js).
//
// Selection is via the DB_MODE env var:
//   DB_MODE=local   → SQLite (offline, set by Electron when spawning the server)
//   DB_MODE=cloud   → Postgres (default — Railway deploys and any plain `node src/server.js`)

const mode = (process.env.DB_MODE || 'cloud').toLowerCase();

if (mode === 'local') {
  console.log('[db] mode=local — SQLite backend');
  module.exports = require('./localDatabase');
} else {
  console.log('[db] mode=cloud — PostgreSQL backend');
  module.exports = require('./database');
}
