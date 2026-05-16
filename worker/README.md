# worker — Cloudflare Worker + CLI

The self-hosted side of [`lavish-publish-cf`](../README.md): a Cloudflare Worker (with KV) plus a Node CLI that talks to it. API-compatible with [htmlship.com](https://htmlship.com) — same shape, no third-party dependency, runs on your own Cloudflare account.

- **Worker**: `src/index.ts` — single-file TypeScript Worker, KV-backed.
- **CLI**: `cli/index.js` — `publish-cf` command, mirrors htmlship's commands.

For the high-level overview (skill integration, install flow), see the [top-level README](../README.md).

---

## Deploy (one-time setup)

You need a Cloudflare account with Workers enabled (free tier is plenty).

Run these from the **repo root** (where `package.json` lives).

```bash
# 1. Install deps
npm install

# 2. Authenticate Wrangler with your Cloudflare account
npx wrangler login

# 3. Create the KV namespace and copy the returned id
npx wrangler kv namespace create PAGES
# → outputs something like:
#   { binding = "PAGES", id = "abc123…" }

# 4. Paste the id into worker/wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID)

# 5. Deploy
npm run deploy
# → outputs the live URL, e.g. https://publish-cloudflare.<account>.workers.dev
```

After deploy, point the CLI at it:

```bash
publish-cf config set --api-base https://publish-cloudflare.<account>.workers.dev
```

(Or set `PUBLISH_CF_API` in your shell profile.)

### Optional: custom view domain

If you want pages served from `view.example.com` instead of the worker subdomain:

1. Add a Worker route or custom domain in the Cloudflare dashboard.
2. In `wrangler.toml`, set:
   ```toml
   [vars]
   VIEW_BASE_URL = "https://view.example.com"
   ```
3. Redeploy.

---

## Install the CLI

The fastest path is npm:

```bash
npm install -g @rubar/lavish-publish-cf
publish-cf --help
```

Or from a checkout: `npm install -g .` from the repo root. Or invoke directly without install:
`node <repo>/worker/cli/index.js …`, or `npx @rubar/lavish-publish-cf …`.

---

## CLI usage

```bash
publish-cf publish report.html
publish-cf publish report.html --password "demo-pass"
publish-cf publish report.html --title "Demo" --expires-in 60
publish-cf publish report.html --no-comments              # disable the comment sidebar
cat report.html | publish-cf publish -

publish-cf get <slug>
publish-cf update <slug> report.html
publish-cf delete <slug>
publish-cf list-mine

publish-cf comments <slug>                                # list open comments
publish-cf comments <slug> --format json --status all     # machine-readable
publish-cf comments resolve <slug> <id> --note "..."      # owner-only
publish-cf comments delete <slug> <id> --yes              # owner-only
publish-cf comments toggle <slug> --on | --off            # flip the page-level switch

publish-cf config show
publish-cf config set --api-base https://...
```

State lives in `~/.publish-cloudflare/`:

- `config.json` — `{ "api_base": "https://…" }`
- `keys.json` — per slug: `owner_key`, `source_path`, `comments_enabled`, `title`, expiry, URL. `source_path` is read by `/address-comments` so it can find the local file without asking.

`PUBLISH_CF_API` env var overrides the config file.

---

## API reference

Base path: `/api/v1`

| Method   | Path                                 | Auth                                  | Purpose                                                                                                                                                                                |
| -------- | ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/pages`                      | none                                  | Create page. Body: `{html, title?, password?, expires_in?, comments_enabled?}` (minutes for `expires_in`). Returns `{slug, url, owner_key, expires_at, size_bytes, comments_enabled}`. |
| `GET`    | `/api/v1/pages/:slug`                | none                                  | Metadata only (no html).                                                                                                                                                               |
| `PATCH`  | `/api/v1/pages/:slug`                | `X-Owner-Key`                         | Update `html`, `title`, and/or `comments_enabled`.                                                                                                                                     |
| `DELETE` | `/api/v1/pages/:slug`                | `X-Owner-Key`                         | Delete page.                                                                                                                                                                           |
| `GET`    | `/v/:slug`                           | cookie if password-protected          | Render the wrapper page (comment sidebar + iframe of the artifact). If `comments_enabled === false`, serves the artifact directly under strict CSP (same content as `/v/:slug/raw`).   |
| `POST`   | `/v/:slug`                           | n/a                                   | Submit password (form-urlencoded `password=…`), sets `hp_<slug>` cookie.                                                                                                               |
| `GET`    | `/v/:slug/comments?status=open\|all` | viewer (cookie if password-protected) | List comments on the page. Returns `403 comments_disabled` if the page has comments off.                                                                                               |
| `POST`   | `/v/:slug/comments`                  | viewer (cookie if password-protected) | Add a comment. Body: `{body, author, anchor?}`. Returns `403 comments_disabled` if comments are off.                                                                                   |
| `PATCH`  | `/v/:slug/comments/:id`              | `X-Owner-Key`                         | Resolve / unresolve a comment. Body: `{status, resolution_note?}`.                                                                                                                     |
| `DELETE` | `/v/:slug/comments/:id`              | `X-Owner-Key`                         | Delete a comment.                                                                                                                                                                      |
| `GET`    | `/healthz`                           | none                                  | Liveness probe.                                                                                                                                                                        |
| `GET`    | `/`                                  | none                                  | Landing page.                                                                                                                                                                          |

### Limits

- `html` ≤ 5 MB (KV cap is 25 MB; we leave headroom).
- `expires_in` ≤ 30 days (43,200 minutes).
- Slug = 8 lowercase alphanumeric chars. 5 retries on collision.
- `owner_key` = `ws_` + 32 random alphanumerics. Stored as SHA-256 hash on the server.
- Passwords stored as SHA-256 hash. Cookie `hp_<slug>=ok` valid for 1 hour.

### Content security

The artifact itself is served at `/v/:slug/raw` with a strict CSP:

```
Content-Security-Policy: default-src 'self' data: blob: https:; script-src 'none'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none';
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Inline `<script>` tags in the artifact are blocked. External CDN scripts are blocked. Inline CSS, images, fonts, and HTTPS subresources are allowed.

The wrapper at `/v/:slug` ships its own JS for the comment UI, so it carries a slightly looser policy: `script-src 'self' 'unsafe-inline'` plus `frame-src 'self'` so it can host the iframe. The wrapper never executes anything from the artifact — the iframe (`/v/:slug/raw`) keeps the strict CSP above.

---

## Inline comments

`/v/:slug` serves a thin **wrapper page** (comment sidebar + same-origin iframe). The iframe loads the artifact at `/v/:slug/raw` under the existing strict CSP, so the artifact itself stays untouched. Viewers select text inside the iframe, type a comment, and pick a display name — the name is stored in their browser `localStorage` (`pcf_name`); there are no accounts.

Anchors use a **text-quote selector** (selected phrase plus ~32 chars of prefix/suffix), so comments survive a republish as long as the anchored phrase (or a near-match) still appears in the new HTML. Comments whose anchor no longer matches are flagged `orphaned` in the sidebar and in the JSON.

Comment reads and writes are gated by the same viewer cookie as the page itself — password-protected pages get password-protected comments. Resolve and delete require `X-Owner-Key` and are intended to be driven from the CLI.

The headline workflow: a reviewer drops comments, the owner asks Claude to address them, and Claude runs:

```bash
publish-cf comments <slug> --format json --status open
# Claude edits the local HTML to address each anchored comment
publish-cf update <slug> <local-file>
# For each addressed comment:
publish-cf comments resolve <slug> <id> --note "<short summary>"
```

Same URL throughout — the reviewer's tab just shows resolved comments on refresh.

### Storage

KV keys in the `PAGES` namespace:

- `page:<slug>` — the artifact record (html, owner_key hash, password hash, expiry, etc.)
- `comment:<slug>:<id>` — one comment per key (avoids lost writes from concurrent commenters; listed via `PAGES.list({ prefix: \`comment:${slug}:\` })`)

---

## vs htmlship.com

|                 | htmlship.com            | publish-cloudflare                   |
| --------------- | ----------------------- | ------------------------------------ |
| Hosted by       | htmlship                | You (Cloudflare)                     |
| Cost            | Free tier with limits   | Free tier (CF Workers: 100k req/day) |
| CLI             | `npx htmlship`          | `publish-cf`                         |
| Owner key store | `~/.htmlship/keys.json` | `~/.publish-cloudflare/keys.json`    |
| API surface     | identical shape         | identical shape                      |
| CSP             | strict, no scripts      | strict, no scripts (same policy)     |
| Custom domain   | depends on plan         | yes, via Cloudflare                  |
| Passwords       | yes                     | yes                                  |
| Expiry          | yes                     | yes (≤ 30 days)                      |
| Vendor lock-in  | yes                     | none — your worker, your KV          |

---

## Local development

```bash
npx wrangler dev --local
```

Uses an in-memory KV emulator on `http://localhost:8787`. No Cloudflare auth required for `--local`. Point the CLI at it:

```bash
PUBLISH_CF_API=http://localhost:8787 node worker/cli/index.js publish foo.html
```

---

## Project layout

```
<repo-root>
├── package.json        # npm publishable (@rubar/lavish-publish-cf)
└── worker/
    ├── README.md
    ├── tsconfig.json
    ├── wrangler.toml
    ├── src/
    │   └── index.ts    # Worker (single file)
    └── cli/
        └── index.js    # CLI client (zero-dep Node)
```
