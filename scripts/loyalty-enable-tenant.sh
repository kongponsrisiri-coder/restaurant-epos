#!/bin/bash
# Enable a tenant on the SiamEPOS Loyalty service. Run by Korakot (reads the
# tenant's sync secret from its .secrets file — Krit can't).
#   bash scripts/loyalty-enable-tenant.sh rumwong "Rumwong Thai Restaurant" https://siamepos-rumwong-production.up.railway.app
set -e
SLUG="$1"; NAME="$2"; CLOUD="$3"
[ -n "$SLUG" ] && [ -n "$NAME" ] && [ -n "$CLOUD" ] || { echo "usage: $0 <slug> <name> <cloud_url>"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
SECRET=$(/usr/bin/grep -o '"sync_secret": *"[^"]*"' "$HERE/.secrets-$SLUG-config.txt" | head -1 | /usr/bin/sed 's/.*: *"//; s/"$//')
[ -n "$SECRET" ] || { echo "no sync_secret in scripts/.secrets-$SLUG-config.txt"; exit 1; }
OPS=$(/usr/bin/grep -o 'X-Ops-Key): *[^ ]*' "$HERE/.secrets-loyalty-service.txt" | /usr/bin/sed 's/.*: *//')
L=https://loyalty-api-production-2a81.up.railway.app
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
curl -s -X POST $L/api/ops/tenants -H "X-Ops-Key: $OPS" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"name\":\"$NAME\",\"cloud_url\":\"$CLOUD\",\"sync_secret\":\"$SECRET\",\"status\":\"pilot\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('tenant:', d.get('slug'), d.get('status'), d.get('mode'), 'min £'+str(d.get('min_spend')), d.get('ladder'))"
curl -s -X PUT $L/api/ops/tenants/$SLUG -H "X-Ops-Key: $OPS" -H 'Content-Type: application/json' -d "{\"launch_at\":\"$TODAY\",\"feed_cursor\":\"$TODAY\"}" >/dev/null
curl -s -X POST $L/api/ops/tenants/$SLUG/sync -H "X-Ops-Key: $OPS" | python3 -c "import sys,json; print('first sync:', json.load(sys.stdin))"
curl -s -X POST $L/api/ops/tenants/$SLUG/owner-link -H "X-Ops-Key: $OPS" | python3 -c "import sys,json; print('owner page:', json.load(sys.stdin)['url'])"
echo "customer card: $L/$SLUG"
