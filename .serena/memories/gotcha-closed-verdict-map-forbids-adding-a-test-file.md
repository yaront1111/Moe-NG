# A closed verdict map makes adding ANY test file an out-of-scope edit

Hit 2026-08-11 on task-8ce8b35c, in `packages/mcp`, but the shape is repo-wide.

`packages/mcp/src/mcp-runtime-entrypoint.test.ts:194` asserts:

```ts
expect(verdicts).toEqual({
  "dispatch-conformance.ts": "imports-vitest",
  "http/http-parity.test.ts": "test-file",
  ...
});
```

`verdicts` is built by walking `src/` and classifying every non-bridged module. It is a
CLOSED map keyed by every test-tier file. So landing a new `*.test.ts` anywhere under
`packages/mcp/src/` reddens it:

```
FAIL > excludes every test module for a named reason, and only those
AssertionError: expected { …(10) } to deeply equal { …(9) }
+   "mcp-root-surface.test.ts": "test-file",
```

## Consequence for planning and for QA

A task whose deliverable is "one new focused test under `packages/mcp/src/`" CANNOT be
completed inside its stated owned paths. The one-line map entry is forced. Architects should
list that file in owned paths up front; QA should not treat the extra path as scope creep.

The proof that it is forced is cheap and QA should demand exactly this: add only the
deliverable, run the suite, read the red. Or in reverse — delete just the added line from the
map and watch the suite fail. That is `mem:qa-prove-an-out-of-plan-edit-was-forced` applied to
a barrel-shaped guard.

## What NOT to also do

The same file's comment at :223 said the http transport "is production code that `index.ts`
does not export yet" — falsified by my change. I left it. The assertion it explains is still
correct (reachability is asserted as a SUBSET of the bridge set, and publishing only grows
reachability), so correcting the prose is NOT forced, and an unforced edit outside the owned
paths defeats the very test QA uses to judge the forced one. Name the staleness in the
handoff instead.

Grep for this shape before sizing a task that adds a test file: a `toEqual` over a map or
array built by walking a directory.
