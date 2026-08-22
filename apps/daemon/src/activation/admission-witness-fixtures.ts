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
 * THE ALLOW RECIPE IS PRODUCTION'S OWN, not one invented here: one tier-bearing DAEMON_VERIFIED
 * fact (without it the risk layer is unclassifiable), no required facts and no rules (nothing to
 * hold or deny), and an auto-approval opt-in naming THIS action at a tier at least as high as
 * the derived one. `orchestrator/demo-seed-payloads.ts:113-140` states the same three conditions
 * for the demo seed's own validatable policy, so a world seeded here is the world the shipped
 * seed produces.
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
  GOAL_ID,
  PROJECT_ID,
  SEALED_SUBMISSION_HASH,
  approvalPayload,
  approvalRecord,
  driveThrough,
  envelope,
  hex64,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";

import { resolveAdmissionGate } from "./admission-gate-resolver.js";

/** The action the bootstrap journey's own policy decision is about. Kept identical to
 *  `evaluationInput` so a seeded opt-in names the action the evaluation actually carries. */
const POLICY_ACTION = "plan.approve";
/** R0/R1 are the only tiers `assessTier` can auto-approve; R2/R3 are human-only by design 710. */
const POLICY_TIER = "R0";
/** Strong truth, so `assessRisk` counts the fact instead of skipping it. */
const POLICY_TRUTH = "DAEMON_VERIFIED";

export const ALLOWING_POLICY_SLICE_REF = hex64("a11007");

/**
 * The one aggregate `policy.install` and `policy.validate` share — PRODUCTION's own constant,
 * the same one `aggregateIdFor` and `resolveAdmissionGate` use, never restated as a template
 * literal here. A fixture seeding one stream while the resolver reads another would report "no
 * durable witness" for a world that decided.
 */
const policyVersion = (store: SqliteEventStore): number =>
  versionOf(readDurableLedger(store, PROJECT_ID), policyAggregateId(PROJECT_ID));

/** A slice whose opt-in is what turns `assessTier`'s REQUIRE_HUMAN_APPROVAL into ALLOW. */
const allowingSlice = (sliceRef: string): JsonObject => ({
  autoApprovalOptIns: [{ action: POLICY_ACTION, tier: POLICY_TIER }],
  rules: [],
  sliceRef,
} as unknown as JsonObject);

/**
 * The evaluation input, tuned ONLY where the decision demands it.
 *
 * `facts` carries the single tier-bearing entry and `sliceChain` the opt-in slice. Everything
 * else stays at the bootstrap fixture's own values so a world seeded here differs from the
 * shipped journey in exactly the two places the outcome depends on.
 */
const evaluationFor = (sliceRef: string, optedIn: boolean): JsonObject => ({
  action: POLICY_ACTION,
  actor: "principal-1",
  callerRiskHint: null,
  decisionDigest: hex64("d1"),
  evaluatedAtEpochMs: 1_760_000_000_000,
  evaluatorVersion: "evaluator-1",
  facts: [{ factId: "fact-admission-risk", tier: POLICY_TIER, truthClass: POLICY_TRUTH }],
  graphNodeRevisionRefs: [],
  policyRevisionRef: sliceRef,
  requiredFactIds: [],
  scope: [],
  sliceChain: [optedIn
    ? allowingSlice(sliceRef)
    : ({ autoApprovalOptIns: [], rules: [], sliceRef } as unknown as JsonObject)],
  waivers: [],
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

function drivePolicyDecision(store: SqliteEventStore, optedIn: boolean): void {
  const sliceRef = optedIn ? ALLOWING_POLICY_SLICE_REF : hex64("de9y00");
  const installed = send(store, envelope("policy.install", policyVersion(store), {
    slice: optedIn
      ? allowingSlice(sliceRef)
      : ({ autoApprovalOptIns: [], rules: [], sliceRef } as unknown as JsonObject),
  }, commandIdFor("policy.install", optedIn)));
  if (!installed.ok) throw new Error(`witness fixture policy.install refused: ${installed.code}`);
  // The version is READ AGAIN: `policy.install` just moved the aggregate, and a value captured
  // before it would refuse `BOOTSTRAP_EXPECTED_VERSION_STALE`.
  const validated = send(store, envelope("policy.validate", policyVersion(store), {
    input: evaluationFor(sliceRef, optedIn),
  }, commandIdFor("policy.validate", optedIn)));
  if (!validated.ok) throw new Error(`witness fixture policy.validate refused: ${validated.code}`);
}

/**
 * A durable POLICY DECISION that ALLOWS, committed by `policy.validate` itself.
 *
 * NOT idempotent-by-skip and deliberately so: it appends, and the resolver reads the LATEST
 * `PolicyEvaluated`. A world that already carries the bootstrap's HOLD_UNKNOWN decision is
 * UPGRADED by this call rather than left refusing, which is the whole reason a "seed only when
 * absent" rule would be wrong here.
 */
export function seedAllowingPolicyDecision(store: SqliteEventStore): void {
  drivePolicyDecision(store, true);
}

/**
 * A durable policy decision that does NOT allow — same writer, opt-in withheld, so the core
 * folds REQUIRE_HUMAN_APPROVAL out of `assessTier`.
 *
 * This is the honest home for the does-not-allow passthrough: the witness EXISTS, so the
 * resolver must not answer, and `checkGate` must refuse it in the SCHEDULER's vocabulary.
 */
export function seedNonAllowingPolicyDecision(store: SqliteEventStore): void {
  drivePolicyDecision(store, false);
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
export function seedTrailingPolicyInstall(store: SqliteEventStore): void {
  const installed = send(store, envelope("policy.install", policyVersion(store), {
    slice: allowingSlice(hex64("7011a1")),
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
  driveThrough(store, "approval.decide");
  const decided = send(store, envelope("approval.decide", 0, approvalPayload({
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...nodeKeys] },
  })));
  if (!decided.ok) throw new Error(`witness fixture approval.decide refused: ${decided.code}`);
}

/**
 * Whether the project's LATEST durable policy decision allows, asked through the PRODUCTION
 * reader rather than by decoding events here.
 *
 * `activation-world-fixtures.ts` uses it to add the witness only when it is the missing layer,
 * the same discipline `ensureActiveGraph` and `ensureAuthorizedBudgetRoot` already follow. Going
 * through `resolveAdmissionGate` means a fixture cannot conclude "this world is fine" by a rule
 * the resolver does not actually apply.
 */
export function policyDecisionAllows(store: SqliteEventStore): boolean {
  const resolved = resolveAdmissionGate({
    goalRef: GOAL_ID, nodeKey: "", projectId: PROJECT_ID, store, witnessField: "allowance",
  });
  return resolved.ok && resolved.gate.allowance?.outcome === "ALLOW";
}
