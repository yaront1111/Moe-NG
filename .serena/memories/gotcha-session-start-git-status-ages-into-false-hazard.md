# A warning built on session-start `git status` ages into a false hazard

The Claude Code session prompt embeds a `# gitStatus` block captured at session
start. It is explicitly a snapshot and **never updates during the session**.

## What happened (2026-08-15, chan-ced99359...)

A peer worker broadcast a QA warning on task-70b6361: "packages/mcp still
carries that work uncommitted — UNTRACKED http-shutdown.ts + .js bridge +
http-shutdown.test.ts; an untracked deliverable passes every habitual check
while committed bytes are missing the module AND its bridge."

Correct when written. **Already false when read.** Commit 181e0e9 had landed all
8 files (350 insertions), bridge included:

    git rev-parse HEAD:packages/mcp/src/http/http-shutdown.ts       -> 3419002820ad
    git rev-parse HEAD:packages/mcp/src/http/http-shutdown.js       -> d09d24dadcc3
    git rev-parse HEAD:packages/mcp/src/http/http-shutdown.test.ts  -> a38efa294047
    git status --porcelain -- packages/mcp                          -> EMPTY

The warning would have sent QA hunting a resolved hazard, and — worse — could
have justified gating the WORKING TREE instead of HEAD, which is the weaker gate.

## Why it is dangerous

It fails in the *safe-looking* direction: an agent who trusts the stale warning
does extra defensive work and concludes the tree is dirty. Nobody notices,
because a false hazard produces no red. The record is not the condition.

Same shape as `mem:moe-block-conditions-go-stale-silently` — a recorded reason
read in place of re-running the literal check.

## How to apply

- Never act on the prompt's `# gitStatus` block for anything time-sensitive.
  Re-run `git status --porcelain -- <path>` first.
- Prove a deliverable by resolution at HEAD, not by absence from `git status`:
  `git rev-parse HEAD:<path>` (see `mem:qa-untracked-deliverable-passes-every-habitual-check`).
- Check BOTH directions — a file can be missing from HEAD (never committed) or
  reverted out of HEAD by a later foreign whole-tree commit while the working
  tree still holds your bytes and every gate stays green
  (`mem:foreign-commit-can-revert-your-landed-deliverable`).
- When you broadcast a tree-state hazard to peers, stamp it with the HEAD sha you
  measured against, so a reader can tell at a glance whether it is spent.
