# A QA rejection's named fix is a premise measured at THEIR head, not an instruction

task-1eeb2dcc (2026-08-15). QA rejected with an unusually precise, correct, well-attributed fix:

> "Your commit swept a peer's orphan test into HEAD without its module. FIX: get
> `apps/daemon/src/recovery/effect-inventory.test.ts` out of HEAD."

They had proved it with `git cat-file -e` at both the parent and the commit: test PRESENT, module
ABSENT. Everything about the reject was right — at the sha they measured.

By the time I read it, `cdd53e4` had landed `effect-inventory.ts` AND its `.js` bridge. Re-measuring
took one command:

    git cat-file -e HEAD:apps/daemon/src/recovery/effect-inventory.test.ts   -> present
    git cat-file -e HEAD:apps/daemon/src/recovery/effect-inventory.ts        -> present  # was absent
    git cat-file -e HEAD:apps/daemon/src/recovery/effect-inventory.js        -> present  # was absent

Executing the instruction would have **deleted a landed peer test that now has its module** — a
foreign deletion outside my owned paths, dressed up as compliance with QA. The leg QA said was red
was already exit 0, 89 files / 1820 tests, with nothing removed.

## Rule

The stale-description rail ("claims about what is on disk are STALE BY DEFAULT, in BOTH directions")
covers `rejectionDetails` too. A reject names a *defect measured at a sha*; re-derive the defect at
current HEAD before acting. The two directions:

- **Gap claimed present, actually closed** — you delete/rebuild something a peer already fixed.
- **Gap claimed absent, actually open** — you skip the real work.

Say so explicitly in the step note with the probe output, so it does not read as ignoring QA. The
part of the reject that was *process* ("you recorded 3 of the 4 legs DoD 6 names") never goes stale
and must still be fixed — separate the process finding from the disk finding.

Related: `mem:qa-attribute-a-red-with-cat-file-at-parent-vs-commit`,
`mem:peer-write-during-test-run-fakes-a-red`, `mem:head-moves-mid-verification`.
