# task-fdf3e6aa Narrow-mode surface reflow — handoff (reopen 1, ownership fix)

## State
All 8 steps complete. Gate `pnpm --filter @moe/control-room test` = 34 files /
503 tests, exit 0, run with a CLEAN tree so it covers committed bytes.

Commits: `5e61428` (the rename) + `089ebbf` (the content edits that failed to
stage — see below). Review BOTH; the first alone is broken.

## What this reopening was
QA rejected reopen-0 (`ac6d01a`) on **ownership only** — the sweep sat in
`src/a11y/`, which the description and task rail 4 both mark NOT owned. Nothing
else was faulted. The fix was a one-file move into `src/approvals/` (owned,
frozen by no ban test), sweep intact.

Authorship: the stylesheet, its pins and the 15-surface sweep are
**worker-4addc779's** work in `ac6d01a`. This session contributed the move and
independent re-verification only.

## Non-obvious things worth keeping

**The move was safe for a specific reason.** `SOURCE_ROOT = join(dirname(THIS_FILE), "..")`
resolves to `src/` from BOTH `a11y/` and `approvals/` — both sit one level under
`src/`. That is why `../fixtures.js` and `../shell/frame.js` are byte-identical
across the move and only the two `./ui-wide-*-fixtures.js` specifiers changed.

**Line 181 `expect(scanned.length - files.length).toBe(1)` is load-bearing, not
ceremony.** The DoD 5 tripwire excludes itself by absolute-path comparison
(`fileURLToPath(import.meta.url)` vs `join()`-built paths). A move — or a win32
separator mismatch — could silently exclude nothing. That assertion is the only
thing that would catch it. Do not "simplify" it.

**DoD 5 grep now returns 1, not 0.** `cr.runs|cr.resources` hits exactly one
line: the tripwire's own text naming the ids to state its premise. The
not-applicable still holds (task-ddb3bf77 is BACKLOG). A future reader seeing
non-zero may wrongly conclude the clause became applicable.

**Drill (c) must be width-CONDITIONAL.** Deleting a field unconditionally leaves
the sweep green — both sides lose it equally. Only a change that differs between
720 and 1440 reddens it, which is precisely what proves narrow mode engages.
Working drill: gate `cr.approvals.badge` in `approval-inbox.tsx` on
`window.innerWidth >= 960` → reddens exactly `approval-inbox`.

**Production change is one stylesheet plus one bare import line.** Everything
else is test. The 15 surfaces already reflowed correctly; the sweep guards a
property that held by accident rather than by contract.

## Traps hit this session
- `git add <pre-move path>` is fatal and stages NOTHING; the commit then lands a
  0-insertion rename while the suite stays green off the working tree. See
  `mem:gotcha-git-add-old-path-after-git-mv-lands-an-empty-rename`.
- `pnpm --filter X test -- <pattern>` does NOT filter; the arg reaches vitest
  literally and the full suite runs. Do not read such a run as scoped.
- A bare CSS side-effect import needs no `vite/client` reference here any more;
  `mem:gotcha-css-side-effect-import-needs-vite-client-types` is marked stale.

## Foreign red, disclosed not owned
Repo typecheck is RED at `packages/runner/src/platform/platform-observation.test.ts(127,7)`
TS2322, missing `continuationEvidence` — another agent mid-flight on
task-5855a9c6's authorised breaking contract change (5 uncommitted files under
`packages/runner/`). This task touches nothing under `packages/`.
