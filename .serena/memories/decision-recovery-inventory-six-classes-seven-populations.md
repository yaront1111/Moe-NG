# Recovery inventory: SIX proof classes, SEVEN populations — both numbers are right

## The apparent contradiction, and why it stalled a CRITICAL task

architect-a42f4965 blocked task-cf7fb147 (Recovery inventory quarantine coordinator) at HEAD
c0c5929 over a cardinality conflict that looked unresolvable:

> design line 978 names 7 populations; CORE-S14 names 6 categories; runner contract has 4 combined
> classes; adding resource yields 5 proof classes; description lists 6; DoD says 7.
> **Do not duplicate combined proofs to fabricate seven.**

That block was correct at the time. task-f6cf8d16 then froze the mapping, and the answer is that the
numbers live on **two different axes** — nothing was ever contradictory.

## The frozen contract (apps/daemon/src/recovery/recovery-inventory-contract.ts)

    RECOVERY_PROOF_CLASSES (6)        :36
      PROVIDER_PROCESS_LAUNCH_LOCK, RESOURCE, WORKSPACE,
      INTEGRATION_TARGET, GIT_INTEGRATION_ON_DISK, ARTIFACT_OBJECT_STAGING

    RECOVERY_INVENTORY_POPULATIONS (7) :56
      EFFECT_LOCK_WRAPPER_REGISTRATION, PROVIDER_RUN, RESOURCE,
      PROJECT_TAGGED_WORKSPACE, INTEGRATION_TARGET, GIT_BRANCH_REF, ARTIFACT_STAGING

    RECOVERY_CLASS_POPULATION_ROWS     :69   (row order is canonical, per :68)
      PROVIDER_PROCESS_LAUNCH_LOCK -> [EFFECT_LOCK_WRAPPER_REGISTRATION, PROVIDER_RUN]   <-- 2:1
      RESOURCE -> [RESOURCE] ... etc.

Seven collapses to six **because one class covers two populations**. That is the production mapping,
not a fabrication — which is exactly the distinction the "do not duplicate proofs" warning drew.

Where the six come from: **4 node-side** (`packages/runner/.../recovery-inventory-contract.ts:24`
RECOVERY_INVENTORY_CLASSES, layer INVENTORY_ADAPTER) **+ 2 durable daemon-side**
(`durable-recovery-inventory-contract.ts:33` = RESOURCE, INTEGRATION_TARGET).

## Consequence for anyone reading that task's DoD

DoD 1's six named items ARE the proof classes. **DoD 6's "all seven configured classes" is stale
wording** that conflates populations with classes. The fix is NOT to narrow the DoD and NOT to
invent a seventh class — assert **both** cardinalities, each from its own imported production array.
That is strictly stronger than picking one number and satisfies both honestly.

Pin the class NAMES and population NAMES **literally**, deriving only the COUNT from the arrays. An
assertion that derives its expected names from the array under test compares the array with itself
and survives every rename and silent addition.

## Also settled while measuring (HEAD a967199)

- **DoD 4 is already satisfied** by task-e33747f9, not by the coordinator:
  `activation-ingress.ts:286 runEffectActivateCommand` reads `readActivationEmbargo` at **:299**
  BEFORE `claimStage` at **:303**, and claimStage calls `claimWork` from `../work/work-claim.js`.
  `activation-embargo.ts:32` pins `ACTIVATION_EMBARGO_CODE = "RECOVERY_RECONCILIATION_REQUIRED"`,
  and `unreadableStore()` at :92 HOLDS the embargo when the store cannot be read (fail-closed).
- **Still open**: `restart-reconciliation.ts:235 reconcileOnRestart` iterates `request.attempts`
  at :241 — caller-supplied. None of the four prerequisites closed it; it is the coordinator's work.
- Already landed and must be COMPOSED, never rebuilt: `recovery-inventory-record.ts:126`
  `buildRecoveryReconciliationRecord` (with CLASS_EXTRA/CLASS_UNKNOWN/CLASS_OMITTED at :98-105),
  `recovery-inventory-ledger.ts:144/:242` record+read, plus -proofs/-invariants/-reader/-codec.
- `recovery-inventory-ledger.ts` (289) and `-contract.ts` (287) are ALREADY over the 250 target and
  under 400 — pre-existing, not a new task's to fix, but do not grow them.

Related: `mem:gotcha-a-landed-family-can-be-complete-and-unconsumed`,
`mem:qa-generated-table-cannot-police-its-own-generator`, `mem:count-the-nouns-in-an-enumerated-dod`.
