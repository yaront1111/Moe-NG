import type {
  RuntimeAggregate,
  RuntimeCommandKind,
  RuntimeTruthClass,
} from "./runtime-vocabulary.js";

export const RUNTIME_ERROR_CODES = Object.freeze([
  "INPUT_INVALID", "INPUT_LIMIT_EXCEEDED", "SCHEMA_VERSION_UNSUPPORTED", "AUTHENTICATION_FAILED",
  "CAPABILITY_DENIED", "SESSION_EXPIRED", "SESSION_REPLAYED", "STALE_LEASE", "STALE_EPOCH",
  "EXPECTED_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "ILLEGAL_TRANSITION",
  "HARD_DEPENDENCY_UNPROVEN", "DEPENDENCY_REDUNDANT", "FRONTIER_STALLED", "FANOUT_SCOPE_REFUSED",
  "FANOUT_ORACLE_REFUSED", "FANOUT_BUDGET_REFUSED", "FANOUT_FLOW_REFUSED",
  "PLANNING_SUBMISSION_FINALIZING", "SUPERSESSION_PREPARED", "PLANNING_DISPOSITION_UNKNOWN",
  "SUPERSESSION_CONSEQUENCE_CHANGED", "SUPERSEDED_AUTHORITY", "REVISION_REBOUND",
  "PROVIDER_CAPABILITY_CHANGED", "METERING_UNAVAILABLE", "INTEGRATION_PROVENANCE_INVALID",
  "INPUT_PROVENANCE_INVALID", "JOURNAL_LIMIT_REACHED", "CONTEXT_TOO_LARGE", "STORAGE_DEGRADED",
  "DISTRIBUTION_MISMATCH", "RESTORE_REQUIRED", "CUTOVER_STATE_INVALID", "NEEDS_RECONCILIATION",
  "OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN", "UNKNOWN_ERROR",
] as const);

/** The only detail keys any error may ever carry. Values stay bounded safe scalars. */
export const RUNTIME_SAFE_DETAIL_KEYS = Object.freeze([
  "actualVersion", "aggregateKind", "caseType", "commandKind", "expectedEpoch",
  "expectedVersion", "limitBytes", "limitName", "observedEpoch", "queryKind",
  "retryAfterSeconds", "sourceState", "supportedSchemaVersion",
] as const);

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];
export type RuntimeSafeDetailKey = (typeof RUNTIME_SAFE_DETAIL_KEYS)[number];
export type RuntimeRetryability =
  | "NEVER" | "AFTER_REFRESH" | "AFTER_FACT_CHANGE" | "AFTER_RECOVERY";
export type RuntimeRecoveryCategory =
  | "NONE" | "CORRECT_REQUEST" | "REAUTHENTICATE" | "REFRESH" | "WAIT_OR_OBSERVE" | "REPLAN"
  | "RECONCILE" | "HUMAN_DECISION" | "INSPECT_OR_EXPORT" | "CANCEL";

export interface RuntimeTransportBinding {
  readonly category: string;
  readonly httpStatus: number;
  readonly mcpCode: number;
}

const TRANSPORTS = Object.freeze({
  CONFLICT: Object.freeze({ category: "CONFLICT", httpStatus: 409, mcpCode: -32003 }),
  FORBIDDEN: Object.freeze({ category: "FORBIDDEN", httpStatus: 403, mcpCode: -32002 }),
  INTERNAL: Object.freeze({ category: "INTERNAL_UNKNOWN", httpStatus: 500, mcpCode: -32603 }),
  PRECONDITION: Object.freeze({ category: "PRECONDITION_FAILED", httpStatus: 412, mcpCode: -32004 }),
  REQUEST_INVALID: Object.freeze({ category: "REQUEST_INVALID", httpStatus: 400, mcpCode: -32602 }),
  TOO_LARGE: Object.freeze({ category: "REQUEST_TOO_LARGE", httpStatus: 413, mcpCode: -32005 }),
  DEGRADED: Object.freeze({ category: "SERVICE_DEGRADED", httpStatus: 503, mcpCode: -32006 }),
  UNAUTHENTICATED: Object.freeze({ category: "UNAUTHENTICATED", httpStatus: 401, mcpCode: -32001 }),
  UNPROCESSABLE: Object.freeze({ category: "UNPROCESSABLE", httpStatus: 422, mcpCode: -32007 }),
  BAD_VERSION: Object.freeze({ category: "VERSION_UNSUPPORTED", httpStatus: 400, mcpCode: -32600 }),
});

export interface RuntimeErrorDescriptor {
  readonly code: RuntimeErrorCode;
  readonly recoveryCategory: RuntimeRecoveryCategory;
  readonly recoveryCommands: readonly RuntimeCommandKind[];
  readonly requiredDetailKeys: readonly RuntimeSafeDetailKey[];
  readonly retryability: RuntimeRetryability;
  readonly transport: RuntimeTransportBinding;
  readonly truthClass: RuntimeTruthClass;
  readonly validSources: readonly RuntimeAggregate[];
}

type Row = readonly [
  RuntimeErrorCode, RuntimeTruthClass, RuntimeRetryability, RuntimeRecoveryCategory,
  keyof typeof TRANSPORTS, readonly RuntimeCommandKind[], readonly RuntimeAggregate[],
  readonly RuntimeSafeDetailKey[],
];

const V = "DAEMON_VERIFIED" as const;
const U = "UNKNOWN" as const;
const cmds = (...items: RuntimeCommandKind[]): readonly RuntimeCommandKind[] => Object.freeze(items);
const srcs = (...items: RuntimeAggregate[]): readonly RuntimeAggregate[] => Object.freeze(items);
const keys = (...items: RuntimeSafeDetailKey[]): readonly RuntimeSafeDetailKey[] =>
  Object.freeze(items);
const NONE = cmds();
const NO_SRC = srcs();
const NO_KEY = keys();
const EPOCHS = keys("expectedEpoch", "observedEpoch");
const LIMITS = keys("limitBytes", "limitName");

const ROWS: readonly Row[] = Object.freeze([
  ["INPUT_INVALID", V, "NEVER", "CORRECT_REQUEST", "REQUEST_INVALID", NONE, NO_SRC, NO_KEY],
  ["INPUT_LIMIT_EXCEEDED", V, "NEVER", "CORRECT_REQUEST", "TOO_LARGE",
    cmds("context.repackage"), NO_SRC, LIMITS],
  ["SCHEMA_VERSION_UNSUPPORTED", V, "NEVER", "CORRECT_REQUEST", "BAD_VERSION", NONE, NO_SRC,
    keys("supportedSchemaVersion")],
  ["AUTHENTICATION_FAILED", V, "AFTER_RECOVERY", "REAUTHENTICATE", "UNAUTHENTICATED",
    cmds("session.open"), NO_SRC, NO_KEY],
  ["CAPABILITY_DENIED", V, "NEVER", "HUMAN_DECISION", "FORBIDDEN", NONE, NO_SRC, NO_KEY],
  ["SESSION_EXPIRED", V, "AFTER_RECOVERY", "REAUTHENTICATE", "UNAUTHENTICATED",
    cmds("session.renew", "session.rotate"), NO_SRC, NO_KEY],
  ["SESSION_REPLAYED", V, "NEVER", "REAUTHENTICATE", "UNAUTHENTICATED", cmds("session.open"),
    NO_SRC, NO_KEY],
  ["STALE_LEASE", V, "AFTER_RECOVERY", "RECONCILE", "PRECONDITION",
    cmds("lease.confirm_revoke", "lease.extend"), srcs("ATTEMPT", "LEASE", "NODE_RUN"), EPOCHS],
  ["STALE_EPOCH", V, "AFTER_REFRESH", "REFRESH", "PRECONDITION", NONE,
    srcs("ATTEMPT", "GRAPH_REVISION", "LEASE", "NODE_RUN"), EPOCHS],
  ["EXPECTED_VERSION_CONFLICT", V, "AFTER_REFRESH", "REFRESH", "CONFLICT", NONE,
    srcs("GOAL", "GRAPH_REVISION", "NODE_RUN", "PLANNING_RUN", "PROJECT"),
    keys("actualVersion", "expectedVersion")],
  ["IDEMPOTENCY_CONFLICT", V, "NEVER", "CORRECT_REQUEST", "CONFLICT", NONE,
    srcs("GOAL", "NODE_RUN", "PLANNING_RUN", "PROJECT"), NO_KEY],
  ["ILLEGAL_TRANSITION", V, "AFTER_FACT_CHANGE", "REFRESH", "UNPROCESSABLE", NONE,
    srcs("APPROVAL", "ATTEMPT", "CUTOVER", "EFFECT", "GOAL", "GRAPH_REVISION", "INTEGRATION",
      "NODE_RUN", "PLANNING_RUN", "PROJECT", "QUALIFICATION_RECOVERY"),
    keys("aggregateKind", "commandKind", "sourceState")],
  ["HARD_DEPENDENCY_UNPROVEN", V, "AFTER_FACT_CHANGE", "WAIT_OR_OBSERVE", "UNPROCESSABLE",
    cmds("blocker.challenge", "dependency.challenge"), srcs("NODE_RUN"), keys("aggregateKind")],
  ["DEPENDENCY_REDUNDANT", V, "AFTER_FACT_CHANGE", "REPLAN", "UNPROCESSABLE",
    cmds("dependency.challenge"), srcs("NODE_RUN"), NO_KEY],
  ["FRONTIER_STALLED", V, "AFTER_FACT_CHANGE", "REPLAN", "UNPROCESSABLE",
    cmds("blocker.challenge", "replan.propose_unblock"), srcs("GOAL"), keys("aggregateKind")],
  ["FANOUT_SCOPE_REFUSED", V, "AFTER_FACT_CHANGE", "REPLAN", "UNPROCESSABLE",
    cmds("graph.request_expansion"), srcs("PLANNING_RUN"), NO_KEY],
  ["FANOUT_ORACLE_REFUSED", V, "AFTER_FACT_CHANGE", "REPLAN", "UNPROCESSABLE",
    cmds("evidence.run"), srcs("PLANNING_RUN"), NO_KEY],
  ["FANOUT_BUDGET_REFUSED", V, "AFTER_RECOVERY", "HUMAN_DECISION", "UNPROCESSABLE",
    cmds("budget.propose_raise"), srcs("PLANNING_RUN"), NO_KEY],
  ["FANOUT_FLOW_REFUSED", V, "AFTER_FACT_CHANGE", "WAIT_OR_OBSERVE", "UNPROCESSABLE", NONE,
    srcs("PLANNING_RUN"), NO_KEY],
  ["PLANNING_SUBMISSION_FINALIZING", V, "AFTER_FACT_CHANGE", "WAIT_OR_OBSERVE", "CONFLICT", NONE,
    srcs("PLANNING_RUN"), keys("sourceState")],
  ["SUPERSESSION_PREPARED", V, "AFTER_FACT_CHANGE", "HUMAN_DECISION", "CONFLICT",
    cmds("graph.release_preparation", "graph.supersede"),
    srcs("GRAPH_REVISION", "PLANNING_FENCE", "SUPERSESSION_FUNDING"), NO_KEY],
  ["PLANNING_DISPOSITION_UNKNOWN", U, "AFTER_RECOVERY", "RECONCILE", "UNPROCESSABLE",
    cmds("effect.reconcile", "resource.reconcile"), srcs("PLANNING_HOLD", "PLANNING_RUN"), NO_KEY],
  ["SUPERSESSION_CONSEQUENCE_CHANGED", V, "AFTER_REFRESH", "HUMAN_DECISION", "CONFLICT",
    cmds("graph.prepare_supersession", "graph.release_preparation"),
    srcs("GRAPH_REVISION", "PLANNING_FENCE", "SUPERSESSION_FUNDING"), NO_KEY],
  ["SUPERSEDED_AUTHORITY", V, "NEVER", "REFRESH", "PRECONDITION", NONE,
    srcs("ATTEMPT", "GRAPH_REVISION", "LEASE", "NODE_RUN"), EPOCHS],
  ["REVISION_REBOUND", V, "AFTER_REFRESH", "REFRESH", "CONFLICT", NONE,
    srcs("ATTEMPT", "GRAPH_REVISION", "NODE_RUN"), NO_KEY],
  ["PROVIDER_CAPABILITY_CHANGED", V, "AFTER_RECOVERY", "RECONCILE", "UNPROCESSABLE",
    cmds("provider.probe"), srcs("ATTEMPT", "PROVIDER_SLOT"), NO_KEY],
  ["METERING_UNAVAILABLE", U, "AFTER_RECOVERY", "RECONCILE", "DEGRADED",
    cmds("budget.conservative_settle", "budget.reconcile"), srcs("ATTEMPT", "EFFECT"),
    keys("retryAfterSeconds")],
  ["INTEGRATION_PROVENANCE_INVALID", V, "NEVER", "INSPECT_OR_EXPORT", "UNPROCESSABLE",
    cmds("integration.submit_finding", "quarantine.export_forensic"), srcs("INTEGRATION"), NO_KEY],
  ["INPUT_PROVENANCE_INVALID", V, "AFTER_RECOVERY", "RECONCILE", "UNPROCESSABLE",
    cmds("effect.reconcile", "quarantine.export_forensic"), srcs("NODE_RUN"), NO_KEY],
  ["JOURNAL_LIMIT_REACHED", V, "AFTER_RECOVERY", "CORRECT_REQUEST", "TOO_LARGE",
    cmds("context.repackage"), srcs("ATTEMPT"), LIMITS],
  ["CONTEXT_TOO_LARGE", V, "AFTER_RECOVERY", "REPLAN", "TOO_LARGE", cmds("context.repackage"),
    srcs("ATTEMPT", "NODE_RUN"), LIMITS],
  ["STORAGE_DEGRADED", U, "AFTER_RECOVERY", "WAIT_OR_OBSERVE", "DEGRADED", NONE, srcs("PROJECT"),
    keys("retryAfterSeconds")],
  ["DISTRIBUTION_MISMATCH", V, "NEVER", "HUMAN_DECISION", "UNPROCESSABLE", NONE, srcs("PROJECT"),
    NO_KEY],
  ["RESTORE_REQUIRED", V, "AFTER_RECOVERY", "RECONCILE", "DEGRADED",
    cmds("recovery.complete", "recovery.inspect_external", "recovery.reconcile_external"),
    srcs("PROJECT"), keys("caseType")],
  ["CUTOVER_STATE_INVALID", V, "AFTER_FACT_CHANGE", "HUMAN_DECISION", "UNPROCESSABLE",
    cmds("cutover.abort"), srcs("CUTOVER"), keys("sourceState")],
  ["NEEDS_RECONCILIATION", U, "AFTER_RECOVERY", "RECONCILE", "UNPROCESSABLE",
    cmds("effect.confirm_absent", "effect.reconcile", "reconciliation.decide",
      "resource.reconcile"),
    srcs("ATTEMPT", "EFFECT", "NODE_RUN", "PROVIDER_SLOT", "QUALIFICATION_RECOVERY"),
    keys("caseType")],
  ["OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN", U, "AFTER_RECOVERY", "INSPECT_OR_EXPORT", "INTERNAL",
    cmds("effect.confirm_absent", "quarantine.export_forensic"), srcs("EFFECT"), NO_KEY],
  ["UNKNOWN_ERROR", U, "NEVER", "NONE", "INTERNAL", NONE, NO_SRC, NO_KEY],
]);


const REGISTRY: ReadonlyMap<string, RuntimeErrorDescriptor> = new Map(
  ROWS.map((row) => [
    row[0],
    Object.freeze({
      code: row[0], recoveryCategory: row[3], recoveryCommands: row[5], requiredDetailKeys: row[7],
      retryability: row[2], transport: TRANSPORTS[row[4]], truthClass: row[1], validSources: row[6],
    }),
  ]),
);

export const UNKNOWN_ERROR_DESCRIPTOR = REGISTRY.get("UNKNOWN_ERROR") as RuntimeErrorDescriptor;

/** Exhaustive lookup. Any unmapped value resolves to the `UNKNOWN_ERROR` descriptor. */
export function lookupRuntimeError(code: unknown): RuntimeErrorDescriptor {
  return (typeof code === "string" ? REGISTRY.get(code) : undefined) ?? UNKNOWN_ERROR_DESCRIPTOR;
}
