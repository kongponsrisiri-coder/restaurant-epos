#!/bin/bash
# SiamPay go-live wiring for AKIN THAI — run by Korakot via `!` (touches
# .infra-keys, which stays local; no key material is ever printed).
#
# What it does:
#   1. Reads the LIVE platform keys from Control Room .infra-keys
#   2. Finds Akin Thai's connected account on the SiamPay platform (matches
#      "akin" in the account's email / business name) and prints ONLY its id
#      + capability flags (details_submitted / charges_enabled / payouts_enabled)
#   3. If charges are enabled: sets the three tenant vars on Railway
#      (PLATFORM_STRIPE_SECRET_KEY / PLATFORM_STRIPE_PUBLISHABLE_KEY /
#      SIAMPAY_ACCOUNT) — the CLI in this repo dir is already linked to
#      siamepos-akin-thai — then redeploys.
#   4. Prints NOTHING sensitive. Krit takes over after: mock-pay off + the
#      go-live payment checkpoint.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS="$HOME/Library/Application Support/SiamEPOS Control Room/.infra-keys"
[ -f "$KEYS" ] || { echo "✗ .infra-keys not found"; exit 1; }
# shellcheck disable=SC1090
source "$KEYS"
: "${PLATFORM_STRIPE_SECRET_KEY:?PLATFORM_STRIPE_SECRET_KEY missing from .infra-keys}"
: "${PLATFORM_STRIPE_PUBLISHABLE_KEY:?PLATFORM_STRIPE_PUBLISHABLE_KEY missing from .infra-keys}"

case "$PLATFORM_STRIPE_SECRET_KEY" in
  sk_live_*) echo "✓ platform key is LIVE mode";;
  *) echo "✗ platform secret is NOT a live key — aborting"; exit 1;;
esac

# Known account — created by siampay-akin-thai-onboarding-link.sh and completed
# by Jaranthon 10 Aug 2026 (shows Enabled in the platform dashboard). Direct
# retrieve beats name-matching: the dashboard lists it under the OWNER'S name,
# not "Akin", so the old search could miss it.
ACCT_ID="acct_1U2wLtHd6lHQpKgM"
echo "→ checking capabilities on ${ACCT_ID}…"
ACCT_INFO=$(curl -s -m 20 "https://api.stripe.com/v1/accounts/${ACCT_ID}" \
  -u "${PLATFORM_STRIPE_SECRET_KEY}:" | python3 -c '
import json, sys
a = json.load(sys.stdin)
if a.get("error"):
    print("ERROR " + a["error"].get("message", "")[:80]); sys.exit(0)
print(f"{a[\"id\"]} details={a.get(\"details_submitted\")} charges={a.get(\"charges_enabled\")} payouts={a.get(\"payouts_enabled\")}")')

echo "  $ACCT_INFO"
case "$ACCT_INFO" in
  ERROR*) echo "✗ Stripe rejected the account lookup — tell Krit"; exit 1;;
esac
echo "$ACCT_INFO" | grep -q "charges=True" || {
  echo "✗ charges NOT enabled yet — onboarding incomplete on Stripe's side; not wiring."; exit 1; }

echo "→ verifying the CLI is linked to siamepos-akin-thai…"
railway status 2>/dev/null | grep -q "siamepos-akin-thai" || {
  echo "✗ railway CLI is not linked to siamepos-akin-thai in this dir"; exit 1; }

echo "→ setting the three tenant variables + redeploying…"
railway variables \
  --set "PLATFORM_STRIPE_SECRET_KEY=${PLATFORM_STRIPE_SECRET_KEY}" \
  --set "PLATFORM_STRIPE_PUBLISHABLE_KEY=${PLATFORM_STRIPE_PUBLISHABLE_KEY}" \
  --set "SIAMPAY_ACCOUNT=${ACCT_ID}" \
  --service siamepos-akin-thai > /dev/null
railway redeploy --service siamepos-akin-thai --yes > /dev/null 2>&1 || railway redeploy --yes > /dev/null

echo "✅ done — account ${ACCT_ID} wired, tenant redeploying."
echo "   Tell Krit to run the payment checkpoint (mock-pay off + verification)."
