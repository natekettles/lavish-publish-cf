#!/usr/bin/env bash
# set-npm-token.sh — pop a native macOS dialog, paste an npm access token, store it in ~/.npmrc.
#
# Uses AppleScript via osascript for a hidden-answer text field. The token never
# appears in the terminal, in chat, or in any temp file.
#
# IMPORTANT: run this from a real Terminal.app (or iTerm) window, NOT via the `!`
# Claude Code bash — that shell doesn't have the GUI context needed for osascript
# to surface the dialog.
#
# Flags:
#   --stdin   read the token from stdin instead of the dialog (for piping / CI)
#   --help    show this help

set -euo pipefail

NPMRC="$HOME/.npmrc"
REGISTRY_LINE='^//registry\.npmjs\.org/:_authToken='

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
esac

TOKEN=""

if [[ "${1:-}" == "--stdin" ]]; then
  if [[ -t 0 ]]; then
    echo "--stdin needs piped input, e.g. echo \$TOKEN | $0 --stdin" >&2
    exit 1
  fi
  IFS= read -r TOKEN || true
else
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "the dialog uses macOS osascript. On other OSes, pipe via --stdin." >&2
    exit 1
  fi

  # AppleScript: hidden-answer dialog. Returns just the entered text on stdout.
  # If the user cancels, osascript exits non-zero — we let `set -e` propagate.
  if ! TOKEN=$(osascript <<'APPLESCRIPT' 2>/dev/null
on run
  set theResult to display dialog "Paste your npm access token" ¬
    with title "Set npm token" ¬
    default answer "" ¬
    with hidden answer ¬
    buttons {"Cancel", "Save"} ¬
    default button "Save" ¬
    cancel button "Cancel"
  return text returned of theResult
end run
APPLESCRIPT
  ); then
    echo "cancelled." >&2
    exit 1
  fi
fi

# Trim whitespace.
TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"

if [[ -z "$TOKEN" ]]; then
  echo "no token entered." >&2
  exit 1
fi

if [[ ! "$TOKEN" =~ ^npm_ ]]; then
  echo "warning: token doesn't start with 'npm_' — continuing anyway" >&2
fi

# Update ~/.npmrc: strip any existing registry authToken line, then append the new one.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if [[ -f "$NPMRC" ]]; then
  grep -Ev "$REGISTRY_LINE" "$NPMRC" > "$TMP" || true
fi
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$NPMRC"
trap - EXIT

echo "wrote token to $NPMRC (mode 0600)"

if user=$(npm whoami 2>&1); then
  echo "logged in as: $user"
else
  echo "token didn't authenticate — npm whoami output:" >&2
  echo "$user" >&2
  exit 1
fi
