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

echo "→ searching the SiamPay platform for Akin Thai's connected account…"
ACCOUNTS_JSON=$(curl -s -m 20 "https://api.stripe.com/v1/accounts?limit=100" \
  -u "${PLATFORM_STRIPE_SECRET_KEY}:")

ACCT_INFO=$(STRIPE_JSON="$ACCOUNTS_JSON" python3 - << 'PY'
import json, os, sys
data = json.loads(os.environ["STRIPE_JSON"])
hits = []
for a in data.get("data", []):
    hay = " ".join(filter(None, [
        a.get("email") or "",
        (a.get("business_profile") or {}).get("name") or "",
        ((a.get("settings") or {}).get("dashboard") or {}).get("display_name") or "",
    ])).lower()
    if "akin" in hay:
        hits.append(a)
if not hits:
    print("NONE")
    sys.exit(0)
if len(hits) > 1:
    print("MULTI " + " ".join(h["id"] for h in hits))
    sys.exit(0)
a = hits[0]
print(f"{a['id']} details={a.get('details_submitted')} charges={a.get('charges_enabled')} payouts={a.get('payouts_enabled')}")
PY
)

echo "  $ACCT_INFO"
case "$ACCT_INFO" in
  NONE)  echo "✗ no connected account matching 'akin' — check the ops SiamPay card for the id"; exit 1;;
  MULTI*) echo "✗ more than one match — tell Krit which acct id is right"; exit 1;;
esac

ACCT_ID=$(echo "$ACCT_INFO" | awk '{print $1}')
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
