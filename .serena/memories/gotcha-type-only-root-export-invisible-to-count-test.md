# A type-only root export is invisible to the export-count test

`packages/runner/src/index-surface.test.ts` guards the root namespace with a
hand-written `EXPECTED_EXPORTS` list, a `.length` literal, and
`Object.keys(runner).sort()` equality. All three see **runtime values only**.

Consequence: you can add ten `export type` lines to `index.ts`, get them wrong,
or omit them entirely, and every existing surface test stays green. The count
literal does not move (correctly — types do not inflate it), so the usual signal
that "the namespace changed and was reviewed" never fires. A consumer in another
package is the first thing that discovers the gap, at compile time, later.

The `runtime-entrypoint.test.ts` child-process probe does not cover it either:
it asserts `undefinedBindingCount === 0` over runtime keys.

## How to assert a type actually publishes

Do not write a bare literal annotated with the type — the file's own comment
(around the recovery/evidence section) explains why: a literal typechecks against
a locally re-declared shape whether or not the real type was ever published. That
warning is about runtime behaviour, but the same reflex produces weak type proofs.

Instead **call the published function through the bare `@moe/runner` specifier and
annotate the returned value**:

```ts
const listing: GitRefListing = runner.parseRefListing(bytes, "for-each-ref");
const observed: readonly GitRefObservation[] = listing.refs;
```

If `GitRefListing` is not exported from the root, that is a tsc error, so
`pnpm --filter @moe/runner typecheck` becomes the assertion. Narrow a union to
reach its arms (`if (!result.ok) throw`; then `const ok: ArtifactEnumerationOk = result`)
so the arm types are covered too.

Related: `mem:gotcha-a-capability-proof-must-name-what-it-is-about`.
