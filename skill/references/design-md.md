# DESIGN.md handling

Load when a project DESIGN.md was found during the walk-up step in `SKILL.md`. The project's design system wins over the six Lavish theme shells — its tokens, fonts, colors, and components are the source of truth.

## Walk-up algorithm

From `cwd`, walk **upward** looking for any of:

- `DESIGN.md`
- `design.md`
- `Design.md`

Stop at the first hit. Bound the search by the nearest `.git` directory — don't escape the repo. `lavish-axi` and `lavish-axi design` both surface this path; you can also `grep` for it directly.

## Override hierarchy

```
explicit theme slug in user prompt   →  use that slug, ignore DESIGN.md
DESIGN.md exists                      →  build from DESIGN.md, skip the theme picker
neither                               →  fall through to theme inference in SKILL.md
```

If the user explicitly names one of the six theme slugs (`latex`, `terminal`, `water`, `swiss`, `handwritten`, `zine`) in their original prompt, that overrides DESIGN.md — proceed with the named template.

## When DESIGN.md is present and not overridden

Surface DESIGN.md as the recommended option in the style question instead of the Editorial/Utility/Expressive buckets:

```
header: "Style"
- label: "Recommended: Use <repo>'s DESIGN.md"
  description: "Build the page from the project's design system. Tokens, fonts, and components come from DESIGN.md."
- label: "Editorial"
  description: "Serif and typographic Lavish theme. LaTeX or Swiss depending on content."
- label: "Utility"
  description: "Neutral or technical Lavish theme. Water or Terminal depending on content."
- label: "Expressive"
  description: "Unconventional Lavish theme. Handwritten or Zine depending on content."
multiSelect: false
```

If the prompt provided **no theme signal at all**, you can skip this question and proceed directly with DESIGN.md — the walk-up itself is a strong signal that the user wants project-system styling.

## "Build from DESIGN.md" semantics

If the user picks the DESIGN.md option (or it's used by default per above), skip the template-shell flow entirely. Build the page directly from the project's design system:

- Copy its tokens, components, and markup conventions.
- Inline the relevant CSS or load the project's stylesheet via HTTPS CDN (subject to the same CSP constraints described in `references/cloudflare.md` if publishing).
- Keep `<meta name="lavish-design" content="off">` in the head so DaisyUI isn't injected on top.

Read DESIGN.md once at the start of authoring. Treat it as opinionated and prescriptive — don't mix Lavish theme conventions in.

## Local vs CF mode interaction

The DESIGN.md path works identically in both `loc` and `cf` modes. In CF mode, the CSP constraints in `references/cloudflare.md` still apply — inline the CSS or use an HTTPS CDN, never relative paths.
