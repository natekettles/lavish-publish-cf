---
name: publish
description: "Generate a styled HTML page from a description, file path, or URL and either open it locally in `lavish-axi` for review or publish it to a self-hosted Cloudflare worker. Use whenever the user asks for a lavish page, styled brief, runbook, mock, prototype, report, manifesto, or any HTML artifact they want to view or share. Default theme is light — never dark unless the prompt explicitly says so. Also handles `/publish list` to manage existing CF pages."
argument-hint: "[cf|loc] <source-path | url | description> | list"
user-invocable: true
---

# publish

One skill, two modes:

- **Local** (`/publish loc <source>` or `/publish <source>` when local-ish keywords are present) — generate the HTML, save under `.lavish/`, and open it in `lavish-axi` for review. No Cloudflare involved.
- **CF** (`/publish cf <source>`) — same generate-and-save, then publish to the self-hosted Cloudflare worker. See `references/cloudflare.md`.

Pairs with `/address-comments <slug>` for the reviewer-feedback loop on CF-published pages.

If the argument is exactly `list` (or `manage` / `pages`), jump to `references/manage.md`.

## Mode resolution

Read the first positional token of the argument:

- `loc` / `local` → **local** mode. Strip the token; treat the remainder as the source.
- `cf` / `cloudflare` / `publish` → **CF** mode. Strip the token.
- `list` / `manage` / `pages` → load `references/manage.md` and follow it.

If no mode token is present, scan the rest of the prompt for keywords (case-insensitive):

- "publish to cloudflare", "ship", "deploy", "share publicly" → CF.
- "view locally", "open in lavish", "preview", "review locally" → local.

If neither token nor keyword resolves the mode, fire `AskUserQuestion` **once** with destination as the question (Local recommended; CF as the alternative). Do **not** default silently — the whole point of asking once is to avoid accidental publishing.

## Inputs

The argument (after stripping the mode token) is required and can be:

| Form                  | Example                            | Treatment                                              |
| --------------------- | ---------------------------------- | ------------------------------------------------------ |
| Existing file path    | `/path/to/brief.md`                | Read it. Use as the source.                            |
| HTTP(S) URL           | `https://example.com/article`      | Fetch via WebFetch; on error fall back to `/crawl4ai`. |
| Prose / "describe it" | `a 1-page brief comparing X and Y` | Generate content from scratch from the description.    |

If invoked with no argument at all, prompt with `AskUserQuestion` for a source — do not start generating from an empty prompt.

## Check for a project DESIGN.md (before picking a theme)

Walk up from `cwd` (bounded by the repo root — stop at `.git`) looking for `DESIGN.md`, `design.md`, or `Design.md`. If one exists, the project's design system is the source of truth — load `references/design-md.md` and follow it. An explicit theme slug in the prompt still overrides DESIGN.md.

## Theme inference (aggressive — ask only as a last resort)

If the prompt names a theme slug verbatim (`latex`, `terminal`, `water`, `swiss`, `handwritten`, `zine`), use it. Skip the rest of this section.

Otherwise, match the prompt against this table and pick silently:

| Prompt signal                                                            | Theme           |
| ------------------------------------------------------------------------ | --------------- |
| "runbook", "postmortem", "RFC", CLI/terminal-flavored                    | **terminal**    |
| "brief", "strategy", "decision", "memo", decisive product/strategy prose | **swiss**       |
| "research", "paper", "abstract", citations, academic                     | **latex**       |
| "manifesto", "launch", "announcement", marketing-loud                    | **zine**        |
| "letter", "note", "personal", "journal", handwritten feel                | **handwritten** |
| Generic / neutral / no signal but theme is fine                          | **water**       |

If the prompt gives **zero** signal AND there is no DESIGN.md, fire `AskUserQuestion` once with three bucket options:

- **Recommended: Editorial** — serif and typographic (maps to `swiss`; `latex` for research-feeling pieces).
- **Utility** — neutral or technical (maps to `water`; `terminal` for runbooks/CLI).
- **Expressive** — unconventional (maps to `zine`; `handwritten` for personal notes).

All three buckets resolve to **light themes** by default. The user can override by typing a theme slug as `Other`.

## Build the page

1. Read the matching shell at `~/.lavish-themes/tier{1,2}/<slug>.html` (Tier 1: latex, terminal, water. Tier 2: swiss, handwritten, zine). The themes library installs there via [lavish-themes](https://github.com/natekettles/lavish-themes); if it is missing, point the user at that repo's `scripts/install.sh`.
2. Replace the body content with the user's actual content, **keeping theme-specific markup conventions intact**.
3. Overwrite every placeholder string (title, masthead, sample copy).

For the per-theme markup rules and the placeholder-replacement checklist, load `references/themes.md` once before authoring.

## Save the file

- If `cwd/.lavish/` exists or `cwd` is writable, save to `<cwd>/.lavish/<kebab-slug>.html`. Create `.lavish/` if missing.
- Otherwise, save to `~/.lavish/throwaway/<YYYY-MM-DD>-<kebab-slug>.html` (create the dir if needed).
- `kebab-slug` derived from the page title — short, lowercase, alphanumeric + hyphens. Match the input file's basename when there is one.

## Local mode — open in lavish-axi

```bash
lavish-axi <path>
```

That's it. The CLI starts (or reuses) the local server and opens the browser at the right session URL. Per global CLAUDE.md, observe the rendered page before reporting done — confirm it loaded, confirm the theme is light, confirm the content replaced cleanly. No Cloudflare, no public URL.

Reply to the user with:

- Local file path
- Theme used
- Any design decision worth review (one-liner, optional)

## CF mode — publish to Cloudflare

Before publishing, load `references/cloudflare.md`. It covers:

- Opt-in keyword/flag triggers for password, comments, and expiry (all off by default)
- `publish-cf publish` command + flag mapping
- Post-publish report shape
- CSP / self-containment rules
- "When the deploy is stale" recovery

After publishing, run `open <url>` and reply with the tight summary described in the reference.

## Trigger phrases

Match on:

- "publish this as a lavish page", "make a lavish page", "ship this as a styled page"
- "deploy this brief", "share this as a published page"
- "view this locally", "preview this in lavish", "open this in the lavish editor"
- "/publish list", "manage my published pages", "list my pages"

## What NOT to do

- Do **not** spawn a subagent for any flow in this skill. `AskUserQuestion` renders in the main thread; subagents can't reach the user.
- Do **not** publish to CF without an explicit `cf` token or a CF keyword (or a user pick in the destination question). The default route is local.
- Do **not** publish before opening the file locally to verify it renders.
- Do **not** use markdown tables in the user-facing reply (the CLI doesn't render them). For long structured output use a `.lavish/` HTML file and `lavish-axi <file>` per global CLAUDE.md.
- Do **not** improvise a custom palette. Use the chosen theme shell as-is and only swap content. DESIGN.md is the one sanctioned override; see `references/design-md.md`.
