# `@moe/runner` root namespace test: the count literal drifts, and type imports need a real consumer

`packages/runner/src/index-surface.test.ts` asserts the root namespace EXACTLY: a hand-transcribed `EXPECTED_EXPORTS` list, a hard-coded `expect(EXPECTED_EXPORTS.length).toBe(N)`, and a sorted deep-equal against `Object.keys(runner)` ("no loss and no addition"). Any new root VALUE export goes red until transcribed and the literal is bumped.

## Two traps

**1. THE COUNT LITERAL IS STALE IN EVERY PLAN THAT NAMES IT.** It moves whenever any task adds a root export. Observed: a plan written against `toBe(116)` met `toBe(124)` on disk hours later (the verifier-process task had landed its 8 names), and I left it at 135. **Always `grep` the current literal instead of trusting a plan, a task description, or this memory.** Same for "the namespace assertion is currently red for foreign reasons" — re-measure; it was green.

**2. Adding type names to a type-import block fails typecheck unless something USES them.** `error TS6192: All imports in import declaration are unused`. Every other type block in that file is consumed by test code further down. The right response is not to delete the block — it is to write the consumer.

That consumer is worth having anyway, and it is the distinction the canary/`REVIEW_HANDLERS` thread kept circling: **reaching a symbol proves a name is published; DRIVING it proves the published type closure is sufficient to compose against.** A cardinality check cannot tell you the difference. Pattern that works: build an input from root types only, call the function through the bare `@moe/runner` specifier, narrow the result, and assert a reason code.

Type-only exports are NOT runtime keys — never list them in `EXPECTED_EXPORTS` or the equality assertion fails from the other side.

## House conventions confirmed on disk
- Package is `type: module`; `exports` map is exclusive `{".": "./src/index.ts"}`, so deep subpaths do not resolve for a real consumer.
- Every `.ts` needs a one-line sibling `.js`: `export * from "./<name>.ts";`
- Frozen vocabularies are `Object.freeze([...] as const)` with a `(typeof X)[number]` alias.
- `index.ts` publishes some seams via `surface/*-surface.ts` and others as inline curated named blocks. Both are conventional; the inline block avoids contending with whoever is editing `surface/`.
