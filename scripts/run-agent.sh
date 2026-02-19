#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OpenClaw Secure — On-Demand Single Agent Run
# Creates a fresh ACI container group, waits for completion, prints logs,
# then cleans up. Designed for one-shot agent executions.
#
# Usage: ./run-agent.sh [mvp0|mvp1|mvp2] [resource-group-name]
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
MVP_LEVEL="${1:-mvp0}"
RESOURCE_GROUP="${2:-rg-openclaw-secure}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! "$MVP_LEVEL" =~ ^(mvp0|mvp1|mvp2)$ ]]; then
  err "Invalid MVP level: $MVP_LEVEL"
  echo "Usage: $0 [mvp0|mvp1|mvp2] [resource-group-name]"
  exit 1
fi

RUN_ID="run-$(date +%s)"
CONTAINER_NAME="openclaw-run-${RUN_ID}"

echo ""
echo -e "${CYAN}${BOLD}=== OpenClaw Secure — On-Demand Agent Run ===${NC}"
echo "MVP Level:      $MVP_LEVEL"
echo "Resource Group: $RESOURCE_GROUP"
echo "Run ID:         $RUN_ID"
echo "Container:      $CONTAINER_NAME"
echo ""

# --------------------------------------------------------------------------
# Resolve ACR details from existing deployment
# --------------------------------------------------------------------------
info "Resolving ACR details from deployment..."

ACR_LOGIN_SERVER=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query 'properties.outputs.acrLoginServer.value' -o tsv 2>/dev/null || echo "")

ACR_NAME_ACTUAL=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query 'properties.outputs.acrName.value' -o tsv 2>/dev/null || echo "")

if [[ -z "$ACR_LOGIN_SERVER" || -z "$ACR_NAME_ACTUAL" ]]; then
  err "Could not resolve ACR details. Is the infrastructure deployed?"
  err "Run: ./scripts/deploy.sh $MVP_LEVEL $RESOURCE_GROUP"
  exit 1
fi

ok "ACR: $ACR_LOGIN_SERVER"

# --------------------------------------------------------------------------
# Create fresh ACI container group (restartPolicy: Never)
# --------------------------------------------------------------------------
info "Creating one-shot container group..."

az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$PROJECT_DIR/infra/aci/container-group.bicep" \
  --parameters "$PROJECT_DIR/infra/aci/parameters.${MVP_LEVEL}.json" \
  --parameters acrLoginServer="$ACR_LOGIN_SERVER" \
    acrName="$ACR_NAME_ACTUAL" \
    proxyImage="${ACR_LOGIN_SERVER}/openclaw-proxy:${MVP_LEVEL}" \
    openclawImage="${ACR_LOGIN_SERVER}/openclaw-agent:${MVP_LEVEL}" \
    containerGroupName="$CONTAINER_NAME" \
    restartPolicy="Never" \
  --output none

ok "Container group '$CONTAINER_NAME' created."

# --------------------------------------------------------------------------
# Wait for completion
# --------------------------------------------------------------------------
info "Waiting for agent to complete (polling every 10s)..."

MAX_WAIT=600  # 10 minutes max
ELAPSED=0

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  STATE=$(az container show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_NAME" \
    --query 'instanceView.state' -o tsv 2>/dev/null || echo "Unknown")

  if [[ "$STATE" == "Succeeded" ]]; then
    ok "Agent completed successfully."
    break
  elif [[ "$STATE" == "Failed" ]]; then
    err "Agent run failed."
    break
  fi

  echo -ne "\r  Status: $STATE (${ELAPSED}s elapsed)..."
  sleep 10
  ((ELAPSED+=10))
done
echo ""

if [[ $ELAPSED -ge $MAX_WAIT ]]; then
  warn "Timed out after ${MAX_WAIT}s. Container state: $STATE"
fi

# --------------------------------------------------------------------------
# Print container logs
# --------------------------------------------------------------------------
info "Fetching container logs..."
echo -e "${BOLD}--- Agent Logs ---${NC}"

az container logs \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_NAME" 2>/dev/null || warn "Could not fetch logs"

echo -e "${BOLD}--- End Logs ---${NC}"
echo ""

# --------------------------------------------------------------------------
# Cleanup: delete the one-shot container group
# --------------------------------------------------------------------------
info "Cleaning up container group '$CONTAINER_NAME'..."
az container delete \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_NAME" \
  --yes \
  --output none 2>/dev/null && ok "Container group deleted." || warn "Could not delete container group"

echo ""
echo -e "${GREEN}${BOLD}=== Agent Run Complete ===${NC}"
echo "Run ID:    $RUN_ID"
echo "Final:     $STATE"
echo "Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
