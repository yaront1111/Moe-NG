# task-fa96b81c — Readiness explanation engine (worker handoff, LANDED)

Commit `bf6bc818` on `moe/work-2026-08-08`. Gate: `pnpm --filter @moe/scheduler test`
= **36 suites / 675 tests passed**, exit 0 (baseline before this task: 32 / 593).
`typecheck` exit 0. Owned path only: `packages/scheduler/src/readiness/**`.
`graph-model.ts` and `frontier.ts` untouched — verified by `git diff --stat`.

## What landed (6 production modules + 6 `.js` bridges + 4 test files + fixtures)

| file | lines | role |
|---|---|---|
| `readiness-model.ts` | 195 | closed vocabulary only, zero derivation |
| `readiness-fact-shapes.ts` | 114 | byte-level hostile-shape parsers |
| `readiness-facts.ts` | 175 | classify caller bundles into `FactConfidence` |
| `readiness-cursor.ts` | 173 | builds the `FrontierCursor` + refusal helpers |
| `readiness-projection.ts` | 240 | the three layers, composing `partitionFrontier` |
| `readiness-explanation.ts` | 170 | classify + order + failed-predecessor record |

`test-fixtures.ts` deliberately shares the name of the package's existing
bridge-exempt fixture so the shim audit keeps ONE exception rule.

## The design decision a reviewer will question first

`graph-model.ts:252-260` says withhold the WHOLE partition if any availability is
unknown; DoD 3 says unknown facts must not hide structurally ready work. Resolution:

- `logicalReady`/`blocked` come from `partitionFrontier` and are functions of
  hard-edge facts ALONE (`frontier.ts:388` pushes to `logicalReady` before reading
  any availability), so they are always reported.
- `projection.partition` is the branded object `analyzeGraphStructure` consumes for
  WIDTHS. It is `null` whenever `withheld === "AVAILABILITY_UNKNOWN"`, so widths
  stay UNKNOWN. That is where the graph-model contract actually bites.
- `admissionReady`/`dispatchable` remain published as **CONFIRMED lower bounds**.
  Membership requires every predicate CONFIRMED_TRUE, so acting on them is safe
  even while another node is unknown. Documented on the interface.

## Two structural choices worth keeping

- **`weaken(inner, outer)`** makes `dispatch ⊆ admission ⊆ logical` true by
  construction, not by convention. `dispatchable` is appended at exactly ONE site.
  Collapsing a layer requires editing `weaken`.
- **No path writes an availability boolean from a non-CONFIRMED fold.** Three
  branches: non-execution-bearing (`false` is the design-8.3-rule-5 truth),
  withheld (uniform node-independent sentinel, partition discarded), and all-
  confirmed (faithful encoding). The uniform sentinel is the subtle one — it
  encodes no per-node claim.

## Classification order (earlier arm wins, deliberately conservative)

1. no execution authority → `UNSAFE_OR_UNKNOWN`
2. ANY `UNKNOWN` reason → `UNSAFE_OR_UNKNOWN`
3. CURRENT wait record → `INTENTIONAL_WAIT`
4. `dispatch === CONFIRMED_TRUE` → `READY_NOW`
5. exactly one remaining AND its `recoveryRef !== null` → `UNBLOCK_NEXT`
6. else (incl. >1 remaining, still fully enumerated) → `UNSAFE_OR_UNKNOWN`

Rank 0/1/2/3, sorted by `(rank, remainingCount, nodeKey)`. A multi-predicate node
therefore lands in the conservative bucket and can never sort ahead of a one-step
item — design 8.2's "UI optimism cannot place it nearer to ready".

## Adversarial review caught three real gaps (all fixed RED-first)

1. `projectReadiness` read `graph.nodes` before any provenance check → now guarded,
   passing through the landed `GRAPH_VALIDATION_PROVENANCE_INVALID`.
2. `explainReadiness` accepted a projection from a DIFFERENT graph; its descendant
   closure came back silently empty. Now throws `GraphAnalysisError`
   `FRONTIER_GRAPH_IDENTITY_MISMATCH`, the same class/code `analyze-graph.ts:72` uses.
3. The cursor derived availability from a possibly-UNKNOWN fold for advisory nodes.

## Mutation drill — all seven red, restores verified by **sha256**, not `git diff`

(a) UNKNOWN→CONFIRMED_FALSE 6 fails · (b) drop withhold 2 · (c) advisory reaches
dispatchable 5 · (d) drop producer-known arm 1 · (e) drop wait CURRENT check 2 ·
(f) invert class rank 2 · (g) collapse admissionReady 4. Every run still reported
4 suites, so nothing broke a file into a silent zero-test pass.

See `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.

## Consumer notes for the next task (Fair scheduler production, task-10cab3e5)

- Nothing is exported from `packages/scheduler/src/index.ts` — `index-surface.test.ts`
  hand-transcribes the root namespace and it is NOT an owned path here. If the fair
  scheduler needs `projectReadiness`/`explainReadiness` at the package root, that
  export is a deliberate change to an unowned file and belongs to that task.
- `explainReadiness(graph, projection)` THROWS on identity/provenance mismatch;
  `projectReadiness` returns a result union. Different failure shapes on purpose:
  the first mirrors `analyzeGraphStructure`, the second mirrors `partitionFrontier`.
- Caller bundle shape: `{nodeKey, currentGate, facts[], wait, currentFactVersions}`;
  one bundle per graph node is REQUIRED (missing one refuses), matching frontier's
  own coverage contract.

Related: `mem:gotcha-scheduler-js-shims`, `mem:gotcha-vitest-hides-missing-js-bridge`,
`mem:gotcha-bare-specifier-probe-needs-an-in-repo-referrer`,
`mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.
