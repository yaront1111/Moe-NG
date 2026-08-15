# Handoff: Effect intent lifecycle + one-use activation gate — SHIPPED (child 1 of 4)

Commit `72545bb`, 11 files, 2559 lines, all under `packages/runner/src/supervisor/`.
Gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` exit 0,
**388/388 tests across 10 files** (235 of them supervisor). Plan memory (pre-build) was
the earlier version of this note; this replaces it with what actually landed.

## What exists now (module map)

| File | Lines | Role |
|---|---|---|
| `effect-shape.ts` | 238 | hostile-input guards + structurally mirrored `MirroredLeaseRecord`/`Proof`, `MAX_SUPERVISOR_COUNT` |
| `effect-kernel.ts` | 250 | frozen vocabularies, 30-code `SUPERVISOR_ERROR_CODES`, `SupervisorFailure`/`withLeg`, all records, `EFFECT_CALLER_CONTRACT` |
| `effect-parse.ts` | 165 | exact-own-key parsers, all return `null` (caller picks the code/layer) |
| `effect-lifecycle.ts` | 253 | `ADMITTED_EFFECT_TRANSITIONS` + `applyEffectCommand` + `applyEffectTombstone` |
| `lease-mirror.ts` | 113 | `fenceMirroredLease` — re-validating clone of `fenceAuthority` |
| `effect-grant.ts` | 148 | `consumeActivationGrant`, `validateActivationCommit`, `deriveGrantId`, `activationDigestInput` |
| `effect-activation.ts` | 257 | `activateEffect` 10-leg gate + `ActivationCommit`; re-exports the grant surface |
| `effect-test-fixtures.ts` | 191 | builders with `unknown`-typed overrides + `withGetter`/`withExtraKey` |
| 3 `*.test.ts` | 944 | lifecycle matrix, activation legs, properties/redaction/hostile |

No `.js` bridges (runner convention, verified: zero package-wide). Nothing added to
`packages/runner/src/index.ts` — supervisor stays internal, claude modules are precedent.

## Decisions a later child must not re-litigate

- **Outcome kinds discriminate on `kind`, not `ok`.** `MUST_DRAIN` deliberately has NO
  `ok` field, so `ok === false` matching cannot mistake a drain instruction for a
  rejected command. `REFUSED` is exactly `{kind, failure}` — a refusal structurally
  cannot carry a successor.
- **Grant id derivation avoids a digest cycle.** `activationDigest` covers the effect
  successor, the attempt successor, and the *identity-free* `initialGrantBinding`
  (`state:"UNUSED", version:0`); `grantId = canonicalDigest({activationDigest, intentId})`.
  Because the binding is identity-free and pinned at UNUSED/0, a CONSUMED grant still
  validates against its own commit in `validateActivationCommit`.
- **Settlement never invents a completion.** `settle` needs a shape-validated
  `{reconciliationVersion, reconciliationDigest, outcomeClass}`; target `UNKNOWN` needs
  uncertainty evidence and every other target REFUSES it. `EffectResult` carries
  `settlementDigest = canonicalDigest({settlement, uncertainty})`. Child 2 binds real
  `reconcileClaudeRun` output to this seam — shape only here, no interpretation.
- **`EFFECT_TRANSITION_NOT_ADMITTED` vs `EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED`** are
  distinct: "this state cannot settle at all" is a different instruction to the caller
  than "pick another terminal". The RED run caught this; do not merge them.
- **Mirror has exactly 4 codes** (`LEASE_MIRROR_MALFORMED|STALE|STALE_EPOCH|SUPERSEDED_AUTHORITY`)
  mapping 1:1 onto scheduler's 4 authority codes, precisely so child 4's verdict-equality
  drift test is a clean mapping.

## For child 2 (`task-4a3b5ec0`, launch lock / adoption / drain)

- Extend `ADMITTED_EFFECT_TRANSITIONS` with the design-776 `ACTIVE -> CANCEL_REQUESTED`
  row. The lifecycle matrix test derives its 54 cells from `EFFECT_STATES x EFFECT_COMMANDS`
  but its EXPECTATIONS are a hand-written `DESIGN_ARCS` list compared for equality against
  the production table — so adding a row means updating `DESIGN_ARCS` too. That coupling
  is the point (`mem:gotcha-self-derived-universe-cannot-check-itself`).
- `applyEffectCommand(ACTIVE, requestCancel)` currently returns `MUST_DRAIN`. Once 776
  lands, decide explicitly whether that becomes a transition or stays a drain instruction;
  the test asserting `"ok" in outcome === false` pins the current answer.
- `validateActivationCommit` is the restart-reconciliation entry point: hand it the three
  rehydrated records and it machine-checks together-or-neither.

## For child 4 (`task-49acb856`, hardening gate) — DO NOT MISS

Runner tests **cannot** import `@moe/scheduler`. The mirror-vs-`fenceAuthority`
verdict-EQUALITY drift test is deferred to child 4 via the **daemon** package (has
scheduler; gets runner via child 3's approved ownership amendment). Child 1 shipped
hostile-fixture parity only. Map: `LEASE_MIRROR_MALFORMED`↔`AUTHORITY_MALFORMED_INPUT`,
`LEASE_MIRROR_STALE`↔`AUTHORITY_STALE_LEASE`, `LEASE_MIRROR_STALE_EPOCH`↔`AUTHORITY_STALE_EPOCH`,
`LEASE_MIRROR_SUPERSEDED_AUTHORITY`↔`AUTHORITY_SUPERSEDED_AUTHORITY`.

## Caller contract (published as DATA, `EFFECT_CALLER_CONTRACT`, asserted by a test)

1. effect + attempt + grant successors in ONE transaction, CAS on BOTH the intent version
   and the attempt version read at revalidation;
2. committing an `EffectTombstone` MUST bump the intent's version, or the
   tombstone-vs-activate race stays open (a pure function cannot see a tombstone that
   commits after revalidation);
3. grant-id uniqueness and (aggregate, idempotencyKey) uniqueness are STORE indexes;
4. the OS-exclusive launch lock is the physical duplicate-launch backstop — the grant is
   only the logical linearization token.

Related: `mem:gotcha-python-inplace-edit-flips-line-endings`,
`mem:convention-hostile-shape-reads-in-pure-kernels`,
`mem:task-task-312c1de3c76a4f1dbd8da5c34e629b0e-handoff`.
