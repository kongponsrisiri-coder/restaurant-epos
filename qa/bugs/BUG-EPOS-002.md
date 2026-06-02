## BUG-EPOS-002: POST /api/orders/:id/items → 500 when unit_price missing from payload

**Date:** 2026-06-02
**Project:** Restaurant EPOS
**Severity:** High
**Status:** Open
**Assigned To:** Krit
**Area:** Orders / Menu

**Steps to reproduce:**
1. Create a new order via `POST /api/orders`
2. Add an item via `POST /api/orders/:id/items` with payload:
   ```json
   { "items": [{ "menu_item_id": 1, "quantity": 1, "notes": "" }] }
   ```
   (note: `unit_price` is NOT included in the item)
3. Server returns HTTP 500: `null value in column "unit_price" of relation "order_items" violates not-null constraint`

**Expected:** Server should look up the item price from `menu_items` table and use it — OR return a clean 400 if price is missing
**Actual:** HTTP 500 crash — raw PostgreSQL NOT NULL constraint violation exposed to the client

**Why this matters:**
The server currently trusts the client to send `unit_price`. This is a security risk — a malicious client could send `unit_price: 0.01` for a £20 dish. The server should ALWAYS fetch the authoritative price from `menu_items.price` server-side, using the client-supplied value only as a fallback or ignoring it entirely.

**File(s) to look at:**
- `src/server.js` line ~536 — INSERT into order_items
- `src/server.js` line ~534 — nameRes lookup already queries menu_items — price should be fetched in the same query

**Suggested fix:**
In `POST /api/orders/:id/items`, change:
```js
const nameRes = await client.query('SELECT name FROM menu_items WHERE id = $1', [item.menu_item_id]);
const itemName = nameRes.rows[0]?.name || item.name || 'Unknown item';
```
To:
```js
const menuRes = await client.query('SELECT name, price FROM menu_items WHERE id = $1', [item.menu_item_id]);
const itemName = menuRes.rows[0]?.name || item.name || 'Unknown item';
const unitPrice = menuRes.rows[0]?.price ?? item.unit_price;
if (unitPrice == null) throw new Error(`unit_price missing for menu_item_id ${item.menu_item_id}`);
```
Then use `unitPrice` instead of `item.unit_price` in the INSERT.
