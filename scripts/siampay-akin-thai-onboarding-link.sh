#!/bin/bash
# SiamPay — Akin Thai onboarding RESCUE (run by Korakot via `!`).
#
# Their connected account (acct_1U2wLtHd6lHQpKgM) is an abandoned shell:
# all 7 requirements outstanding, ToS never accepted. This script:
#   1. PRE-FILLS everything the platform legitimately knows — website,
#      industry (MCC 5812 restaurant), product description, support phone
#      (read from the tenant's own Railway env), display name — so the
#      owner's remaining form is ONLY identity + bank + Accept.
#   2. Mints a FRESH onboarding link (the 10 Aug one is long expired)
#      and prints it for Korakot to send to the owner himself.
# Nothing sensitive is printed; keys never leave this machine.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCT="acct_1U2wLtHd6lHQpKgM"
KEYS="$HOME/Library/Application Support/SiamEPOS Control Room/.infra-keys"
[ -f "$KEYS" ] || { echo "✗ .infra-keys not found"; exit 1; }
# shellcheck disable=SC1090
source "$KEYS"
: "${PLATFORM_STRIPE_SECRET_KEY:?missing from .infra-keys}"
case "$PLATFORM_STRIPE_SECRET_KEY" in sk_live_*) ;; *) echo "✗ not the live platform key"; exit 1;; esac

echo "→ reading the tenant's phone number from Railway…"
PHONE=$(railway variables --kv 2>/dev/null | grep '^RESTAURANT_PHONE=' | cut -d= -f2- || true)
echo "  support phone: ${PHONE:-'(none on tenant — skipping)'}"

echo "→ pre-filling the account profile (website / MCC / description / name)…"
PREFILL=(-d "business_profile[url]=https://akinthai.co.uk"
         -d "business_profile[mcc]=5812"
         -d "business_profile[name]=Akin Thai"
         -d "business_profile[product_description]=Thai restaurant — online takeaway orders via our own website")
[ -n "${PHONE:-}" ] && PREFILL+=(-d "business_profile[support_phone]=${PHONE}")
HTTP=$(curl -s -o /tmp/siampay-prefill.json -w "%{http_code}" -m 20 \
  "https://api.stripe.com/v1/accounts/${ACCT}" \
  -u "${PLATFORM_STRIPE_SECRET_KEY}:" "${PREFILL[@]}")
if [ "$HTTP" != "200" ]; then
  # Newer Express controller accounts only let the OWNER's onboarding flow set
  # these fields — the platform gets a 403. Fine: the hosted form asks anyway.
  echo "  (pre-fill not permitted on this account type — the owner's form will collect these; continuing)"
else
  echo "  ✓ profile pre-filled"
fi

echo "→ minting a fresh onboarding link…"
HTTP=$(curl -s -o /tmp/siampay-link.json -w "%{http_code}" -m 20 \
  "https://api.stripe.com/v1/account_links" \
  -u "${PLATFORM_STRIPE_SECRET_KEY}:" \
  -d "account=${ACCT}" \
  -d "type=account_onboarding" \
  -d "refresh_url=https://akinthai.co.uk" \
  -d "return_url=https://akinthai.co.uk")
if [ "$HTTP" != "200" ]; then
  echo "✗ link failed (HTTP $HTTP):"; python3 -c "import json;print(json.load(open('/tmp/siampay-link.json')).get('error',{}).get('message','?'))"
  exit 1
fi
LINK=$(python3 -c "import json;print(json.load(open('/tmp/siampay-link.json'))['url'])")
rm -f /tmp/siampay-prefill.json /tmp/siampay-link.json

echo ""
echo "✅ Send this to the Akin Thai owner (valid for a limited time — use soon):"
echo ""
echo "   $LINK"
echo ""
echo "   What's left for them: confirm identity (representative), add their"
echo "   bank account for payouts, and tap Accept at the end. ~3 minutes."
echo "   When done, the account flips to Enabled — then run:"
echo "   bash scripts/siampay-wire-akin-thai.sh"
