#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# OpenClaw Secure — SOUL.md Integrity Check
# Computes SHA-256 of openclaw/SOUL.md and compares against stored checksum.
# Ensures the agent's constitution has not been tampered with.
#
# Usage: ./check-soul-integrity.sh
# ============================================================================

# -- Color helpers --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[PASS]${NC}  $*"; }
err()  { echo -e "${RED}[FAIL]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

# -- Paths --
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOUL_FILE="$PROJECT_DIR/openclaw/SOUL.md"
CHECKSUM_FILE="$PROJECT_DIR/.soul-checksum"

# --------------------------------------------------------------------------
# Verify SOUL.md exists
# --------------------------------------------------------------------------
if [[ ! -f "$SOUL_FILE" ]]; then
  err "SOUL.md not found at: $SOUL_FILE"
  err "The agent's constitutional document is missing."
  exit 1
fi

# --------------------------------------------------------------------------
# Compute current SHA-256
# --------------------------------------------------------------------------
if command -v shasum >/dev/null 2>&1; then
  CURRENT_HASH=$(shasum -a 256 "$SOUL_FILE" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  CURRENT_HASH=$(sha256sum "$SOUL_FILE" | awk '{print $1}')
else
  err "Neither shasum nor sha256sum found. Cannot verify integrity."
  exit 1
fi

info "SOUL.md SHA-256: $CURRENT_HASH"

# --------------------------------------------------------------------------
# Compare or create checksum
# --------------------------------------------------------------------------
if [[ ! -f "$CHECKSUM_FILE" ]]; then
  # First run: store the checksum
  echo "$CURRENT_HASH" > "$CHECKSUM_FILE"
  warn "First run — checksum file created: $CHECKSUM_FILE"
  warn "Stored hash: $CURRENT_HASH"
  ok "SOUL.md integrity baseline established."
  exit 0
fi

# Read stored checksum
STORED_HASH=$(cat "$CHECKSUM_FILE" | tr -d '[:space:]')

if [[ "$CURRENT_HASH" == "$STORED_HASH" ]]; then
  ok "SOUL.md integrity verified. Hash matches stored checksum."
  exit 0
else
  err "SOUL.md integrity check FAILED!"
  err "  Expected: $STORED_HASH"
  err "  Actual:   $CURRENT_HASH"
  err ""
  err "SOUL.md has been modified since the last verified deployment."
  err "If this change is intentional, review the diff and update the checksum:"
  err "  git diff openclaw/SOUL.md"
  err "  shasum -a 256 openclaw/SOUL.md | awk '{print \$1}' > .soul-checksum"
  exit 1
fi
