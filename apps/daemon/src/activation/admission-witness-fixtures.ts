/**
 * The DURABLE ADMISSION WITNESSES an `effect.activate` owes once `resolveAdmissionGate` reads
 * them instead of the caller's `payload.budget.gate`.
 *
 * WHY THIS FILE EXISTS, and it is not a convenience. Until the resolver landed, every activation
 * world satisfied its gate with a hand-built `{allowance: {decisionRef: "dec-1", outcome:
 * "ALLOW"}}` in the request payload — bytes no production writer ever emitted. The moment the
 * witness comes from durable records, those worlds carry NO admissible witness at all, and that
 * was measured rather than predicted:
 *
 *   `driveThrough(store, "goal.close")` leaves `${PROJECT_ID}-policy` at
 *   [PolicyInstalled, PolicyEvaluated{decision: "HOLD_UNKNOWN"}] — HOLD_UNKNOWN, not ALLOW,
 *   because `POLICY_SLICE` declares no rules and no opt-ins and `evaluationInput` carries no
 *   tier-bearing fact, so `assessRisk` computes no tier and RISK_TIER_UNCLASSIFIABLE folds the
 *   decision to HOLD_UNKNOWN (core policy-evaluation.ts:53-75, :174-182).
 *
 *   `seedReadyProject` (recovery/restore-test-harness.ts) never drives `policy.install` or
 *   `policy.validate` at all, so its policy aggregate is EMPTY.
 *
 * THE HISTORICAL ALLOW RECIPE IS NO LONGER AUTHORITATIVE. The installed slice still carries its
 * old opt-in, but no durable producer is entitled to supply the tier-bearing fact it needs.
 * `policy.validate` now supplies a null-tier UNKNOWN fact and production therefore records
 * RISK_TIER_UNCLASSIFIABLE / HOLD_UNKNOWN. Existing helper names remain stable only for explicit
 * negative worlds; generic happy worlds use the HUMAN_APPROVAL writer below.
 *
 * EVERY FACT GOES IN THROUGH A COMMAND HANDLER. Nothing here folds an event by hand: the policy
 * decision rides `policy.install` + `policy.validate` and the approval rides `approval.decide`,
 * so a fixture cannot seed a witness the daemon would have refused. The expected versions are
 * READ from the durable ledger rather than hardcoded, because these worlds arrive with the
 * policy aggregate at version 0 (`seedReadyProject`) or at version 2 (`driveThrough` past
 * `policy.validate`) and a hardcoded number would silently refuse in one of them.
 */

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  PROJECT_ID,
  SEALED_SUBMISSION_HASH,
  approvalPayload,
  approvalRecord,
  bootstrapSequence,
  envelope,
  hex64,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";

/** R0/R1 are the only tiers `assessTier` can auto-approve; R2/R3 are human-only by design 710. */
const POLICY_TIER = "R0";

export interface PolicyWitnessSubject {
  readonly action: "effect.activate";
  readonly graphRevisionRef: string;
  readonly nodeKey: string;
  readonly policySliceHash: string;
  readonly principalId: string;
}

const CUSTOM_PROJECT_PREFIX_KINDS = new Set([
  "project.register", "project.bind_repository", "provider.probe", "project.activate",
]);

/**
 * Drives the approval prefix without replaying a custom project's different bootstrap bytes.
 * Planning requests are still replayed by command id, including both `plan.propose` phases.
 */
export function driveApprovalPrefix(store: SqliteEventStore): void {
  for (const request of bootstrapSequence()) {
    if (request.kind === "approval.decide") return;
    const ledger = readDurableLedger(store, PROJECT_ID);
    if (CUSTOM_PROJECT_PREFIX_KINDS.has(request.kind) && ledger.kinds.has(request.kind)) continue;
    const outcome = send(store, request);
    if (!outcome.ok) {
      throw new Error(`witness fixture setup failed at ${request.kind}: ${outcome.code}`);
    }
  }
}

/**
 * The one aggregate `policy.install` and `policy.validate` share — PRODUCTION's own constant,
 * the same one `aggregateIdFor` and `resolveAdmissionGate` use, never restated as a template
 * literal here. A fixture seeding one stream while the resolver reads another would report "no
 * durable witness" for a world that decided.
 */
const policyVersion = (store: SqliteEventStore): number =>
  versionOf(readDurableLedger(store, PROJECT_ID), policyAggregateId(PROJECT_ID));

/** A slice whose opt-in is what turns `assessTier`'s REQUIRE_HUMAN_APPROVAL into ALLOW. */
const allowingSlice = (sliceRef: string, subject: PolicyWitnessSubject): JsonObject => ({
  autoApprovalOptIns: [{ action: subject.action, tier: POLICY_TIER }],
  rules: [],
  sliceRef,
} as unknown as JsonObject);

/**
 * The evaluation input, tuned ONLY where the decision demands it.
 *
 * The server supplies the honest null-tier UNKNOWN risk fact; the OPT-IN rides the INSTALLED
 * slice alone. Before task-eb6a1fa6 this record also re-sent `sliceChain`, duplicating a fact
 * `drivePolicyDecision` had already written to the store - so the allow/hold distinction was
 * asserted twice and the caller's copy was the one core read. `validatePolicy` now composes the
 * chain from the installed bytes and refuses a caller that supplies one, which is why this
 * function no longer needs to know whether the world opted in.
 */
const evaluationFor = (sliceRef: string, subject: PolicyWitnessSubject): JsonObject => ({
  action: subject.action,
  actor: subject.principalId,
  callerRiskHint: null,
  decisionDigest: hex64("d1"),
  graphNodeRevisionRefs: [subject.graphRevisionRef],
  policyRevisionRef: sliceRef,
  requiredFactIds: [],
  scope: [subject.nodeKey],
} as unknown as JsonObject);

/**
 * COMMAND IDS ARE EXPLICIT AND DISTINCT PER VARIANT, and that is a correctness requirement.
 *
 * `envelope(kind, expectedVersion, payload, commandId = `cmd-${kind}`)` mints ONE id per kind,
 * and `bootstrapSequence()` already spends `cmd-policy.install` / `cmd-policy.validate`. A world
 * driven past those commands would answer this seeder's re-send with
 * `BOOTSTRAP_COMMAND_BYTES_CONFLICT` — a THROW from the fixture, naming the fixture line rather
 * than any defect. The allowing and non-allowing seeders differ too, because both may run
 * against one world.
 */
const commandIdFor = (kind: string, optedIn: boolean): string =>
  `cmd-witness-${kind}-${optedIn ? "allow" : "hold"}`;

function drivePolicyDecision(
  store: SqliteEventStore, optedIn: boolean, subject: PolicyWitnessSubject,
): void {
  const sliceRef = subject.policySliceHash;
  const installed = send(store, envelope("policy.install", policyVersion(store), {
    // Both production paths use the node-bound content-addressed slice. Today the daemon's
    // server-held fact is null-tier UNKNOWN, so even its R0 opt-in honestly evaluates to HOLD.
    slice: allowingSlice(sliceRef, subject),
  }, commandIdFor("policy.install", optedIn)));
  if (!installed.ok) throw new Error(`witness fixture policy.install refused: ${installed.code}`);
  // The version is READ AGAIN: `policy.install` just moved the aggregate, and a value captured
  // before it would refuse `BOOTSTRAP_EXPECTED_VERSION_STALE`.
  const validated = send(store, envelope("policy.validate", policyVersion(store), {
    input: evaluationFor(sliceRef, subject),
  }, commandIdFor("policy.validate", optedIn)));
  if (!validated.ok) throw new Error(`witness fixture policy.validate refused: ${validated.code}`);
}

/**
 * A durable POLICY DECISION from the historically allowing harness path, committed by
 * `policy.validate` itself. The name is retained for its existing callers, but until a real
 * server-held tier source lands the honest resolver makes this decision HOLD_UNKNOWN.
 *
 * NOT idempotent-by-skip and deliberately so: it appends, and the resolver reads the LATEST
 * `PolicyEvaluated`. A world that already carries the bootstrap's HOLD_UNKNOWN decision is
 * REPLACED by this call rather than skipped, which is why a "seed only when absent" rule would
 * be wrong here even while both evaluations honestly remain non-allowing.
 */
export function seedAllowingPolicyDecision(
  store: SqliteEventStore, subject: PolicyWitnessSubject,
): void {
  drivePolicyDecision(store, true, subject);
}

/**
 * A durable policy decision that does NOT allow — same writer, opt-in withheld, so the core
 * folds REQUIRE_HUMAN_APPROVAL out of `assessTier`.
 *
 * This is the honest home for the does-not-allow passthrough: the witness EXISTS, so the
 * resolver must not answer, and `checkGate` must refuse it in the SCHEDULER's vocabulary.
 */
export function seedNonAllowingPolicyDecision(
  store: SqliteEventStore, subject: PolicyWitnessSubject,
): void {
  drivePolicyDecision(store, false, subject);
}

/**
 * A LATER `PolicyInstalled` on the policy aggregate, so the newest event on that stream is NOT
 * the decision.
 *
 * The resolver selects `PolicyEvaluated` BY TYPE; a by-index pick would take this event instead
 * and resolve nothing. Without this world that selection has no witness on the policy side —
 * `policy.install` then `policy.validate` leaves the decision last by accident, so an
 * index-based resolver would still pass every other arm. Measured: it did.
 */
export function seedTrailingPolicyInstall(
  store: SqliteEventStore, subject: PolicyWitnessSubject,
): void {
  const installed = send(store, envelope("policy.install", policyVersion(store), {
    slice: allowingSlice(hex64("7011a1"), subject),
  }, "cmd-witness-policy.install-trailing"));
  if (!installed.ok) throw new Error(`witness fixture trailing install refused: ${installed.code}`);
}

/**
 * The approved+activated goal whose `GoalExecutionEnabled` carries the human approval record,
 * with `approvedNodeScope` naming exactly the nodes asked for.
 *
 * The stock `approvalRecord` scopes the approval to `["node-1"]`, which is NOT the activation
 * world's `dev-solo`. That mismatch is a fixture the scope arm needs, not a bug to paper over,
 * so the scope is a parameter and both worlds are reachable through the same production command.
 */
export function seedApprovedNodeScope(
  store: SqliteEventStore, nodeKeys: readonly string[],
): void {
  driveApprovalPrefix(store);
  const decided = send(store, envelope("approval.decide", 0, approvalPayload({
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...nodeKeys] },
  })));
  if (!decided.ok) throw new Error(`witness fixture approval.decide refused: ${decided.code}`);
}
