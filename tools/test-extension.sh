#!/usr/bin/env bash
#
# Run the integration test inside a real VS Code extension host.
#
# The host is detached from this terminal on macOS, so the test writes its
# report to $GLEAN_TEST_OUTPUT and this script prints it and sets the exit code.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$REPO/version-2-json-bridge"

command -v code >/dev/null 2>&1 || {
  echo "error: 'code' is not on PATH." >&2
  echo "In VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'" >&2
  exit 1
}

cd "$EXT"
npm run --silent compile

UD="$(mktemp -d "${TMPDIR:-/tmp}/glean-ud-XXXXXX")"
REPORT="$(mktemp "${TMPDIR:-/tmp}/glean-report-XXXXXX")"
trap 'rm -rf "$UD" "$REPORT"' EXIT

GLEAN_TEST_OUTPUT="$REPORT" code --wait \
  --extensionDevelopmentPath="$EXT" \
  --extensionTestsPath="$EXT/out/test/index.js" \
  --user-data-dir="$UD" \
  --disable-extensions \
  --disable-workspace-trust >/dev/null 2>&1 || true

if [[ ! -s "$REPORT" ]]; then
  echo "error: the extension host produced no report — it likely failed to start." >&2
  exit 1
fi

cat "$REPORT"
grep -q -- "--- PASS ---" "$REPORT"
