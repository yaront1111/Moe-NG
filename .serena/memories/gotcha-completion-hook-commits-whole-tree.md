# Gotcha: the completion hook commits the WHOLE tree under the finishing task's message

Observed 2026-08-08 on `task-4a3b5ec0`. Every worker's careful per-file pathspec commit can be
followed minutes later by a second commit that sweeps everything.

## The signature

Two commits, same subject line, minutes apart:

- `7528e00` @ 23:39:50 — the worker's own: 16 files, all owned, hand-written body plus
  `Co-Authored-By: Claude Opus 5`. Rail-3 compliant.
- `42f1c21` @ 23:42:36 — **same subject, body is the generic template
  `"Completed via Moe worker session."`** — 58 files: all of `packages/context/`, all of
  `packages/coordination/`, `packages/runner/src/evidence/`, `.codex/*`, `pnpm-lock.yaml`,
  14 `.moe/tasks/*.json`. None of it belonging to that task.

Same shape one commit earlier on `task-2f6ac0d1` (`b8a2381`, reflog subject `@`).

**Read the BODY to tell them apart.** `"Completed via Moe worker session."` = hook. A long
hand-written rationale = the worker.

## It is not a worker leaving paths staged

`git status --porcelain` right after showed everything worktree-modified (` M`) and nothing
staged. The hook stages the tree itself at completion. A worker cannot prevent it by unstaging
before `complete_task`.

## Consequences seen in practice

A foreign task's TDD-RED file got committed: `evidence-receipt.test.ts` landed while its
production sibling `evidence-receipt.ts` did not exist, so `pnpm --filter @moe/runner
typecheck` was red at HEAD (`TS2307: Cannot find module './evidence-receipt.js'`) until that
task's worker wrote the file ~4 minutes later.

**QA implication:** attribute a red gate BY PATH and re-run before concluding. A red in a
directory the task does not own is very likely a live foreign TDD window, not a regression —
re-running a minute later often flips it green on its own.

**Do not "fix" it.** Undoing such a commit needs a history rewrite or a revert that would
delete several live agents' committed work; epic rail 3 forbids reset. Escalate to governors.

## Correction to a wrong belief circulating in handoffs

`mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff` trap 3 claims unstaging a foreign
path "destroys a live agent's work". **False.** `git restore --staged -- <path>` only removes
the path from the index; working-tree content is untouched and the owner re-stages freely.
Rail 3's instruction to unstage foreign paths is safe as written.

## Mutation-drill escalation

A later recurrence proved a worse failure mode: the hook can commit another agent's deliberately broken mutation while its test is running. Commit `c42b578` swept a temporary `advisoryOnly` mutant; `a3c16f0` had to restore the production byte. Therefore keep mutation windows as short as possible, restore immediately after the expected-red process returns, and verify the production hash. Even an out-of-tree backup cannot prevent the hook from snapshotting the mutated working file. Do not revert a contaminated multi-agent commit; add the smallest explicit-path restoration commit if the captured mutant is yours, or notify its owner/governors if foreign.

This same recurrence swept task-4a3b5ec0's two legitimate QA test fixes into foreign completion commit `34a3d11`, leaving no owned diff to commit. Attribute exact bytes with a path-limited parent diff rather than manufacturing a no-op change.

## Worst shape yet: an importer committed with NONE of its imports (2026-08-11)

Third cross-task incident in one day. `fdbdb36` (hook sweep, subject copied from
`task-40983c7c`, whose own clean 2-file pathspec commit was `f9875bd`) captured
`packages/store/src/recovery-anchor.test.ts`, a mid-TDD RED belonging to
`task-b6e3dd2a`. Its three sibling modules stayed untracked, so at HEAD:

    git ls-tree HEAD --name-only packages/store/src/ | grep recovery-anchor
    -> packages/store/src/recovery-anchor.test.ts        # the ONLY tracked one

**A fresh clone can never build this.** Previous recurrences left a red that healed
itself when the owner landed its sibling minutes later; this one is permanent until
the owner commits, because the imports were never in history at all.

### The durable statement of the bug

The whole-tree completion hook attributes FOREIGN BYTES to whatever task name
happens to be completing. The global rail already forbids the whole-tree commit;
the hook has not been changed to match, so every role absorbs the cost.

### The red MOVES — never attribute by error text

Same command, same file, twelve minutes apart, two different messages:

    npx vitest run packages/store/src/recovery-anchor.test.ts
    -> Cannot find module './recovery-anchor-contracts.js'    # earlier
    -> Cannot find module './recovery-anchor.js'              # later

The owner created modules in between. Two agents comparing notes on error text get
different answers for one cause, and the committed test is already stale (` M`)
against the working-tree one. Decide by PATH instead: `git log -1 -- <failing path>`
plus `git status` on each module it imports. Tracked importer + `??` imports = swept
in-flight file, not a regression.

**Do not reach for `git stash -u` to see HEAD bytes** — it deletes the peer's
untracked modules. Use `git show HEAD:<path>`. See
`mem:gotcha-git-stash-u-destroys-a-peers-untracked-work`.

Related: `mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-shared-git-index-amend-captures-foreign-work`.
