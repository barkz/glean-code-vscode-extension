#!/usr/bin/env bash
#
# Install the Glean Code extension from the latest GitHub release.
#
# Needs no clone, no Node and no build — it downloads the prebuilt .vsix and
# hands it to whichever editors it finds.
#
#   curl -fsSL https://raw.githubusercontent.com/barkz/glean-code-vscode-extension/main/get.sh | bash
#
# Options (when run as a file rather than piped):
#   ./get.sh --editor code     install into one editor instead of all found
#   ./get.sh --tag v0.2.4      install a specific release instead of the latest
#   ./get.sh --keep            leave the downloaded .vsix in the working directory
#   ./get.sh --uninstall
#
# Piping into bash runs a script you have not read. To read it first:
#   curl -fsSL .../get.sh -o get.sh && less get.sh && bash get.sh
#
set -euo pipefail

REPO="barkz/glean-code-vscode-extension"
EXT_ID="barkz.glean-code-bridge"
CLI_REPO="barkz/glean-code-cli"

EDITOR_FILTER=""
TAG="latest"
KEEP=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --editor) EDITOR_FILTER="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) awk 'NR>2 && /^#/ {sub(/^# ?/, ""); print; next} NR>2 {exit}' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- find editors -------------------------------------------------------
# Every VS Code derivative installs a .vsix the same way.
FOUND=()
for candidate in code cursor codium code-insiders windsurf positron; do
  if [[ -n "$EDITOR_FILTER" && "$candidate" != "$EDITOR_FILTER" ]]; then continue; fi
  if command -v "$candidate" >/dev/null 2>&1; then FOUND+=("$candidate"); fi
done

if [[ ${#FOUND[@]} -eq 0 ]]; then
  if [[ -n "$EDITOR_FILTER" ]]; then
    die "'$EDITOR_FILTER' is not on your PATH."
  fi
  die "No VS Code-compatible editor found on your PATH.

Looked for: code, cursor, codium, code-insiders, windsurf, positron.
In VS Code or Cursor, run the 'Shell Command: Install code command in PATH'
command from the palette, then try again."
fi

# ---- uninstall ----------------------------------------------------------
if [[ $UNINSTALL -eq 1 ]]; then
  for ed in "${FOUND[@]}"; do
    bold "removing $EXT_ID from $ed"
    "$ed" --uninstall-extension "$EXT_ID" || warn "$ed could not remove it (not installed?)"
  done
  exit 0
fi

# ---- resolve the release ------------------------------------------------
if [[ "$TAG" == "latest" ]]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

bold "finding the $TAG release of $REPO"
# Parsed with grep/sed rather than jq, which is not installed everywhere.
META=$(curl -fsSL "$API" 2>/dev/null) || die "could not reach the GitHub API. Offline, or the tag does not exist?"
URL=$(printf '%s' "$META" | grep -o '"browser_download_url": *"[^"]*\.vsix"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
VER=$(printf '%s' "$META" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[[ -n "$URL" ]] || die "that release has no .vsix attached."

# ---- download -----------------------------------------------------------
if [[ $KEEP -eq 1 ]]; then
  DEST="$(pwd)/$(basename "$URL")"
else
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  DEST="$TMP/$(basename "$URL")"
fi

bold "downloading $(basename "$URL")"
curl -fsSL -o "$DEST" "$URL" || die "download failed."
SIZE=$(( $(wc -c < "$DEST") / 1024 ))
[[ $SIZE -gt 20 ]] || die "the download looks truncated (${SIZE} KB)."

# ---- install ------------------------------------------------------------
for ed in "${FOUND[@]}"; do
  bold "installing into $ed"
  "$ed" --install-extension "$DEST" --force
done

# ---- the one prerequisite that is not bundled ---------------------------
# The extension ships the Glean Code CLI as a zipapp, but a zipapp still needs
# an interpreter. Checking here turns a confusing first-run error into a
# sentence at install time.
echo
if command -v python3 >/dev/null 2>&1; then
  PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "?")
  bold "python3 found (${PYV}) — the bundled CLI will run"
else
  warn "python3 was not found on your PATH.

The extension bundles the Glean Code CLI, but a bundled zipapp still needs a
Python interpreter (3.9 or newer). Install Python, then reload your editor:
  macOS    already present on current versions, or: brew install python
  Linux    apt install python3   (or your distribution's equivalent)
  Windows  https://www.python.org/downloads/"
fi

echo
bold "installed ${VER:-$TAG} — reload your editor, then open the Glean panel"
printf '    Bundled CLI: https://github.com/%s/releases\n' "$CLI_REPO"
printf '    Uninstall:   curl -fsSL https://raw.githubusercontent.com/%s/main/get.sh | bash -s -- --uninstall\n' "$REPO"
