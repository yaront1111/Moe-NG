/**
 * THE DURABLE ADMISSION GATE of the authenticated `effect.activate` route.
 *
 * WHAT MOVED, and it is the LAST caller-supplied budget input on this route. Until this module
 * existed the stage read `payload.budget.gate` and checked exactly one thing about it — that the
 * witness field the node's own durable policy names was PRESENT (`checkGateWitness`, retired in
 * the same commit as this file). Presence is not authenticity: a caller could assert
 * `{allowance: {decisionRef: "anything", outcome: "ALLOW"}}` and no durable record was ever
 * consulted. Here the witness is BUILT FROM durable records, so the forgery is unrepresentable
 * rather than merely refused, and `payload.budget.gate` is not read on this route at all.
 *
 * THE TWO SOURCES, keyed by the node's own `admissionGatePolicy`
 * (`node-authority-contract.ts:54` promised exactly this resolution and nothing performed it):
 *   POLICY_ALLOWANCE -> the LATEST `PolicyEvaluated` on `policyAggregateId(projectId)`, accepted
 *     only when its exact v2 material digest recomputes, its core outcome replays, and its bound
 *     project/actor/slice summary agrees. It must also name THIS effect action, authenticated
 *     principal, active graph revision and node scope. Legacy rows and foreign subjects confer
 *     nothing.
 *   HUMAN_APPROVAL -> the goal's single `GoalExecutionEnabled`, `eventPayload.approval`
 *     (`approval-activation.ts:72-82`), which is a full core-validated approval record whose
 *     `approvalRef` / `decision` / `validity` map one-for-one onto `AdmissionHumanApproval`.
 *
 * THE BOUNDARY THIS MODULE DOES NOT CROSS (task rail 1). It answers WHICH durable record
 * witnesses this node. Whether that witness ALLOWS is `checkGate`'s call in `@moe/scheduler`
 * (`budget-reservation.ts:151-157`) and a second opinion here could disagree with it. So the
 * approval's `decision` and `validity` are forwarded VERBATIM and are deliberately NOT filtered
 * the way `readApprovedNodeScope` filters them: filtering would make
 * `BUDGET_RESERVATION_APPROVAL_NOT_CURRENT` unreachable and would be this module deciding
 * admission. It filters only on RESOLUTION questions — which event, and whether the approval
 * names this node.
 *
 * THE VOCABULARIES ARE PROVEN BY THEIR PRODUCERS, not mirrored. The strict policy reader replays
 * `evaluatePolicy`; `RUNTIME_LIFECYCLES.APPROVAL_*` narrows the approval enums. Each value is
 * assigned into the scheduler's own field type, so a vocabulary drift reddens typecheck.
 *
 * SEQUENCING: this module lands before task-b8b69e74 (fence link 4), after which `payload.budget`
 * does not exist at all and this resolver is the ONLY source of an `AdmissionGate` on the route.
 */

import { readHumanApprovalAuthority } from "./human-approval-authority-reader.js";
import { readPolicyAdmission } from "./policy-admission-reader.js";

import type { PolicyEvaluationAuthorityRefused } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import type { AdmissionGate } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

/**
 * This module's OWN faults. Strict policy-reader faults are not members: they retain their exact
 * code and DAEMON_POLICY_AUTHORITY layer when they pass through this boundary.
 *
 * POLICY_SOURCE_ABSENT names an absent or unreadable PolicyEvaluated selection. WITNESS_ABSENT
 * remains the human-approval absence and sealed-policy-supersession answer. Both confer nothing,
 * but they are durably distinguishable and must not collapse into one generic code.
 *
 * SUBJECT_MISMATCH is a sealed policy decision for another action, principal, graph revision,
 * or node. It stays separate from ABSENT because the authority exists but does not govern this
 * activation. SCOPE_MISMATCH likewise stays separate for a human approval that names other nodes:
 * the opposite durable state from no approval at all, and collapsing them would let one approval
 * admit every node in the goal — the forged-witness class this module closes.
 */
export const ADMISSION_GATE_RESOLVER_CODES = Object.freeze([
  "ADMISSION_GATE_POLICY_SOURCE_ABSENT",
  "ADMISSION_GATE_SCOPE_MISMATCH",
  "ADMISSION_GATE_SUBJECT_MISMATCH",
  "ADMISSION_GATE_WITNESS_ABSENT",
] as const);

export type AdmissionGateResolverCode = (typeof ADMISSION_GATE_RESOLVER_CODES)[number];

/**
 * MODULE-PRIVATE on purpose. The layer travels on every refusal this module returns, so no
 * caller needs the constant, and a runtime export named `*_LAYER` at column 0 is the
 * boundary-roster surface this repo keeps closed.
 */
const ADMISSION_GATE_LAYER = "DAEMON_ADMISSION_GATE";

export interface AdmissionGateResolverInput {
  /** The goal whose single `GoalExecutionEnabled` carries the human approval record. */
  readonly goalRef: string;
  /** The ACTIVE revision whose exact node this activation would execute. */
  readonly graphRevisionRef: string;
  /** The node the activation admits, checked against the approval's `approvedNodeScope`. */
  readonly nodeKey: string;
  /** The authenticated command principal, never a payload actor. */
  readonly principalId: string;
  /** The immutable policy identity embedded in this node's durable definition. */
  readonly policySliceHash: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  /** The node's OWN durable policy, already mapped to its witness field by the derivation. */
  readonly witnessField: keyof AdmissionGate;
}

export interface AdmissionGateRefused {
  readonly code: AdmissionGateResolverCode;
  readonly layer: typeof ADMISSION_GATE_LAYER;
  readonly ok: false;
}

export type ResolveAdmissionGateResult =
  | { readonly gate: AdmissionGate; readonly ok: true }
  | AdmissionGateRefused
  | PolicyEvaluationAuthorityRefused;

const refuse = (code: AdmissionGateResolverCode): AdmissionGateRefused =>
  Object.freeze({ code, layer: ADMISSION_GATE_LAYER, ok: false as const });

/**
 * The `AdmissionGate` this node's durable policy owes, or this module's own refusal.
 *
 * NOTHING HERE READS REQUEST BYTES. The input carries no payload and no request, so the caller's
 * gate is not merely ignored — it is unreachable from this module by construction.
 */
export function resolveAdmissionGate(
  input: AdmissionGateResolverInput,
): ResolveAdmissionGateResult {
  const { goalRef, graphRevisionRef, nodeKey, policySliceHash, principalId, projectId, store,
    witnessField } = input;
  return witnessField === "allowance"
    ? (() => {
      const read = readPolicyAdmission({
        graphRevisionRef, nodeKey, policySliceHash, principalId, projectId, store,
      });
      return read;
    })()
    : (() => {
      const read = readHumanApprovalAuthority({
        graphRevisionRef, goalRef, nodeKey, projectId, store,
      });
      return read.ok
        ? Object.freeze({
          gate: Object.freeze({ allowance: null, approval: read.approval }), ok: true as const,
        })
        : refuse(read.code);
    })();
}
