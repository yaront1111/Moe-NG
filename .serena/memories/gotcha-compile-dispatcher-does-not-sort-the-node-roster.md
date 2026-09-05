# `planning.submit_decomposition` refuses an UNSORTED node roster, with a code that says nothing

Measured 2026-09-05 (worker-75411639, task-b8a389bb) against the live UnAI daemon on branch
`moe/work-2026-09-04`, then reproduced read-only against the production authority.

## The behaviour
`compile-dispatcher.ts:212-224` seals each node's `criterionIds` as an ascending SET —

```ts
// "A SET, never the agent's listing: order and repeats are not plan facts, and the
//  plan codec admits only an ascending, duplicate-free set."
criterionIds: Object.freeze([...new Set(criterionIds)].sort()),
```

— but it leaves `structure.nodes` in the AGENT'S ORDER. The graph codec applies the same
ascending rule to the node roster, so a plan whose nodes are not sorted by `nodeKey` throws
`GRAPH_CONTENT_FIELD_INVALID@GRAPH_CONTENT_CODEC` inside `createCompiledPolicyAuthorityBody`.

## Reproduction (no daemon needed)
Import `compiledPlanAuthority` from `apps/daemon/src/planning/compiled-authority-bodies.ts`,
feed it a real approved revision plus `COMPILED_NODE_RISK_PROFILE`, and vary ONLY node order:

    keys n-alpha / n-beta / n-omega       ok=true
    keys alpha  / beta   / omega          ok=true
    keys n1     / n2     / n-completion   ok=false  GRAPH_CONTENT_FIELD_INVALID@GRAPH_CONTENT_CODEC
    keys n-one  / n-two  / n-completion   ok=false  (same)
    keys zeta   / alpha  / beta           ok=false  (same)

`n-completion` sorts BEFORE `n-one`, so "completion node last" — the natural way a planner
writes a DAG — is exactly the failing shape.

## Why it is expensive
`compiled-authority-bodies.ts:113/127` produce a real message (`${approval.code}@${approval.layer}`
or the `CompiledPolicyAdmissionError` text) and the dispatch layer DISCARDS it: the seat receives
`{"code":"COMPILED_PLAN_ADMISSION_REFUSED","detail":"COMPILED_PLAN_ADMISSION_REFUSED"}`. A real
`claude` planning seat burned a whole session on SEVEN shapes (6 and 10 nodes, depth 1-3, fan-out
4-6, short and long keys) and never moved the refusal, because nothing it varied was the cause.

Related, same seat, same session: a node with `criterionIds: []` CRASHES the submit with
`MCP error -32603 UNKNOWN_ERROR` instead of refusing, so a plan cannot use a pure sink
completion node.

## The workaround that actually ships a plan
The goal's OPERATOR INSTRUCTIONS reach the compiler mission: the browser's new-goal
`outcome` + `acceptance criteria` become `brief.instructions`
(`live-goal-create.ts:42-56 briefOfDraft`), which `agent-wrapper-main.ts:244 compilerInstructions`
reads back and `compilerMission` embeds between `<<<OPERATOR INSTRUCTIONS` markers. Typing
"List the structure.nodes array in ASCENDING nodeKey order" into the new-goal form made the next
real seat seal a 5-node DAG on its FIRST submission.

## The fix
One line at `compile-dispatcher.ts:212`, symmetric with the `criterionIds` sort — or say it in
`compilerMission`. Owner row: task-f79d38b1 (the compiler seals N nodes).

Related: `mem:task-task-b8a389bb78604b2e8224f0bd11675ee3-handoff`,
`mem:gotcha-file-authored-node-spec-disables-the-compiled-dependency-gate`.

## FIXED 2026-09-05 (same day, later session)
`compile-dispatcher.ts` now sorts `sealedNodes` by `nodeKey` (code-unit order, the codec's own
`<=`) after sealing, and seals `dependsOn` as a sorted SET (a repeated producer used to refuse
`GRAPH_DUPLICATE_EDGE`). `compile-dispatcher.test.ts` pins that c,b,a and a,b,c seal the SAME
`graphContentHash`. The producer also gained two shape fences: `criterionIds: []` refuses
`COMPILED_PLAN_MALFORMED "node X binds no criterion"` (was a plain throw = MCP -32603), and node
keys longer than `COMPILED_NODE_KEY_MAX_CHARS` (61 = (128 - "dep---".length) / 2) refuse
`node key ...` instead of `GRAPH_MALFORMED_EDGE` one layer down. The dispatch edges forward the
producer's `detail` now — see `mem:gotcha-seat-refusals-echoed-the-code-as-detail-until-2026-09-05`.
The operator-instruction workaround above is no longer needed.
