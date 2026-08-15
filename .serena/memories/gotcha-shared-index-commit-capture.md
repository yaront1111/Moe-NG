# Gotcha: in the shared working directory, another agent's commit can capture YOUR in-flight files

Epic rail 2 pins every agent in this project to the single working directory
`D:/projexts/moe-next`. Rail 3 therefore forbids `git add -A` and bare `git commit` and demands
`git commit -- <owned path>`. The rail is usually explained as "don't sweep in foreign work".
The other direction bites harder and is easier to miss: **a foreign agent that ignores the rail
commits YOUR uncommitted edits under THEIR task's commit message.**

Observed 2026-08-08 on task-556d87c3 (policy approval core, QA fix pass). Commit `d6c7bcf`
`feat(task-18c7921fb1f34a8cb1ed39509bf67a31): Foundation executable specification` landed
mid-session and contained, alongside its own `packages/runner/src/providers/claude/**` work:

    packages/core/src/policy/policy-composition.ts
    packages/core/src/policy/policy-evaluation.ts
    packages/core/src/policy/policy-decision-table.test.ts
    packages/core/src/policy/policy-relaxation.test.ts     (untracked new file, also swept)
    packages/core/src/policy/policy-invariants.test.ts     (mid-edit intermediate state)

Untracked files are swept too — `git add -A` does not care that the file is new.

## How you notice

`git status --porcelain -- <your area>` suddenly shows FEWER modified files than you edited.
That is the signal. Do not assume your edits were lost or that a tool silently reverted them:
run `git log --oneline -3 -- <one of your paths>` and `git show --stat <sha> | grep <your area>`.

## What to do

1. Do NOT reset, rebase, revert, or amend the foreign commit. It contains someone else's work
   and the epic rail says preserve it. Rewriting shared history is worse than bad attribution.
2. Commit whatever delta remains under your own message, by explicit pathspec.
3. Say so LOUDLY in the completion summary and the step note, with both SHAs and the diff range
   that actually shows your work — e.g. `git diff <last-own-commit>..HEAD -- <area>`. QA opens
   your commit by default; if that commit holds one file out of five, the review is worthless
   without the pointer.
4. Post it to #general too. The other worker is not malicious, and the next agent in that tree
   needs the reminder more than the blame.

## The consequence that actually breaks a DoD: sweeps commit INTERMEDIATE states

Observed again 2026-08-08 on task-7dc2e487 (budget contract vocabulary). Commit `e97250e`
`fix(task-18c7921fb1f34a8cb1ed39509bf67a31): Foundation executable specification` swept all three
`packages/scheduler/src/budget/**` files while the task was still in flight — and captured
`budget-contract.ts` at **258 physical lines, over that task's hard 250-line cap**. The working
tree was already compacted to 250, so every local check looked clean while HEAD was
non-compliant.

**Therefore: verify size/shape DoD items against HEAD, not the working tree.**

```bash
git show HEAD:<path> | wc -l          # what QA and the gate actually see
```

Generalizes past line counts to any "the committed file must X" DoD item: a sweep can land any
mid-edit state, so a working-tree measurement proves nothing about what shipped. The remaining
delta still commits normally by explicit pathspec (here `326e146`, one file) — and that commit is
the one that makes HEAD compliant, so it must not be skipped as "just formatting".

## If you must amend your OWN commit in a shared tree

Guard it, because HEAD may have moved to someone else's commit between your commit and your
amend — amending then rewrites THEIR commit:

```bash
if [ "$(git rev-parse HEAD)" = "$(git rev-parse <your-sha>)" ]; then
  git commit --amend -F <msgfile> --only -- <your path>
else
  echo "SKIP: HEAD moved"
fi
```

See `mem:gotcha-bash-tool-heredoc-on-windows` for why the message came from a file.
