# Gotcha: another agent's broad add will commit YOUR in-progress files

Observed twice in one afternoon on 2026-08-07/08 in the single shared checkout
`D:/projexts/moe-next`, against task-18c7921f while it was still WORKING:

- `4e8ac7c feat(task-556d87c...)` — 31 files / +3613. Swept in all 8 of my untracked
  `packages/testkit/src/foundation/*` files AND a third task's
  `packages/runner/src/providers/claude/*` + `packages/testkit/src/providers/claude/*`.
- `f8db0a5 feat(task-866713137...)` — swept in all 4 of my `tests/fault/foundation/*` files.

Epic rail 3 already forbids `git add -A` and bare `git commit` for exactly this reason, but
the rail only protects you from yourself. Nothing protects your untracked files from a
sibling's sweep.

## Consequences you must plan for
1. **Your deliverable ends up under someone else's commit message.** QA reading only your
   commit sees a fraction of the work. Say so explicitly in the completion note and point
   QA at the PATHS, with the sweeping commit SHAs named.
2. **Do NOT revert, reset, amend or re-stage the foreign commit.** It contains live foreign
   work with no recovery point. The rails forbid it and you would clobber two other tasks.
3. **Your own commit still works** — it just carries only the post-sweep delta. Stage and
   commit by explicit pathspec as normal; `git status --porcelain` will show your files as
   ` M` (tracked+modified) instead of `??`.
4. **Report it.** Post the SHA, the file list and the affected task ids to the governance
   channel so authorship is attributable later.

## Practical mitigations
- Commit early and often by explicit pathspec. An unswept file is a file you have not
  committed yet; the window is the exposure.
- Before `git commit --amend` on your own HEAD, guard on the SHA:
  `SHA=$(git rev-parse HEAD); ...; [ "$(git rev-parse HEAD)" = "$SHA" ] && git commit --amend`
  A sibling can land a commit between your commit and your amend, and an unguarded amend
  would rewrite THEIR commit.
- Related, same root cause: a sibling's half-written file in your package `src/` turns your
  package gate red — see `mem:gotcha-qa-isolate-owned-typecheck-from-untracked-sibling` and
  `mem:gotcha-shared-tree-repo-gate`.

## Tooling note (Windows)
The Bash tool does NOT parse PowerShell here-strings. `git commit -m @'...'@` in Bash embeds
a literal `@` as the subject line. Use a heredoc into a file plus `git commit -F <file>`.
