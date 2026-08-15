# Which modules get a `.js` bridge — the rule is per-package, and runner's does not transfer

Node does not resolve a `./foo.js` specifier to `foo.ts`; vitest and `tsc` both do. So every
package publishing a `.ts` entry needs a sibling `.js` bridge per runtime module
(`mem:gotcha-vitest-hides-missing-js-bridge`). Landed for `@moe/runner` (task-eb9ff081),
`@moe/core` (task-386fcb4c) and `@moe/daemon` (task-f6440f26).

Bridge byte form, identical everywhere — copy it, do not type it:

```
export * from "./<own-basename>.ts";\n
```

LF only, trailing newline, and it must name its OWN sibling. `export * from "./other.ts";`
resolves cleanly and re-exports the wrong surface, so no import probe can catch a mis-target —
only a per-file content assertion can.

## The classification trap

`packages/runner/src/runtime-entrypoint.test.ts` seeds its test tier from FILENAMES
(`/\.test\.ts$|-test-fixtures\.ts$|-test-helpers\.ts$/`) then closes forward. **That rule is
wrong for `apps/daemon` in both directions:**

- `http/event-stream-fixtures.ts` and all five `work/work-race-*.ts` are scaffolding whose
  names match nothing — a filename rule demands bridges for them and puts test code on the
  runtime surface.
- `http/http-adapter.ts` is production code whose ONLY importer is its own `.test.ts`; a strict
  "every importer is a test" rule wrongly excludes it. `work/work-lifecycle.ts` is excluded
  too, transitively, since its one non-test importer is test-tier `work-race-world.ts`.

## The rule that works

Runtime tier = forward closure from **published units**, where a published unit is the package
entry (`index.ts`) plus **every module carrying its own `<name>.test.ts` sibling** — a module
under direct test is a unit, not scaffolding. Close over `from "./x.js"` imports. Test tier is
the remainder: imported only BY tests, never reached FROM a published unit.

For `apps/daemon`: 27 non-test `.ts` → 19 runtime, 8 test-tier
(`bootstrap-test-fixtures`, `http-test-fixtures`, `event-stream-fixtures`, and
`work-race-{fixtures,drift-table,world,schedule,tampers}`).

## Prove it in BOTH directions or it proves nothing

- **COMPLETENESS** — plain-Node probe of the entry. Fails on the FIRST missing bridge, so a
  clean load means everything reachable is bridged. Assert the bindings
  (`undefinedBindings: []`), never just exit 0: a process exits 0 having imported nothing, and
  an import cycle yields a TDZ-undefined binding that imports fine and dies at first use.
- **NO-EXCESS** — import each test-tier path under Node and assert the literal
  `ERR_MODULE_NOT_FOUND`. A MISSING-only audit reports zero while test code sits on the runtime
  surface; an UNEXPECTED-only audit reports zero on an incomplete sweep.
- Add set-equality between the on-disk `.js` set and the classified runtime set — a
  list-driven audit misses a bridge written for a module nobody ever classified.

Related: `mem:gotcha-node-does-not-resolve-js-specifier-to-ts`, `mem:gotcha-scheduler-js-shims`.
