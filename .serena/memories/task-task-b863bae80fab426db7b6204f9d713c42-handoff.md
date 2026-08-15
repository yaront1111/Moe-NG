# task-b863bae8 (Expansion manual approval binding) — DELIVERED, in REVIEW

worker-767ae903, 2026-08-11. Supersedes the 2026-08-09 block-era note entirely: both
dependencies (`task-2561a780`, `task-dddfaf83`) are DONE and the work landed.

Gate exit 0: `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test`,
26 test files / 471 tests (baseline 25 / 382).

## What landed

```
packages/core/src/expansion/expansion-preparation.ts   360
packages/core/src/expansion/expansion-approval.ts      313
packages/core/src/expansion/expansion-approval.test.ts 838
```

Entry points `prepareExpansion(value: unknown)` and `approveExpansionManually(value: unknown)`.

Bytes were swept into FOREIGN commit **08b7028** (task-584f4af0's whole-tree hook) before I could
stage them. Review by base-ref diff: `git diff e426e5e..HEAD -- packages/core/src/expansion/`.
Worktree and HEAD hashes match on all three files.

## THE TWO `.js` BRIDGES ARE DELIBERATELY ABSENT — read this before "fixing" it

The plan's owned-path list named `expansion-preparation.js` and `expansion-approval.js`. Creating
them reddens `packages/core/src/runtime-entrypoint.test.ts`. See
`mem:gotcha-js-bridge-is-illegal-for-an-unpublished-core-module`. They become correct only when
`task-a1e7f75e` exports these modules from `packages/core/src/index.ts`.

## Design decisions a reviewer or successor will question

**Core CANNOT import @moe/scheduler.** `packages/core/package.json` declares only
`@moe/contracts`; scheduler depends on core. The admitted expansion therefore arrives as INBOUND
DATA under a core-owned closed shape. `grep "from \"@moe/"` over my two production files returns
NOTHING — not even contracts.

**`bound` binds each family exactly ONCE, and that is why the graph binding is missing from it.**
`bound` has 8 keys: admitted, criteria, deadlineEpochMs, fence, funding, graphLifecycle,
policyDecision, supersessionAuthorityHash. `decideSupersession`'s `authorityHash` already frames
revisionId / graphContentHash / graphEpoch / every disposition, so binding those beside it would
make each unfalsifiable — the exact defect
`mem:gotcha-a-digest-can-mask-every-field-it-covers` found on the producer task. They are reached
through `sources.supersession.expectedPredecessor`, whose integrity the recomputed hash proves.
The scheduler's own `identity` digest is REFUSED as an extra key for the same reason plus rail 4:
core cannot verify it, and an unverifiable digest must not gain authority.

**Approval RE-RUNS the whole preparation.** `verifyPreparation` calls `prepareExpansion` over the
stored record's own bound facts and sources, then compares the freshly derived
supersessionAuthorityHash, policy facts and identity. That is what makes `evaluatePolicy` and
`decideSupersession` load-bearing at approval time instead of trusted digests, and it is how
SUPERSESSION_CHANGED and POLICY_CHANGED get distinct codes from PREPARATION_STALE.

**`authorityFencedRef`, not `leaseFencedRef`.** The planning contract's name tripped the
zero-authority key sweep: a substring ban cannot tell a lease FENCED OFF from a lease handed out.
Renamed rather than weakening the ban.

**Manual only.** One `ok: true` return, past `actorKind === "HUMAN"`. `bound.policyDecision.decision`
is read at exactly one line and it is an equality refusal check. Eligibility (ALLOW /
REQUIRE_HUMAN_APPROVAL, decided in preparation) and approval never meet.

**Funding and fence are inbound facts, not landed records.** `grep Funding packages/*/src` returns
nothing repo-wide; core "fence" today means `leaseFencedRef` / `subordinateAuthorityFenced`. There
was nothing to consume, so both get a core-owned closed shape.

## Traps the tests caught (each cost a real debugging cycle)

- Flipping the ADD disposition's `kind` to CARRY does NOT reach
  SUPERSESSION_CONSEQUENCE_CHANGED — `validHashes` refuses it first as REVISION_REBOUND. Reach it
  with a structurally valid CARRY whose `safeCarry.authority.targetHash` disagrees with
  `successorAuthorityHash`. `mem:refusal-test-answered-by-earlier-guard`.
- The zero-authority sweep must NOT descend into `sources`: a policy rule's `effect` field is a
  rule effect, not an execution effect.
- Drill (e) only works if you mutate the CALLER'S object. The reducer snapshots its input, so
  mutating the internal copy is undetectable by construction and proves nothing.

## Fixtures that work

- policy REQUIRE_HUMAN_APPROVAL: one `{tier:"R2", truthClass:"DAEMON_VERIFIED"}` fact, rules all
  ALLOW (design-710 human-only tier). ALLOW: tier R0 plus an opt-in `{action, tier:"R0"}` in the
  LAST slice. DENY: flip a rule effect. HOLD_UNKNOWN: empty `facts`.
- `RUNTIME_LIFECYCLES.APPROVAL_DECISION` is `["APPROVE","REJECT"]` — not "APPROVED".
- A HUMAN record needs truthClass HUMAN_APPROVED + non-null stepUpAuthRef; a SYSTEM_POLICY record
  needs DAEMON_VERIFIED, tier R0/R1, hex64 policyDecisionRef, null stepUpAuthRef and an actor
  matching `^policy:[0-9a-f]{64}$`.

## Open item for the architect/governor

DoD 5 names ARCHIVED `task-9634ed3b72014fe781591c7df9674da2` as the durable consumer. I recorded
the live `task-a1e7f75e9681486cb0a8f93e9397b8b5` and asked for the id to be corrected in
`msg-adbdb389c39e43a9bd98d2fd2b9e6e0d` on #general.
See `mem:gotcha-consumer-edge-named-against-an-archived-task`.

## Known foreign red at HEAD (NOT mine)

`pnpm test`: 2 of 4713 fail, both in `tests/fault/foundation` —
`incident:hot-claim-loop-on-gated-work` (probe scoped `@moe/scheduler`) and
`incident:stale-assets-refuse-handshake` (probe scoped `@moe/contracts`). Both reproduce with all
three of my files physically moved off disk. `pnpm -r typecheck` is exit 0.
