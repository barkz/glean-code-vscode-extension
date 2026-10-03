#!/usr/bin/env bash
#
# Build and install a Glean Code extension into VS Code and/or Cursor.
#
#   ./install.sh                 # build + install version-2-json-bridge
#   ./install.sh --version 1     # build + install version-1-repl
#   ./install.sh --editor cursor # target one editor instead of all found
#   ./install.sh --package-only  # build the .vsix, don't install it
#   ./install.sh --uninstall
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=2
EDITOR_FILTER=""
PACKAGE_ONLY=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --editor) EDITOR_FILTER="$2"; shift 2 ;;
    --package-only) PACKAGE_ONLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$VERSION" in
  1) DIR="version-1-repl";        EXT_ID="barkz.glean-code-repl" ;;
  2) DIR="version-2-json-bridge"; EXT_ID="barkz.glean-code-bridge" ;;
  *) echo "--version must be 1 or 2" >&2; exit 2 ;;
esac

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- find editors -------------------------------------------------------

EDITORS=()
for cmd in code cursor; do
  if [[ -n "$EDITOR_FILTER" && "$cmd" != "$EDITOR_FILTER" ]]; then continue; fi
  if command -v "$cmd" >/dev/null 2>&1; then EDITORS+=("$cmd"); fi
done

if [[ ${#EDITORS[@]} -eq 0 && $PACKAGE_ONLY -eq 0 ]]; then
  die "No 'code' or 'cursor' command on PATH.
In VS Code run: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'
Or build only:  ./install.sh --package-only"
fi

# ---- uninstall ----------------------------------------------------------

if [[ $UNINSTALL -eq 1 ]]; then
  for ed in "${EDITORS[@]}"; do
    say "Removing $EXT_ID from $ed"
    "$ed" --uninstall-extension "$EXT_ID" || warn "$ed: not installed"
  done
  exit 0
fi

# ---- prerequisites ------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node 18+ is required (not found on PATH)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node 18+ is required (found $(node -v))."
command -v python3 >/dev/null 2>&1 || warn "python3 not found — the extension needs it at runtime."

# ---- build --------------------------------------------------------------

cd "$REPO/$DIR"
say "Installing npm dependencies ($DIR)"
npm install --silent

say "Compiling TypeScript"
npm run --silent compile

say "Packaging .vsix"
rm -rf dist
npm run --silent package >/dev/null

VSIX="$(ls -t dist/*.vsix 2>/dev/null | head -1)"
[[ -n "$VSIX" ]] || die "Packaging produced no .vsix"
say "Built $DIR/$VSIX ($(du -h "$VSIX" | cut -f1))"

if [[ $PACKAGE_ONLY -eq 1 ]]; then
  echo
  echo "Install it manually with:"
  for ed in code cursor; do echo "  $ed --install-extension $REPO/$DIR/$VSIX"; done
  exit 0
fi

# ---- install ------------------------------------------------------------

for ed in "${EDITORS[@]}"; do
  say "Installing into $ed"
  "$ed" --install-extension "$VSIX" --force
done

# ---- runtime check ------------------------------------------------------

echo
say "Checking that the extension will be able to find glean_code"
# Mirrors PythonBridge.resolveSourceRoot() / ReplManager — see CLAUDE.md.
if [[ "$VERSION" == 2 ]]; then SETTING="gleanCodeBridge.cliPath"; else SETTING="gleanCode.cliPath"; fi
FOUND=""
if [[ -n "${GLEAN_CODE_HOME:-}" && ( -d "$GLEAN_CODE_HOME/glean_code" || -f "$GLEAN_CODE_HOME" ) ]]; then
  FOUND="GLEAN_CODE_HOME ($GLEAN_CODE_HOME)"
elif [[ "$VERSION" == 2 ]] && unzip -l "$VSIX" 2>/dev/null | grep 'extension/bundled/glean-code.pyz' >/dev/null; then
  BUNDLED_VER="$(unzip -p "$VSIX" extension/bundled/cli-version.json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || echo unknown)"
  FOUND="the copy bundled in the .vsix (glean_code $BUNDLED_VER)"
elif python3 -c 'import glean_code' 2>/dev/null; then
  FOUND="python3 imports it directly"
elif [[ -f "$HOME/.local/bin/glean" ]]; then
  FOUND="the installed zipapp at ~/.local/bin/glean"
elif [[ -d "$REPO/../glean-code-cli/glean_code" ]]; then
  FOUND="the clone at $(cd "$REPO/.." && pwd)/glean-code-cli"
fi

if [[ -n "$FOUND" ]]; then
  echo "    OK — will resolve via $FOUND"
  echo "    (a '$SETTING' setting, if you have one, takes precedence)"
else
  warn "glean_code not found yet. Do one of:
    - Run 'python3 install.py' in your glean-code-cli checkout
    - Set '$SETTING' in Settings to your checkout
    - Open glean-code-cli as a folder in the same window"
fi

echo
say "Done. Open the panel with Cmd+Alt+G (Ctrl+Alt+G on Windows/Linux)."
