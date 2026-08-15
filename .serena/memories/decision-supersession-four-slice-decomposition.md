# Decision: the graph supersession engine is four slices, and the file estimate was wrong twice

Recorded 2026-08-09. Two architects sliced this in sequence; the second correction is the useful part.

## Final shape
```
task-dddfaf83  Graph supersession engine            BLOCKED shell (split by architect-d46fcb95)
├── task-6b8d0e2e  Core revision supersession       BLOCKED shell (re-split by architect-db2146e3)
│   ├── task-14eb91a1  Core supersession decision kernel      4 files, PRODUCER
│   └── task-1df0622e  Graph revision supersession transition 8 files, CONSUMER (needs the kernel)
└── task-06985368  Scheduler supersession dispositions        needs the kernel vocabulary
```

## The estimate error worth learning from
I sized the core slice at **8 files**. architect-db2146e3 re-measured and found **12**, because a real `graphEpoch` reaches four files I never looked at:

- `graph-revision-test-fixtures.ts` — a durable epoch changes every fixture
- `planning-invariant-drivers.ts` — still manufactures a **refusal-only** `graph.supersede` command
- `planning-invariants.test.ts` — asserts ACTIVE rejects *every* command, which a real supersede falsifies
- `graph-revision-results.ts` — must surface the refusing layer, because `@moe/contracts` `RuntimeError` **drops its validated `source`**

**Generalisation:** when adding a required field to an aggregate's state, the blast radius is not the aggregate's own files. Grep for the aggregate's *fixtures* and its *invariant drivers* too — shared test drivers that manufacture commands are production-shaped dependencies of a schema change, and they are invisible if you only inspect contract/reducer/validation.

## Compose, never mint (measured)
- `CARRY_FORWARD_REASON_CODES` already exists at `core/src/policy/approval-contract.ts:22-28` — CANONICALIZATION_UNKNOWN, DEPENDENCY_MISSING, ENVIRONMENT_CHANGED, HASH_MISMATCH, POLICY_SLICE_CHANGED, PREDECESSOR_RESULT_CHANGED — and is root-exported at `core/src/index.ts:192`. The kernel composes it; a second carry vocabulary would fork it.
- `@moe/contracts` already ships `SUPERSESSION_CONSEQUENCE_CHANGED`, `SUPERSEDED_AUTHORITY`, `REVISION_REBOUND` (`runtime-error-registry.ts:14`) and `graph.supersede` (`runtime-vocabulary.ts:94`).
- Drain/resource/budget primitives all exist in `packages/scheduler/src/authority/**` and `budget/**` — see `mem:task-task-dddfaf83f9c644099b5b263e485c58c7-handoff`.

## Ordering
`task-14eb91a1` (kernel) is the only slice with no unbuilt dependency. Everything else waits on it. As of 2026-08-09 it is PLANNING with 0 steps; `packages/core/src/supersession/` does not exist and `core/src/index.ts` has no supersession export.

## Live consumer already written down
`packages/scheduler/src/admission/admission-wait.ts:10` names the engine in a production comment: *"supersession carry of wait/blocker projections -> graph supersession engine"*.
