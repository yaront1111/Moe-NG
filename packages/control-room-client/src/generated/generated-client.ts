// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: the @moe/contracts runtime registry (packages/contracts/src/runtime).
// Regenerate with: pnpm --filter @moe/control-room-client generate
//
// Honesty boundaries, stated so no reader credits this file with more authority than
// it has:
//  1. Command builders are AFFORDANCE-ANCHORED. Every identity field (commandId,
//     expectedVersion, targetAggregateId, leaseAuthority, graphRevisionHash,
//     policyRevisionHash) is COPIED from a daemon-supplied NextAllowedCommand. No
//     builder synthesizes one, no raw-field builder exists on this surface, and the
//     surface itself is reachable only through a matching compatibility gate (design
//     section 90; control-room spec CR-CMD-001). Residual, stated plainly rather than
//     claimed away: NextAllowedCommand is a structural type, so TypeScript cannot
//     prove a given affordance came from buildNextAllowedCommands. A caller that
//     hand-authors one gets an envelope the daemon refuses on its own checks. This
//     layer removes the mint path; it is not the authority.
//  2. Payloads stay JsonObject. No per-kind payload schema exists in the contract, and
//     NextAllowedCommand.inputSchemaVersion is an opaque daemon-supplied string, so
//     generating per-kind payload types would invent a contract that does not exist.
//  3. Caller-supplied fields (correlationId, sessionCredential, requestDigest) are
//     passed through unvalidated. The daemon's envelope decoder is the single
//     authority on field validity; re-validating here would be a competing validator.
//  4. contractDigest covers only the RUNTIME-ENUMERABLE surface. The envelope
//     required/optional key arrays are module-private in @moe/contracts, so the digest
//     CANNOT see envelope-shape drift. The exhaustive-key assertions below are the
//     compensating tripwire: they break typecheck loudly if an envelope interface
//     changes.
//  5. No event-stream frame vocabulary is generated. Cursor/resume semantics are TBD
//     (control-room spec section 13-D3) and no domain-event type exists in the
//     contract; inventing a frame shape would create a second competing vocabulary.

import type {
  JsonObject,
  NextAllowedCommand,
  RuntimeCommandEnvelope,
  RuntimeCommandKind,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeErrorDescriptor,
  RuntimeQueryEnvelope,
  RuntimeQueryKind,
} from "@moe/contracts";
import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_TELEMETRY_KINDS,
  createRuntimeError,
} from "@moe/contracts";

/** One daemon-issued mutation affordance, narrowed to a single command kind. */
export type CommandAffordance<K extends RuntimeCommandKind> = NextAllowedCommand & {
  readonly commandKind: K;
};

/** The only fields a caller may contribute to a command. Identity is never among them. */
export interface CommandCallerInput {
  readonly correlationId: string;
  readonly payload: JsonObject;
  readonly requestDigest: string;
  readonly sessionCredential: string;
}

export type CommandBuildResult =
  | { readonly envelope: RuntimeCommandEnvelope; readonly ok: true }
  | { readonly error: RuntimeError; readonly ok: false };

export type CommandBuilder<K extends RuntimeCommandKind> = (
  affordance: CommandAffordance<K>,
  caller: CommandCallerInput,
) => CommandBuildResult;

/** Queries carry no authority, so they need no affordance and cannot fail closed. */
export interface QueryCallerInput {
  readonly correlationId: string;
  readonly cursor?: string;
  readonly payload: JsonObject;
  readonly sessionCredential: string;
  readonly targetAggregateId?: string;
}

export type QueryEnvelopeFor<K extends RuntimeQueryKind> = RuntimeQueryEnvelope & {
  readonly queryKind: K;
};

export type QueryBuilder<K extends RuntimeQueryKind> = (
  caller: QueryCallerInput,
) => QueryEnvelopeFor<K>;

export const COMMAND_ENVELOPE_KEYS = Object.freeze([
  "commandId", "commandKind", "correlationId", "expectedVersion", "graphRevisionHash",
  "leaseAuthority", "payload", "policyRevisionHash", "requestDigest", "schemaVersion",
  "sessionCredential", "targetAggregateId",
] as const) satisfies readonly (keyof RuntimeCommandEnvelope)[];

export const QUERY_ENVELOPE_KEYS = Object.freeze([
  "correlationId", "cursor", "payload", "queryKind", "schemaVersion", "sessionCredential",
  "targetAggregateId",
] as const) satisfies readonly (keyof RuntimeQueryEnvelope)[];

type AssertNever<T extends never> = T;
type CommandKeyDrift = Exclude<
  keyof RuntimeCommandEnvelope,
  (typeof COMMAND_ENVELOPE_KEYS)[number]
>;
type QueryKeyDrift = Exclude<keyof RuntimeQueryEnvelope, (typeof QUERY_ENVELOPE_KEYS)[number]>;

/** Compile-time tripwires for boundary 4. A new envelope key breaks these first. */
export type CommandEnvelopeKeyCoverage = AssertNever<CommandKeyDrift>;
export type QueryEnvelopeKeyCoverage = AssertNever<QueryKeyDrift>;

const AFFORDANCE_REQUIRED_ERROR: RuntimeError = createRuntimeError({ code: "INPUT_INVALID" });

function isAffordanceFor(kind: RuntimeCommandKind, value: unknown): value is NextAllowedCommand {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)["commandKind"] === kind;
}

function commandBuilderFor<K extends RuntimeCommandKind>(kind: K): CommandBuilder<K> {
  return (affordance, caller) => {
    if (!isAffordanceFor(kind, affordance)) {
      return Object.freeze({ error: AFFORDANCE_REQUIRED_ERROR, ok: false as const });
    }
    const draft: Record<string, unknown> = {
      commandId: affordance.commandId,
      commandKind: affordance.commandKind,
      correlationId: caller.correlationId,
      expectedVersion: affordance.expectedVersion,
      payload: caller.payload,
      requestDigest: caller.requestDigest,
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: caller.sessionCredential,
      targetAggregateId: affordance.targetAggregateId,
    };
    if (affordance.graphRevisionHash !== undefined) {
      draft["graphRevisionHash"] = affordance.graphRevisionHash;
    }
    if (affordance.leaseAuthority !== undefined) {
      draft["leaseAuthority"] = affordance.leaseAuthority;
    }
    if (affordance.policyRevisionHash !== undefined) {
      draft["policyRevisionHash"] = affordance.policyRevisionHash;
    }
    return Object.freeze({
      envelope: Object.freeze(draft) as unknown as RuntimeCommandEnvelope,
      ok: true as const,
    });
  };
}

function queryBuilderFor<K extends RuntimeQueryKind>(kind: K): QueryBuilder<K> {
  return (caller) => {
    const draft: Record<string, unknown> = {
      correlationId: caller.correlationId,
      payload: caller.payload,
      queryKind: kind,
      schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      sessionCredential: caller.sessionCredential,
    };
    if (caller.cursor !== undefined) draft["cursor"] = caller.cursor;
    if (caller.targetAggregateId !== undefined) {
      draft["targetAggregateId"] = caller.targetAggregateId;
    }
    return Object.freeze(draft) as unknown as QueryEnvelopeFor<K>;
  };
}

function frozenRow(row: RuntimeErrorDescriptor): RuntimeErrorDescriptor {
  Object.freeze(row.recoveryCommands);
  Object.freeze(row.requiredDetailKeys);
  Object.freeze(row.transport);
  Object.freeze(row.validSources);
  return Object.freeze(row);
}

export interface GeneratedCommandBuilders {
  readonly ["approval.decide"]: CommandBuilder<"approval.decide">;
  readonly ["approval.decide_intent"]: CommandBuilder<"approval.decide_intent">;
  readonly ["blocker.challenge"]: CommandBuilder<"blocker.challenge">;
  readonly ["blocker.open"]: CommandBuilder<"blocker.open">;
  readonly ["blocker.resolve"]: CommandBuilder<"blocker.resolve">;
  readonly ["budget.acknowledge_unknown_liability"]: CommandBuilder<"budget.acknowledge_unknown_liability">;
  readonly ["budget.conservative_settle"]: CommandBuilder<"budget.conservative_settle">;
  readonly ["budget.propose_raise"]: CommandBuilder<"budget.propose_raise">;
  readonly ["budget.reconcile"]: CommandBuilder<"budget.reconcile">;
  readonly ["context.repackage"]: CommandBuilder<"context.repackage">;
  readonly ["cutover.abort"]: CommandBuilder<"cutover.abort">;
  readonly ["cutover.activate"]: CommandBuilder<"cutover.activate">;
  readonly ["cutover.preview"]: CommandBuilder<"cutover.preview">;
  readonly ["cutover.quiesce"]: CommandBuilder<"cutover.quiesce">;
  readonly ["dependency.challenge"]: CommandBuilder<"dependency.challenge">;
  readonly ["deployment.deploy"]: CommandBuilder<"deployment.deploy">;
  readonly ["deployment.set_target"]: CommandBuilder<"deployment.set_target">;
  readonly ["effect.activate"]: CommandBuilder<"effect.activate">;
  readonly ["effect.adopt_result"]: CommandBuilder<"effect.adopt_result">;
  readonly ["effect.confirm_absent"]: CommandBuilder<"effect.confirm_absent">;
  readonly ["effect.observe"]: CommandBuilder<"effect.observe">;
  readonly ["effect.reconcile"]: CommandBuilder<"effect.reconcile">;
  readonly ["environment.set_variable"]: CommandBuilder<"environment.set_variable">;
  readonly ["environment.unset_variable"]: CommandBuilder<"environment.unset_variable">;
  readonly ["escalation.decide"]: CommandBuilder<"escalation.decide">;
  readonly ["events.resume"]: CommandBuilder<"events.resume">;
  readonly ["evidence.rerun"]: CommandBuilder<"evidence.rerun">;
  readonly ["evidence.run"]: CommandBuilder<"evidence.run">;
  readonly ["expansion.decline"]: CommandBuilder<"expansion.decline">;
  readonly ["export.run"]: CommandBuilder<"export.run">;
  readonly ["finding.route"]: CommandBuilder<"finding.route">;
  readonly ["foundation.dispatch"]: CommandBuilder<"foundation.dispatch">;
  readonly ["foundation.verification"]: CommandBuilder<"foundation.verification">;
  readonly ["goal.cancel"]: CommandBuilder<"goal.cancel">;
  readonly ["goal.close"]: CommandBuilder<"goal.close">;
  readonly ["goal.create"]: CommandBuilder<"goal.create">;
  readonly ["goal.create_with_source"]: CommandBuilder<"goal.create_with_source">;
  readonly ["goal.pause"]: CommandBuilder<"goal.pause">;
  readonly ["goal.reopen_as_revision"]: CommandBuilder<"goal.reopen_as_revision">;
  readonly ["goal.resume"]: CommandBuilder<"goal.resume">;
  readonly ["graph.approve"]: CommandBuilder<"graph.approve">;
  readonly ["graph.prepare_supersession"]: CommandBuilder<"graph.prepare_supersession">;
  readonly ["graph.release_preparation"]: CommandBuilder<"graph.release_preparation">;
  readonly ["graph.request_expansion"]: CommandBuilder<"graph.request_expansion">;
  readonly ["graph.supersede"]: CommandBuilder<"graph.supersede">;
  readonly ["integration.accept_output"]: CommandBuilder<"integration.accept_output">;
  readonly ["integration.resolve_finding"]: CommandBuilder<"integration.resolve_finding">;
  readonly ["integration.seal"]: CommandBuilder<"integration.seal">;
  readonly ["integration.start"]: CommandBuilder<"integration.start">;
  readonly ["integration.submit_finding"]: CommandBuilder<"integration.submit_finding">;
  readonly ["journal.append"]: CommandBuilder<"journal.append">;
  readonly ["lease.confirm_revoke"]: CommandBuilder<"lease.confirm_revoke">;
  readonly ["lease.extend"]: CommandBuilder<"lease.extend">;
  readonly ["lease.mark_suspect"]: CommandBuilder<"lease.mark_suspect">;
  readonly ["plan.propose"]: CommandBuilder<"plan.propose">;
  readonly ["planning.cancel"]: CommandBuilder<"planning.cancel">;
  readonly ["planning.claim"]: CommandBuilder<"planning.claim">;
  readonly ["planning.recover_absent"]: CommandBuilder<"planning.recover_absent">;
  readonly ["planning.release"]: CommandBuilder<"planning.release">;
  readonly ["planning.submit_decomposition"]: CommandBuilder<"planning.submit_decomposition">;
  readonly ["policy.install"]: CommandBuilder<"policy.install">;
  readonly ["policy.validate"]: CommandBuilder<"policy.validate">;
  readonly ["preview.decide"]: CommandBuilder<"preview.decide">;
  readonly ["product_contract.answer_clarification"]: CommandBuilder<"product_contract.answer_clarification">;
  readonly ["product_contract.approve_gate_1"]: CommandBuilder<"product_contract.approve_gate_1">;
  readonly ["product_contract.ask_clarification"]: CommandBuilder<"product_contract.ask_clarification">;
  readonly ["product_contract.propose_revision"]: CommandBuilder<"product_contract.propose_revision">;
  readonly ["profile.register"]: CommandBuilder<"profile.register">;
  readonly ["project.activate"]: CommandBuilder<"project.activate">;
  readonly ["project.bind_repository"]: CommandBuilder<"project.bind_repository">;
  readonly ["project.register"]: CommandBuilder<"project.register">;
  readonly ["provider.probe"]: CommandBuilder<"provider.probe">;
  readonly ["qualification.cancel"]: CommandBuilder<"qualification.cancel">;
  readonly ["qualification.recover"]: CommandBuilder<"qualification.recover">;
  readonly ["qualification.replan"]: CommandBuilder<"qualification.replan">;
  readonly ["qualification.retry"]: CommandBuilder<"qualification.retry">;
  readonly ["quarantine.discard"]: CommandBuilder<"quarantine.discard">;
  readonly ["quarantine.export_forensic"]: CommandBuilder<"quarantine.export_forensic">;
  readonly ["reconciliation.decide"]: CommandBuilder<"reconciliation.decide">;
  readonly ["recovery.complete"]: CommandBuilder<"recovery.complete">;
  readonly ["recovery.inspect_external"]: CommandBuilder<"recovery.inspect_external">;
  readonly ["recovery.reconcile_external"]: CommandBuilder<"recovery.reconcile_external">;
  readonly ["release.decide"]: CommandBuilder<"release.decide">;
  readonly ["replan.propose_unblock"]: CommandBuilder<"replan.propose_unblock">;
  readonly ["repository.bootstrap"]: CommandBuilder<"repository.bootstrap">;
  readonly ["repository.publish"]: CommandBuilder<"repository.publish">;
  readonly ["resource.confirm_released"]: CommandBuilder<"resource.confirm_released">;
  readonly ["resource.reconcile"]: CommandBuilder<"resource.reconcile">;
  readonly ["resource.release"]: CommandBuilder<"resource.release">;
  readonly ["resource.renew"]: CommandBuilder<"resource.renew">;
  readonly ["resource.request"]: CommandBuilder<"resource.request">;
  readonly ["review.release"]: CommandBuilder<"review.release">;
  readonly ["review.start"]: CommandBuilder<"review.start">;
  readonly ["review.submit"]: CommandBuilder<"review.submit">;
  readonly ["safe_boundary.observe"]: CommandBuilder<"safe_boundary.observe">;
  readonly ["session.close"]: CommandBuilder<"session.close">;
  readonly ["session.open"]: CommandBuilder<"session.open">;
  readonly ["session.renew"]: CommandBuilder<"session.renew">;
  readonly ["session.rotate"]: CommandBuilder<"session.rotate">;
  readonly ["step.checkpoint"]: CommandBuilder<"step.checkpoint">;
  readonly ["step.finish"]: CommandBuilder<"step.finish">;
  readonly ["step.start"]: CommandBuilder<"step.start">;
  readonly ["wait.cancel"]: CommandBuilder<"wait.cancel">;
  readonly ["wait.declare"]: CommandBuilder<"wait.declare">;
  readonly ["wait.extend"]: CommandBuilder<"wait.extend">;
  readonly ["work.cancel"]: CommandBuilder<"work.cancel">;
  readonly ["work.claim"]: CommandBuilder<"work.claim">;
  readonly ["work.release"]: CommandBuilder<"work.release">;
  readonly ["work.renew"]: CommandBuilder<"work.renew">;
  readonly ["work.resume"]: CommandBuilder<"work.resume">;
}

export const GENERATED_COMMAND_BUILDERS: GeneratedCommandBuilders =
  Object.freeze({
    ["approval.decide"]: commandBuilderFor("approval.decide"),
    ["approval.decide_intent"]: commandBuilderFor("approval.decide_intent"),
    ["blocker.challenge"]: commandBuilderFor("blocker.challenge"),
    ["blocker.open"]: commandBuilderFor("blocker.open"),
    ["blocker.resolve"]: commandBuilderFor("blocker.resolve"),
    ["budget.acknowledge_unknown_liability"]: commandBuilderFor("budget.acknowledge_unknown_liability"),
    ["budget.conservative_settle"]: commandBuilderFor("budget.conservative_settle"),
    ["budget.propose_raise"]: commandBuilderFor("budget.propose_raise"),
    ["budget.reconcile"]: commandBuilderFor("budget.reconcile"),
    ["context.repackage"]: commandBuilderFor("context.repackage"),
    ["cutover.abort"]: commandBuilderFor("cutover.abort"),
    ["cutover.activate"]: commandBuilderFor("cutover.activate"),
    ["cutover.preview"]: commandBuilderFor("cutover.preview"),
    ["cutover.quiesce"]: commandBuilderFor("cutover.quiesce"),
    ["dependency.challenge"]: commandBuilderFor("dependency.challenge"),
    ["deployment.deploy"]: commandBuilderFor("deployment.deploy"),
    ["deployment.set_target"]: commandBuilderFor("deployment.set_target"),
    ["effect.activate"]: commandBuilderFor("effect.activate"),
    ["effect.adopt_result"]: commandBuilderFor("effect.adopt_result"),
    ["effect.confirm_absent"]: commandBuilderFor("effect.confirm_absent"),
    ["effect.observe"]: commandBuilderFor("effect.observe"),
    ["effect.reconcile"]: commandBuilderFor("effect.reconcile"),
    ["environment.set_variable"]: commandBuilderFor("environment.set_variable"),
    ["environment.unset_variable"]: commandBuilderFor("environment.unset_variable"),
    ["escalation.decide"]: commandBuilderFor("escalation.decide"),
    ["events.resume"]: commandBuilderFor("events.resume"),
    ["evidence.rerun"]: commandBuilderFor("evidence.rerun"),
    ["evidence.run"]: commandBuilderFor("evidence.run"),
    ["expansion.decline"]: commandBuilderFor("expansion.decline"),
    ["export.run"]: commandBuilderFor("export.run"),
    ["finding.route"]: commandBuilderFor("finding.route"),
    ["foundation.dispatch"]: commandBuilderFor("foundation.dispatch"),
    ["foundation.verification"]: commandBuilderFor("foundation.verification"),
    ["goal.cancel"]: commandBuilderFor("goal.cancel"),
    ["goal.close"]: commandBuilderFor("goal.close"),
    ["goal.create"]: commandBuilderFor("goal.create"),
    ["goal.create_with_source"]: commandBuilderFor("goal.create_with_source"),
    ["goal.pause"]: commandBuilderFor("goal.pause"),
    ["goal.reopen_as_revision"]: commandBuilderFor("goal.reopen_as_revision"),
    ["goal.resume"]: commandBuilderFor("goal.resume"),
    ["graph.approve"]: commandBuilderFor("graph.approve"),
    ["graph.prepare_supersession"]: commandBuilderFor("graph.prepare_supersession"),
    ["graph.release_preparation"]: commandBuilderFor("graph.release_preparation"),
    ["graph.request_expansion"]: commandBuilderFor("graph.request_expansion"),
    ["graph.supersede"]: commandBuilderFor("graph.supersede"),
    ["integration.accept_output"]: commandBuilderFor("integration.accept_output"),
    ["integration.resolve_finding"]: commandBuilderFor("integration.resolve_finding"),
    ["integration.seal"]: commandBuilderFor("integration.seal"),
    ["integration.start"]: commandBuilderFor("integration.start"),
    ["integration.submit_finding"]: commandBuilderFor("integration.submit_finding"),
    ["journal.append"]: commandBuilderFor("journal.append"),
    ["lease.confirm_revoke"]: commandBuilderFor("lease.confirm_revoke"),
    ["lease.extend"]: commandBuilderFor("lease.extend"),
    ["lease.mark_suspect"]: commandBuilderFor("lease.mark_suspect"),
    ["plan.propose"]: commandBuilderFor("plan.propose"),
    ["planning.cancel"]: commandBuilderFor("planning.cancel"),
    ["planning.claim"]: commandBuilderFor("planning.claim"),
    ["planning.recover_absent"]: commandBuilderFor("planning.recover_absent"),
    ["planning.release"]: commandBuilderFor("planning.release"),
    ["planning.submit_decomposition"]: commandBuilderFor("planning.submit_decomposition"),
    ["policy.install"]: commandBuilderFor("policy.install"),
    ["policy.validate"]: commandBuilderFor("policy.validate"),
    ["preview.decide"]: commandBuilderFor("preview.decide"),
    ["product_contract.answer_clarification"]: commandBuilderFor("product_contract.answer_clarification"),
    ["product_contract.approve_gate_1"]: commandBuilderFor("product_contract.approve_gate_1"),
    ["product_contract.ask_clarification"]: commandBuilderFor("product_contract.ask_clarification"),
    ["product_contract.propose_revision"]: commandBuilderFor("product_contract.propose_revision"),
    ["profile.register"]: commandBuilderFor("profile.register"),
    ["project.activate"]: commandBuilderFor("project.activate"),
    ["project.bind_repository"]: commandBuilderFor("project.bind_repository"),
    ["project.register"]: commandBuilderFor("project.register"),
    ["provider.probe"]: commandBuilderFor("provider.probe"),
    ["qualification.cancel"]: commandBuilderFor("qualification.cancel"),
    ["qualification.recover"]: commandBuilderFor("qualification.recover"),
    ["qualification.replan"]: commandBuilderFor("qualification.replan"),
    ["qualification.retry"]: commandBuilderFor("qualification.retry"),
    ["quarantine.discard"]: commandBuilderFor("quarantine.discard"),
    ["quarantine.export_forensic"]: commandBuilderFor("quarantine.export_forensic"),
    ["reconciliation.decide"]: commandBuilderFor("reconciliation.decide"),
    ["recovery.complete"]: commandBuilderFor("recovery.complete"),
    ["recovery.inspect_external"]: commandBuilderFor("recovery.inspect_external"),
    ["recovery.reconcile_external"]: commandBuilderFor("recovery.reconcile_external"),
    ["release.decide"]: commandBuilderFor("release.decide"),
    ["replan.propose_unblock"]: commandBuilderFor("replan.propose_unblock"),
    ["repository.bootstrap"]: commandBuilderFor("repository.bootstrap"),
    ["repository.publish"]: commandBuilderFor("repository.publish"),
    ["resource.confirm_released"]: commandBuilderFor("resource.confirm_released"),
    ["resource.reconcile"]: commandBuilderFor("resource.reconcile"),
    ["resource.release"]: commandBuilderFor("resource.release"),
    ["resource.renew"]: commandBuilderFor("resource.renew"),
    ["resource.request"]: commandBuilderFor("resource.request"),
    ["review.release"]: commandBuilderFor("review.release"),
    ["review.start"]: commandBuilderFor("review.start"),
    ["review.submit"]: commandBuilderFor("review.submit"),
    ["safe_boundary.observe"]: commandBuilderFor("safe_boundary.observe"),
    ["session.close"]: commandBuilderFor("session.close"),
    ["session.open"]: commandBuilderFor("session.open"),
    ["session.renew"]: commandBuilderFor("session.renew"),
    ["session.rotate"]: commandBuilderFor("session.rotate"),
    ["step.checkpoint"]: commandBuilderFor("step.checkpoint"),
    ["step.finish"]: commandBuilderFor("step.finish"),
    ["step.start"]: commandBuilderFor("step.start"),
    ["wait.cancel"]: commandBuilderFor("wait.cancel"),
    ["wait.declare"]: commandBuilderFor("wait.declare"),
    ["wait.extend"]: commandBuilderFor("wait.extend"),
    ["work.cancel"]: commandBuilderFor("work.cancel"),
    ["work.claim"]: commandBuilderFor("work.claim"),
    ["work.release"]: commandBuilderFor("work.release"),
    ["work.renew"]: commandBuilderFor("work.renew"),
    ["work.resume"]: commandBuilderFor("work.resume"),
  });

export interface GeneratedQueryBuilders {
  readonly ["budget.get"]: QueryBuilder<"budget.get">;
  readonly ["dependency.explain"]: QueryBuilder<"dependency.explain">;
  readonly ["doctor.get"]: QueryBuilder<"doctor.get">;
  readonly ["documents.source_read"]: QueryBuilder<"documents.source_read">;
  readonly ["events.read"]: QueryBuilder<"events.read">;
  readonly ["events.wait"]: QueryBuilder<"events.wait">;
  readonly ["evidence.get"]: QueryBuilder<"evidence.get">;
  readonly ["frontier.get"]: QueryBuilder<"frontier.get">;
  readonly ["goal.get"]: QueryBuilder<"goal.get">;
  readonly ["goal.list"]: QueryBuilder<"goal.list">;
  readonly ["graph.get"]: QueryBuilder<"graph.get">;
  readonly ["graph.preview"]: QueryBuilder<"graph.preview">;
  readonly ["product_contract.read"]: QueryBuilder<"product_contract.read">;
  readonly ["project.get"]: QueryBuilder<"project.get">;
  readonly ["quarantine.get"]: QueryBuilder<"quarantine.get">;
  readonly ["reconciliation.get"]: QueryBuilder<"reconciliation.get">;
  readonly ["scheduler.readiness_explain"]: QueryBuilder<"scheduler.readiness_explain">;
  readonly ["work.get_context"]: QueryBuilder<"work.get_context">;
}

export const GENERATED_QUERY_BUILDERS: GeneratedQueryBuilders = Object.freeze({
  ["budget.get"]: queryBuilderFor("budget.get"),
  ["dependency.explain"]: queryBuilderFor("dependency.explain"),
  ["doctor.get"]: queryBuilderFor("doctor.get"),
  ["documents.source_read"]: queryBuilderFor("documents.source_read"),
  ["events.read"]: queryBuilderFor("events.read"),
  ["events.wait"]: queryBuilderFor("events.wait"),
  ["evidence.get"]: queryBuilderFor("evidence.get"),
  ["frontier.get"]: queryBuilderFor("frontier.get"),
  ["goal.get"]: queryBuilderFor("goal.get"),
  ["goal.list"]: queryBuilderFor("goal.list"),
  ["graph.get"]: queryBuilderFor("graph.get"),
  ["graph.preview"]: queryBuilderFor("graph.preview"),
  ["product_contract.read"]: queryBuilderFor("product_contract.read"),
  ["project.get"]: queryBuilderFor("project.get"),
  ["quarantine.get"]: queryBuilderFor("quarantine.get"),
  ["reconciliation.get"]: queryBuilderFor("reconciliation.get"),
  ["scheduler.readiness_explain"]: queryBuilderFor("scheduler.readiness_explain"),
  ["work.get_context"]: queryBuilderFor("work.get_context"),
});

/** Every stable error code, projected from the registry at generation time. */
export type GeneratedErrorTable = Readonly<Record<RuntimeErrorCode, RuntimeErrorDescriptor>>;

export const GENERATED_ERROR_TABLE: GeneratedErrorTable = Object.freeze({
  "AUTHENTICATION_FAILED": frozenRow({
    code: "AUTHENTICATION_FAILED",
    recoveryCategory: "REAUTHENTICATE",
    recoveryCommands: ["session.open"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNAUTHENTICATED",
      httpStatus: 401,
      mcpCode: -32001 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "CAPABILITY_DENIED": frozenRow({
    code: "CAPABILITY_DENIED",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "FORBIDDEN",
      httpStatus: 403,
      mcpCode: -32002 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "CONTEXT_TOO_LARGE": frozenRow({
    code: "CONTEXT_TOO_LARGE",
    recoveryCategory: "REPLAN",
    recoveryCommands: ["context.repackage"],
    requiredDetailKeys: ["limitBytes", "limitName"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "REQUEST_TOO_LARGE",
      httpStatus: 413,
      mcpCode: -32005 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "NODE_RUN"],
  }),
  "CUTOVER_STATE_INVALID": frozenRow({
    code: "CUTOVER_STATE_INVALID",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: ["cutover.abort"],
    requiredDetailKeys: ["sourceState"],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["CUTOVER"],
  }),
  "DEPENDENCY_REDUNDANT": frozenRow({
    code: "DEPENDENCY_REDUNDANT",
    recoveryCategory: "REPLAN",
    recoveryCommands: ["dependency.challenge"],
    requiredDetailKeys: [],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["NODE_RUN"],
  }),
  "DISTRIBUTION_MISMATCH": frozenRow({
    code: "DISTRIBUTION_MISMATCH",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PROJECT"],
  }),
  "EXPECTED_VERSION_CONFLICT": frozenRow({
    code: "EXPECTED_VERSION_CONFLICT",
    recoveryCategory: "REFRESH",
    recoveryCommands: [],
    requiredDetailKeys: ["actualVersion", "expectedVersion"],
    retryability: "AFTER_REFRESH",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["GOAL", "GRAPH_REVISION", "NODE_RUN", "PLANNING_RUN", "PROJECT"],
  }),
  "FANOUT_BUDGET_REFUSED": frozenRow({
    code: "FANOUT_BUDGET_REFUSED",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: ["budget.propose_raise"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PLANNING_RUN"],
  }),
  "FANOUT_FLOW_REFUSED": frozenRow({
    code: "FANOUT_FLOW_REFUSED",
    recoveryCategory: "WAIT_OR_OBSERVE",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PLANNING_RUN"],
  }),
  "FANOUT_ORACLE_REFUSED": frozenRow({
    code: "FANOUT_ORACLE_REFUSED",
    recoveryCategory: "REPLAN",
    recoveryCommands: ["evidence.run"],
    requiredDetailKeys: [],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PLANNING_RUN"],
  }),
  "FANOUT_SCOPE_REFUSED": frozenRow({
    code: "FANOUT_SCOPE_REFUSED",
    recoveryCategory: "REPLAN",
    recoveryCommands: ["graph.request_expansion"],
    requiredDetailKeys: [],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PLANNING_RUN"],
  }),
  "FRONTIER_STALLED": frozenRow({
    code: "FRONTIER_STALLED",
    recoveryCategory: "REPLAN",
    recoveryCommands: ["blocker.challenge", "replan.propose_unblock"],
    requiredDetailKeys: ["aggregateKind"],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["GOAL"],
  }),
  "HARD_DEPENDENCY_UNPROVEN": frozenRow({
    code: "HARD_DEPENDENCY_UNPROVEN",
    recoveryCategory: "WAIT_OR_OBSERVE",
    recoveryCommands: ["blocker.challenge", "dependency.challenge"],
    requiredDetailKeys: ["aggregateKind"],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["NODE_RUN"],
  }),
  "IDEMPOTENCY_CONFLICT": frozenRow({
    code: "IDEMPOTENCY_CONFLICT",
    recoveryCategory: "CORRECT_REQUEST",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["GOAL", "NODE_RUN", "PLANNING_RUN", "PROJECT"],
  }),
  "ILLEGAL_TRANSITION": frozenRow({
    code: "ILLEGAL_TRANSITION",
    recoveryCategory: "REFRESH",
    recoveryCommands: [],
    requiredDetailKeys: ["aggregateKind", "commandKind", "sourceState"],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["APPROVAL", "ATTEMPT", "CUTOVER", "EFFECT", "GOAL", "GRAPH_REVISION", "INTEGRATION", "NODE_RUN", "PLANNING_RUN", "PROJECT", "QUALIFICATION_RECOVERY"],
  }),
  "INPUT_INVALID": frozenRow({
    code: "INPUT_INVALID",
    recoveryCategory: "CORRECT_REQUEST",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "REQUEST_INVALID",
      httpStatus: 400,
      mcpCode: -32602 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "INPUT_LIMIT_EXCEEDED": frozenRow({
    code: "INPUT_LIMIT_EXCEEDED",
    recoveryCategory: "CORRECT_REQUEST",
    recoveryCommands: ["context.repackage"],
    requiredDetailKeys: ["limitBytes", "limitName"],
    retryability: "NEVER",
    transport: { category: "REQUEST_TOO_LARGE",
      httpStatus: 413,
      mcpCode: -32005 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "INPUT_PROVENANCE_INVALID": frozenRow({
    code: "INPUT_PROVENANCE_INVALID",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["effect.reconcile", "quarantine.export_forensic"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["NODE_RUN"],
  }),
  "INTEGRATION_PROVENANCE_INVALID": frozenRow({
    code: "INTEGRATION_PROVENANCE_INVALID",
    recoveryCategory: "INSPECT_OR_EXPORT",
    recoveryCommands: ["integration.submit_finding", "quarantine.export_forensic"],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["INTEGRATION"],
  }),
  "JOURNAL_LIMIT_REACHED": frozenRow({
    code: "JOURNAL_LIMIT_REACHED",
    recoveryCategory: "CORRECT_REQUEST",
    recoveryCommands: ["context.repackage"],
    requiredDetailKeys: ["limitBytes", "limitName"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "REQUEST_TOO_LARGE",
      httpStatus: 413,
      mcpCode: -32005 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT"],
  }),
  "METERING_UNAVAILABLE": frozenRow({
    code: "METERING_UNAVAILABLE",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["budget.conservative_settle", "budget.reconcile"],
    requiredDetailKeys: ["retryAfterSeconds"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "SERVICE_DEGRADED",
      httpStatus: 503,
      mcpCode: -32006 },
    truthClass: "UNKNOWN",
    validSources: ["ATTEMPT", "EFFECT"],
  }),
  "NEEDS_RECONCILIATION": frozenRow({
    code: "NEEDS_RECONCILIATION",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["effect.confirm_absent", "effect.reconcile", "reconciliation.decide", "resource.reconcile"],
    requiredDetailKeys: ["caseType"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "UNKNOWN",
    validSources: ["ATTEMPT", "EFFECT", "NODE_RUN", "PROVIDER_SLOT", "QUALIFICATION_RECOVERY"],
  }),
  "OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN": frozenRow({
    code: "OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN",
    recoveryCategory: "INSPECT_OR_EXPORT",
    recoveryCommands: ["effect.confirm_absent", "quarantine.export_forensic"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "INTERNAL_UNKNOWN",
      httpStatus: 500,
      mcpCode: -32603 },
    truthClass: "UNKNOWN",
    validSources: ["EFFECT"],
  }),
  "PLANNING_DISPOSITION_UNKNOWN": frozenRow({
    code: "PLANNING_DISPOSITION_UNKNOWN",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["effect.reconcile", "resource.reconcile"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "UNKNOWN",
    validSources: ["PLANNING_HOLD", "PLANNING_RUN"],
  }),
  "PLANNING_SUBMISSION_FINALIZING": frozenRow({
    code: "PLANNING_SUBMISSION_FINALIZING",
    recoveryCategory: "WAIT_OR_OBSERVE",
    recoveryCommands: [],
    requiredDetailKeys: ["sourceState"],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PLANNING_RUN"],
  }),
  "PROVIDER_CAPABILITY_CHANGED": frozenRow({
    code: "PROVIDER_CAPABILITY_CHANGED",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["provider.probe"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNPROCESSABLE",
      httpStatus: 422,
      mcpCode: -32007 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "PROVIDER_SLOT"],
  }),
  "RESTORE_REQUIRED": frozenRow({
    code: "RESTORE_REQUIRED",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["recovery.complete", "recovery.inspect_external", "recovery.reconcile_external"],
    requiredDetailKeys: ["caseType"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "SERVICE_DEGRADED",
      httpStatus: 503,
      mcpCode: -32006 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["PROJECT"],
  }),
  "REVISION_REBOUND": frozenRow({
    code: "REVISION_REBOUND",
    recoveryCategory: "REFRESH",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "AFTER_REFRESH",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "GRAPH_REVISION", "NODE_RUN"],
  }),
  "SCHEMA_VERSION_UNSUPPORTED": frozenRow({
    code: "SCHEMA_VERSION_UNSUPPORTED",
    recoveryCategory: "CORRECT_REQUEST",
    recoveryCommands: [],
    requiredDetailKeys: ["supportedSchemaVersion"],
    retryability: "NEVER",
    transport: { category: "VERSION_UNSUPPORTED",
      httpStatus: 400,
      mcpCode: -32600 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "SESSION_EXPIRED": frozenRow({
    code: "SESSION_EXPIRED",
    recoveryCategory: "REAUTHENTICATE",
    recoveryCommands: ["session.renew", "session.rotate"],
    requiredDetailKeys: [],
    retryability: "AFTER_RECOVERY",
    transport: { category: "UNAUTHENTICATED",
      httpStatus: 401,
      mcpCode: -32001 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "SESSION_REPLAYED": frozenRow({
    code: "SESSION_REPLAYED",
    recoveryCategory: "REAUTHENTICATE",
    recoveryCommands: ["session.open"],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "UNAUTHENTICATED",
      httpStatus: 401,
      mcpCode: -32001 },
    truthClass: "DAEMON_VERIFIED",
    validSources: [],
  }),
  "STALE_EPOCH": frozenRow({
    code: "STALE_EPOCH",
    recoveryCategory: "REFRESH",
    recoveryCommands: [],
    requiredDetailKeys: ["expectedEpoch", "observedEpoch"],
    retryability: "AFTER_REFRESH",
    transport: { category: "PRECONDITION_FAILED",
      httpStatus: 412,
      mcpCode: -32004 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "GRAPH_REVISION", "LEASE", "NODE_RUN"],
  }),
  "STALE_LEASE": frozenRow({
    code: "STALE_LEASE",
    recoveryCategory: "RECONCILE",
    recoveryCommands: ["lease.confirm_revoke", "lease.extend"],
    requiredDetailKeys: ["expectedEpoch", "observedEpoch"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "PRECONDITION_FAILED",
      httpStatus: 412,
      mcpCode: -32004 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "LEASE", "NODE_RUN"],
  }),
  "STORAGE_DEGRADED": frozenRow({
    code: "STORAGE_DEGRADED",
    recoveryCategory: "WAIT_OR_OBSERVE",
    recoveryCommands: [],
    requiredDetailKeys: ["retryAfterSeconds"],
    retryability: "AFTER_RECOVERY",
    transport: { category: "SERVICE_DEGRADED",
      httpStatus: 503,
      mcpCode: -32006 },
    truthClass: "UNKNOWN",
    validSources: ["PROJECT"],
  }),
  "SUPERSEDED_AUTHORITY": frozenRow({
    code: "SUPERSEDED_AUTHORITY",
    recoveryCategory: "REFRESH",
    recoveryCommands: [],
    requiredDetailKeys: ["expectedEpoch", "observedEpoch"],
    retryability: "NEVER",
    transport: { category: "PRECONDITION_FAILED",
      httpStatus: 412,
      mcpCode: -32004 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["ATTEMPT", "GRAPH_REVISION", "LEASE", "NODE_RUN"],
  }),
  "SUPERSESSION_CONSEQUENCE_CHANGED": frozenRow({
    code: "SUPERSESSION_CONSEQUENCE_CHANGED",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: ["graph.prepare_supersession", "graph.release_preparation"],
    requiredDetailKeys: [],
    retryability: "AFTER_REFRESH",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["GRAPH_REVISION", "PLANNING_FENCE", "SUPERSESSION_FUNDING"],
  }),
  "SUPERSESSION_PREPARED": frozenRow({
    code: "SUPERSESSION_PREPARED",
    recoveryCategory: "HUMAN_DECISION",
    recoveryCommands: ["graph.release_preparation", "graph.supersede"],
    requiredDetailKeys: [],
    retryability: "AFTER_FACT_CHANGE",
    transport: { category: "CONFLICT",
      httpStatus: 409,
      mcpCode: -32003 },
    truthClass: "DAEMON_VERIFIED",
    validSources: ["GRAPH_REVISION", "PLANNING_FENCE", "SUPERSESSION_FUNDING"],
  }),
  "UNKNOWN_ERROR": frozenRow({
    code: "UNKNOWN_ERROR",
    recoveryCategory: "NONE",
    recoveryCommands: [],
    requiredDetailKeys: [],
    retryability: "NEVER",
    transport: { category: "INTERNAL_UNKNOWN",
      httpStatus: 500,
      mcpCode: -32603 },
    truthClass: "UNKNOWN",
    validSources: [],
  }),
});

/**
 * Telemetry vocabulary, re-exported verbatim (boundary 5: no stream frame types).
 */
export const GENERATED_TELEMETRY_KINDS = RUNTIME_TELEMETRY_KINDS;

export interface GeneratedContractPins {
  readonly commandEnvelopeVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;
  readonly contractDigest: string;
  readonly errorRegistryVersion: typeof RUNTIME_ERROR_REGISTRY_VERSION;
  readonly queryEnvelopeVersion: typeof RUNTIME_QUERY_ENVELOPE_VERSION;
}

export const GENERATED_CONTRACT_DIGEST = "f07b77e49025d5fd8a6bd391f5848f24103390d23e4db11523346b87f0891bfd";

export const GENERATED_CONTRACT_PINS: GeneratedContractPins = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  contractDigest: GENERATED_CONTRACT_DIGEST,
  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
});

/**
 * The wire protocol version a caller presents on every request. COMPOSED from the three
 * registry constants rather than written down, so this client and the daemon seam cannot
 * drift into two compatibility rules: both compose the same three values in the same
 * order, and a registry bump moves both at once. This is a pin, not a second gate --
 * `createCompatGate` remains the only place that decides admission.
 */
export const GENERATED_WIRE_PROTOCOL_VERSION =
  `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}` as const;
