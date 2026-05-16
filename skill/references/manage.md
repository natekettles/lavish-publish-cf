# Manage existing CF pages

Load when `/publish` is invoked with `list`, `manage`, or `pages`, or when the user says "list my published pages", "manage my pages", etc.

This flow operates only on **Cloudflare-published** pages — local `.lavish/` files aren't tracked anywhere and aren't part of this list.

## Step 1 — gather

```bash
publish-cf list-mine
```

One line per page: slug, URL, title, expires, comments, source. `list-mine` does **not** include password presence — fetch that per-slug via `publish-cf get <slug>` (returns `has_password`). Run the `get` calls in parallel.

**Classify each entry** while parsing:

- **Live** — `get` returns 200. URL is on the configured prod `api_base`.
- **Dead — localhost** — URL uses `localhost` / `127.0.0.1`. Stale dev entries; the production CLI cannot reach them. Don't `get` against prod — they 404 noisily.
- **Dead — expired** — `expires_at` is in the past, or `get` returns 404 with no localhost URL. KV TTL has already evicted them server-side; the local `keys.json` entry is orphaned.

If `list-mine` returns "no pages saved on this machine", say so and exit.

## Step 2 — render

Print a compact one-row-per-page summary in chat as plain text (never a markdown table — the CLI doesn't render them). Group into a **Live** section and a **Dead** section so the action buckets in step 3 make sense. Format roughly as:

```
<slug>  <title-or-"Untitled">  pw:yes/no  comments:on/off  expires:<human>  <url>
```

If there are more than ~15 live pages, build a `.lavish/` HTML file and open it with `lavish-axi` instead (per global CLAUDE.md, long structured output goes to lavish).

## Step 3 — pick the next action

`AskUserQuestion` is capped at 4 options, so **don't try to enumerate every page as an option** — it won't fit. Instead, ask one bucket-style question and rely on the auto-`Other` slot for free-text slug entry. Header: `"Pick"`. Compose options from the relevant ones below (pick 2–4 that apply to the current state):

- **"Act on a specific page"** — tell the user to type the slug in `Other`, or if they pick this option re-prompt with `AskUserQuestion` to capture the slug. Either way, jump to step 4 with that slug.
- **"Clean up N dead entries"** — only include if there are dead entries. Removes them from local `keys.json` (no API calls — they're already gone server-side). See "Cleanup dead entries" below.
- **"Delete all live pages"** — only include if the user has clearly signaled bulk-cleanup intent in this session. Otherwise omit; bulk deletion is destructive and shouldn't be a one-click default.
- **"Done"** — always include.

If the user typed a slug into `Other`, treat that as "act on this specific page".

## Step 4 — pick an action on the picked page

`AskUserQuestion` with header `"Action"` and these options (drop ones that don't apply — e.g. "Toggle password" branches differently based on `has_password`):

- **Delete** — destructive. Confirm with a second `AskUserQuestion` (`"Delete <slug>? Yes / No"`), then `publish-cf delete <slug>`.
- **Toggle comments** — flip current state via `publish-cf comments toggle <slug> --on` or `--off`.
- **Toggle password** — branch on `has_password`:
  - Off → on: generate (`openssl rand -base64 12 | tr -d '=+/' | cut -c1-12`), run `publish-cf password <slug> --set "<pw>"`, share the new password back in the reply.
  - On → ask sub-question `"Password: replace / remove"`. Replace → generate new pw, `--set <newpw>`, share it back. Remove → `publish-cf password <slug> --clear`.
- **Open** — `open <url>`.
- **Back** — return to step 3.

## Cleanup dead entries

`publish-cf delete <slug>` calls the worker API first and only removes the local key on a 200 response. For localhost and KV-expired entries that path fails, so the orphaned key persists. To clean them up locally without an API call, edit `~/.publish-cloudflare/keys.json` directly.

The snippet below backs up `keys.json` and then removes the dead slugs in one command — the backup is part of the chain so it cannot be skipped. Edit the `SLUG1,SLUG2` list before running, and report the printed backup path back to the user in the final reply so they can roll back if needed.

```bash
cp ~/.publish-cloudflare/keys.json ~/.publish-cloudflare/keys.json.backup-$(date +%s) && node -e "const fs=require('fs'),p=process.env.HOME+'/.publish-cloudflare/keys.json',k=JSON.parse(fs.readFileSync(p));const dead=['SLUG1','SLUG2'];const ok=k.owner_keys||k;dead.forEach(s=>delete ok[s]);fs.writeFileSync(p,JSON.stringify(k,null,2));console.log('removed',dead.length,'dead entries; backup at',p+'.backup-*')"
```

## Step 5 — loop

After any action other than Done, return to step 1 (re-fetch — the list may have changed). Exit when the user picks Done.
