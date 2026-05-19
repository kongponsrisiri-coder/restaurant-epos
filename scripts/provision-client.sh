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

railway variables set \
  NODE_ENV=production \
  RESTAURANT_NAME="$RESTAURANT_NAME" \
  RESTAURANT_EMAIL="$RESTAURANT_EMAIL" \
  RESTAURANT_ADDRESS="$RESTAURANT_ADDRESS" \
  RESTAURANT_PHONE="$RESTAURANT_PHONE" \
  JWT_SECRET="$JWT_SECRET" \
  AUTH_SECRET="$AUTH_SECRET" \
  SYNC_SECRET="$SYNC_SECRET" \
  PUBLIC_API_URL="https://${SUBDOMAIN}" \
  STUART_ENV=production \
  DELIVEROO_ENV=production \
  UBER_DIRECT_ENV=production

log "Environment variables set"

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
  -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\",\"name\":\"${OWNER_NAME}\"}")

if echo "$SEED_RESPONSE" | grep -q '"id"'; then
  log "Owner login created"
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

# ── 11. Print DNS + summary ───────────────────────────────────────────────────
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

JWT_SECRET=${JWT_SECRET}
AUTH_SECRET=${AUTH_SECRET}
SYNC_SECRET=${SYNC_SECRET}
EOF
chmod 600 "$SECRETS_FILE"
log "Secrets saved to ${SECRETS_FILE} (keep private)"
