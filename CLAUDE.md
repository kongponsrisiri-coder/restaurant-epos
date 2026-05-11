# SiamEPOS — Developer Context for Krit (Claude Code Agent)

## Project
Cloud restaurant management system for Thai restaurants in the UK.
Owner: Korakot Kongponsrisiri | info@siamepos.co.uk

## Stack
- Frontend: React + Vite → Netlify (app.siamepos.co.uk)
- Backend: Node.js + Express → Railway
- Database: PostgreSQL (Railway)
- Real-time: Socket.io
- Automation: Make.com

## File Structure
- Backend: src/server.js, src/db/database.js
- Frontend: client/src/
- Screens: client/src/screens/
- Admin sections: client/src/screens/admin/
- API layer: client/src/api.js

## Deployment
- git push → Railway auto-deploys backend, Netlify auto-deploys frontend
- Always commit with a clear message referencing the ticket number

## Critical Coding Rules
- PostgreSQL syntax: $1 $2 params, pool.query()
- Always ADD COLUMN IF NOT EXISTS for any new DB columns
- Always give complete files — never partial snippets
- Test that imports exist before referencing them
- Socket.io: { transports: ['websocket','polling'] }

## Key Settings
- Service charge key: service_charge_rate (not service_charge_percent)
- service_charge_enabled: stored as '1'/'0' string

## AdminScreen Structure (refactored 8 May 2026)
AdminScreen.jsx is a shell only. Always edit the specific section file:
client/src/screens/admin/SettingsSection.jsx
client/src/screens/admin/MenuSection.jsx
client/src/screens/admin/TradingSection.jsx
client/src/screens/admin/ReportsSection.jsx
client/src/screens/admin/BillsSection.jsx
client/src/screens/admin/ZReportSection.jsx
client/src/screens/admin/StaffSection.jsx
client/src/screens/admin/AllergenSection.jsx
client/src/screens/admin/inventory/InventorySection.jsx
client/src/screens/admin/inventory/IngredientsTab.jsx
client/src/screens/admin/inventory/RecipesTab.jsx
client/src/screens/admin/inventory/StockTab.jsx
client/src/screens/admin/inventory/InvoiceScannerTab.jsx
client/src/screens/admin/inventory/CostSalesTab.jsx

## Active Tickets
- SEPOS-021: VAT / Making Tax Digital — HIGH priority
- SEPOS-022: Staff Clock In/Out — MEDIUM priority
