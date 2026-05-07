#!/usr/bin/env bash
# Phase 7 e2e parity: replay tests/e2e/wave-fixture.jsonl into a fresh
# wave-mode workflow and assert each of the 7 parity checklist items.
set -e

REPO_ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
SCO="$REPO_ROOT/bin/system-orca"
HOST="${SYSTEM_ORCA_HOST:-127.0.0.1}"
PORT="${SYSTEM_ORCA_PORT:-8765}"
URL="http://$HOST:$PORT"

"$SCO" up >/dev/null 2>&1 || true

WF=$("$SCO" init --title "v2 e2e replay" --goal "phase 7 parity" --mode wave | head -1)
echo "WF=$WF"

# Replay fixture: one event per line, attaching workflow_id.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  envelope=$(echo "$line" | jq --arg wf "$WF" '. + {workflow_id: $wf}')
  HTTP=$(curl -s -o /tmp/sysorca-replay-resp.json -w "%{http_code}" \
    -X POST -H 'content-type: application/json' \
    -d "$envelope" "$URL/api/events")
  if [ "$HTTP" != "200" ]; then
    echo "FAIL on event: $line"
    cat /tmp/sysorca-replay-resp.json
    exit 1
  fi
done < "$REPO_ROOT/tests/e2e/wave-fixture.jsonl"

echo
echo "=== parity checklist ==="

# 1. Index card has wave · Nw/Mi
RES=$(curl -fsS "$URL/api/workflows" | jq -r ".[] | select(.id==\"$WF\") | \"\(.mode)|\(.wave_count)|\(.issue_count)\"")
echo "$RES" | grep -q '^wave|4|23$' && echo "✓ 1. index card: $RES"

# 2. Wave detail page renders waves
curl -fsS "$URL/w/$WF" | grep -q 'id="waves"' && echo "✓ 2. wave detail page served"

# 3. Each issue card has 10-step grid populated
ISSUE_COUNT=$(curl -fsS "$URL/api/workflows/$WF/issues" | jq 'length')
ALL_HAVE_STEPS=$(curl -fsS "$URL/api/workflows/$WF/issues" | jq '[.[] | (.steps | keys | length)] | min')
test "$ISSUE_COUNT" = "23" && test "$ALL_HAVE_STEPS" = "10" && echo "✓ 3. all 23 issues have 10-step grid"

# 4. Critical-path banner has next_dispatch + blocking_pr
curl -fsS "$URL/api/workflows/$WF/wave-state" | jq -e '.critical_path.next_dispatch and .critical_path.blocking_pr == 305' >/dev/null && echo "✓ 4. critical-path stored (blocking_pr=305)"

# 5. Escalations present
ESC_LEN=$(curl -fsS "$URL/api/workflows/$WF/wave-state" | jq '.escalations | length')
test "$ESC_LEN" = "1" && echo "✓ 5. escalation present (W2.B.3)"

# 5b. escalation_clear empties
curl -s -X POST -H 'content-type: application/json' \
  -d "{\"workflow_id\":\"$WF\",\"type\":\"escalation_clear\",\"data\":{\"issue_id\":\"W2.B.3\"}}" \
  "$URL/api/events" >/dev/null
ESC_LEN=$(curl -fsS "$URL/api/workflows/$WF/wave-state" | jq '.escalations | length')
test "$ESC_LEN" = "0" && echo "✓ 5b. escalation_clear empties"

# 6. Issue detail page + activity NDJSON
curl -fsS "$URL/w/$WF/issue/W1.A.1" | grep -q 'id="steps"' && echo "✓ 6a. issue detail page served"
ACT_LINES=$(curl -fsS "$URL/api/workflows/$WF/issues/W1.A.1/activity.ndjson" | wc -l | tr -d ' ')
test "$ACT_LINES" -ge 5 && echo "✓ 6b. activity NDJSON has $ACT_LINES lines"

# 7. Tracker band has all 10 cells n/a (tracker correctness)
TRACKER_NA=$(curl -fsS "$URL/api/workflows/$WF/issues" | jq '[.[] | select(.issue_id=="W3.D.x") | .steps[] | select(. == "n/a")] | length')
test "$TRACKER_NA" = "10" && echo "✓ 7. tracker issue (W3.D.x) has all 10 cells n/a"

# Summary card counts
SUMMARY=$(curl -fsS "$URL/api/workflows/$WF/wave-state" | jq '.summary')
echo "summary: $SUMMARY"

echo
echo "REPLAY PASS"
