# SiamEPOS — Brand Corporate Identity

**Version:** 1.3  
**Owner:** Korakot Kongponsrisiri, Founder & Director  
**Contact:** info@siamepos.co.uk  
**Website:** siamepos.co.uk  
**EPOS:** app.siamepos.co.uk  

---

## 1. Brand Overview

SiamEPOS is a **cloud restaurant management system** built specifically for Thai restaurants in the UK.  
Built **by** a Thai person **for** Thai restaurants.

**Product category:** Thai Restaurant Management System  
**Brand name:** SiamEPOS *(name does not change — "EPOS" is a proper name, not a category descriptor)*

**Tagline — PENDING KORAKOT APPROVAL (ticket #BP-001):**
- Option A: "The Thai Restaurant Management System" *(clear, category-defining)*
- Option B: "Built for Thai Restaurants. Built for Profit." *(Sandy recommends — most commercial energy)*
- Option C: "Restaurant Intelligence for Thai Restaurants" *(premium tone)*

**Brand personality:** Elegant · Trustworthy · Thai heritage · Modern tech · Intelligent

**Language rules (Nick ticket #BP-001 — effective immediately):**

| ❌ Do not use | ✅ Use instead |
|---|---|
| "EPOS system" | "restaurant management system" |
| "EPOS provider" | "Thai Restaurant Management System" |
| "cloud EPOS" | "cloud restaurant management system" |
| "our EPOS" | "our platform" / "our system" |
| "an EPOS" | "a restaurant management system" |
| SiamEPOS *(name)* | **KEEP** — name does not change |

---

## 2. Logo Mark — The Lotus Badge

The SiamEPOS logo mark is a **geometric 5-petal lotus** inside a double gold ring.

The lotus represents Thai heritage, purity, and elegance. The 5-petal arrangement uses graduated opacity (100% → 82% → 62%) to create depth — like a real flower viewed from above. A gold centre dot completes the mark.

### Full Horizontal Logo (Dark Background)

```svg
<svg viewBox="0 0 340 100" xmlns="http://www.w3.org/2000/svg">
  <!-- Gold ring badge -->
  <circle cx="52" cy="50" r="44" fill="none" stroke="#C9A84C" stroke-width="1.5"/>
  <circle cx="52" cy="50" r="38" fill="none" stroke="#C9A84C" stroke-width="0.5" opacity="0.28"/>
  <!-- 5-petal lotus centred at 52,50 -->
  <g transform="translate(52,50)">
    <path d="M 0,4 C -8,-6 -6,-30 0,-40 C 6,-30 8,-6 0,4 Z" fill="#C9A84C"/>
    <path d="M 0,4 C -8,-6 -6,-30 0,-40 C 6,-30 8,-6 0,4 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
    <path d="M 0,4 C -8,-6 -6,-30 0,-40 C 6,-30 8,-6 0,4 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
    <path d="M 0,4 C -8,-6 -6,-30 0,-40 C 6,-30 8,-6 0,4 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
    <path d="M 0,4 C -8,-6 -6,-30 0,-40 C 6,-30 8,-6 0,4 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
    <circle cx="0" cy="0" r="8" fill="#0D1B3E"/>
    <circle cx="0" cy="0" r="4.5" fill="#C9A84C"/>
  </g>
  <!-- Thin vertical divider -->
  <line x1="110" y1="16" x2="110" y2="84" stroke="#C9A84C" stroke-width="0.8" opacity="0.32"/>
  <!-- Wordmark -->
  <text x="126" y="58" font-family="Georgia, 'Times New Roman', serif" font-size="40" font-weight="700" letter-spacing="-1">
    <tspan fill="white">Siam</tspan><tspan fill="#C9A84C">EPOS</tspan>
  </text>
</svg>
```

### Full Horizontal Logo (Light Background)

Same SVG as above with these two changes:
- `<circle cx="0" cy="0" r="8" fill="#FAFAF8"/>` (centre hollow matches bg)
- Wordmark: `<tspan fill="#0D1B3E">Siam</tspan>` (navy instead of white)

### Icon Mark — Square Badge (All Sizes)

```svg
<!-- Use this SVG for all icon sizes. Scale with width/height attributes. -->
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" stroke-width="1.8"/>
  <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" stroke-width="0.6" opacity="0.28"/>
  <g transform="translate(50,50)">
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
    <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
    <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
  </g>
</svg>
```

**Recommended sizes:** 16px (favicon) · 32px (browser tab) · 48px (app icon small) · 80px (app icon large)  
**Minimum size:** Do not use the icon mark below 16px — the petals become unreadable.  
**Background:** Always place the icon mark on Deep Navy `#0D1B3E` or White `#FFFFFF`.

### Navbar Logo (Lotus badge + Wordmark — SiamEPOS platform)

The SiamEPOS platform navbar uses the lotus badge icon mark alongside the Georgia serif wordmark. Flags were removed in v1.2.

```jsx
{/* Lotus badge icon mark — 32×32px in navbar */}
<svg viewBox="0 0 100 100" style={{ width: 32, height: 32 }}>
  <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8"/>
  <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" strokeWidth="0.6" opacity="0.28"/>
  <g transform="translate(50,50)">
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
    <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
    <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
    <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
  </g>
</svg>

{/* Wordmark */}
<span style={{ fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 700 }}>
  <span style={{ color: 'white' }}>Siam</span>
  <span style={{ color: '#C9A84C' }}>EPOS</span>
</span>
```

---

## 3. Colour Palette

### Primary Brand Colours

| Name | Hex | Usage |
|------|-----|-------|
| **Thai Gold** | `#C9A84C` | Buttons, highlights, accents, logo mark, "EPOS" wordmark |
| **Deep Navy** | `#0D1B3E` | Backgrounds, navbar, headers, logo backgrounds |
| **White** | `#FFFFFF` | Cards, page backgrounds, "Siam" wordmark on dark |
| **Light Grey** | `#F5F5F5` | Page backgrounds, menu grid background |

### Status / Semantic Colours

| Name | Hex | Usage |
|------|-----|-------|
| **Success** | `#22c55e` | Payments confirmed, available tables, positive actions |
| **Warning** | `#f59e0b` | Pending items, amber alerts, starters fired |
| **Danger / Action** | `#ef4444` | Errors, destructive actions |
| **Action Red** | `#e94560` | Primary action buttons (View Bill, Pay), occupied tables |
| **Info** | `#3b82f6` | Mains fired, informational states, bar category highlight |

### Table Status Colour System

| Status | Hex | Description |
|--------|-----|-------------|
| Available | `#22c55e` | Green — table empty |
| Occupied | `#e94560` | Red — table open, no courses fired yet |
| Starters Fired | `#eab308` | Yellow — starters sent to kitchen |
| Starters Done | `#f97316` | Orange — starters served |
| Mains Fired | `#60a5fa` | Light blue — mains sent to kitchen |
| Mains Done | `#0D1B3E` | Navy — mains served |
| Desserts Fired | `#ec4899` | Pink — desserts sent to kitchen |
| Desserts Done | `#6b7280` | Grey — desserts served |
| Bill Printed | `#ffffff` | White — bill has been printed |

---

## 4. Typography

### Typefaces

| Role | Font | Usage |
|------|------|-------|
| **Brand / Headings** | Georgia, serif | Section headings, modal titles, the "Siam" wordmark |
| **Body / UI** | System sans-serif (`system-ui, -apple-system, sans-serif`) | All UI labels, buttons, body text, data |
| **Kitchen Display** | Monospace (`monospace`) | Kitchen timers, large countdown displays |

### Type Rules

- **Minimum font size:** 13px (restaurant lighting condition — staff must read quickly)
- **Kitchen screen minimum:** 18px (read from standing position, 50cm+ away)
- **Wordmark treatment:** "Siam" always white (dark bg) or Deep Navy (light bg) · "EPOS" always Thai Gold
- **Thai text:** Display in Thai Gold `#C9A84C` on dark screens for visibility
- **Never use:** Arial, Roboto, or Inter — they undermine the premium Thai heritage feel

### Font Weight Usage

- `font-weight: 400` — body text, descriptions, secondary info
- `font-weight: 600` — labels, column headers, status text
- `font-weight: 700` — headings, prices, totals, button text, names
- `font-weight: 800` — Total amount on bill, critical numbers

---

## 5. Logo Usage Rules

### ✅ Do

- Place the logo on Deep Navy `#0D1B3E` or White `#FFFFFF` backgrounds
- Maintain clear space of at least 16px around the logo mark on all sides
- Use the light-background version on white/light grey surfaces
- Use the dark-background version on navy/dark surfaces
- Scale the icon mark proportionally — never stretch or squash
- Use the wordmark-only version when the icon mark is already present nearby

### ❌ Do Not

- Do not place the logo on patterned, photographic, or busy backgrounds
- Do not recolour the lotus mark — it must always be Thai Gold `#C9A84C`
- Do not separate "Siam" and "EPOS" — they are one word, one mark
- Do not use emoji flags anywhere in the product (always SVG)
- Do not add drop shadows, glows, or outlines to the logo mark
- Do not use the logo below 32px width (minimum legible size)
- Do not rotate or tilt the logo

---

## 6. UI Component Style Tokens

These values are used consistently across all screens in the SiamEPOS platform.

### Buttons

```javascript
// Primary action button
{
  background: '#e94560',      // Action Red
  color: 'white',
  borderRadius: 12,
  padding: '14px 24px',
  fontWeight: 800,
  fontSize: 16,
  border: 'none'
}

// Secondary / nav button
{
  background: '#1a1a2e',      // Deep Navy variant
  color: 'white',
  borderRadius: 10,
  padding: '10px 18px',
  fontWeight: 700,
  fontSize: 14,
  border: 'none'
}

// Destructive (void, delete)
{
  background: '#fee2e2',
  color: '#ef4444',
  borderRadius: 4,
  padding: '2px 6px',
  fontWeight: 700,
  fontSize: 10,
  border: 'none'
}

// Ghost / outline
{
  background: 'white',
  color: '#e94560',
  border: '2px dashed #e94560',
  borderRadius: 8,
  padding: '10px',
  fontWeight: 700,
  fontSize: 13
}
```

### Cards

```javascript
// Standard white card
{
  background: 'white',
  borderRadius: 14,
  padding: 16,
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  border: '2px solid transparent'   // use accent colour when selected
}

// Kitchen item card — cooking
{
  background: '#0a1628',
  border: '1px solid #1e40af',
  borderRadius: 8,
  color: 'white'
}

// Kitchen item card — pending (unfired)
{
  background: '#fffbeb',
  border: '2px solid #f59e0b',
  borderRadius: 8,
  animation: 'pendingPulse 2s infinite'
}
```

### Navigation

```javascript
// Navbar
{
  background: '#1a1a2e',          // Deep Navy variant
  height: 56,
  borderBottom: '2px solid rgba(201,168,76,0.3)'   // Thai Gold 30%
}

// Active nav link
{
  color: '#C9A84C',               // Thai Gold
  borderBottom: '2px solid #C9A84C'
}
```

### Category Pills / Tags

```javascript
// Active category tab — food
{ background: '#1a1a2e', color: 'white', borderRadius: 20, padding: '10px 20px' }

// Active category tab — bar
{ background: '#1e40af', color: 'white', borderRadius: 20, padding: '10px 20px' }

// Inactive tab
{ background: '#f0f0f0', color: '#555', borderRadius: 20, padding: '10px 20px' }

// Course badge — Starters
{ background: '#3b82f6', color: 'white', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700 }

// Course badge — Mains
{ background: '#e94560', color: 'white', ... }

// Course badge — Desserts
{ background: '#8b5cf6', color: 'white', ... }

// Course badge — Extra
{ background: '#22c55e', color: 'white', ... }
```

---

## 7. Animation Tokens

Only two animations are used in the SiamEPOS platform. Use sparingly — only when an item genuinely needs attention.

```css
/* Pending order item — pulsing amber border */
@keyframes pendingPulse {
  0%, 100% {
    border-color: #f59e0b;
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
  }
  50% {
    border-color: #d97706;
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.15);
  }
}

/* Kitchen pending item — stronger glow for kitchen environment */
@keyframes pendingGlow {
  0%, 100% { border-color: #f59e0b; }
  50% {
    border-color: #fbbf24;
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.5);
  }
}
```

**Animation rules:**
- Duration: 1–2 seconds only
- Never animate more than 2 things simultaneously
- Never animate decoratively — only to signal action required
- Respect `prefers-reduced-motion` in future accessibility updates

---

## 8. Screen-Specific Design Notes

### Kitchen Screen
- Background: `#111111` (near black)
- All text minimum 18px — read from standing position, 50cm away
- Timer colour urgency: Green `< 5 mins` · Amber `5–10 mins` · Red `> 10 mins`
- Language toggle (EN / EN+Thai) always visible top right

### Bar Screen
- Background: `#0a0a1a` (dark navy)
- Item cards: navy blue, large tap targets
- "Serve Table" button: full green when all items ready — must be unmissable

### Order Screen
- Left panel (menu): `#f5f5f5` background grid
- Right panel (order summary): white, `340px` fixed width on desktop
- Mobile: tab-switching layout — Menu tab | Order tab with item count badge
- Pending items: amber pulse animation
- Sent/fired items: no animation, subdued grey

### Table Map
- Grid of colour-coded squares/circles per the Table Status Colour System (Section 3)
- Timer displayed on every occupied table — large and bold
- Status must be readable at a glance from across the restaurant floor

### Bill / Payment Screen
- White modal overlay on semi-transparent dark scrim
- Receipt-style layout — customer may be viewing this
- Payment numpad: large, minimum 60px button height
- Change amount: prominent, green, large font

---

## 9. Bilingual (EN / TH) Guidelines

- Thai text is displayed in **Thai Gold `#C9A84C`** on dark screens
- Thai text is displayed in **Deep Navy `#0D1B3E`** on light screens
- Always leave additional space for Thai text — Thai script runs longer than English equivalents
- Thai name field: `name_alt` in database, `item.name_alt` in frontend
- Language toggle on Kitchen and Bar screens — always visible, top-right position

---

## 10. File & Asset Locations

| Asset | Location |
|-------|----------|
| Frontend source | `/Users/korakot/Desktop/restaurant-epos/src/` |
| App screens | `src/screens/` |
| Shared utilities | `src/utils/` |
| API layer | `src/api.js` |
| Global styles | `src/App.css` |
| Brand CI (this file) | `BRAND_CI.md` (project root) |

**Deployment:**
- Frontend: Netlify → `app.siamepos.co.uk`
- Backend: Railway → `restaurant-epos-production.up.railway.app`
- Marketing site: Netlify → `siamepos.co.uk`

---

## 11. AdminScreen File Structure (v1.2)

AdminScreen is refactored into 17 files as of 8 May 2026.

**Rule: always edit the specific section file. Never edit `AdminScreen.jsx` directly.**

```
src/screens/
  AdminScreen.jsx              ← shell only (~51 lines)
  admin/
    shared.js                  ← shared constants, style tokens, helpers
    TradingSection.jsx
    MenuSection.jsx
    TablePlanSection.jsx
    ReportsSection.jsx
    BillsSection.jsx
    ZReportSection.jsx
    StaffSection.jsx
    AllergenSection.jsx
    SettingsSection.jsx
    inventory/
      InventorySection.jsx     ← inventory tab shell + sub-tab routing
      IngredientsTab.jsx
      RecipesTab.jsx
      StockTab.jsx
      InvoiceScannerTab.jsx    ← AI scanner + Invoice History tabs
      CostSalesTab.jsx
```

**Cost vs Sales label standards (v1.2):**
- `Stock Purchasing Cost` — cost of goods purchased from suppliers
- `Gross Profit (after stock)` — revenue minus stock purchasing cost
- `Net Profit (after all costs)` — gross profit minus all overheads

**Stock Log deleted ingredient styling:**
- Text: `color: '#9ca3af', fontStyle: 'italic'` — grey italic, NOT red
- Badge: small grey pill `background: '#f3f4f6', color: '#4b5563'`
- Rationale: deleted items are historical records, not errors. Red is reserved for voids and critical alerts.

---

*SiamEPOS Brand CI v1.3 — Maintained by Sandy (UI/UX Designer)*  
*Last updated: 10 May 2026*  
*Changes in v1.3: New category positioning per Nick ticket #BP-001 — "EPOS system" → "restaurant management system" throughout. Language rules table added to Section 1. Tagline options documented pending Korakot approval. "EPOS app" descriptor replaced with "SiamEPOS platform."*
