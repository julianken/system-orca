#!/usr/bin/env bash
# Phase 7 v1 base-mode regression: replay prior-art STATUS.json into a
# fresh base-mode workflow, assert the v1 contract still holds — top-level
# keys are exactly {meta, stages, feed} (no wave-field leakage).
set -e

REPO_ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
SCO="$REPO_ROOT/bin/system-orca"
HOST="${SYSTEM_ORCA_HOST:-127.0.0.1}"
PORT="${SYSTEM_ORCA_PORT:-8765}"
URL="http://$HOST:$PORT"

"$SCO" up >/dev/null 2>&1 || true

# v1's prior-art STATUS.json may be present (kept locally, gitignored).
STATUS="$REPO_ROOT/prior-art/agentic-bridge/STATUS.json"
if [ ! -f "$STATUS" ]; then
  echo "skip: prior-art STATUS.json not present (locally-gitignored). Skipping with exit 0."
  exit 0
fi

WF=$("$SCO" init --title "v1 base regression" --goal "phase 7 base mode" | head -1)
echo "WF=$WF (base mode)"

# Reuse the v1-shipped replay tool (tracked under tests/).
node "$REPO_ROOT/tests/agentic-bridge-replay.js" "$STATUS" "$WF"

echo
echo "=== assert top-level keys are exactly meta, stages, feed (no wave-field leakage) ==="
KEYS=$(curl -fsS "$URL/api/workflows/$WF" | jq -c 'keys | sort')
EXPECTED='["feed","meta","stages"]'
if [ "$KEYS" = "$EXPECTED" ]; then
  echo "✓ keys match $EXPECTED"
else
  echo "FAIL: keys = $KEYS, expected $EXPECTED"
  exit 1
fi

echo "=== assert stage count matches (7 from STATUS.json) ==="
COUNT=$(curl -fsS "$URL/api/workflows/$WF" | jq '.stages | length')
test "$COUNT" = "7" && echo "✓ 7 stages"

echo "=== assert critic count (3 from STATUS.json) ==="
CRIT=$(curl -fsS "$URL/api/workflows/$WF" | jq '[.stages[] | select(.type=="critic")] | length')
test "$CRIT" = "3" && echo "✓ 3 critics"

echo
echo "BASE REGRESSION PASS"
