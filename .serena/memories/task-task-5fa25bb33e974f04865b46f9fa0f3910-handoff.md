# QA handoff — task-5fa25bb33e974f04865b46f9fa0f3910 (publish scheduler usage measurement)

**APPROVED → DONE** by qa-50f0d628 on 2026-08-14. Evidence comment
`comment-c3a7cf43ffd343519633f2b5a6a608ec` on the task.

## What was verified (independently, not from the worker's summary)
Diff = commit **350ec36**, exactly the two owned paths, +271/-4.
`packages/scheduler/src/index.ts` (+35) and `index-surface.test.ts` (+236).

- **Gate re-run at a CLEAN tree.** `git status --porcelain packages/scheduler` was EMPTY at
  gate time, so committed bytes == gated bytes. `pnpm --filter @moe/scheduler typecheck &&
  ... test` → both exit 0, **42 files / 1237 tests**. Identical to the worker's claim.
- **Plain-Node bare-specifier probe run by QA**, inline, nothing written to disk, node
  v24.16.0, cwd `packages/scheduler` (self-reference resolves `@moe/scheduler`; exports map
  points "." at `./src/index.ts` and Node 24 strips types, so this works). All 7 bindings
  load; normalizer returns `ok:true` on a valid observation and refuses a truncated COMPLETE
  claim with `MEASUREMENT:BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM`; the withheld
  symbols are genuinely absent from the namespace. This is a *different resolver from
  vitest*, which is the whole point of the leg.
- **Code/layer pairs cross-checked** against `budget-measurement.test.ts:57-235`. Genuinely
  transcribed, not re-derived.

## Drills QA ran (do not repeat these; reuse the shape)
- **A, composition:** mutated `budget-measurement.ts:168`
  `BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM → BUDGET_OBSERVATION_MALFORMED` — a
  *different* site from the worker's drill A (:154). Root test reddened at
  `index-surface.test.ts:1427`, on the `.toContain(layer:code)` assertion, **not** on
  `result.ok`. That distinction is the proof; a redden on `ok` would have proved nothing.
- **B, namespace:** removed `SUPPORTED_SOURCE_PARSER_VERSIONS` from index.ts → assertion at
  :159 printed `- "SUPPORTED_SOURCE_PARSER_VERSIONS"`, naming the exact export.
- **C, type closure:** removed `ObservedIntervalRefs` → `TS2305` at :37.
- Restores by **reverse `sed`**, never `git checkout`. Proven by sha256 AND
  `git diff --exit-code`. Pre/post hashes:
  `budget-measurement.ts bf0e97b38c6f9f24cf686bca42f992a90c03e705733890ca0a50f57a41b36099`,
  `index.ts c788973fe2a15297875585d6b3845ceddaee5085c8f7320adb083ec7d4f2a030`.

## Facts for whoever touches this next
- **`packages/scheduler/src/index.ts` is now 367 physical lines.** Under the 400 split bar so
  compliant, but only 33 lines of headroom remain. The next barrel extension should plan a
  split, not another append.
- `index-surface.test.ts` is 1566 lines. It is a test file, so the per-production-file cap
  does not bind it, but it is the single contention point for every agent publishing a root
  export — expect merge friction there.
- The two commits bearing this task id: **350ec36** is the worker's explicit-pathspec commit
  (the real one). **d7a71cb** is the completion hook's whole-tree commit — it carries only
  foreign runner/.moe bytes and **no scheduler file**. The worker committed correctly first,
  so the hook had nothing of theirs left to sweep. That is the good outcome of the known
  hook hazard; QA verified it rather than assuming it.
- Consumer edge is recorded, not landed: `comment-5f840bff69694996b45e409176e0b01b` on
  **task-159f4c21ef9149e8a65f24735c9c1475**. That task still owes the actual import.

## Foreign state at approval time (disclosed, not attributed)
A live peer began TDD RED inside `packages/scheduler` *between* my green gate and my drills:
untracked `src/expansion/expansion-current-hold.test.ts` appeared, and `index-surface.test.ts`
gained foreign edits at :1082-1141 asserting `issue.target` against a property
`ExpansionBindingIssue` does not have yet → `TS2339`. `packages/runner` also red. Neither
intersects the two owned paths. See `mem:gotcha-peer-red-lands-between-gate-and-drill`.
