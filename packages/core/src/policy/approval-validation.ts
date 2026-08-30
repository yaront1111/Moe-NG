/**
 * Approval record and command guards (design 7.2, 360, 701, 710, 718).
 *
 * Four cross-field invariants are enforced here rather than at the transition, because a record
 * violating any of them was never a legal approval in the first place:
 *
 * - `decision` is non-null if and only if `lifecycle` is `DECIDED`;
 * - a `HUMAN` record is `HUMAN_APPROVED` and always names a step-up reference (design 718
 *   scopes step-up to every human approval, not just `R3`);
 * - a `SYSTEM_POLICY` record is `DAEMON_VERIFIED`, never `HUMAN_APPROVED` (design 701), is
 *   confined to `R0`/`R1` (design 710), names its originating policy decision, and carries no
 *   step-up reference — a daemon principal cannot have authenticated at a terminal;
 * - a `SYSTEM_POLICY` actor is literally `policy:<hash>` (design 701).
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import { APPROVAL_ACTOR_KINDS, APPROVAL_COMMAND_KINDS } from "./approval-contract.js";
import type {
  ApprovalCommand,
  ApprovalDecisionRecord,
  ApprovalDependencyChanges,
} from "./approval-contract.js";
import { deepFreeze, exact, snapshotData, validHex64, validRef, validTier, validTruthClass } from
  "./policy-validation.js";

const POLICY_ACTOR = /^policy:[0-9a-f]{64}$/;

const RECORD_KEYS = [
  "actor", "actorKind", "applicablePolicyRef", "approvalRef", "approvedNodeScope", "budgetRef",
  "criteriaRef", "decision", "decisionReason", "dependencyChanges", "exactRevisionHash",
  "lifecycle", "planQualityAssessmentRef", "policyDecisionRef", "riskTier", "stepUpAuthRef",
  "truthClass", "validity",
] as const;
const DEPENDENCY_KEYS = ["additions", "challenges", "removals"] as const;
const DECIDE_KEYS = ["decision", "decisionReason", "kind", "stepUpAuthRef"] as const;
const HASH_KEYS = [
  "applicablePolicyRef", "budgetRef", "criteriaRef", "exactRevisionHash",
  "planQualityAssessmentRef",
] as const;

function refList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(validRef);
}

function optionalRef(value: unknown): boolean {
  return value === null || validRef(value);
}

function validDependencyChanges(value: unknown): boolean {
  return exact(value, DEPENDENCY_KEYS) && DEPENDENCY_KEYS.every((key) => refList(value[key]));
}

export function validateApprovalDependencyChanges(
  value: unknown,
): ApprovalDependencyChanges | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok) return undefined;
  if (!validDependencyChanges(snapshot.value)) return undefined;
  return deepFreeze(snapshot.value) as unknown as ApprovalDependencyChanges;
}

function validLifecycleFields(record: Readonly<Record<string, unknown>>): boolean {
  const decision = record["decision"];
  const decided = decision !== null;
  if (decided && !RUNTIME_LIFECYCLES.APPROVAL_DECISION.some((entry) => entry === decision)) {
    return false;
  }
  if (decided !== (record["lifecycle"] === "DECIDED")) return false;
  return RUNTIME_LIFECYCLES.APPROVAL.some((entry) => entry === record["lifecycle"])
    && RUNTIME_LIFECYCLES.APPROVAL_VALIDITY.some((entry) => entry === record["validity"]);
}

/** Actor-kind authority floors. Neither direction may borrow the other's truth class. */
function validActorAuthority(record: Readonly<Record<string, unknown>>): boolean {
  if (record["actorKind"] === "HUMAN") {
    return record["truthClass"] === "HUMAN_APPROVED" && validRef(record["stepUpAuthRef"]);
  }
  return record["truthClass"] === "DAEMON_VERIFIED"
    && (record["riskTier"] === "R0" || record["riskTier"] === "R1")
    && validHex64(record["policyDecisionRef"])
    && record["stepUpAuthRef"] === null
    && typeof record["actor"] === "string" && POLICY_ACTOR.test(record["actor"]);
}

export function validateApprovalRecord(value: unknown): ApprovalDecisionRecord | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok) return undefined;
  const record = snapshot.value;
  if (!exact(record, RECORD_KEYS)) return undefined;
  if (!validRef(record["actor"]) || !validRef(record["approvalRef"])) return undefined;
  if (!HASH_KEYS.every((key) => validHex64(record[key]))) return undefined;
  if (!refList(record["approvedNodeScope"])) return undefined;
  if (!validDependencyChanges(record["dependencyChanges"])) return undefined;
  if (!APPROVAL_ACTOR_KINDS.some((kind) => kind === record["actorKind"])) return undefined;
  if (!validTier(record["riskTier"]) || !validTruthClass(record["truthClass"])) return undefined;
  if (!optionalRef(record["decisionReason"]) || !optionalRef(record["stepUpAuthRef"])) {
    return undefined;
  }
  if (record["policyDecisionRef"] !== null && !validHex64(record["policyDecisionRef"])) {
    return undefined;
  }
  if (!validLifecycleFields(record) || !validActorAuthority(record)) return undefined;
  return record as unknown as ApprovalDecisionRecord;
}

export function validateApprovalCommand(value: unknown): ApprovalCommand | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok) return undefined;
  const command = snapshot.value;
  if (command === null || typeof command !== "object") return undefined;
  const kind = (command as Record<string, unknown>)["kind"];
  if (!APPROVAL_COMMAND_KINDS.some((entry) => entry === kind)) return undefined;
  if (kind === "approval.withdraw") {
    return exact(command, ["kind"]) ? (command as unknown as ApprovalCommand) : undefined;
  }
  if (!exact(command, DECIDE_KEYS)) return undefined;
  if (!RUNTIME_LIFECYCLES.APPROVAL_DECISION.some((entry) => entry === command["decision"])) {
    return undefined;
  }
  if (!optionalRef(command["decisionReason"]) || !optionalRef(command["stepUpAuthRef"])) {
    return undefined;
  }
  return command as unknown as ApprovalCommand;
}
