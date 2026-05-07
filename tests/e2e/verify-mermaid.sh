#!/usr/bin/env bash
# Phase 7 mermaid hash check: the vendored mermaid file must match the
# pinned sha256 from MERMAID_VENDOR.md. Tampering or accidental modification
# fails the check.
set -e

REPO_ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
EXPECTED='61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6'
ACTUAL=$(shasum -a 256 "$REPO_ROOT/server/static/vendor/mermaid.min.js" | awk '{print $1}')

if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "✓ mermaid.min.js sha256 matches: $ACTUAL"
else
  echo "FAIL: mermaid.min.js sha256 mismatch"
  echo "  expected: $EXPECTED"
  echo "  actual:   $ACTUAL"
  echo "  Do NOT update the expected hash to silence this — escalate."
  exit 1
fi
