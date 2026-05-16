#!/usr/bin/env bash
# release.sh — cut a new version and let CI publish it.
#
# Usage:
#   ./scripts/release.sh patch     # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor     # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major     # 0.1.0 -> 1.0.0
#   ./scripts/release.sh 0.3.2     # exact version
#
# What it does:
#   1. Verifies working tree is clean and you're on main.
#   2. Runs `npm version <bump>` — bumps package.json, creates a `vX.Y.Z` tag.
#   3. Pushes the commit + tag.
#   4. The `.github/workflows/publish.yml` action runs `npm publish` from the tag.
#
# What it does NOT do:
#   - Build / test (this package has no build step and no test suite).
#   - Publish directly. CI does that, so a leaked local token is never enough.

set -euo pipefail

BUMP="${1:-}"
if [[ -z "$BUMP" ]]; then
  echo "usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 1
fi

# Working tree clean?
if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree has uncommitted changes — commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# On main?
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "on branch '$branch' — release from main. Switch branches or pass --force-branch (not implemented; just switch)." >&2
  exit 1
fi

# Up to date with origin?
git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "main is not in sync with origin/main. Pull or push before releasing." >&2
  exit 1
fi

echo "bumping version ($BUMP)…"
new_version="$(npm version "$BUMP" -m "release: v%s")"
echo "tagged $new_version"

echo "pushing commit + tag…"
git push --follow-tags origin main

echo
echo "done. GitHub Actions will publish $new_version to npm."
echo "watch: https://github.com/natekettles/$(basename "$(git rev-parse --show-toplevel)")/actions"
