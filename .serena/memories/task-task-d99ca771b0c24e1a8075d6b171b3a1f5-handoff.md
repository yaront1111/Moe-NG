# Handoff: task-d99ca771 Evidence causal timeline (apps/control-room)

Delivered 2026-08-09 by worker-f2e587cb. 10 files, +2148, 0 deletions, all under
`apps/control-room/src/timeline/**` and `apps/control-room/src/evidence/**`.

## WHERE THE DIFF IS — read this before reviewing

**There is no commit named for this task.** Concurrent agents' completion hooks swept the
whole tree twice while I worked, so my 10 files are committed inside two FOREIGN commits:
`c699422` (task-e17da1c9 "Predecessor input materializer") and `a6e46f6`
(task-386fcb4c ".js runtime bridges to @moe/core"). Working tree == HEAD for these paths;
nothing was left uncommitted, so a pathspec commit at step 11 would have been empty.
`mem:gotcha-completion-hook-commits-whole-tree`, `mem:gotcha-shared-index-commit-capture`.

QA: do not run `git show <worker commit>` (`mem:gotcha-qa-must-diff-the-workers-commit-not-head`
does not apply here). Use:

```
git diff 9e0f123 HEAD -- apps/control-room/src/timeline apps/control-room/src/evidence
```

All 10 files are 100% mine; no foreign author edited inside them.

## Shape

| file | lines | role |
|---|---|---|
| `timeline/timeline-contract.ts` | 196 | vocabulary, `describeCursor`, `statedValue`, `statedProvenance`, `refuseTimeline` |
| `timeline/timeline-page.ts` | 206 | the pure cursor walk |
| `timeline/timeline-row.tsx` | 193 | one row |
| `timeline/timeline-list.tsx` | 151 | list, filters, cursor line, refusal/truncation notices |
| `evidence/evidence-contract.ts` | 81 | §2.9 receipt record types |
| `evidence/evidence-inspect.tsx` | 197 | the receipt view |
| 4 test files | 237–318 | 55 tests |

## Load-bearing decisions (do not "simplify" these)

1. **`page.nextCursor` is never read.** See `mem:gotcha-filtered-pager-differs-from-clamped-pager`
   — the store's `kept.length === items.length` fix, copied verbatim, HANGS a
   filter-driven pager. Split EXAMINED from ADMITTED.
2. **RESTART_GAP rows are exempt from every filter** (`survivesFilter`). A gap belongs to
   the stream, not to a node or actor, so a node filter would otherwise erase the only
   evidence of a restart. REJECTED rows are deliberately NOT exempt — they have a real
   actor and node.
3. **`FactWithProvenance` is deliberately NOT reused**, though the plan named it. It takes
   `FixtureProvenance` from `fixtures.ts`, a module whose own header says
   "Development-only ... nothing here carries authority". It would also have forced two
   lies: rendering an absent lease epoch as "not a leased mutation", and fabricating a
   `linkKind`/`linkRef` for a row with no typed link. `PROVENANCE_SHORTCUT_KEY` IS reused,
   including its "only while a chip holds focus" target guard. Truth presentation is still
   not reimplemented: `FactRow -> Fact -> TruthChip -> describeTruthClass`.
4. **Truncation is not a refusal.** It gets `TIMELINE_VIEW_LIMIT_REACHED` and rides on a
   WALKED result, because withholding rows already walked would lose truth.
5. **A refused walk renders `cr.timeline.refusal`**, never an empty list. An empty list on
   a forensic surface reads as "nothing happened".
6. **Absent lease epoch renders UNKNOWN**, not §3.2's "not a leased mutation". The daemon
   omits the field both when the mutation was unleased and when it stated nothing, and
   this surface cannot tell those apart.

## Found by adversarial self-review, after the drill, all three fixed

- Blank supplied string rendered as an empty cell marked `DAEMON_STATED` — a confident
  label attached to nothing. Fixed by `statedValue()` (whitespace counts as absent),
  mirroring `node-authority.readValue`.
- A throwing page source blanked the whole surface — failing OPEN. Now
  `TIMELINE_SOURCE_FAILED`/`PAGING`.
- A blank `eventId` produced a jump link to `#timeline/`. Now no link, matching
  `node-evidence.EvidenceLink`.

## Mutation drill: 7/7 killed

(a) envelope cursor -> 1 red; (b) truncated walk claims complete -> 3; (c) gap rows
suppressed -> 6; (d) digest elided -> 1; (e) non-zero exit relabelled -> 1; (f) ban-list
entry deleted -> 1; (g) gap filter-exemption removed -> 2.

Restoration used reverse-edits + `sha256sum -c`, NOT `git checkout --`: my files were
already tracked via the foreign sweep, and the ban test's working copy was AHEAD of HEAD,
so a checkout restore would have silently reverted a real fix
(`mem:mutation-drills-in-shared-worktree`).

## Verification

`pnpm --filter @moe/control-room typecheck` -> 0 errors in owned paths.
My four suites alone: `npx vitest run src/timeline src/evidence` -> 4 files / 55 tests.
Package baseline was 13 files / 175 tests; my contribution is +4 suites / +52 tests.

**The package gate was intermittently RED from a FOREIGN mid-TDD file**,
`src/board/board-surface.test.tsx`, whose `./board-surface.js` did not exist yet
(`mem:gotcha-shared-package-gate-broken-by-sibling-red-file`). Nothing to do with these
paths — all 250 other tests passed throughout.

## Follow-ups (not defects, not in scope)

- Nothing wires a real daemon page source to `TimelineList` yet; `source` is a prop.
- `cr.action.evidence-rerun` (§2.9) is unrendered — altering evidence is out of scope.
- `cr.evidence.compare` renders only a daemon-supplied comparison; the UI never compares
  two digests itself.
- §13-D3 restart-gap semantics are still TBD upstream, so the gap row renders exactly
  what the daemon stated and derives nothing about the missing span.
