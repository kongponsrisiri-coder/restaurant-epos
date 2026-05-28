#!/bin/bash
# ============================================================
#  SiamEPOS — New Restaurant Setup Script (macOS)
#  Run this on the customer's Mac after installing the DMG.
#  Usage: bash setup-siamepos-mac.sh
# ============================================================

set -e

# ── Colours ─────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}================================================${RESET}"
echo -e "${CYAN}${BOLD}   SiamEPOS — New Restaurant Setup${RESET}"
echo -e "${CYAN}${BOLD}================================================${RESET}"
echo ""
echo "This will configure SiamEPOS on this Mac."
echo "You will need 3 values from Korakot before starting."
echo ""

# ── Step 1 — Check SiamEPOS is installed ────────────────────
echo -e "${BOLD}Step 1/5 — Checking requirements...${RESET}"

APP_PATH="/Applications/SiamEPOS.app"
if [ -d "$APP_PATH" ]; then
  echo -e "  ${GREEN}✓${RESET} SiamEPOS app found"
else
  echo -e "  ${YELLOW}⚠${RESET}  SiamEPOS.app not found in /Applications"
  echo -e "      Please install the DMG first, then re-run this script."
  echo ""
  read -p "  Continue anyway? (y/n): " CONTINUE
  if [ "$CONTINUE" != "y" ]; then
    echo "Setup cancelled."
    exit 1
  fi
fi
echo ""

# ── Step 2 — Collect restaurant details ─────────────────────
echo -e "${BOLD}Step 2/5 — Restaurant details${RESET}"
echo -e "  ${YELLOW}(Korakot will give you these 3 values)${RESET}"
echo ""

read -p "  Restaurant ID (e.g. baan-siam): " RESTAURANT_ID
while [ -z "$RESTAURANT_ID" ]; do
  echo -e "  ${RED}✗${RESET} Restaurant ID cannot be empty."
  read -p "  Restaurant ID: " RESTAURANT_ID
done

read -p "  Restaurant Name (e.g. Baan Siam): " RESTAURANT_NAME
while [ -z "$RESTAURANT_NAME" ]; do
  echo -e "  ${RED}✗${RESET} Restaurant name cannot be empty."
  read -p "  Restaurant Name: " RESTAURANT_NAME
done
echo ""

# ── Step 3 — Cloud connection ────────────────────────────────
echo -e "${BOLD}Step 3/5 — Cloud connection${RESET}"
echo ""

read -p "  Cloud API URL (e.g. https://xxx.up.railway.app): " CLOUD_API_URL
while [ -z "$CLOUD_API_URL" ]; do
  echo -e "  ${RED}✗${RESET} Cloud API URL cannot be empty."
  read -p "  Cloud API URL: " CLOUD_API_URL
done

read -p "  Sync Secret (long code from Korakot): " SYNC_SECRET
while [ -z "$SYNC_SECRET" ]; do
  echo -e "  ${RED}✗${RESET} Sync Secret cannot be empty."
  read -p "  Sync Secret: " SYNC_SECRET
done
echo ""

# ── Step 4 — Write config.json ───────────────────────────────
echo -e "${BOLD}Step 4/5 — Writing config...${RESET}"

CONFIG_DIR="$HOME/Library/Application Support/siamepos-electron"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_FILE" <<EOF
{
  "restaurant_name": "$RESTAURANT_NAME",
  "restaurant_id": "$RESTAURANT_ID",
  "cloud_api_url": "$CLOUD_API_URL",
  "sync_secret": "$SYNC_SECRET"
}
EOF

echo -e "  ${GREEN}✓${RESET} Config saved to:"
echo -e "      $CONFIG_FILE"
echo ""

# ── Step 5 — Test connection ─────────────────────────────────
echo -e "${BOLD}Step 5/5 — Testing connection...${RESET}"

HTTP_STATUS=$(curl -s -o /tmp/siamepos_test.json -w "%{http_code}" \
  --max-time 10 \
  "$CLOUD_API_URL/api/menu" 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  # Count menu items if jq is available
  if command -v jq &>/dev/null; then
    ITEM_COUNT=$(jq '[.[].items // [] | length] | add // 0' /tmp/siamepos_test.json 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${RESET} Connected to cloud successfully"
    echo -e "  ${GREEN}✓${RESET} Menu loaded ($ITEM_COUNT items found)"
  else
    echo -e "  ${GREEN}✓${RESET} Connected to cloud successfully"
    echo -e "  ${GREEN}✓${RESET} Menu endpoint responding"
  fi
elif [ "$HTTP_STATUS" = "000" ]; then
  echo -e "  ${RED}✗${RESET} Could not reach $CLOUD_API_URL"
  echo -e "      Check the URL is correct and this Mac has internet access."
  echo -e "      Config was saved — you can retest by opening SiamEPOS."
else
  echo -e "  ${YELLOW}⚠${RESET}  Server replied with status $HTTP_STATUS"
  echo -e "      Config was saved — try opening SiamEPOS to check."
fi

rm -f /tmp/siamepos_test.json
echo ""

# ── Done ─────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}================================================${RESET}"
echo -e "${GREEN}${BOLD}  ✅  SiamEPOS is configured!${RESET}"
echo -e "${CYAN}${BOLD}================================================${RESET}"
echo ""
echo -e "  Launch ${BOLD}SiamEPOS${RESET} from your Applications folder."
echo -e "  On first open it will sync the full menu and staff list."
echo ""
echo -e "  Need help? Contact ${CYAN}info@siamepos.co.uk${RESET}"
echo ""
