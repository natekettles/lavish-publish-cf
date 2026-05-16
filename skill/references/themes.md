# Theme reference

Per-theme content fit, markup conventions, and the placeholder-replacement checklist. Load this once when building a page.

## Picking the theme shell

Six shells live under `~/.lavish-themes/tier{1,2}/<slug>.html` (installed via [lavish-themes](https://github.com/natekettles/lavish-themes)):

- **Tier 1** (vendored CSS, fully self-contained, no external deps): `latex`, `terminal`, `water`.
- **Tier 2** (Google Fonts via `<link>` — still self-contained otherwise): `swiss`, `handwritten`, `zine`.

All six render light by default. None should be modified — read the shell, replace content, leave styling intact.

## Per-theme cues

### latex (Tier 1)

- **Fit**: research-feeling briefs, papers, citation-heavy writing, anything that should read like a working paper.
- **Markup**: `<header>` with `<h1>`, optional `<p class="author">` and `<p class="abstract">`. Body in `<main>` with numbered `<h2>` sections.

### terminal (Tier 1)

- **Fit**: runbooks, postmortems, RFCs, CLI documentation, anything that should read like a developer note. Mono everywhere.
- **Markup**: wrap content in `<div class="container">`. Keep `<body class="terminal">`.

### water (Tier 1)

- **Fit**: the neutral default. Generic reports, briefs, neutral product writing. Classless — just paste content into `<main>` and it looks correct.
- **Markup**: classless. Drop content into `<main>`. Do not add wrapper divs unless the content genuinely needs them.

### swiss (Tier 2)

- **Fit**: decisive product/strategy briefs, memos, opinionated writing. Modernist grid, red accent.
- **Markup**: `<h1>` inside `<header class="masthead">`, plus a `.meta` block. Keep the inline `<style>` block exactly as-is — replace only the content inside `<header>`, `<main>`, `<aside>`, etc.

### handwritten (Tier 2)

- **Fit**: personal notes, letters, journal-feeling pieces. Looser, more human.
- **Markup**: `<h1>` in the header. Keep the inline `<style>` block exactly as-is.

### zine (Tier 2)

- **Fit**: loud manifestos, launch announcements, marketing-flavored pieces.
- **Markup**: `<h1>` inside `<header class="cover">` (note the `<br>` line breaks in the sample). Keep the inline `<style>` block exactly as-is.

For Tier 2 themes (swiss / handwritten / zine), **do not redesign**. The inline styling is load-bearing for the look. Replace text content only.

## Placeholder-replacement checklist

Every shell ships with sample copy that must not survive into the published page. Walk through this list every time:

1. **`<title>` tag** — replace with the page's real title. The `publish-cf` CLI auto-extracts this and uses it as the wrapper title for comments-on pages, so a stale `<title>` becomes a visible bug.
2. **Masthead heading** (per theme):
   - **latex**: `<h1>` inside the `<header>` block.
   - **terminal**: `<h1>` near the top of `<div class="container">`.
   - **water**: `<h1>` near the top of `<main>`.
   - **swiss**: `<h1>` inside `<header class="masthead">`, **plus** the `.meta` block underneath.
   - **handwritten**: `<h1>` in the header.
   - **zine**: `<h1>` inside `<header class="cover">`.
3. **Body content** — replace every paragraph, list item, blockquote, etc. The shells ship with placeholder essays; none of it should leak.

### Verify before saving

After replacing, run this check on the file:

```bash
grep -E '— sample|The Quiet Architecture' <path>
```

It must return nothing. If it returns hits, you missed placeholder copy.

## When in doubt

- Pick `water` as the neutral fallback — it's classless and forgiving.
- Pick `swiss` when the prose is opinionated and benefits from a strong masthead.
- Pick `terminal` when the content is technical and reads naturally as monospace.
- Avoid `zine` and `handwritten` unless the prompt explicitly suggests their tone — they are loud choices that shape how the content reads.
