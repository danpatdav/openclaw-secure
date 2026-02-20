#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OpenClaw Secure — Kill Switch
# Immediately stops and deletes all ACI container groups.
#
# Usage: ./kill-agent.sh [resource-group-name]
# ============================================================================

# -- Color helpers --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

# -- Arguments --
RESOURCE_GROUP="${1:-rg-openclaw-secure}"

PROXY_CONTAINER="openclaw-proxy"
AGENT_CONTAINER="openclaw-openclaw"

echo ""
echo -e "${RED}${BOLD}=== OpenClaw Secure — KILL SWITCH ===${NC}"
echo "Resource Group: $RESOURCE_GROUP"
echo "Timestamp:      $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# --------------------------------------------------------------------------
# Stop containers
# --------------------------------------------------------------------------
info "Stopping container group: $PROXY_CONTAINER..."
az container stop \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PROXY_CONTAINER" \
  --output none 2>/dev/null && ok "Stopped $PROXY_CONTAINER" || warn "$PROXY_CONTAINER not found or already stopped"

info "Stopping container group: $AGENT_CONTAINER..."
az container stop \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --output none 2>/dev/null && ok "Stopped $AGENT_CONTAINER" || warn "$AGENT_CONTAINER not found or already stopped"

# --------------------------------------------------------------------------
# Delete containers
# --------------------------------------------------------------------------
info "Deleting container group: $PROXY_CONTAINER..."
az container delete \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PROXY_CONTAINER" \
  --yes \
  --output none 2>/dev/null && ok "Deleted $PROXY_CONTAINER" || warn "$PROXY_CONTAINER already deleted"

info "Deleting container group: $AGENT_CONTAINER..."
az container delete \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --yes \
  --output none 2>/dev/null && ok "Deleted $AGENT_CONTAINER" || warn "$AGENT_CONTAINER already deleted"

# --------------------------------------------------------------------------
# Verify deletion (expect errors = success)
# --------------------------------------------------------------------------
info "Verifying deletion..."

PROXY_EXISTS=$(az container show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PROXY_CONTAINER" \
  --query 'name' -o tsv 2>/dev/null || echo "DELETED")

AGENT_EXISTS=$(az container show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --query 'name' -o tsv 2>/dev/null || echo "DELETED")

if [[ "$PROXY_EXISTS" == "DELETED" && "$AGENT_EXISTS" == "DELETED" ]]; then
  ok "Both container groups confirmed deleted."
else
  err "One or more containers may still exist (proxy=$PROXY_EXISTS, agent=$AGENT_EXISTS)"
fi

# --------------------------------------------------------------------------
# Confirmation
# --------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}=== Kill Switch Complete ===${NC}"
echo "All containers stopped and deleted."
echo "Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""
echo "To redeploy: ./scripts/deploy.sh <mvp-level> $RESOURCE_GROUP"
