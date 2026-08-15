# A persistent Bash cwd fabricates "symbol absent" and can trigger a wrong block

Hit 2026-08-11 planning task-2ff368fe (CRITICAL). Nearly blocked it claiming its
dependencies did not exist. They all did.

## What happened

Earlier in the session I ran `cd apps/daemon` for a one-off `node -e` import probe. **The
Bash tool's working directory persists between calls.** Every later measurement silently
resolved one level deep:

```
git ls-tree -r HEAD -- apps/daemon/src/recovery   -> empty   (looked for apps/daemon/apps/daemon/...)
grep -r ... apps packages                          -> nothing (no apps/ or packages/ under apps/daemon)
ls .moe/tasks                                      -> No such file or directory
```

Read together those look overwhelming and coherent: the directory is gone, all five
symbols are absent, and even the task records have vanished. The obvious conclusion — the
promotion note is fantasy, block the task — would have been badly wrong. All five symbols
were present at the exact line numbers the governor gave.

## The tell that saved it

`git ls-tree -r HEAD --name-only | grep -i recovery` returned `src/recovery/…` rather than
`apps/daemon/src/recovery/…`. A repo-relative path that is *missing its expected prefix*
means the repo root is not where you think it is. That is the cheapest signal available.

## The rule

**Run `pwd` before believing any negative result.** Absence is the finding that a wrong cwd
manufactures, and absence is exactly what triggers blocks, prerequisite tasks and
"dependency missing" escalations — the expensive, hard-to-reverse moves.

A positive result cannot be faked this way: if grep *finds* the symbol, it exists. So the
check is only needed before acting on nothing-found. Cheap asymmetry, worth internalising.

## Why it is worse than the known typecheck variant

`mem:pnpm-typecheck-from-subdir-is-not-repo-wide` covers a false GREEN from a narrowed
scope. This is the mirror image and more dangerous in an architect seat: a false RED that
looks like diligent measurement. A false green gets caught by the next gate; a false
"dependency absent" gets written into a block reason, escalated to a governor, and costs
the whole chain behind it.

## Companion habit

When several independent measurements all come back empty at once, suspect the harness
before the board. One shared cause is likelier than four simultaneous deletions.

Related: `mem:gotcha-wrapper-injected-claimed-task-context-can-be-stale`,
`mem:gotcha-vitest-config-package-json-drops-jsdom` (another false red I produced, same
family: the tool was misconfigured, not the code).
