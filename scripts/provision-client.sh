#!/usr/bin/env bash
# =============================================================================
# SiamEPOS — Client Provisioning Script
# Usage: ./scripts/provision-client.sh
#
# Provisions a new SiamEPOS client with:
#   - Their own Railway service + Postgres DB
#   - Subdomain: <slug>.siamepos.co.uk
#   - Owner email login (set-credentials)
#   - Plan set in the restaurants table
#
# Requires: Railway CLI (railway.app/docs/cli) — run `railway login` first
# =============================================================================

set -e

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}✔ $1${NC}"; }
info() { echo -e "${CYAN}→ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✖ $1${NC}"; exit 1; }

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

# Validate slug (lowercase, hyphens only)
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
echo ""

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

# ── 4. Create Railway service ─────────────────────────────────────────────────
info "Creating Railway service: ${SERVICE_NAME}..."

# Link to the SiamEPOS project (uses the current directory's railway.json)
railway service create --name "$SERVICE_NAME" || err "Failed to create Railway service"
log "Railway service created: ${SERVICE_NAME}"

# ── 5. Add Postgres database ──────────────────────────────────────────────────
info "Adding Postgres database..."
railway add --plugin postgresql --service "$SERVICE_NAME" || err "Failed to add Postgres"
log "Postgres database added (DATABASE_URL auto-set by Railway)"

# ── 6. Set environment variables ──────────────────────────────────────────────
info "Setting environment variables..."

railway variables set \
  --service "$SERVICE_NAME" \
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

# ── 7. Deploy the codebase ────────────────────────────────────────────────────
info "Deploying codebase to ${SERVICE_NAME}..."
railway up --service "$SERVICE_NAME" --detach
log "Deployment triggered (Railway will build in ~2-3 minutes)"

# ── 8. Wait for deployment ────────────────────────────────────────────────────
echo ""
info "Waiting for deployment to complete..."
echo "   (checking every 15 seconds — up to 5 minutes)"

DEPLOY_URL=""
for i in {1..20}; do
  sleep 15
  # Get the service URL
  DEPLOY_URL=$(railway service --service "$SERVICE_NAME" --json 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('url',''))" 2>/dev/null || echo "")

  if [ -n "$DEPLOY_URL" ]; then
    # Try hitting the health endpoint
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${DEPLOY_URL}/api/health" 2>/dev/null || echo "000")
    if [ "$HTTP_STATUS" = "200" ]; then
      log "Service is live at ${DEPLOY_URL}"
      break
    fi
  fi
  echo "   Attempt ${i}/20 — still deploying..."
done

if [ -z "$DEPLOY_URL" ]; then
  warn "Could not auto-detect service URL. Get it from Railway dashboard then run step 9 manually."
  read -p "Paste the Railway service URL (e.g. https://xxx.up.railway.app): " DEPLOY_URL
fi

# Strip trailing slash
DEPLOY_URL="${DEPLOY_URL%/}"

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
info "Seeding restaurants registry row (plan: ${PLAN})..."

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

# ── 11. Add custom domain to Railway ─────────────────────────────────────────
info "Adding custom domain ${SUBDOMAIN} to Railway service..."
railway domain add "$SUBDOMAIN" --service "$SERVICE_NAME" || \
  warn "Could not auto-add domain — add ${SUBDOMAIN} manually in Railway → service → Settings → Domains"

# ── 12. Print DNS instructions ────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  NAMECHEAP DNS — ADD THIS                   ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Type:  CNAME                                               ║"
echo "║  Host:  ${SLUG}                                             ║"
echo "║  Value: (copy the Railway-generated domain from dashboard)  ║"
echo "║  TTL:   Automatic                                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Go to: Railway → ${SERVICE_NAME} → Settings → Domains"
echo "  Copy the .up.railway.app URL and use it as the CNAME value"
echo ""

# ── 13. Summary ───────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    PROVISIONING COMPLETE                     ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  Restaurant:  %-46s ║\n" "$RESTAURANT_NAME"
printf "║  Slug:        %-46s ║\n" "$SLUG"
printf "║  Plan:        %-46s ║\n" "$PLAN"
printf "║  URL:         %-46s ║\n" "https://${SUBDOMAIN}"
printf "║  Owner:       %-46s ║\n" "$OWNER_EMAIL"
printf "║  Service:     %-46s ║\n" "$SERVICE_NAME"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  NEXT STEPS:                                                 ║"
echo "║  1. Add CNAME in Namecheap (see above)                       ║"
echo "║  2. Add STRIPE_WEBHOOK_SECRET in Railway when ready          ║"
echo "║  3. Add BREVO_API_KEY if email confirmations needed          ║"
echo "║  4. Test login at https://${SUBDOMAIN}                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
