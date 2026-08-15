# Handoff: Lease presence core (IMPLEMENTED, commit c0b564e)

`packages/scheduler/src/authority/**`, 21 files, +2535. Verification
`pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test`.
Focused suite: 6 files / 131 tests green.

## Landed module map (plan said 3 prod modules; shipped 7, all <=250 lines)

| module | role |
|---|---|
| `authority-kernel.ts` | frozen vocabularies, counters/limits, core record types, result primitives, hostile-input helpers, 3rd-clone `deepFreeze`/`compareStrings` |
| `lease-fencing.ts` | `parseLeaseRecord`/`parseProof`/`parseClock` + `fenceAuthority` (the ONLY authority gate) |
| `lease-state.ts` | `fencedRenew`, `markSuspect`, `extend`, `confirmRevoke`, `restartReconstruct`; re-exports the public surface so `./lease-state.js` stays the named entry |
| `lease-drain.ts` | `applyDrainReason`, `releaseWork` (all three design-765 branches) |
| `lease-resource.ts` | `reserveAll`, `adapterConfirm`, `adapterFail`, `reserveProviderSlot`, `grantSuccessorCapacity` |
| `resource-model.ts` | resource vocabularies/shapes/parsers |
| `presence.ts` | `openPresence`, `acceptPing` — imports ONLY `../runtime-shape.js` |

Tests: `lease-state.test.ts`, `lease-release.test.ts`, `lease-resource.test.ts`,
`presence.test.ts`, `authority-kernel-invariants.test.ts`, `authority-races.test.ts`,
plus `test-fixtures.ts` (no `.js` shim — matches `../test-fixtures.ts`).
All 7 production modules have their one-line `.js` shim.

## Decisions a successor must not relitigate

1. **Slot vocabulary is THREE-state** `RESERVED|ACTIVE|RELEASED`, not the plan's two —
   `RUNTIME_LIFECYCLES.PROVIDER_SLOT` and design line 222 are three-state. Only `RESERVED`
   is minted here; `effect.activate` is out of scope.
2. **Dueness is a server-wall fact only.** A boot-id change must NOT make a live lease
   overdue — the first draft did, which would mark every ACTIVE lease SUSPECT on every
   daemon restart. `bootId` scopes the monotonic observation and nothing else.
3. **Token redaction is scoped to REJECTIONS.** The accepted result returns the
   authoritative record with its `leaseToken` — a lease row without its token is unusable.
   Only the rejection-security record and error paths are token-free (epochs stay, because
   the registry requires `expectedEpoch`/`observedEpoch`).
4. **Counter ceiling** — see `mem:gotcha-authority-counter-ceiling`. Two bounds: parse
   `<= MAX_AUTHORITY_COUNT`, mutate `< MAX_AUTHORITY_COUNT`.
5. **`releaseWork` NO_OP returns a fresh record at the SAME version.** Any invariant of the
   form "a new object implies version+1" is wrong; the right one is
   `versionDelta in {0,1}` and `state change implies 1`.
6. **DoD-2 is proven by the static source scan**, not by behaviour. `presence.ts`'s import
   list is asserted to be EXACTLY `["../runtime-shape.js"]`, every lease module is asserted
   to have zero `presence` specifier, and a third test asserts the scanned production-file
   list equals the expected set so a NEW module cannot escape the ban.
7. **`applyDrainReason` guarantees are per-application**, not historical: given a
   disposition, applying a reason never drops one and never lowers the strongest. Durability
   of the accumulated set belongs to the persisting transaction; a self-inconsistent
   disposition (strongest not in its own reason set) is refused.

## Non-vacuity numbers (quote these, do not re-derive)

Race harness: 5 seeds x 240 steps, 5-member asserted-good state pool, 70/30 honest/tamper
bias, 10-command alphabet including resource ops. The test asserts the observed
outcome-kind SET equals an exact 18-entry list. Counts:
`AUTHORITY_STALE_LEASE 460, AUTHORITY_MALFORMED_INPUT 29, AUTHORITY_STALE_EPOCH 26,
AUTHORITY_SUPERSEDED_AUTHORITY 4, ACCEPT:ACTIVE 90, ACCEPT:SUSPECT 11, ACCEPT:DRAINING 38,
ACCEPT:RELEASED 37, ACCEPT:REVOKED 68, ACCEPT:NO_OP 16, ACCEPT:DRAIN:REVOKED 130,
ACCEPT:DRAIN:RELEASED 3, ACCEPT:RESERVED 57, ACCEPT:WAITING 52, ACCEPT:RESOURCE_ACTIVE 20,
ACCEPT:RESOURCE_HELD 36, RESTART:0 75, RESTART:1 48`.

## Explicitly OUT of scope (do not assume it exists)

Capability check (needs the auth boundary; scheduler is dependency-free), successor claim
(`work.claim`), provider launch / `effect.activate`, OS locks, policy decisions, graph
fan-out, and M2 queue selection (priority/ticket/aging deliberately absent from
`ResourceWaitRequest`).

## Size caveat for QA

+2535 LOC across 21 files is far over the ~400 net-LOC batch bar in
`mem:gotcha-task-size-vs-module-size`. This is plan-scoped, not drift: the approved plan
named 7 steps covering four separate concerns (fencing, drain/release, resource
acquisition, presence) plus a race harness, and every DoD item needs its own evidence. The
seam for any future re-scoping is already in the file layout: fencing+state / drain /
resource / presence.
