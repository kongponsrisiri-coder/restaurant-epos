# TICKET: SEPOS-WEB-001
## Website Builder — Complete Integration Spec

```
From:     Sandy (Design) + Korakot (Product)
To:       Krit (Backend Developer)
Priority: HIGH
Version:  2.0 — includes custom colour picker
```

---

## 1. Overview

Add a **Website Builder** tab to the SiamEPOS admin panel.

**What it does:**
1. Paste a customer's existing website URL → AI reads it and fills in all details automatically
2. Edit restaurant name, tagline, address, phone, about text
3. Pick a colour theme (3 presets) OR set any custom colour using a colour picker or hex code
4. Upload 5 photos via drag & drop or click to browse
5. Click Generate → downloads a complete, self-contained HTML website file

**Photos are embedded as base64** inside the HTML — no CDN or external hosting needed.

---

## 2. Admin Panel Integration

**New file:** `client/src/screens/admin/WebsiteBuilderSection.jsx`

**In `AdminScreen.jsx` — add one tab and one import:**

```jsx
// 1. Add to tab list (alongside existing tabs):
{ key: 'website', label: '🌐 Website', icon: null }

// 2. Add to section renderer:
{activeTab === 'website' && <WebsiteBuilderSection />}

// 3. Add import at top of file:
import WebsiteBuilderSection from './WebsiteBuilderSection';
```

---

## 3. Database

### 3.1 PostgreSQL — `src/db/database.js`

Add inside the `initializeDatabase` function:

```javascript
await pool.query(`
  CREATE TABLE IF NOT EXISTS website_configs (
    id               SERIAL PRIMARY KEY,
    restaurant_id    VARCHAR(100) DEFAULT 'siamepos',
    restaurant_name  TEXT,
    tagline          TEXT,
    address          TEXT,
    phone            TEXT,
    about_text       TEXT,
    primary_colour   VARCHAR(7)  DEFAULT '#7B1C2D',
    accent_colour    VARCHAR(7)  DEFAULT '#C49030',
    photo_hero       TEXT,
    photo_story      TEXT,
    photo_gallery_1  TEXT,
    photo_gallery_2  TEXT,
    photo_gallery_3  TEXT,
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW()
  )
`);
```

### 3.2 SQLite — `src/db/localDatabase.js`

Add to the CREATE TABLE block:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS website_configs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id    TEXT DEFAULT 'siamepos',
    restaurant_name  TEXT,
    tagline          TEXT,
    address          TEXT,
    phone            TEXT,
    about_text       TEXT,
    primary_colour   TEXT DEFAULT '#7B1C2D',
    accent_colour    TEXT DEFAULT '#C49030',
    photo_hero       TEXT,
    photo_story      TEXT,
    photo_gallery_1  TEXT,
    photo_gallery_2  TEXT,
    photo_gallery_3  TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
  )
`);
```

Add to the `addColumnIfMissing()` migration section:

```javascript
addColumnIfMissing('website_configs', 'restaurant_name',  'TEXT');
addColumnIfMissing('website_configs', 'tagline',          'TEXT');
addColumnIfMissing('website_configs', 'address',          'TEXT');
addColumnIfMissing('website_configs', 'phone',            'TEXT');
addColumnIfMissing('website_configs', 'about_text',       'TEXT');
addColumnIfMissing('website_configs', 'primary_colour',   "TEXT DEFAULT '#7B1C2D'");
addColumnIfMissing('website_configs', 'accent_colour',    "TEXT DEFAULT '#C49030'");
addColumnIfMissing('website_configs', 'photo_hero',       'TEXT');
addColumnIfMissing('website_configs', 'photo_story',      'TEXT');
addColumnIfMissing('website_configs', 'photo_gallery_1',  'TEXT');
addColumnIfMissing('website_configs', 'photo_gallery_2',  'TEXT');
addColumnIfMissing('website_configs', 'photo_gallery_3',  'TEXT');
```

---

## 4. Backend Routes — `src/server.js`

Add these three routes after the existing admin routes section.

### Route 1 — GET /api/website-config

```javascript
app.get('/api/website-config', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM website_configs WHERE restaurant_id = $1 LIMIT 1`,
      ['siamepos']
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error('GET /api/website-config:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

### Route 2 — POST /api/website-config

```javascript
app.post('/api/website-config', async (req, res) => {
  const {
    restaurant_name, tagline, address, phone, about_text,
    primary_colour, accent_colour,
    photo_hero, photo_story,
    photo_gallery_1, photo_gallery_2, photo_gallery_3
  } = req.body;

  try {
    const existing = await pool.query(
      `SELECT id FROM website_configs WHERE restaurant_id = $1 LIMIT 1`,
      ['siamepos']
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE website_configs SET
           restaurant_name = $1,  tagline         = $2,
           address         = $3,  phone           = $4,
           about_text      = $5,  primary_colour  = $6,
           accent_colour   = $7,  photo_hero      = $8,
           photo_story     = $9,  photo_gallery_1 = $10,
           photo_gallery_2 = $11, photo_gallery_3 = $12,
           updated_at      = NOW()
         WHERE restaurant_id = $13`,
        [
          restaurant_name, tagline, address, phone, about_text,
          primary_colour, accent_colour,
          photo_hero, photo_story,
          photo_gallery_1, photo_gallery_2, photo_gallery_3,
          'siamepos'
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO website_configs
           (restaurant_id, restaurant_name, tagline, address, phone,
            about_text, primary_colour, accent_colour,
            photo_hero, photo_story,
            photo_gallery_1, photo_gallery_2, photo_gallery_3)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          'siamepos',
          restaurant_name, tagline, address, phone, about_text,
          primary_colour, accent_colour,
          photo_hero, photo_story,
          photo_gallery_1, photo_gallery_2, photo_gallery_3
        ]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/website-config:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

### Route 3 — POST /api/website-config/ai-import

Uses the existing `ANTHROPIC_API_KEY` env var already on Railway.
`@anthropic-ai/sdk` is already installed (used by InvoiceScanner).

```javascript
const Anthropic = require('@anthropic-ai/sdk');

app.post('/api/website-config/ai-import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You extract restaurant details from websites.
Visit the given URL and extract restaurant information.
Return ONLY a valid JSON object — no markdown, no extra text.
Fields:
  name       — restaurant name
  tagline    — one-line description of cuisine and location
  address    — full postal address
  phone      — phone number with area code
  about_text — 2-3 sentence about-us paragraph in the restaurant's own voice
Use empty string for any field not found.`,
      messages: [{
        role:    'user',
        content: `Extract restaurant details from this website: ${url}`
      }]
    });

    const text  = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in AI response');

    const data = JSON.parse(match[0]);
    res.json({ success: true, data });

  } catch (err) {
    console.error('POST /api/website-config/ai-import:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

---

## 5. Frontend API helpers — `client/src/api.js`

Add these three functions:

```javascript
// ── Website Builder ─────────────────────────────────────────────
export const getWebsiteConfig = () =>
  fetch(`${API_URL}/api/website-config`).then(r => r.json());

export const saveWebsiteConfig = (config) =>
  fetch(`${API_URL}/api/website-config`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(config)
  }).then(r => r.json());

export const aiImportWebsite = (url) =>
  fetch(`${API_URL}/api/website-config/ai-import`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ url })
  }).then(r => r.json());
```

---

## 6. Frontend Component — `client/src/screens/admin/WebsiteBuilderSection.jsx`

Full file in the conversation thread — see Sandy's original handover or the
in-repo copy when Krit drops it in.

Key implementation notes:

- 3 colour presets (burgundy, sage, midnight) plus a custom colour
  picker driving primary + accent hex inputs.
- `buildTheme(primary, accent)` derives a full palette (darken/lighten
  helpers — no external colour library needed).
- 5 photo slots with drag-and-drop + click-to-browse. Files read via
  FileReader → base64 → stored in component state, then sent up to
  Postgres as TEXT columns.
- "Generate website" produces a single self-contained HTML file (CSS
  inlined, photos as base64 data URIs) and triggers a download.
- AI import calls `aiImportWebsite(url)` which goes through the new
  cloud endpoint that uses Claude + web_search to extract restaurant
  details and populate the form.

---

## 7. Environment Variables

No new env vars needed.
`ANTHROPIC_API_KEY` is already set on Railway (used by InvoiceScanner).

---

## 8. Krit's Build Checklist

- [ ] 1. Add website_configs table — `src/db/database.js`       (PostgreSQL CREATE TABLE)
- [ ] 2. Add website_configs table — `src/db/localDatabase.js`  (SQLite CREATE + migrations)
- [ ] 3. Add GET  `/api/website-config`                         (server.js)
- [ ] 4. Add POST `/api/website-config`                         (server.js)
- [ ] 5. Add POST `/api/website-config/ai-import`               (server.js)
- [ ] 6. Add `api.js` helpers (getWebsiteConfig, saveWebsiteConfig, aiImportWebsite)
- [ ] 7. Create `client/src/screens/admin/WebsiteBuilderSection.jsx`  (full file per spec)
- [ ] 8. Add Website tab to `AdminScreen.jsx` (import + tab entry + renderer)
- [ ] 9. Test: AI import fills all fields correctly
- [ ] 10. Test: Colour picker + hex input both update live preview
- [ ] 11. Test: Photos upload via drag & drop and click-to-browse
- [ ] 12. Test: Save persists across page reload
- [ ] 13. Test: Generated HTML opens in browser with correct colours + photos embedded
- [ ] 14. `git push` → Railway + Netlify auto-deploy

---

## 9. Phase 2 — Future Ticket

- Auto-publish to `[slug].siamepos.net` via Netlify Deploy API
- More website templates and layout options
- SiamEPOS booking widget auto-embedded in generated site
- Live preview pane inside admin
- More colour themes and font choices

---

*Sandy — SiamEPOS Design · SEPOS-WEB-001 v2.0 · May 2026*
