#!/usr/bin/env bash
# =============================================================================
# SiamEPOS — Finish Akin Thai provisioning
# (provision-client.sh died at `railway up` — a timeout — after the env vars
#  were already set; this completes the remaining steps: owner login,
#  restaurants row [plan: pro], base settings, local secrets file.)
# Run from the repo root in the SAME terminal where `railway link` was done:
#   bash scripts/finish-akinthai-provision.sh
# =============================================================================
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}✔ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✖ $1${NC}"; exit 1; }

SLUG="akin-thai"
NAME="Akin Thai"
DEPLOY_URL="https://siamepos-akin-thai-production.up.railway.app"

command -v railway >/dev/null || err "Railway CLI not found"
railway status 2>/dev/null | grep -qi "$SLUG" || warn "Terminal may not be linked to siamepos-akin-thai — run 'railway link' first if the next step fails"

# ── Pull the secrets this project already carries (stay local, never echoed) ──
VARS=$(railway variables --kv 2>/dev/null) || err "Could not read variables — run 'railway link' and pick siamepos-akin-thai"
AUTH_SECRET=$(echo "$VARS" | grep '^AUTH_SECRET=' | cut -d= -f2-)
SYNC_SECRET=$(echo "$VARS" | grep '^SYNC_SECRET=' | cut -d= -f2-)
JWT_SECRET=$(echo "$VARS"  | grep '^JWT_SECRET='  | cut -d= -f2-)
[ -n "$AUTH_SECRET" ] || err "AUTH_SECRET not found on the service"
[ -n "$SYNC_SECRET" ] || err "SYNC_SECRET not found on the service"
log "Secrets read from Railway (not shown)"

# ── Owner details ─────────────────────────────────────────────────────────────
read -p "Owner email [kinthai.nantwich@gmail.com]: " OWNER_EMAIL
OWNER_EMAIL=${OWNER_EMAIL:-kinthai.nantwich@gmail.com}
read -p "Owner name [J intapad]: " OWNER_NAME
OWNER_NAME=${OWNER_NAME:-J intapad}
read -p "Owner till PIN [2526]: " OWNER_PIN
OWNER_PIN=${OWNER_PIN:-2526}
read -s -p "Owner password (min 8 chars): " OWNER_PASSWORD; echo ""
[ ${#OWNER_PASSWORD} -ge 8 ] || err "Password must be at least 8 characters"

# ── 1. Owner login ───────────────────────────────────────────────────────────
R=$(curl -s -X POST "$DEPLOY_URL/api/auth/set-credentials" \
  -H "Content-Type: application/json" -H "X-Setup-Secret: $AUTH_SECRET" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\",\"name\":\"$OWNER_NAME\",\"pin\":\"$OWNER_PIN\"}")
echo "$R" | grep -q '"id"' && log "Owner login created ($OWNER_EMAIL, PIN $OWNER_PIN)" || warn "set-credentials: $R"

# ── 2. Restaurants row — plan PRO (Korakot: Akin Thai is Pro bundle) ─────────
R=$(curl -s -X POST "$DEPLOY_URL/api/setup/restaurant" \
  -H "Content-Type: application/json" -H "X-Setup-Secret: $AUTH_SECRET" \
  -d "{\"restaurant_id\":\"$SLUG\",\"name\":\"$NAME\",\"plan\":\"pro\",\"email\":\"$OWNER_EMAIL\",\"status\":\"active\"}")
echo "$R" | grep -qE '"id"|"created"|"restaurant_id"' && log "Restaurant row seeded (plan: pro)" || warn "restaurant seed: $R"

# ── 3. Base settings (branding + mock pay until SiamPay keys go on) ──────────
R=$(curl -s -X PUT "$DEPLOY_URL/api/settings" \
  -H "Content-Type: application/json" -H "x-sync-secret: $SYNC_SECRET" \
  -d '{"restaurant_name":"Akin Thai","company_name":"Akin Thai","company_address":"15 Pillory Street, Nantwich, Cheshire CW5 5BZ","company_phone":"01270 421261","takeaway_mock_pay":"1"}')
echo "$R" | grep -qE '"success"|"ok"' && log "Base settings written (mock pay ON until SiamPay)" || warn "settings: $R"

# ── 4. Local secrets file (same convention as provision-client.sh) ───────────
SECRETS_FILE="scripts/.secrets-${SLUG}.txt"
cat > "$SECRETS_FILE" << EOF
# SiamEPOS client secrets — ${NAME}
# Generated: $(date)
# KEEP THIS FILE PRIVATE — do not commit to git
SERVICE_NAME=siamepos-${SLUG}
SUBDOMAIN=${SLUG}.siamepos.co.uk
DEPLOY_URL=${DEPLOY_URL}
OWNER_EMAIL=${OWNER_EMAIL}
PLAN=pro
RESTAURANT_ID=${SLUG}
JWT_SECRET=${JWT_SECRET}
AUTH_SECRET=${AUTH_SECRET}
SYNC_SECRET=${SYNC_SECRET}
EOF
chmod 600 "$SECRETS_FILE"
log "Secrets saved to $SECRETS_FILE"

# ── 5. Verify ────────────────────────────────────────────────────────────────
WHO=$(curl -s "$DEPLOY_URL/api/restaurant" --max-time 10)
echo "$WHO" | grep -q "\"$SLUG\"" && log "Live check: $WHO" || warn "verify: $WHO"
echo ""
log "DONE. Next: Krit loads nothing further here — tell him it finished."
