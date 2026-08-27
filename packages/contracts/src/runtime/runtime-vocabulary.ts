import { hasExactKeys, isPlainRecord } from "./runtime-guards.js";

export const RUNTIME_COMMAND_ENVELOPE_VERSION = "moe-runtime-command/1" as const;
export const RUNTIME_QUERY_ENVELOPE_VERSION = "moe-runtime-query/1" as const;
export const RUNTIME_ERROR_REGISTRY_VERSION = "moe-runtime-error-registry/1" as const;

/** Closed lifecycle projections from design sections 6, 8, 12, and 16. */
export const RUNTIME_LIFECYCLES = Object.freeze({
  APPROVAL: Object.freeze(["PENDING", "DECIDED", "WITHDRAWN"] as const),
  APPROVAL_DECISION: Object.freeze(["APPROVE", "REJECT"] as const),
  APPROVAL_VALIDITY: Object.freeze(["CURRENT", "INVALIDATED", "SUPERSEDED"] as const),
  ATTEMPT: Object.freeze([
    "CREATED", "LEASED", "LAUNCH_REQUESTED", "RUNNING", "DRAINING", "CHECKPOINTED",
    "SUCCEEDED", "FAILED", "CANCELLED", "SUPERSEDED", "RELEASED", "UNKNOWN",
  ] as const),
  CUTOVER: Object.freeze([
    "PREVIEWED", "QUIESCE_APPROVED", "QUIESCING", "QUIESCED", "IMPORT_VERIFIED",
    "ACTIVATE_APPROVED", "ACTIVE", "ABORTED",
  ] as const),
  EFFECT: Object.freeze([
    "PENDING", "CLAIMED", "ARMED", "ACTIVE", "CANCEL_REQUESTED", "SUCCEEDED", "FAILED",
    "CANCELLED", "UNKNOWN",
  ] as const),
  GOAL: Object.freeze([
    "DRAFT", "EXECUTION_ENABLED", "CLOSING", "COMPLETED", "CANCELLED",
  ] as const),
  GOAL_SCHEDULING: Object.freeze([
    "RUNNING", "PAUSE_AFTER_CURRENT_STEP", "DRAIN_AND_PAUSE",
  ] as const),
  GRAPH_REVISION: Object.freeze([
    "DRAFT", "PENDING_APPROVAL", "APPROVED", "ACTIVE", "SUPERSEDED", "REJECTED",
  ] as const),
  INTEGRATION: Object.freeze([
    "WAITING_INPUTS", "HELD", "READY", "INTEGRATING", "FINDINGS_OPEN", "VERIFIED",
    "REVIEW_READY", "FAILED", "INVALIDATED", "SUPERSEDED",
  ] as const),
  LEASE: Object.freeze(["ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED"] as const),
  NODE_RUN: Object.freeze([
    "EXECUTION_READY", "EXECUTING", "WORK_REVIEW", "ACCEPTED", "CANCELLED",
  ] as const),
  PLANNING_FENCE: Object.freeze([
    "ACTIVE", "CONSUMED", "RELEASED", "INVALIDATED", "EXPIRED",
  ] as const),
  PLANNING_HOLD: Object.freeze(["ACTIVE", "RESOLVED", "SUPERSEDED", "CANCELLED"] as const),
  PLANNING_HOLD_KIND: Object.freeze([
    "EXPANSION_PLANNING", "REPLAN_REQUIRED", "PROOF_REEXECUTE",
  ] as const),
  PLANNING_RUN: Object.freeze([
    "DRAFT", "READY", "PLANNING", "SUBMISSION_DRAINING", "PLAN_REVIEW", "APPROVED",
    "ACTIVATED", "REJECTED", "CANCELLED",
  ] as const),
  PROJECT: Object.freeze(["BOOTSTRAPPING", "READY", "DEGRADED", "QUIESCED"] as const),
  PROVIDER_SLOT: Object.freeze(["RESERVED", "ACTIVE", "RELEASED"] as const),
  QUALIFICATION_RECOVERY: Object.freeze([
    "PENDING", "READY", "RUNNING", "QUALIFIED", "FAILED", "UNKNOWN", "CANCEL_DRAINING",
    "CANCELLED",
  ] as const),
  SUPERSESSION_FUNDING: Object.freeze([
    "HELD", "CONSUMED", "RELEASED", "INVALIDATED", "EXPIRED",
  ] as const),
  TRUTH_CLASS: Object.freeze([
    "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
  ] as const),
});

export type RuntimeAggregate = keyof typeof RUNTIME_LIFECYCLES;
export type RuntimeTruthClass = (typeof RUNTIME_LIFECYCLES)["TRUTH_CLASS"][number];

export const RUNTIME_AGGREGATES: readonly RuntimeAggregate[] = Object.freeze(
  (Object.keys(RUNTIME_LIFECYCLES) as RuntimeAggregate[]).sort(),
);

/** Section 17 read-only operations. None of these may ever become a mutation affordance. */
export const RUNTIME_QUERY_KINDS = Object.freeze([
  "budget.get", "dependency.explain", "doctor.get", "events.read", "events.wait",
  "evidence.get", "frontier.get", "goal.get", "goal.list", "graph.get", "graph.preview",
  "project.get", "quarantine.get", "reconciliation.get", "scheduler.readiness_explain",
  "work.get_context",
] as const);

/** Authenticated telemetry: neither a command nor a query envelope (design section 12.3). */
export const RUNTIME_TELEMETRY_KINDS = Object.freeze(["presence.ping"] as const);

/** Every other section 17 v1 operation. Disjoint from queries and telemetry. */
export const RUNTIME_COMMAND_KINDS = Object.freeze([
  "approval.decide", "approval.decide_intent", "blocker.challenge", "blocker.open",
  "blocker.resolve",
  "budget.acknowledge_unknown_liability", "budget.conservative_settle", "budget.propose_raise",
  "budget.reconcile", "context.repackage", "cutover.abort", "cutover.activate",
  "cutover.preview", "cutover.quiesce", "dependency.challenge", "effect.activate",
  "effect.adopt_result", "effect.confirm_absent", "effect.observe", "effect.reconcile",
  "escalation.decide", "events.resume", "evidence.rerun", "evidence.run", "expansion.decline", "export.run",
  "finding.route", "foundation.dispatch", "foundation.verification",
  "goal.cancel", "goal.close", "goal.create", "goal.pause",
  "goal.reopen_as_revision", "goal.resume", "graph.approve", "graph.prepare_supersession",
  "graph.release_preparation", "graph.request_expansion", "graph.supersede",
  "integration.accept_output", "integration.resolve_finding", "integration.seal",
  "integration.start", "integration.submit_finding", "journal.append", "lease.confirm_revoke",
  "lease.extend", "lease.mark_suspect", "plan.propose", "planning.cancel", "planning.claim",
  "planning.recover_absent", "planning.release", "policy.install", "policy.validate",
  "product_contract.approve_gate_1", "profile.register", "project.activate",
  "project.bind_repository", "project.register",
  "provider.probe", "qualification.cancel", "qualification.recover", "qualification.replan",
  "qualification.retry", "quarantine.discard", "quarantine.export_forensic",
  "reconciliation.decide", "recovery.complete", "recovery.inspect_external",
  "recovery.reconcile_external", "replan.propose_unblock", "resource.confirm_released",
  "resource.reconcile", "resource.release", "resource.renew", "resource.request",
  "review.release", "review.start", "review.submit", "safe_boundary.observe",
  "session.close", "session.open", "session.renew", "session.rotate", "step.checkpoint",
  "step.finish", "step.start", "wait.cancel", "wait.declare", "wait.extend", "work.cancel",
  "work.claim", "work.release", "work.renew", "work.resume",
] as const);

export type RuntimeCommandKind = (typeof RUNTIME_COMMAND_KINDS)[number];
export type RuntimeQueryKind = (typeof RUNTIME_QUERY_KINDS)[number];

/**
 * The two Foundation kinds, pinned by `satisfies` so that dropping either member from the
 * frozen tuple above stops compiling here rather than silently narrowing the vocabulary.
 * The annotation cannot live on the tuple entries themselves: `RuntimeCommandKind` is
 * derived FROM that tuple, so annotating an entry with it would be circular.
 */
export const FOUNDATION_DISPATCH_COMMAND_KIND =
  "foundation.dispatch" as const satisfies RuntimeCommandKind;
export const FOUNDATION_VERIFICATION_COMMAND_KIND =
  "foundation.verification" as const satisfies RuntimeCommandKind;

const COMMAND_KIND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_COMMAND_KINDS);
const QUERY_KIND_SET: ReadonlySet<string> = new Set<string>(RUNTIME_QUERY_KINDS);

export function isCommandKind(value: unknown): value is RuntimeCommandKind {
  return typeof value === "string" && COMMAND_KIND_SET.has(value);
}

export function isQueryKind(value: unknown): value is RuntimeQueryKind {
  return typeof value === "string" && QUERY_KIND_SET.has(value);
}

export interface RuntimeLifecycleSource {
  readonly aggregate: RuntimeAggregate;
  readonly state: string;
}

/** A tagged source is known only when both its aggregate and its state are closed. */
export function isKnownLifecycleSource(value: unknown): value is RuntimeLifecycleSource {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["aggregate", "state"], [])) return false;
  const aggregate = value["aggregate"];
  if (typeof aggregate !== "string" || !Object.hasOwn(RUNTIME_LIFECYCLES, aggregate)) {
    return false;
  }
  const states: readonly string[] = RUNTIME_LIFECYCLES[aggregate as RuntimeAggregate];
  const state = value["state"];
  return typeof state === "string" && states.includes(state);
}
