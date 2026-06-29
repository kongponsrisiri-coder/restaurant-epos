# SiamEPOS — UI/UX Design Brief

**Purpose:** Hand this to a design-focused Claude (or any designer) to improve the look & feel of the SiamEPOS apps. The designer produces the **vision** (mockups + a values spec) — **not code**. A developer (Claude Code) then implements it in the real React components, so the codebase stays clean and on-brand.

> **Output we want back:** annotated mockups/screenshots **+ a values spec** (colours, spacing, font sizes, component states). **Please do NOT output code** — images and specs only. Work **screen by screen** so each can be built and reviewed on the real till before moving on.

---

## 1. Brand
- **Deep Navy** `#0D1B3E` — primary background / chrome
- **Thai Gold** `#C9A84C` — accent (logo, highlights, active states, clock)
- **Action Red** `#e94560` — primary action button (e.g. Log In)
- **Ink** `#1a1a2e` — dark text / headings on light surfaces
- **Wordmark:** "SiamEPOS" in a Georgia serif; "Siam" white, "EPOS" gold
- **Logo:** gold lotus/star badge (per-restaurant logo also shown on receipts)
- Tone: clean, calm, premium-but-practical. It's a working till, not a marketing site.

## 2. Devices & interaction
- **Sunmi T2s till** — 15.6" **landscape**, ~**1583 px** CSS-wide viewport, finger touch.
- Also runs on **tablets** and the **desktop app** (same React UI).
- **Touch-first:** large tap targets (min ~44px), generous spacing, no hover-only affordances, no tiny controls.
- Used in a **busy restaurant** — legibility at a glance and speed matter more than density.

## 3. Tech (what's implementable)
- **React**, styled mostly with **inline styles** + some global `App.css`. No CSS framework.
- So: give spacing/sizes/colours as concrete values. Avoid designs that need heavy new dependencies.
- Receipts/tickets print to **80mm thermal** (32 chars/line) — that layer is separate, not part of this UI brief.

## 4. Screens (priority order for redesign)
1. **Login** (`LoginScreen`) — lotus + wordmark, "tap your name" staff list + PIN pad, Clock (top-right), Clock In/Out, "Sign in with email".
2. **Tables / floor map** (`TableMapScreen`) — table grid with status colours, covers, move/merge.
3. **Order** (`OrderScreen`) — menu category/grid (left) + running cart/order summary (right), modifiers popup, Fire course, View Bill.
4. **Kitchen (KDS)** (`KitchenScreen`) — course-grouped tickets, big readable item text, mark cooking→ready→served.
5. **Bill / Pay** (`BillScreen`) — itemised bill, discounts/service/VAT, payment + change.
6. **Bar** (`BarScreen`), **Counter** (`CounterScreen`), **Reservations** (`ReservationsScreen`).
7. **Admin** (`AdminScreen` + sections: Menu, Settings, Printers, Reports, Z-Report, Staff, Customers, Inventory, etc.) — owner-facing, grouped by workflow.

## 5. Global elements (keep consistent across screens)
- **Top navbar** (navy): logo (left), screen tabs (centre), and right side = **live Clock** (gold time + date) · status badge · staff name · Log out.
- **Clock** — visible on every screen.
- **Offline banner** — a thin amber bar at the very top **only when internet drops** ("orders save on this till and sync…"). Design should leave room for it.
- **Modals/popups** — modifiers, confirm dialogs, discount entry, covers entry. Centred, touch-sized.

## 6. States to cover in mockups
- Online vs **offline** (banner shown; some admin/reservation screens degrade to read-only).
- **Role variations** — waiter vs manager/admin (Admin tab hidden for waiters); dedicated **Kitchen** and **Bar** display logins (no navbar — full-screen KDS).
- Button states: default / pressed / disabled / loading.
- Empty states (no tables open, empty cart, no reservations).

## 7. Hard constraints (don't break)
- Must fit the **1583px landscape** Sunmi without horizontal scroll or overflow.
- **OS-neutral language** — say "your device / till", never "your Mac/iPad".
- Keep the **brand palette** above; gold is an accent, not a flood.
- Don't rely on hover; don't shrink touch targets for density.

---

*Deliver per-screen: a mockup (or a few state variants) + the spec values. The dev will implement, build to the till, and you/we review before the next screen.*
