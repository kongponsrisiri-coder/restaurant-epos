#!/bin/bash
# One-off ops update, 18 Sep 2026 — run by Korakot (prompts for ops login; nothing stored).
#   Baan Rao  → plan founder, £59/mo, active, sub_start 2026-09-18
#   Akin Thai → website-hosting fee off (monthly_fee 0) — they use online ordering instead
set -e
OPS=https://ops.siamepos.co.uk
read -p "ops email: " EMAIL
read -s -p "ops password: " PASS; echo
TOKEN=$(curl -s -X POST $OPS/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
unset PASS
[ -n "$TOKEN" ] || { echo "login failed"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

clients=$(curl -s $OPS/api/clients -H "$AUTH")
find_id() { echo "$clients" | python3 -c "
import sys,json; rows=json.load(sys.stdin); rows=rows if isinstance(rows,list) else rows.get('clients',rows)
m=[r for r in rows if '$1'.lower() in (r.get('restaurant_name') or '').lower()]
print(m[0]['id'] if len(m)==1 else '')"; }

BAANRAO=$(find_id "baan rao"); AKIN=$(find_id "akin")
[ -n "$BAANRAO" ] || { echo "Baan Rao card not found (or ambiguous)"; exit 1; }
[ -n "$AKIN" ]    || { echo "Akin card not found (or ambiguous)"; exit 1; }

echo "Baan Rao (id $BAANRAO) → founder £59 active"
curl -s -X PUT $OPS/api/clients/$BAANRAO -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"plan":"founder","monthly_fee":59,"status":"active","sub_start":"2026-09-18"}' | head -c 200; echo
echo "Akin Thai (id $AKIN) → hosting fee off"
curl -s -X PUT $OPS/api/clients/$AKIN -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"monthly_fee":0}' | head -c 200; echo
echo "done — check the MRR tile reads £412"
