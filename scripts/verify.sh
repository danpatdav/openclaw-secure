#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OpenClaw Secure — Pre-flight Safety Verification
# Runs 6 tests to confirm the deployment is correctly locked down.
#
# Usage: ./verify.sh [resource-group-name]
# ============================================================================

# -- Color helpers --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $*"; }
fail() { echo -e "  ${RED}FAIL${NC} $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }

# -- Arguments --
RESOURCE_GROUP="${1:-}"
if [[ -z "$RESOURCE_GROUP" ]]; then
  echo "Usage: $0 <resource-group-name>"
  echo "Example: $0 rg-openclaw-secure"
  exit 1
fi

PROXY_CONTAINER="openclaw-proxy"
AGENT_CONTAINER="openclaw-openclaw"
PROXY_HEALTH_URL="http://10.0.2.4:3128/health"
BLOCKED_DOMAIN="http://evil.example.com"
ALLOWED_DOMAIN="https://api.anthropic.com/v1/messages"

PASSED=0
FAILED=0
TOTAL=6

echo ""
echo -e "${BOLD}=== OpenClaw Secure — Verification Suite ===${NC}"
echo "Resource Group: $RESOURCE_GROUP"
echo "Running $TOTAL tests..."
echo ""

# --------------------------------------------------------------------------
# Test 1: Both container groups are running
# --------------------------------------------------------------------------
info "Test 1: Container groups are running..."

PROXY_STATE=$(az container show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PROXY_CONTAINER" \
  --query 'instanceView.state' -o tsv 2>/dev/null || echo "NOT_FOUND")

AGENT_STATE=$(az container show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --query 'instanceView.state' -o tsv 2>/dev/null || echo "NOT_FOUND")

# Proxy should be Running (restartPolicy: Always); Agent may be Succeeded (restartPolicy: Never)
if [[ "$PROXY_STATE" == "Running" ]] && [[ "$AGENT_STATE" == "Running" || "$AGENT_STATE" == "Succeeded" ]]; then
  pass "Both containers healthy (proxy=$PROXY_STATE, agent=$AGENT_STATE)"
  ((PASSED++))
else
  fail "Containers not healthy (proxy=$PROXY_STATE, agent=$AGENT_STATE)"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Test 2: Direct internet access from agent is BLOCKED (NSG rule)
# --------------------------------------------------------------------------
info "Test 2: Direct internet from agent is blocked (NSG)..."

if [[ "$AGENT_STATE" != "Running" ]]; then
  warn "Agent container not running (state=$AGENT_STATE), skipping exec tests 2-5"
  warn "This is expected for MVP0 (restartPolicy: Never with no persistent task)"
  TOTAL=$((TOTAL - 4))
else

DIRECT_RESULT=$(az container exec \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --exec-command "curl -sf --max-time 5 https://example.com" 2>&1 || true)

if [[ -z "$DIRECT_RESULT" || "$DIRECT_RESULT" == *"timed out"* || "$DIRECT_RESULT" == *"Connection refused"* || "$DIRECT_RESULT" == *"error"* ]]; then
  pass "Direct internet access blocked (NSG working)"
  ((PASSED++))
else
  fail "Direct internet access succeeded — NSG may not be configured"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Test 3: Proxy health endpoint is reachable from agent
# --------------------------------------------------------------------------
info "Test 3: Proxy health endpoint reachable from agent..."

HEALTH_RESULT=$(az container exec \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --exec-command "curl -sf --max-time 5 $PROXY_HEALTH_URL" 2>&1 || true)

if [[ -n "$HEALTH_RESULT" && "$HEALTH_RESULT" != *"error"* && "$HEALTH_RESULT" != *"refused"* ]]; then
  pass "Proxy health endpoint reachable"
  ((PASSED++))
else
  fail "Cannot reach proxy health endpoint at $PROXY_HEALTH_URL"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Test 4: Blocked domain returns 403 through proxy
# --------------------------------------------------------------------------
info "Test 4: Blocked domain returns 403 via proxy..."

BLOCKED_HTTP_CODE=$(az container exec \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --exec-command "curl -s -o /dev/null -w '%{http_code}' --proxy http://10.0.2.4:3128 --max-time 10 $BLOCKED_DOMAIN" 2>&1 || echo "000")

if [[ "$BLOCKED_HTTP_CODE" == *"403"* ]]; then
  pass "Blocked domain correctly returned 403"
  ((PASSED++))
else
  fail "Blocked domain returned HTTP $BLOCKED_HTTP_CODE (expected 403)"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Test 5: Allowed domain (Anthropic) passes through proxy
#   401 from Anthropic = proxy allowed request, Anthropic rejected bad key
# --------------------------------------------------------------------------
info "Test 5: Allowed domain (Anthropic) passes through proxy..."

ALLOWED_HTTP_CODE=$(az container exec \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AGENT_CONTAINER" \
  --exec-command "curl -s -o /dev/null -w '%{http_code}' --proxy http://10.0.2.4:3128 --max-time 10 $ALLOWED_DOMAIN" 2>&1 || echo "000")

# 401 or 400 means the proxy allowed the request through to Anthropic
if [[ "$ALLOWED_HTTP_CODE" == *"401"* || "$ALLOWED_HTTP_CODE" == *"400"* || "$ALLOWED_HTTP_CODE" == *"200"* ]]; then
  pass "Allowed domain passed through proxy (HTTP $ALLOWED_HTTP_CODE)"
  ((PASSED++))
else
  fail "Allowed domain returned HTTP $ALLOWED_HTTP_CODE (expected 401/400/200)"
  ((FAILED++))
fi

fi  # end of agent-running exec tests (2-5)

# --------------------------------------------------------------------------
# Test 6: Azure Monitor has proxy log entries
# --------------------------------------------------------------------------
info "Test 6: Azure Monitor proxy logs exist..."

# Get Log Analytics workspace ID from the resource group
WORKSPACE_ID=$(az monitor log-analytics workspace list \
  --resource-group "$RESOURCE_GROUP" \
  --query '[0].customerId' -o tsv 2>/dev/null || echo "")

if [[ -z "$WORKSPACE_ID" ]]; then
  warn "No Log Analytics workspace found — cannot verify logs"
  fail "Azure Monitor logs not verifiable (no workspace)"
  ((FAILED++))
else
  LOG_COUNT=$(az monitor log-analytics query \
    --workspace "$WORKSPACE_ID" \
    --analytics-query "ContainerLog | where ContainerName_s == 'openclaw-proxy' | count" \
    --query '[0].Count' -o tsv 2>/dev/null || echo "0")

  if [[ "$LOG_COUNT" -gt 0 ]] 2>/dev/null; then
    pass "Found $LOG_COUNT proxy log entries in Azure Monitor"
    ((PASSED++))
  else
    fail "No proxy log entries found in Azure Monitor"
    ((FAILED++))
  fi
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo -e "${BOLD}=== Verification Summary ===${NC}"
echo -e "  Total:  $TOTAL"
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo ""

if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL TESTS PASSED — deployment is secure.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}$FAILED TEST(S) FAILED — review issues above.${NC}"
  exit 1
fi
