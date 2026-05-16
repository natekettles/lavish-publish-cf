#!/usr/bin/env bash
# install.sh — set up the lavish-publish-cf worker + CLI + Claude Code skills.
#
# Idempotent. Each step detects "already done" and skips. Safe to re-run.
#
# Steps:
#   1. cd worker && npm install
#   2. npx wrangler login (only if not already logged in)
#   3. Create the PAGES KV namespace and patch wrangler.toml
#   4. npx wrangler deploy
#   5. npm install -g . (puts `publish-cf` on your PATH)
#   6. Optionally symlink skill/ and skill-shim/ into ~/.claude/skills/
#
# Env overrides:
#   LAVISH_PUBLISH_CF_DIR  — repo location (default: $(dirname $(dirname $(realpath $0))))
#   SKIP_GLOBAL_CLI=1      — skip step 5 (the global npm install)
#   SKIP_SKILLS=1          — skip step 6 (the Claude Code skill symlinks)

set -euo pipefail

REPO_DIR="${LAVISH_PUBLISH_CF_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKER_DIR="$REPO_DIR/worker"
SKILL_DIR="$REPO_DIR/skill"
SKILL_SHIM_DIR="$REPO_DIR/skill-shim"
SKILLS_HOME="$HOME/.claude/skills"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
warn() { printf "\033[33m%s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$*" >&2; }

ask() {
  local prompt="$1" default="${2:-Y}" reply
  read -r -p "$prompt " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

require() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}

bold "lavish-publish-cf installer"
echo "Repo: $REPO_DIR"
echo

require node
require npm
require git

# ---- step 1: install worker deps -------------------------------------------
bold "Step 1: install worker dependencies"
cd "$WORKER_DIR"
if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
  ok "node_modules already in place — skipping"
else
  npm install
  ok "Installed"
fi
echo

# ---- step 2: wrangler login -------------------------------------------------
bold "Step 2: authenticate with Cloudflare"
if npx --no-install wrangler whoami >/dev/null 2>&1; then
  ok "Already logged in: $(npx --no-install wrangler whoami 2>/dev/null | tail -1)"
else
  warn "Wrangler needs to authenticate. A browser window will open."
  if ask "Run \`npx wrangler login\` now? [Y/n]"; then
    npx wrangler login
  else
    warn "Skipped login. Re-run this script after you've authenticated."
    exit 1
  fi
fi
echo

# ---- step 3: create KV namespace + patch wrangler.toml ----------------------
bold "Step 3: create the PAGES KV namespace"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' "$WRANGLER_TOML"; then
  dim "Creating namespace…"
  ns_output="$(npx wrangler kv namespace create PAGES 2>&1)"
  ns_id="$(printf "%s" "$ns_output" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed -E 's/id = "([a-f0-9]+)"/\1/')"
  if [[ -z "$ns_id" ]]; then
    err "Could not parse KV namespace id from wrangler output:"
    printf "%s\n" "$ns_output" >&2
    exit 1
  fi
  # macOS sed needs the empty -i argument
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$ns_id/" "$WRANGLER_TOML"
  else
    sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/$ns_id/" "$WRANGLER_TOML"
  fi
  ok "Namespace $ns_id wired into wrangler.toml"
else
  ok "wrangler.toml already has a KV namespace id — skipping"
fi
echo

# ---- step 4: deploy ---------------------------------------------------------
bold "Step 4: deploy the worker"
if ask "Run \`npx wrangler deploy\` now? [Y/n]"; then
  npx wrangler deploy
  ok "Deployed"
else
  warn "Skipped deploy. Run \`cd $WORKER_DIR && npx wrangler deploy\` when ready."
fi
echo

# ---- step 5: global CLI install --------------------------------------------
if [[ "${SKIP_GLOBAL_CLI:-0}" != "1" ]]; then
  bold "Step 5: install the publish-cf CLI globally"
  if command -v publish-cf >/dev/null 2>&1; then
    ok "publish-cf already on PATH ($(command -v publish-cf))"
  elif ask "Run \`npm install -g .\` from $WORKER_DIR? [Y/n]"; then
    npm install -g .
    ok "publish-cf installed globally"
  else
    dim "Skipped. You can call it directly: node $WORKER_DIR/cli/index.js …"
  fi
  echo
fi

# ---- step 6: skill symlinks -------------------------------------------------
if [[ "${SKIP_SKILLS:-0}" != "1" ]]; then
  bold "Step 6: register Claude Code skills"
  if [[ -d "$SKILLS_HOME" ]]; then
    for entry in "publish:$SKILL_DIR" "publish-cf:$SKILL_SHIM_DIR"; do
      name="${entry%%:*}"
      src="${entry#*:}"
      link="$SKILLS_HOME/$name"
      if [[ -L "$link" ]]; then
        current="$(readlink "$link")"
        if [[ "$current" == "$src" ]]; then
          ok "$link → $src (already correct)"
          continue
        fi
        warn "$link points elsewhere ($current). Re-pointing."
        ln -sfn "$src" "$link"
        ok "$link → $src (updated)"
      elif [[ -e "$link" ]]; then
        warn "$link exists and is not a symlink. Skipping — move it manually if you want lavish-publish-cf there."
      elif ask "Symlink $link → $src? [Y/n]"; then
        ln -s "$src" "$link"
        ok "$link → $src"
      else
        dim "Skipped $name"
      fi
    done
  else
    dim "~/.claude/skills not found — install Claude Code first if you want skill discovery."
  fi
  echo
fi

# ---- next steps -------------------------------------------------------------
bold "What's next"
echo "  publish-cf --help                  CLI reference"
echo "  /publish cf <source>               via Claude Code, after symlinking the skill"
echo "  /publish loc <source>              same skill, local-only with lavish-axi"
echo
bold "Related projects"
echo "  lavish-themes  https://github.com/natekettles/lavish-themes  (themes/ library)"
echo "  lavish-axi     https://github.com/kunchenguid/lavish-axi     (local editor)"
echo
ok "Install complete."
