# Durable OS-protected recovery key provider — worker handoff (LANDED, in REVIEW)

Built by worker-01abf979, 2026-08-10. Gate: `pnpm --filter @moe/daemon typecheck && test` exit 0,
57 files / 883 tests (baseline 55 / 872). Commit 79ac8e2 + two foreign sweeps (fec9488, 2847455).

## What shipped — TEN files under apps/daemon/src/recovery/, all new

| file | lines | role |
|---|---|---|
| `recovery-key-provider-contract.ts` | 250 | vocabulary, protection union, port, refusals, request + snapshot |
| `recovery-key-epoch-store.ts` | 250 | pointer aggregate id/encode/decode/read/write + succession-record writer + `readRecordedSuccessor` |
| `recovery-key-provider.ts` | 249 | pure orchestrator, `createRecoveryKeyProvider(crypto, port).open(store, request)` |
| `recovery-key-provider.node.ts` | 185 | the host port |
| `recovery-key-provider.test.ts` | 464 | pure suite |
| `recovery-key-provider.node.test.ts` | 280 | real process death + host mechanism |
plus four one-line LF `.js` bridges.

The plan said EIGHT files. The contract was 290 lines as one file, so it split the way
`recovery-incarnation-contract.ts` / `recovery-succession-contract.ts` already split. Disclosed, not absorbed.

## The design decision that matters most

`open()` returns a `RecoveryKeyEpoch` whose `originIncarnationRef` is the STABLE identity across
restarts and whose `incarnationRef` / `publicKeySpkiHex` MUST differ every open. Never resurrect a key.

Reopen path composes the four EXPORTED succession functions individually — NOT
`createRecoverySuccessionService(...).succeed`. Two reasons:
1. `succeed` destroys the successor handle in a `finally` (recovery-succession.ts:363) and returns none.
2. Decisive: drills (b)/(c)/(d) require `verifyAnchoredPredecessor` / `mintSuccessor` / `proveSuccession`
   to be MY call sites. Delegating makes those drills unrunnable without editing a landed file in the
   shared worktree.
Because `commitSuccession` is module-private, the record is written on its OWN terms exactly — same
command kind, same predecessor-keyed aggregate via exported `successionAggregateId`, same
`expectedVersion: 0`, same `recovery-succeed:<pred>:<succ>` id. The store therefore still refuses a fork
across BOTH writers. Then the chain is read back through the LANDED `readSuccessionChain`, which is the
authority on the origin — the pointer is only a hint.

## The one new durable artifact

`recovery-key-epoch:<digestOf("key-epoch-pointer", projectId, restoreCommandId)>` on the SAME
SqliteEventStore. It exists because a dead process holds nothing and every incarnationRef is
entropy-derived, so NOTHING is recomputable; this aggregate is the only thing addressable from the
restore command alone. Read as THREE states (ABSENT / PRESENT / UNREADABLE) — collapsing UNREADABLE into
ABSENT silently forks the epoch. Advanced with `expectedVersion: pointer.generation`.

## Beyond the plan, forced by correctness

`resolveHead()` + `readRecordedSuccessor()` follow succession records FORWARD. ANCHOR → RECORD → ADVANCE
is three writes; a death between the second and third leaves a head that is ALREADY succeeded, and the
retry would lose to `expectedVersion: 0` forever and wedge the epoch permanently. Named test:
"a crash between the succession record and the pointer advance heals".

## Vocabulary

Only FOUR codes minted: `RECOVERY_KEY_EPOCH_INPUT_INVALID`, `RECOVERY_KEY_PROTECTION_UNAVAILABLE`,
`RECOVERY_KEY_PROTECTION_UNVERIFIABLE`, `RECOVERY_KEY_EPOCH_POINTER_UNREADABLE`. Everything else
propagates a succession refusal VERBATIM with layer `RECOVERY_SUCCESSION`, so evidence names the layer
that actually refused. Input-invalid is minted rather than reused because succession's reads "must name
exactly one predecessor incarnation" and a provider request must NOT name one.

## Platform mechanism

- win32 `WIN32_DACL_EXPLICIT_OWNER_ONLY`: `icacls <dir> /inheritance:r /grant:r "<whoami>:(OI)(CI)F"`,
  then the READ-BACK decides — exactly one ACE, our identity, `(F)`, no `(I)`. Identity from
  `%SystemRoot%\System32\whoami.exe`, never `%USERNAME%`. Both tools resolved under SystemRoot, not PATH.
- darwin/linux `POSIX_MODE_0700_OWNER_ONLY`: chmod then stat on mode AND uid.
- anything else: typed UNKNOWN. No mode bits and no fsync claim on win32.

## Open items for whoever picks this up

- Consumers (Clause 1): `task-b6e3dd2af916490fb2bc4d375a530683` (two-slot anchor installer) composes
  this; `task-8a01c025b65246aca09e69d82e009587` is the downstream auth consumer. NOTHING imports the
  provider yet outside its own tests.
- `store.readEvents` is bounded at MAX_PAGE_SIZE 1000 and THROWS past it (documented in code). 1000 opens
  of ONE restore command is the ceiling; it fails loudly, never silently.
- Residual: if `finish()` refuses AFTER the three writes (chain unreadable / origin disagreeing) the
  store has advanced while the caller sees a refusal. Reachable only from an already-inconsistent log;
  the next open resolves the new head.
- Repo-wide foreign red at handoff: `tests/fault/foundation/j1-linear.test.ts >
  incident:hot-claim-loop-on-gated-work` — a behaviour declared absent in
  `packages/testkit/src/foundation/foundation-incident-schedules.ts:112` has since landed. Not ours.

Related: `mem:gotcha-fake-port-makes-host-drill-vacuous`,
`mem:gotcha-node-dash-e-argv-index-off-by-one`, `mem:gotcha-empty-absent-unreadable-need-three-answers`.
