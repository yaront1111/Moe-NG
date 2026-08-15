# Gotcha: `export *` hides a duplicate export — a green tsc does NOT prove there was no collision

Found on `task-7d0abdcd` (2026-08-09) while publishing three subtrees on the `@moe/runner`
root. The task plan warned that "a name exported from two modules is a compile error in
index.ts that reads like a mystery". **That is true for two explicit `export { X } from`
blocks. It is FALSE the moment a star re-export is involved**, which is exactly the shape the
same plan's size rail pushes you toward.

## The two silent cases

Given `index.ts`:

```ts
export * from "./surface/recovery-surface.js";
export * from "./surface/evidence-surface.js";
export { refMatches } from "./artifacts/artifact-contract.js";
```

- **explicit vs star:** if a surface module also exports `refMatches`, the EXPLICIT one wins
  silently. ES modules give a local/explicit export precedence over a star export. No error.
- **star vs star:** if both surface modules export `X`, `X` becomes ambiguous and is EXCLUDED
  from the namespace entirely. Node does not throw; the name is simply not there.

Either way the published surface is wrong and the compiler is green. The failure only shows up
as a name that a consumer cannot import, or as the WRONG binding under a name that resolves.

## What actually detects it

**The export COUNT, asserted against a hand-transcribed number.** On this task the prediction
was 66 pre-existing + 50 new = 116, written by hand before anything was probed:

```
node --experimental-strip-types --input-type=module \
  -e 'const ns = await import("@moe/runner"); ...Object.keys(ns).length'
-> 116
```

A shadowed or dropped name lands as 115. Then the set-equality assertion against the
hand-written list names WHICH one. Neither `tsc` nor a "does it import" smoke test can see it.

## Rules

- **Author:** if your entry point uses `export *` at all, an exact-count assertion is
  load-bearing, not decoration. Predict the count by hand BEFORE probing, or the check is
  self-derived and cannot fail (`mem:gotcha-self-derived-universe-cannot-check-itself`).
- **Author:** a curated surface module behind `export *` is still a reviewed seam — the list
  cannot grow without a human edit — but it moves collision detection from the compiler to
  your test. Say so where you write it.
- **QA:** "typecheck is green so there are no duplicate exports" is not a valid inference on
  any package whose root star-re-exports. Ask for the count.

Companion facts from the same task: `Object.keys` sees VALUES only, so a dropped type-only
export is invisible to set-equality — the guard is an `import type { ... }` block in the test,
which fails with TS2724. Verify both directions by mutation: drop an export (red by name),
add an unreviewed one (red by set-equality), drop a type (red by TS2724).

Related: `mem:task-task-7d0abdcd586742548a0733f7f71985c1-handoff`,
`mem:pattern-prove-a-published-package-root-with-plain-node`,
`mem:gotcha-vitest-hides-missing-js-bridge`.
