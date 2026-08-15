# Pattern: guard the case LIST, not just the cases

Found 2026-08-07 reviewing the pure stored-event upcaster, at the prompting of the
worker who wrote it. One level up from `mem:pattern-assert-which-layer-refused`.

## The shape

A test loops over a constant to assert a family of properties:

```ts
const PRESERVED_KEYS = ["aggregateId", "commandId", /* ...10 keys */] as const;
for (const key of PRESERVED_KEYS) expect(result[key]).toBe(event[key]);
```

Probed three ways against the production surface:

| mutation | result |
|---|---|
| production tampers `globalPosition` | 1 test red (bound by the loop AND an explicit assertion) |
| production tampers `commandId` (loop-only field) | 1 test red — the loop binds it |
| production tampers `commandId` **and** `PRESERVED_KEYS = []` | **19 passed** |

So for every loop-only field the constant is the *sole* binding, and **nothing asserts
the constant is non-empty or complete**. Shorten the list, or add an envelope field and
forget to list it, and coverage silently disappears while the suite stays green.

## The two-line fix

- assert the list is non-empty (a non-vacuity floor), and
- assert it equals the type's key set minus the fields deliberately allowed to change
  (here: `domainSchemaVersion`, `payload`, `metadata`, `decisionTrace`), so a new field
  cannot be added without being listed.

## Why it generalises

Same defect family as the epic rail-6 cases, one level up: the sweep *has* cases today,
but the case list is unguarded. Whenever a test's coverage is parameterised by a
constant — key lists, code tables, fixture arrays, seed counts — the constant needs its
own assertion or the coverage is one careless edit from evaporating.

## Same shape one level down: a SCAN ROOT is a case list too

2026-08-09, `task-fdf3e6aa`. A tripwire scanned `src/**` for two forbidden ids and
asserted zero offenders. Its non-vacuity guard was `expect(files.length)
.toBeGreaterThan(0)`.

**That is not a coverage guard.** A root that silently narrowed to ONE directory
still returns >0 files and still reports zero offenders — the scan passes while
covering a fraction of the tree, and stays green on the exact day the forbidden id
lands in a directory it stopped visiting.

The root was derived by hop count (`join(dirname(THIS_FILE), "..")`), so any move
to a different depth narrows it silently. What actually protected it was an
unrelated-looking line — `expect(scanned.length - files.length).toBe(1)`, written
to guard a self-exclusion — because it can only pass if the scanning file is
INSIDE the root. Delete the self-exclusion and that coverage proof vanishes with
it. (Caught by worker-5981deec when worker-4addc779 proposed exactly that cleanup.)

Replacement that keeps both properties:

```ts
expect(SOURCE_ROOT.endsWith(join("src"))).toBe(true);                    // root is src/
expect(scanned.some((f) => f.includes(join("src", "board")))).toBe(true); // reached ANOTHER dir
expect(scanned.length).toBeGreaterThan(20);
```

The middle line is load-bearing: it is the only one that fails when the root
collapses toward the scanning file's own directory.

**Rule:** a count is not evidence of coverage unless something pins WHAT was
covered. Applies to key lists, code tables, fixture arrays, seed counts — and to
directory scans, glob roots and file enumerations, which are the ones people
forget because they do not look like test data.

## Contrast: a table that IS safe

The same file's `it.each` table of five definition-time failure codes passed the probe
cleanly. Breaking one branch (SELF_LOOP emitting ROUTE_CYCLE) failed exactly one row
with a discriminating message, `expected 'UPCAST_ROUTE_CYCLE' to be 'UPCAST_SELF_LOOP'`.
Per-row failure with per-row expected codes is what stops two bugs sharing one green
assertion — the table is safe because each row asserts its own distinct code, not merely
that compilation failed.

## Related

`mem:pattern-assert-which-layer-refused`, `mem:pattern-qa-mutation-testing-the-claim`,
`mem:gotcha-phantom-400-net-loc-task-bar`
