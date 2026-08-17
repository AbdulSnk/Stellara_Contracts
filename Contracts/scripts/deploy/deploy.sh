#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# deploy.sh
#
# Deployment and governance initialization wrapper for MultisigTreasury.
#
# Usage:
#   ./scripts/deploy/deploy.sh [--network <name>] [--skip-tests]
#
# Configuration (environment variables, see treasury-deploy.js for docs):
#   TREASURY_OWNERS             Comma-separated owner addresses
#   TREASURY_REQUIRED           Base multisig threshold (default: 2)
#   TREASURY_SENSITIVE_REQUIRED Sensitive-action threshold (default: all owners)
#   TREASURY_TIMELOCK_DAYS      Timelock in days, 1-7 (default: 2)
#   TREASURY_THRESHOLD_ETH      Large-transfer threshold in ETH (default: 2)
#   TREASURY_DAILY_LIMIT_ETH    Daily limit in ETH (default: 5)
#   TREASURY_WEEKLY_LIMIT_ETH   Weekly limit in ETH (default: 10)
#
# The script gates deployment on the treasury test suite passing, then
# prints a governance initialization summary and verification steps.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/../.."   # move to Contracts/

NETWORK=""
RUN_TESTS=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="${2:?--network requires a value}"
      shift 2
      ;;
    --skip-tests)
      RUN_TESTS=false
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./scripts/deploy/deploy.sh [--network <name>] [--skip-tests]" >&2
      exit 1
      ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Step 1: Compile ──────────────────────────────────────────────────
info "Compiling Solidity contracts..."
npx hardhat compile

# ── Step 2: Test gate ────────────────────────────────────────────────
if [ "$RUN_TESTS" = true ]; then
  info "Running MultisigTreasury test suite (deployment gate)..."
  if ! npx hardhat test test/MultisigTreasury.test.js; then
    error "Test suite failed — refusing to deploy. Fix tests or use --skip-tests."
    exit 1
  fi
  info "Test suite passed."
else
  warn "Skipping test suite (--skip-tests)."
fi

# ── Step 3: Pre-deploy governance sanity checks ──────────────────────
if [ -n "${TREASURY_OWNERS:-}" ]; then
  OWNER_COUNT=$(echo "$TREASURY_OWNERS" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
  REQUIRED="${TREASURY_REQUIRED:-2}"
  SENSITIVE="${TREASURY_SENSITIVE_REQUIRED:-$OWNER_COUNT}"
  TIMELOCK="${TREASURY_TIMELOCK_DAYS:-2}"

  info "Governance configuration sanity check:"
  echo "  Owners: $OWNER_COUNT | Required: $REQUIRED | Sensitive: $SENSITIVE | Timelock: $TIMELOCK day(s)"
  if [ "$REQUIRED" -le 0 ] || [ "$REQUIRED" -gt "$OWNER_COUNT" ]; then
    error "TREASURY_REQUIRED ($REQUIRED) must be within 1..$OWNER_COUNT"
    exit 1
  fi
  if [ "$SENSITIVE" -lt "$REQUIRED" ] || [ "$SENSITIVE" -gt "$OWNER_COUNT" ]; then
    error "TREASURY_SENSITIVE_REQUIRED ($SENSITIVE) must be within $REQUIRED..$OWNER_COUNT"
    exit 1
  fi
  if [ "$TIMELOCK" -lt 1 ] || [ "$TIMELOCK" -gt 7 ]; then
    error "TREASURY_TIMELOCK_DAYS ($TIMELOCK) must be between 1 and 7"
    exit 1
  fi
fi

# ── Step 4: Deploy ───────────────────────────────────────────────────
NETWORK_ARGS=()
if [ -n "$NETWORK" ]; then
  NETWORK_ARGS+=(--network "$NETWORK")
fi

info "Deploying MultisigTreasury${NETWORK:+ to $NETWORK}..."
npx hardhat run scripts/deploy/treasury-deploy.js "${NETWORK_ARGS[@]}"

# ── Step 5: Verification commands ────────────────────────────────────
echo ""
info "Post-deploy verification (replace <ADDRESS> with the deployed address):"
echo "  # Owners and thresholds"
echo "  npx hardhat console --network ${NETWORK:-hardhat}"
echo "  # const t = await ethers.getContractAt('MultisigTreasury', '<ADDRESS>');"
echo "  # (await t.getOwners()).length        // owner count"
echo "  # (await t.required())                // base threshold"
echo "  # (await t.sensitiveRequired())       // sensitive-action threshold"
echo "  # (await t.timelockDelay())           // seconds (1-7 days)"
echo "  # (await t.threshold())               // large-transfer threshold (wei)"
echo ""
info "Deployment complete."
