#!/usr/bin/env bash
# =============================================================================
# SiamEPOS — Client Provisioning Script
# Usage: ./scripts/provision-client.sh
#
# Provisions a new SiamEPOS client with:
#   - Their own Railway service + Postgres DB (created manually in dashboard)
#   - Environment variables set via Railway CLI
#   - Owner email login (set-credentials)
#   - Plan set in the restaurants table
#
# Requires: Railway CLI v4+ — run `railway login` first
# =============================================================================

set -e

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}✔ $1${NC}"; }
info() { echo -e "${CYAN}→ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✖ $1${NC}"; exit 1; }
step() { echo -e "\n${BOLD}$1${NC}"; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║      SiamEPOS — New Client Provisioner       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Collect inputs ─────────────────────────────────────────────────────────
read -p "Restaurant name (e.g. Baan Siam):          " RESTAURANT_NAME
read -p "Client slug — no spaces (e.g. baan-siam):  " SLUG
read -p "Owner email:                                " OWNER_EMAIL
read -p "Owner password (min 8 chars):               " -s OWNER_PASSWORD
echo ""
read -p "Owner name:                                 " OWNER_NAME
read -p "Owner till PIN (4-6 digits, blank=auto):    " OWNER_PIN
echo ""
echo "Plan options: lite_booking | lite_ordering | lite_bundle | pro"
read -p "Plan:                                       " PLAN
read -p "Restaurant address (for Stuart/emails):     " RESTAURANT_ADDRESS
read -p "Restaurant phone:                           " RESTAURANT_PHONE
read -p "Restaurant email (public-facing):           " RESTAURANT_EMAIL

# Validate slug
if [[ ! "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  err "Slug must be lowercase letters, numbers and hyphens only (e.g. baan-siam)"
fi

# Validate owner PIN (optional — blank lets the backend auto-allocate a free one)
if [[ -n "$OWNER_PIN" && ! "$OWNER_PIN" =~ ^[0-9]{4,6}$ ]]; then
  err "Owner till PIN must be 4-6 digits (or left blank)"
fi

# Validate plan
case "$PLAN" in
  lite_booking|lite_ordering|lite_bundle|pro) ;;
  *) err "Plan must be one of: lite_booking, lite_ordering, lite_bundle, pro" ;;
esac

SERVICE_NAME="siamepos-${SLUG}"
SUBDOMAIN="${SLUG}.siamepos.co.uk"

echo ""
info "Provisioning: ${RESTAURANT_NAME}"
info "Service:      ${SERVICE_NAME}"
info "Subdomain:    ${SUBDOMAIN}"
info "Plan:         ${PLAN}"

# ── 2. Check Railway CLI ──────────────────────────────────────────────────────
if ! command -v railway &> /dev/null; then
  err "Railway CLI not found. Install: npm install -g @railway/cli then run: railway login"
fi

info "Checking Railway login..."
railway whoami &> /dev/null || err "Not logged in to Railway. Run: railway login"
log "Railway CLI ready"

# ── 3. Generate secrets ───────────────────────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
SYNC_SECRET=$(openssl rand -hex 32)
UNSUB_SECRET=$(openssl rand -hex 32)   # HMAC for unsubscribe links (insecure default otherwise)
log "Secrets generated"

# ── 4. Manual Railway dashboard steps ────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║           MANUAL STEP — DO THIS IN RAILWAY DASHBOARD            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  1. Go to railway.com → your SiamEPOS project                   ║"
echo "║  2. Click '+ New' → 'Empty Service'                             ║"
printf "║     Name it exactly: %-45s║\n" "${SERVICE_NAME}"
echo "║  3. In that service → click '+ New' → 'Database' → PostgreSQL   ║"
echo "║     (DATABASE_URL is auto-set — no action needed)               ║"
echo "║  4. In that service → Settings → Source → connect to GitHub     ║"
echo "║     repo: restaurant-epos, branch: main                         ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
read -p "Press ENTER once you've created the service and Postgres DB in Railway..."

# ── 5. Link CLI to the new service ───────────────────────────────────────────
info "Linking Railway CLI to service ${SERVICE_NAME}..."
echo "   (A prompt will appear — select your project and the '${SERVICE_NAME}' service)"
echo ""
railway link
log "Railway CLI linked"

# ── 6. Set environment variables ─────────────────────────────────────────────
info "Setting environment variables on ${SERVICE_NAME}..."

# Railway CLI v4 takes each var as a separate --set flag (the old positional
# `railway variables set KEY=val …` form was removed). TZ=Europe/London is
# essential — Railway containers default to UTC and HH:MM booking-slot checks
# come out 1h off during BST without it.
railway variables \
  --set "NODE_ENV=production" \
  --set "TZ=Europe/London" \
  --set "RESTAURANT_ID=$SLUG" \
  --set "RESTAURANT_NAME=$RESTAURANT_NAME" \
  --set "RESTAURANT_EMAIL=$RESTAURANT_EMAIL" \
  --set "RESTAURANT_ADDRESS=$RESTAURANT_ADDRESS" \
  --set "RESTAURANT_PHONE=$RESTAURANT_PHONE" \
  --set "JWT_SECRET=$JWT_SECRET" \
  --set "AUTH_SECRET=$AUTH_SECRET" \
  --set "SYNC_SECRET=$SYNC_SECRET" \
  --set "UNSUB_SECRET=$UNSUB_SECRET" \
  --set "PUBLIC_API_URL=https://${SUBDOMAIN}" \
  --set "STUART_ENV=production" \
  --set "DELIVEROO_ENV=production" \
  --set "UBER_DIRECT_ENV=production"

log "Environment variables set"

# Verify the critical RESTAURANT_ID actually registered. Without it the
# deployment defaults to 'siamepos' and the admin can't see widget bookings
# (they get tagged with the right slug but the admin filter falls back to
# the env). This caught us once on Baan Siam — don't ship without it.
if railway variables 2>/dev/null | grep -E "RESTAURANT_ID.*${SLUG}" -q; then
  log "Verified RESTAURANT_ID=${SLUG} on the Railway service"
else
  warn "Could NOT confirm RESTAURANT_ID=${SLUG} on the service."
  warn "Set it manually before continuing:"
  warn "  railway variables --set RESTAURANT_ID=${SLUG}"
  read -p "Press ENTER once it is set..."
fi

# ── 7. Deploy ─────────────────────────────────────────────────────────────────
info "Deploying codebase..."
railway up --detach
log "Deployment triggered — Railway will build in ~2-3 minutes"

# ── 8. Wait for deployment ────────────────────────────────────────────────────
echo ""
info "Waiting for deployment..."
echo "   Watch Railway dashboard for the green ✓ deploy status"
echo ""
read -p "Paste the Railway service URL once deployed (e.g. https://xxx.up.railway.app): " DEPLOY_URL

# Strip trailing slash
DEPLOY_URL="${DEPLOY_URL%/}"

# Health check
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${DEPLOY_URL}/api/health" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  log "Service is live at ${DEPLOY_URL}"
else
  warn "Health check returned ${HTTP_STATUS} — service may still be starting, continuing anyway"
fi

# ── 9. Seed owner credentials ─────────────────────────────────────────────────
info "Creating owner login (${OWNER_EMAIL})..."

SEED_RESPONSE=$(curl -s -X POST "${DEPLOY_URL}/api/auth/set-credentials" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: ${AUTH_SECRET}" \
  -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\",\"name\":\"${OWNER_NAME}\",\"pin\":\"${OWNER_PIN}\"}")

if echo "$SEED_RESPONSE" | grep -q '"id"'; then
  # The backend echoes the PIN it actually set (the one we sent, or an
  # auto-allocated free one). The owner needs this to log into the till.
  ASSIGNED_PIN=$(echo "$SEED_RESPONSE" | sed -n 's/.*"pin":"\([0-9]*\)".*/\1/p')
  log "Owner login created — till PIN: ${ASSIGNED_PIN:-<see response>}"
else
  warn "set-credentials returned: ${SEED_RESPONSE}"
  warn "You may need to run this manually once the service is live"
fi

# ── 10. Seed restaurants row ──────────────────────────────────────────────────
info "Seeding restaurants row (plan: ${PLAN})..."

RESTAURANTS_RESPONSE=$(curl -s -X POST "${DEPLOY_URL}/api/setup/restaurant" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: ${AUTH_SECRET}" \
  -d "{
    \"restaurant_id\": \"${SLUG}\",
    \"name\": \"${RESTAURANT_NAME}\",
    \"plan\": \"${PLAN}\",
    \"email\": \"${OWNER_EMAIL}\",
    \"status\": \"active\"
  }")

if echo "$RESTAURANTS_RESPONSE" | grep -q '"id"\|"created"\|"restaurant_id"'; then
  log "Restaurant row seeded (restaurant_id: ${SLUG}, plan: ${PLAN})"
else
  warn "Restaurant seed returned: ${RESTAURANTS_RESPONSE}"
  warn "You may need to add the restaurants row manually in the DB"
fi

# ── 10b. Verify the LIVE deployment resolves to the right RESTAURANT_ID ──────
# This is the real safety net: GET /api/restaurant uses the env-resolved
# restaurant_id to look up the registry row. If the env didn't take, the
# slug we just seeded won't be returned — fix it now, not in production.
info "Verifying the live deployment identifies as '${SLUG}'..."
WHO_AM_I=$(curl -s "${DEPLOY_URL}/api/restaurant" --max-time 10 2>/dev/null)
RETURNED_ID=$(echo "$WHO_AM_I" | sed -n 's/.*"restaurant_id"[^"]*"\([^"]*\)".*/\1/p')
if [ "$RETURNED_ID" = "$SLUG" ]; then
  log "Live deployment correctly identifies as '${SLUG}'"
else
  warn "Deployment returned restaurant_id='${RETURNED_ID}' (expected '${SLUG}')"
  warn "Widget bookings will be INVISIBLE in the admin until this is fixed."
  warn "Fix:"
  warn "  railway variables --set RESTAURANT_ID=${SLUG}"
  warn "  Then trigger a redeploy from the Railway dashboard."
fi

# ── 11. Seed menu categories — copied from main system ───────────────────────
info "Fetching categories from main system..."
MAIN_CATS=$(curl -s "https://restaurant-epos-production.up.railway.app/api/categories")

if echo "$MAIN_CATS" | grep -q '"name"'; then
  log "Fetched categories from main system"
  CATS_RESPONSE=$(curl -s -X POST "${DEPLOY_URL}/api/setup/seed-categories" \
    -H "Content-Type: application/json" \
    -H "X-Setup-Secret: ${AUTH_SECRET}" \
    -d "{\"categories\": ${MAIN_CATS}}")
  if echo "$CATS_RESPONSE" | grep -q '"seeded"\|"skipped"'; then
    log "Menu categories seeded (copied from main system)"
  else
    warn "Category seed returned: ${CATS_RESPONSE}"
  fi
else
  warn "Could not fetch categories from main system. Got: ${MAIN_CATS}"
  warn "Seed manually after deploy: POST ${DEPLOY_URL}/api/setup/seed-categories"
fi

# ── 12. Print DNS + summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║               NAMECHEAP DNS — ADD THIS CNAME                    ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf "║  Type:  CNAME                                                    ║\n"
printf "║  Host:  %-57s║\n" "${SLUG}"
printf "║  Value: %-57s║\n" "(the .up.railway.app URL from Railway dashboard)"
printf "║  TTL:   Automatic                                                ║\n"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  In Railway: service → Settings → Domains → Add Custom Domain   ║"
printf "║  Enter: %-57s║\n" "${SUBDOMAIN}"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                    PROVISIONING COMPLETE ✅                      ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
printf "║  Restaurant:  %-51s║\n" "$RESTAURANT_NAME"
printf "║  URL:         %-51s║\n" "https://${SUBDOMAIN} (after DNS)"
printf "║  Temp URL:    %-51s║\n" "$DEPLOY_URL"
printf "║  Owner:       %-51s║\n" "$OWNER_EMAIL"
printf "║  Plan:        %-51s║\n" "$PLAN"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  NEXT STEPS:                                                     ║"
echo "║  1. Add CNAME in Namecheap (see above)                           ║"
echo "║  2. Add custom domain in Railway → Settings → Domains            ║"
echo "║  3. Add BREVO_API_KEY in Railway env vars for email              ║"
echo "║  4. Add STRIPE_WEBHOOK_SECRET when Stripe billing is ready       ║"
printf "║  5. Test login at %-48s║\n" "${DEPLOY_URL}"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Save secrets to a local file for reference
SECRETS_FILE="scripts/.secrets-${SLUG}.txt"
cat > "$SECRETS_FILE" << EOF
# SiamEPOS client secrets — ${RESTAURANT_NAME}
# Generated: $(date)
# KEEP THIS FILE PRIVATE — do not commit to git

SERVICE_NAME=${SERVICE_NAME}
SUBDOMAIN=${SUBDOMAIN}
DEPLOY_URL=${DEPLOY_URL}
OWNER_EMAIL=${OWNER_EMAIL}
PLAN=${PLAN}
RESTAURANT_ID=${SLUG}

JWT_SECRET=${JWT_SECRET}
AUTH_SECRET=${AUTH_SECRET}
SYNC_SECRET=${SYNC_SECRET}
EOF
chmod 600 "$SECRETS_FILE"
log "Secrets saved to ${SECRETS_FILE} (keep private)"
