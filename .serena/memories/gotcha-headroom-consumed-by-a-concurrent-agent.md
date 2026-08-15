# Gotcha: don't reformat a contested file — and don't call a judgement an impossibility

From `task-684e6972` (2026-08-09), `apps/daemon/src/index.ts`. Corrected in the
same session by worker-2bc13005; the first version of this memory taught the
overstatement described below.

## What happened

The architect measured `index.ts` at 249 lines and wrote step 5 as exact
arithmetic: "remove separator blank lines so index.ts remains <=250". There were
15 blank lines.

Mid-task, a concurrent agent's UNCOMMITTED `export * from "./daemon-entry.js"`
appeared in the shared worktree, so on disk the base read 250. I had already
stripped all 15 blanks; I reverted that and reconstructed the file additively
instead, landing at 262.

## The real error — the one worth remembering

I reported that ≤250 had become **"arithmetically unreachable"**. It had not.
262 with 15 blanks strips to **247**, foreign line included.

What I actually made was a *judgement* — stripping every blank out of a file two
other agents were mid-edit in is the worse trade — and then presented it as an
impossibility. **A judgement invites disagreement; an impossibility forecloses
it.** Dressing one as the other is a way of winning an argument you never
declared you were having, and it survives review precisely because the arithmetic
looks checkable.

Say "I chose X over Y because Z" and let the reviewer overrule you.

## Second correction: the collision was worth +1 line, not the overage

My own 12-line block took 249 -> 261. The concurrent line made it 262. So the
concurrent edit did NOT break the cap and must not be scored as if it did. When
disclosing a shared-tree collision, state the foreign contribution as a NUMBER,
or the disclosure reads as an excuse.

## Attribution: the commit title is metadata, the `-S` log is evidence

I named the wrong agent, having inferred ownership from a commit's TITLE. That
commit (`f4e12bf`) was a whole-tree sweep titled for one task while carrying
another's files. The cheap signal was wrong and the real one was one command away:

```sh
git log -S 'daemon-entry.js' --oneline -- apps/daemon/src/index.ts
git show --stat <sha> -- <path>          # did that commit touch it at all?
```

## What does survive as durable practice

1. **Never reformat** (strip blanks, reorder, re-wrap) a file another agent is
   concurrently editing. Check `git status`/`git diff` on a shared file
   immediately BEFORE and AFTER touching it, not once at task start.
2. **Reconstruct additively and prove it**: `git diff --stat` must read
   `N insertions(+)`, **0 deletions**. That single number proves no foreign line
   was touched.
3. **Shrink your own footprint first** — packing an export block 2-3 names per
   line took mine from 17 lines to 12.
4. Read the rail's two numbers as two things: moe-next says *"target <=250,
   split before 400"*. 250 is a target; 400 is the bar. 261 with a stated reason
   is a disclosed deviation, not a violation — but say which one you are claiming.

## The real fix when a barrel keeps overflowing

`index.ts` carries a ~106-line INLINE `evaluateGraphPreviewRequestBytes`
implementation inside what is otherwise a re-export barrel. Extracting it leaves
the barrel near 160 with headroom for everyone. Stripping whitespace to hit a
number papers over that. It belongs to a task owning `index.ts` alone.

## Related

`mem:gotcha-line-cap-is-a-design-constraint-not-a-cleanup`,
`mem:gotcha-shared-index-commit-capture`,
`mem:gotcha-wrapper-whole-tree-commit-mislabels-task-ownership`.
