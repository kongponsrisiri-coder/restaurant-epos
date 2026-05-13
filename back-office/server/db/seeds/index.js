// SEPOS — engineering tickets seed loader.
// Reads every `*.md` file in this directory and inserts it into
// engineering_tickets if a row with that code doesn't already exist.
// Idempotent — safe to call on every server boot.
//
// File-name convention: `{CODE}.md`, e.g. `SEPOS-WEB-001.md`.
// First line of the markdown is parsed as the title (must start with
// `# TICKET: {CODE}` or `# {CODE}` — we take everything after the
// first newline as the body).

const fs = require('fs');
const path = require('path');
const { pool } = require('../pool');

function parseTitle(md, code) {
  // First non-empty line. Strip leading "# TICKET: " or "# ".
  const firstLine = md.split(/\r?\n/).find(l => l.trim().length > 0) || `Ticket ${code}`;
  return firstLine
    .replace(/^#+\s*/, '')         // strip leading hashes
    .replace(/^TICKET:\s*/i, '')   // strip "TICKET:" prefix
    .trim();
}

async function seedTickets() {
  const dir = __dirname;
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return;
  }
  for (const file of files) {
    const code = file.replace(/\.md$/, '');
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    const title = parseTitle(body, code);
    try {
      const existing = await pool.query(
        'SELECT id FROM engineering_tickets WHERE code = $1 LIMIT 1',
        [code]
      );
      if (existing.rows.length > 0) continue;
      await pool.query(
        `INSERT INTO engineering_tickets (code, title, status, priority, author, body_markdown)
         VALUES ($1, $2, 'open', 'high', 'Sandy + Korakot', $3)`,
        [code, title, body]
      );
      console.log(`[ops-db] seeded ticket ${code}`);
    } catch (err) {
      console.warn(`[ops-db] seed ${code} failed:`, err.message);
    }
  }
}

module.exports = { seedTickets };
