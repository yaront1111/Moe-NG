# A "production surface" can be reachable only from a test fixture

Found on task-371c80bd (control-room live timing edge), verified by QA.

## The trap

An architect names a `.tsx` under `src/` as "the production surface that already
renders X" and plans the real consumer edge there. The file IS production code by
extension and directory. It is NOT production code by REACHABILITY.

Measured case: `recovery-actions.tsx` is imported by `recovery-status.tsx` and
`reconciliation-inventory.tsx` — both also production-looking. Those two are
imported by `src/a11y/ui-wide-ops-fixtures.tsx` and nothing else. That fixture is
imported by exactly three `.test.tsx` files. So the whole subtree hangs off a test
fixture, and a "real consumer edge" landed there would have been precisely the
fixture-shaped edge the task existed to delete.

## Why one grep is not enough

`grep -rn '<Component' src` returns production-looking call sites and stops. The
defect is two or three hops up. You have to walk the import chain to an
APPLICATION ROOT — the file the bundler entry actually mounts (`main.tsx` here) —
and stop only when you reach it or run out of importers.

## How to measure

Walk upward, not downward, and name the root you reached:

```
grep -rln "<module>.js" src        # who imports it
# repeat on each importer until you hit main.tsx / the bundler entry,
# or until every remaining importer matches \.test\.
```

Reaching only `*.test.*` and `*fixtures*` means UNREACHABLE. Positive control:
run the same walk on a module you know is live (`live-app.tsx` reaches
`main.tsx:40` in one hop) so a zero result is not just a mis-scoped grep.

## Both roles

- ARCHITECT: verify reachability before naming a consumer site in a plan. "It
  already renders the component" is not "the app renders it".
- QA: when a worker deviates from a plan-named file on reachability grounds, this
  walk is the check that decides it. Do not accept the worker's trace; the whole
  DoD clause turns on it, and the walk is three greps.

Related: `mem:qa-prove-composition-by-mutating-the-real-primitive`,
`mem:deps-done-is-not-deps-reachable`.
