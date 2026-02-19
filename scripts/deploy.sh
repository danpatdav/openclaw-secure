#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OpenClaw Secure — Full Deployment Script
# Deploys infrastructure, builds containers, and launches ACI groups.
#
# Usage: ./deploy.sh [mvp0|mvp1|mvp2] [resource-group-name]
# ============================================================================

# -- Color helpers --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# -- Arguments --
MVP_LEVEL="${1:-mvp0}"
RESOURCE_GROUP="${2:-rg-openclaw-secure}"
LOCATION="eastus2"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! "$MVP_LEVEL" =~ ^(mvp0|mvp1|mvp2)$ ]]; then
  err "Invalid MVP level: $MVP_LEVEL"
  echo "Usage: $0 [mvp0|mvp1|mvp2] [resource-group-name]"
  exit 1
fi

echo ""
echo -e "${CYAN}=== OpenClaw Secure Deployment ===${NC}"
echo "MVP Level:      $MVP_LEVEL"
echo "Resource Group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo "Project Dir:    $PROJECT_DIR"
echo ""

# --------------------------------------------------------------------------
# Step 0: Pre-flight checks
# --------------------------------------------------------------------------
info "[0/5] Pre-flight checks..."

command -v az >/dev/null 2>&1 || { err "Azure CLI (az) not installed. Install: https://aka.ms/install-azure-cli"; exit 1; }
command -v docker >/dev/null 2>&1 || { err "Docker not installed or not in PATH."; exit 1; }
az account show >/dev/null 2>&1 || { err "Not logged into Azure CLI. Run: az login"; exit 1; }

# Verify SOUL.md integrity before deploying
"$PROJECT_DIR/scripts/check-soul-integrity.sh" || { err "SOUL.md integrity check failed. Deployment aborted."; exit 1; }

ok "Pre-flight checks passed."

# --------------------------------------------------------------------------
# Step 1: Create resource group
# --------------------------------------------------------------------------
info "[1/5] Creating resource group '$RESOURCE_GROUP' in '$LOCATION'..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --tags project=openclaw-secure environment=dev mvp="$MVP_LEVEL" \
  --output none

ok "Resource group ready."

# --------------------------------------------------------------------------
# Step 2: Deploy Bicep infrastructure
# --------------------------------------------------------------------------
info "[2/5] Deploying infrastructure via Bicep..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$PROJECT_DIR/infra/main.bicep" \
  --parameters "$PROJECT_DIR/infra/parameters.json" \
  --parameters projectName=openclaw \
  --output none

# Capture deployment outputs
ACR_LOGIN_SERVER=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query 'properties.outputs.acrLoginServer.value' -o tsv)

ACR_NAME_ACTUAL=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query 'properties.outputs.acrName.value' -o tsv)

VAULT_NAME=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name main \
  --query 'properties.outputs.keyVaultName.value' -o tsv)

ok "Infrastructure deployed. ACR=$ACR_LOGIN_SERVER, Vault=$VAULT_NAME"

# --------------------------------------------------------------------------
# Step 3: Build and push Docker images
# --------------------------------------------------------------------------
info "[3/5] Building and pushing container images..."
az acr login --name "$ACR_NAME_ACTUAL"

# Build and push proxy image
info "  Building proxy image..."
docker build -t "${ACR_LOGIN_SERVER}/openclaw-proxy:${MVP_LEVEL}" "$PROJECT_DIR/proxy/"
docker push "${ACR_LOGIN_SERVER}/openclaw-proxy:${MVP_LEVEL}"
ok "  Proxy image pushed."

# Build and push OpenClaw agent image
info "  Building openclaw-agent image..."
docker build -t "${ACR_LOGIN_SERVER}/openclaw-agent:${MVP_LEVEL}" "$PROJECT_DIR/openclaw/"
docker push "${ACR_LOGIN_SERVER}/openclaw-agent:${MVP_LEVEL}"
ok "  Agent image pushed."

# --------------------------------------------------------------------------
# Step 4: Check / prompt for API key in Key Vault
# --------------------------------------------------------------------------
info "[4/5] Checking Key Vault secrets..."
if ! az keyvault secret show --vault-name "$VAULT_NAME" --name "ANTHROPIC-API-KEY" >/dev/null 2>&1; then
  warn "ANTHROPIC_API_KEY not set in Key Vault."
  warn "Run:  az keyvault secret set --vault-name $VAULT_NAME --name ANTHROPIC-API-KEY --value 'sk-...'"
else
  ok "ANTHROPIC_API_KEY already set in Key Vault."
fi

# --------------------------------------------------------------------------
# Step 5: Deploy ACI container groups
# --------------------------------------------------------------------------
info "[5/5] Deploying ACI container groups..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$PROJECT_DIR/infra/aci/container-group.bicep" \
  --parameters "$PROJECT_DIR/infra/aci/parameters.${MVP_LEVEL}.json" \
  --parameters acrLoginServer="$ACR_LOGIN_SERVER" \
    acrName="$ACR_NAME_ACTUAL" \
    proxyImage="${ACR_LOGIN_SERVER}/openclaw-proxy:${MVP_LEVEL}" \
    openclawImage="${ACR_LOGIN_SERVER}/openclaw-agent:${MVP_LEVEL}" \
  --output none

ok "ACI container groups deployed."

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo "Resource Group: $RESOURCE_GROUP"
echo "ACR:            $ACR_LOGIN_SERVER"
echo "Key Vault:      $VAULT_NAME"
echo "MVP Level:      $MVP_LEVEL"
echo ""
echo "Next steps:"
echo "  1. Set API key (if not already done):"
echo "     az keyvault secret set --vault-name $VAULT_NAME --name ANTHROPIC-API-KEY --value 'sk-...'"
echo "  2. Run verification:"
echo "     ./scripts/verify.sh $RESOURCE_GROUP"
echo "  3. Monitor logs:"
echo "     az monitor log-analytics query -w <workspace-id> --analytics-query 'ContainerLog | take 10'"
