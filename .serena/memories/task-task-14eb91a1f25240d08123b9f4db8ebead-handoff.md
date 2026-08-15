# Core supersession decision kernel — architect handoff

Plan submitted with 7 steps / 4 distinct files for task `task-14eb91a1f25240d08123b9f4db8ebead`.

## Exact scope
- Create `packages/core/src/supersession/supersession-engine.ts`
- Create exact one-line bridge `supersession-engine.js`
- Create focused production-root test `supersession-engine.test.ts`
- Add a curated explicit block to `packages/core/src/index.ts`
- Named consumer: `task-1df0622e87cf42beae2cd82280e9ff99`

## Contract decisions
- Runtime values: `SUPERSESSION_DISPOSITION_KINDS`, `SUPERSESSION_KERNEL_LAYER`, `decideSupersession`.
- `decideSupersession(currentPredecessor, input)` compares the actual current predecessor with the request's expected predecessor.
- Predecessor binding is revisionId/content hash/epoch; successor also names its predecessor revision/content binding and must be a distinct revision at exactly epoch + 1.
- Dispositions carry nodeKey, kind, predecessor/successor authority hashes, and nullable safeCarry. ADD/REMOVE/CHANGE/REQUALIFY/REEXECUTE/CARRY have closed structural presence/equality rules.
- Safe carry contains two production `CarryForwardInput` records: authority and inputBinding. Call `evaluateCarryForward` for each; never duplicate its six predicates. Any malformed, UNKNOWN, or invalid carry result maps to `SUPERSESSION_CONSEQUENCE_CHANGED` at `SUPERSESSION_KERNEL`.
- Structural/stale/rebound faults take precedence and return `REVISION_REBOUND` at `SUPERSESSION_KERNEL`, with no decision.
- Accepted output is inert deep-frozen data with predecessor SUPERSEDED/successor ACTIVE terminal markers and a deterministic SHA-256 `authorityHash` over versioned length-framed, code-unit-sorted semantic fields.

## Critical live collision
At exploration HEAD `d050258027bffef85497b75b7028136d67b1312a`, `packages/core/src/index.ts` was clean but 237 physical lines. Active task `task-fcad40b6d26243439cd19fd3e49c924d` was WORKING and its approved plan also edits that file; its untracked RED test made the current core package gate red. The implementation must wait until that task is DONE/committed and `index.ts` is clean, then remeasure line headroom and root namespace. Never stage or absorb its bytes. If a readable explicit block cannot keep the root <=250, report blocked/replan.

## Tests and evidence
Tests import the production API/types through `../index.js`, pin the exact six-kind set and a positive exhaustive sweep, exact code plus layer for every refusal, precedence, 128/129 disposition and 32/33 canonicalizer bounds, hostile shapes, permutation/golden-hash behavior, deep freeze/no aliasing, and a hand-measured root namespace count. Transient compile-valid mutants must kill the +1 epoch guard, stored authority/input binding guard, and evaluator invalid/rejection guard, then restore exact bytes.

Final completion evidence command, run last:
`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test`

Repo-wide `pnpm typecheck` and `pnpm test` are additionally compared as path-attributed baseline/HEAD legs; foreign red must be disclosed, never called green.