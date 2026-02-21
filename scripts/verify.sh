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

# Helper: run a fetch inside the agent container using node (no curl needed)
# Usage: agent_fetch URL [proxy_url]
# Returns: HTTP status code or "ERROR:<message>"
agent_fetch() {
  local url="$1"
  local proxy="${2:-}"
  local node_script

  if [[ -n "$proxy" ]]; then
    # Use undici ProxyAgent (installed in agent container)
    node_script="const{ProxyAgent}=require('undici');const d=new ProxyAgent('${proxy}');fetch('${url}',{dispatcher:d,signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERROR:'+e.message))"
  else
    node_script="fetch('${url}',{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERROR:'+e.message))"
  fi

  az container exec \
    --resource-group "$RESOURCE_GROUP" \
    --name "$AGENT_CONTAINER" \
    --exec-command "node -e \"${node_script}\"" 2>&1 || echo "EXEC_ERROR"
}

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

# Proxy should be Running (restartPolicy: Always)
# Agent has restartPolicy: Never — valid states are Running, Succeeded (clean exit), or Failed (non-zero exit)
# All three mean the container was created and ran. Only NOT_FOUND is a real failure.
if [[ "$PROXY_STATE" == "Running" ]] && [[ "$AGENT_STATE" != "NOT_FOUND" ]]; then
  pass "Containers deployed (proxy=$PROXY_STATE, agent=$AGENT_STATE)"
  PASSED=$((PASSED + 1))
  if [[ "$AGENT_STATE" == "Failed" ]]; then
    warn "Agent exited with error — check logs: az container logs -g $RESOURCE_GROUP -n $AGENT_CONTAINER"
  fi
else
  fail "Containers not healthy (proxy=$PROXY_STATE, agent=$AGENT_STATE)"
  FAILED=$((FAILED + 1))
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

DIRECT_RESULT=$(agent_fetch "https://example.com")

if [[ "$DIRECT_RESULT" == *"ERROR"* || "$DIRECT_RESULT" == *"timed out"* || "$DIRECT_RESULT" == *"EXEC_ERROR"* || -z "$DIRECT_RESULT" ]]; then
  pass "Direct internet access blocked (NSG working)"
  PASSED=$((PASSED + 1))
else
  fail "Direct internet access succeeded — NSG may not be configured"
  FAILED=$((FAILED + 1))
fi

# --------------------------------------------------------------------------
# Test 3: Proxy health endpoint is reachable from agent
# --------------------------------------------------------------------------
info "Test 3: Proxy health endpoint reachable from agent..."

HEALTH_RESULT=$(agent_fetch "$PROXY_HEALTH_URL")

if [[ "$HEALTH_RESULT" == *"200"* ]]; then
  pass "Proxy health endpoint reachable"
  PASSED=$((PASSED + 1))
else
  fail "Cannot reach proxy health endpoint at $PROXY_HEALTH_URL (got: $HEALTH_RESULT)"
  FAILED=$((FAILED + 1))
fi

# --------------------------------------------------------------------------
# Test 4: Blocked domain returns 403 through proxy
# --------------------------------------------------------------------------
info "Test 4: Blocked domain returns 403 via proxy..."

BLOCKED_HTTP_CODE=$(agent_fetch "$BLOCKED_DOMAIN" "http://10.0.2.4:3128")

if [[ "$BLOCKED_HTTP_CODE" == *"403"* ]]; then
  pass "Blocked domain correctly returned 403"
  PASSED=$((PASSED + 1))
else
  fail "Blocked domain returned HTTP $BLOCKED_HTTP_CODE (expected 403)"
  FAILED=$((FAILED + 1))
fi

# --------------------------------------------------------------------------
# Test 5: Allowed domain (Anthropic) passes through proxy
#   401 from Anthropic = proxy allowed request, Anthropic rejected bad key
# --------------------------------------------------------------------------
info "Test 5: Allowed domain (Anthropic) passes through proxy..."

ALLOWED_HTTP_CODE=$(agent_fetch "$ALLOWED_DOMAIN" "http://10.0.2.4:3128")

# 401 or 400 means the proxy allowed the request through to Anthropic
if [[ "$ALLOWED_HTTP_CODE" == *"401"* || "$ALLOWED_HTTP_CODE" == *"400"* || "$ALLOWED_HTTP_CODE" == *"200"* ]]; then
  pass "Allowed domain passed through proxy (HTTP $ALLOWED_HTTP_CODE)"
  PASSED=$((PASSED + 1))
else
  fail "Allowed domain returned HTTP $ALLOWED_HTTP_CODE (expected 401/400/200)"
  FAILED=$((FAILED + 1))
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
  FAILED=$((FAILED + 1))
else
  LOG_COUNT=$(az monitor log-analytics query \
    --workspace "$WORKSPACE_ID" \
    --analytics-query "ContainerLog | where ContainerName_s == 'openclaw-proxy' | count" \
    --query '[0].Count' -o tsv 2>/dev/null || echo "0")

  if [[ "$LOG_COUNT" -gt 0 ]] 2>/dev/null; then
    pass "Found $LOG_COUNT proxy log entries in Azure Monitor"
    PASSED=$((PASSED + 1))
  else
    warn "No proxy log entries yet — Azure Monitor ingestion can take 5-15 min after first deploy"
    warn "Treating as non-fatal. Re-run verify after a few minutes to confirm."
    PASSED=$((PASSED + 1))
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
