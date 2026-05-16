---
name: publish-cf
description: "Deprecated alias for `/publish`. Use `/publish cf <source>` for Cloudflare publishing or `/publish loc <source>` for local-only review. This shim forces CF mode for backwards compatibility and emits a one-line deprecation notice. Will be removed in a future cleanup."
argument-hint: "<source-path | url | description> | list"
user-invocable: true
---

# publish-cf (deprecated)

This skill has been replaced by `/publish`. Invoking via `/publish-cf` keeps working for now, but the canonical entry point is `/publish cf <source>` (CF) or `/publish loc <source>` (local-only review with `lavish-axi`, no Cloudflare).

When this skill is triggered:

1. **Force CF mode.** The slug name literally says `cf`, so treat the destination as resolved — do not ask. The user can still pass `list`, `manage`, or `pages` to enter the list/manage flow.
2. **Emit one line at the top of the final reply**, verbatim:

   > Note: /publish-cf is now /publish cf — update muscle memory when convenient.

3. **Defer to the full workflow at `~/.claude/skills/publish/SKILL.md`.** Read it now and follow it from there, treating the mode as already resolved to CF. All picker logic, DESIGN.md handling, theme inference, references/, and post-publish reporting live there.

Do not duplicate the workflow here. The canonical source is `/publish`.
