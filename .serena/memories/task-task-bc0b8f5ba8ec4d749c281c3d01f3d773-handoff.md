# task-bc0b8f5b — §4.16 table-clause parity for Runs/Resources — DONE, in REVIEW

Commit **16bd8e5**, one file: `apps/control-room/src/approvals/narrow-parity.test.tsx`.
Gate: `pnpm --filter @moe/control-room test` → 39 files / 569 tests, exit 0.

## The commit carries work that is not this task's

141 insertions; **only 62 are mine and all 62 are comments.** The other 79 are the `TABLE_SURFACES` block + describe — **task-ddb3bf77's deliverable**, which was uncommitted in the shared tree (`git show HEAD:<file> | grep -c TABLE_SURFACES` = 0 at HEAD 961fc18). Interactive staging is unavailable here, so they could not be split off, and leaving them loose would have exposed them to the next foreign sweep. Review those 79 against ddb3bf77.

## The task description was false and I wrote it

I filed this task at 14:38 claiming Runs/Resources "get no parity treatment at all today". True of the fixture lists, **false of the coverage** — ddb3bf77 gave them a dedicated block instead of joining `CORE_/OPS_SURFACE_FIXTURES`. Running the suite first showed DoD 2 already satisfied. **Authoring a description is not a reason to trust it.** This is the gap-claimed-present-actually-closed direction of the stale-by-default rail.

## Drill result worth carrying forward

Removing the resources entry from `TABLE_SURFACES` took the suite **22 → 21**: the parity row **silently stopped existing** rather than failing. Every assertion inside it "passed" by never running. Only `expect(TABLE_SURFACES.length).toBe(2)` caught it.

**A deleted fixture entry is an invisible green removal of coverage unless a count guard sits beside the sweep.** Same family as `mem:gotcha-vacuous-set-membership-clears-everyone`, but the vanishing unit is a whole generated test, not a case inside one.

The strongest drill was making `cr.runs.suspect` render only at `>=960px`: the surface has **no** breakpoint-conditional rendering today, so the parity rows could have been comparing identical trees forever and nobody would know. Introducing the violation is the only way to prove the comparison is live.

## Why the 15 literal does not move

`SURFACES.length).toBe(15)` is unchanged and that is **correct, not a skipped DoD**. Line 237 asserts the table ids are absent from `SURFACES`, so the two sweeps cannot overlap. Folding table surfaces into the a11y fixture lists would opt them into several other sweeps nobody evaluated for table semantics. An unchanged literal looks exactly like an omission from outside — say so explicitly in any completion note.

## The half that cannot be tested

Spec §4.16 line 432, verbatim (digest `C55AF8A9…` verified): *"Tables drop to two-line rows; no column removed, only reflowed."* The field-set half is covered. **"Two-line rows" is a pixel property; jsdom evaluates no CSS and Vitest stubs the CSS import**, so no assertion in this suite can reach it. Recorded in-file as a not-applicable **with its reason** plus a "do not convert this into a test" line — the next reader's instinct is to close the gap with an assertion that passes over nothing.

## Drill hygiene

Backups to `os.tmpdir()`, never in the repo. Verify restoration with **`git diff`, not `git status`** — a foreign completion hook can commit a drill edit while status reads clean (`mem:mutation-drills-in-shared-worktree`). `fs.mkdirSync('D:/')` throws `EPERM`; use `os.tmpdir()` directly.
