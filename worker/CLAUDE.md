# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted clone of htmlship.com running on Cloudflare Workers + KV. Two halves:

- **Worker** (`src/index.ts`) — single-file TypeScript Worker. All routing, storage, rendering, comments, and auth live here.
- **CLI** (`cli/index.js`) — zero-dep Node client (`publish-cf`) that talks to the deployed Worker. Stores per-slug `owner_key` and API base under `~/.publish-cloudflare/`.

Both files are intentionally single-file. Don't split them up "for organization" — the design constraint is keeping the Worker deployable as one module and the CLI installable without `npm install`.

## Commands

Run these from the **repo root** (where `package.json` now lives). Wrangler is invoked with `--config worker/wrangler.toml`.

```bash
npm run dev         # wrangler dev — local Worker on http://localhost:8787 (in-memory KV)
npm run deploy      # wrangler deploy to Cloudflare
npm run tail        # wrangler tail — stream live logs from prod
npm run types       # wrangler types — regenerate worker types

# CLI against local dev server
PUBLISH_CF_API=http://localhost:8787 node worker/cli/index.js publish foo.html
PUBLISH_CF_API=http://localhost:8787 node worker/cli/index.js list-mine
```

`PUBLISH_CF_API` overrides `~/.publish-cloudflare/config.json`. There is no test suite, no linter, and no build step (Wrangler bundles the TS directly).

## Architecture notes

**Routing**: All paths are handled by a single `fetch` export at the bottom of `src/index.ts` using regex matches. Order matters — `/v/:slug/comments` and `/v/:slug/raw` must be matched before `/v/:slug`. When adding routes, add them in the same `fetch` handler, not via any framework.

**Two CSPs, one wrapper-iframe split**:

- `/v/:slug` serves a **wrapper page** (comment sidebar + UI JS) under `WRAPPER_CSP` (allows `'unsafe-inline'` scripts so the comment UI can run).
- `/v/:slug/raw` serves the **user's artifact** under the strict `PAGE_CSP` (`script-src 'none'`), embedded in a same-origin iframe.
- The wrapper never executes anything from the artifact. If you touch CSP or the wrapper HTML, preserve this boundary — the strict CSP on `/raw` is the only thing keeping user-supplied HTML from running scripts.

**KV layout** (`PAGES` namespace):

- `page:<slug>` → `PageRecord` (html, hashes, expiry)
- `comment:<slug>:<id>` → one comment per key, listed via `PAGES.list({ prefix: "comment:<slug>:" })`. One-key-per-comment is deliberate, to avoid lost writes from concurrent commenters.

**Auth model**:

- `owner_key` (CLI side, plaintext `ws_…`) and `password` (viewer side, plaintext) are both stored on the server as SHA-256 hex hashes only. Compare with `timingSafeEqualHex`.
- Viewer cookie `hp_<slug>=ok` (1h) gates `/v/:slug`, `/v/:slug/raw`, and comment read/write for password-protected pages.
- `X-Owner-Key` header gates PATCH/DELETE on pages and comments.

**Comment anchoring**: text-quote selector (quote + ~32 chars prefix/suffix). Comments whose anchor no longer matches after a republish are flagged `orphaned` rather than deleted. Anchor matching logic is in the wrapper page's inline JS (inside `wrapperHtml`), not server-side.

## Conventions

- The Worker has no dependencies beyond `@cloudflare/workers-types`. Don't add runtime deps — use Web Crypto, `fetch`, `Response`, KV directly.
- The CLI has zero runtime deps. Don't add any. It calls the API with plain `fetch` and writes JSON to `~/.publish-cloudflare/` with mode `0600`.
- Limits (`MAX_HTML_BYTES`, `MAX_EXPIRES_MINUTES`, etc.) are declared as top-level consts in `src/index.ts`. Change them there, not inline.
- `wrangler.toml` has a real KV namespace id committed (`15dcacac…`). That's intentional — this is a personal worker, not a template.

## When asked to change behavior

- API surface is documented in `README.md` and is meant to mirror htmlship. If you change request/response shape, update the README table.
- Skill at `~/.claude/skills/publish-cloudflare/SKILL.md` wraps the CLI for Claude Code use. If you rename a CLI command or change its flags, that skill likely needs updating too.
