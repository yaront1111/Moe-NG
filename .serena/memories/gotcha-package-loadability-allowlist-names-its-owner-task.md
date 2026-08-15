# Gotcha: `tests/runtime/package-loadability.test.ts` carries an allowlist stamped with the task that must retire it

Found on `task-17b03331` (2026-08-09).

## What it is

`tests/runtime/package-loadability.test.ts` (tracked, landed in `a6e46f6`) probes every
workspace package's Node entry in a real child process. Packages known to be broken sit in
`allowedPackageFailures`, each entry carrying `expectedCode`, `expectedPathFragment`, `reason`
and — the load-bearing field — **`ownerTaskId`**.

`tests/runtime/package-loadability-support.ts` `observationIssues()` is symmetric:

```ts
if (result.outcome === "IMPORTED") {
  if (allowance !== undefined) issues.push(`${name}: allowlist entry is stale`);
```

So the allowance is not a mute exemption. **The moment you fix the package, the allowance
itself becomes the failure.** Fixing three packages and leaving their entries turns this test
red for a reason that looks nothing like your change.

## Why it bites

Nothing in the owning task's description, DoD, or owned paths mentions this file. You discover
the coupling only by reading a test in `tests/runtime/` that your package-scoped gate never
runs — `pnpm --filter @moe/<pkg> test` scopes to `packages/<pkg>/src` and cannot see it.

## What to actually do

1. Grep `ownerTaskId` for your task id BEFORE you start, not after your gates go green.
2. Check `git status` first. On task-17b03331 a **concurrent worker already had both files
   modified** and had reduced the allowlist to `Object.freeze({})`. Editing it would have
   collided with live foreign work in a shared tree. Verify the outcome instead:
   `pnpm exec vitest run tests/runtime/package-loadability.test.ts`.
3. The two commits are mutually dependent — an empty allowlist WITHOUT the bridges fails the
   same test from the other direction. Either order converges; say so in channel so the other
   owner does not think they are blocked.

## The general shape

A tracked test can name your task as the owner of a cleanup that is invisible to your focused
gate. Same family as `mem:gotcha-vitest-hides-missing-js-bridge`: the gate you were told to run
is not the gate that can observe your defect.

Related: `mem:task-task-17b03331e4ee488a994635144cae4a53-handoff`,
`mem:gotcha-vitest-hides-missing-js-bridge`, `mem:mutation-drills-in-shared-worktree`.
