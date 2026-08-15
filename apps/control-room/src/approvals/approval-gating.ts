import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import {
  APPROVAL_AUTHORITY_CODES, APPROVAL_AUTHORITY_LAYERS, decideApprovalAuthority,
} from "@moe/core";
import type {
  ApprovalAuthorityCode, ApprovalAuthorityLayer, ApprovalAuthorityRefusal,
  ApprovalAuthorityRequest, ApprovalAuthorityResult, ApprovalPolicy,
  HumanAuthorityGate, HumanAuthorityGrant,
} from "@moe/core";
import type { ApprovalDecisionKind, ApprovalDecisionRecord } from "./approval-fixtures.js";
const CODE_LAYERS = Object.freeze({
  APPROVAL_HUMAN_AUTHORITY_REQUIRED: "HUMAN_AUTHORITY_GATE",
  APPROVAL_AUTHORITY_BINDING_MISMATCH: "HUMAN_AUTHORITY_GATE",
  APPROVAL_PRINCIPAL_MISSING: "HUMAN_AUTHORITY_GATE",
  APPROVAL_PRINCIPAL_UNNAMED: "HUMAN_AUTHORITY_GATE",
  APPROVAL_PRINCIPAL_NOT_HUMAN: "HUMAN_AUTHORITY_GATE",
  APPROVAL_GRANT_MOMENT_INVALID: "HUMAN_AUTHORITY_GATE",
  APPROVAL_POLICY_DELAY_INVALID: "APPROVAL_POLICY",
  APPROVAL_HUMAN_REVIEW_REQUIRED: "APPROVAL_POLICY",
} satisfies Record<ApprovalAuthorityCode, ApprovalAuthorityLayer>);
const AUTHORITY_PHRASES = Object.freeze({
  APPROVAL_HUMAN_AUTHORITY_REQUIRED: "a named human has not satisfied this authority gate",
  APPROVAL_AUTHORITY_BINDING_MISMATCH: "the authority is not bound to this unit of work",
  APPROVAL_PRINCIPAL_MISSING: "the authority grant carries no principal",
  APPROVAL_PRINCIPAL_UNNAMED: "the authority grant's human principal is unnamed",
  APPROVAL_PRINCIPAL_NOT_HUMAN: "the authority grant principal is not human",
  APPROVAL_GRANT_MOMENT_INVALID: "the authority grant moment is invalid",
  APPROVAL_POLICY_DELAY_INVALID: "the approval policy delay is invalid",
  APPROVAL_HUMAN_REVIEW_REQUIRED: "the approval policy requires human review",
} satisfies Record<ApprovalAuthorityCode, string>);
type ApprovalReasonFor<Code extends ApprovalAuthorityCode> = Readonly<{
  code: Code; phrase: string; refusingLayer: (typeof CODE_LAYERS)[Code];
}>;
export type ApprovalReason = {
  [Code in ApprovalAuthorityCode]: ApprovalReasonFor<Code>;
}[ApprovalAuthorityCode];
/** Builds only canonical code/layer pairs from the landed runtime registries. */
export function approvalReason(code: ApprovalAuthorityCode, phrase: string): ApprovalReason {
  if (!APPROVAL_AUTHORITY_CODES.includes(code)) {
    throw new Error(`approval reason ${code} is not a landed approval authority code`);
  }
  const refusingLayer = CODE_LAYERS[code];
  if (!APPROVAL_AUTHORITY_LAYERS.includes(refusingLayer)) {
    throw new Error(`approval reason ${code} has no landed refusal layer`);
  }
  return Object.freeze({ code, phrase, refusingLayer }) as unknown as ApprovalReason;
}
const bindingReason = (phrase: string): ApprovalReason =>
  approvalReason("APPROVAL_AUTHORITY_BINDING_MISMATCH", phrase);
export const APPROVAL_REASONS = Object.freeze({
  HASH_MISMATCH: bindingReason(
    "this record's exact revision hash is not the identity the command would act on",
  ),
  HASH_UNPINNED: bindingReason("the returned command pinned no revision hash to compare"),
  HUMAN_AUTHORITY_REQUIRED: approvalReason(
    "APPROVAL_HUMAN_AUTHORITY_REQUIRED", "a named human must satisfy this authority gate",
  ),
  INVALIDATED: bindingReason("a newer revision rebound the identity this approval was given for"),
  LIFECYCLE_CLOSED: bindingReason("this approval has already been decided or withdrawn"),
  MALFORMED_AUTHORITY: bindingReason("the supplied authority context is missing or unverifiable"),
  SUPERSEDED: bindingReason("a successor approval superseded this record"),
});
export type ApprovalControlState = "ENABLED" | "DISABLED" | "ABSENT";
export type ApprovalGuardId =
  | "AFFORDANCE_ABSENT" | "AUTHORITY_CONTEXT" | "RECORD_LIFECYCLE"
  | "RECORD_VALIDITY" | "REVISION_HASH";
export type ApprovalAuthorityContext = ApprovalAuthorityRequest;
export interface ApprovalAuthorityPresentation {
  readonly gate: HumanAuthorityGate | null;
  readonly grant: HumanAuthorityGrant | null;
  readonly policy: ApprovalPolicy;
  readonly result: ApprovalAuthorityResult;
  readonly truthClass: ApprovalDecisionRecord["truthClass"];
}
export interface ApprovalControlRequest {
  readonly commandKind: RuntimeCommandKind;
  readonly destructive?: boolean;
  readonly label: string;
  readonly qualifier?: string;
}
export interface ApprovalControl {
  readonly authority?: ApprovalAuthorityPresentation | null;
  readonly commandId: string | null;
  readonly commandKind: RuntimeCommandKind;
  readonly destructive: boolean;
  readonly disabledText: string | null;
  readonly label: string;
  readonly reasonCode: string | null;
  readonly reasonPhrase?: string | null;
  readonly refusedBy: ApprovalGuardId | null;
  readonly refusingLayer?: ApprovalAuthorityLayer | null;
  readonly state: ApprovalControlState;
  readonly testId: string;
}
export interface ApprovalGatingInput {
  readonly affordances: readonly NextAllowedCommand[];
  readonly authority?: ApprovalAuthorityContext | undefined;
  readonly reasons?: Readonly<Record<string, ApprovalReason>>;
  readonly record: ApprovalDecisionRecord;
  readonly requests: readonly ApprovalControlRequest[];
  readonly targetAggregateId: string;
}
export function controlTestId(commandKind: RuntimeCommandKind, qualifier?: string): string {
  const base = `cr.action.${commandKind.replaceAll(".", "-")}`;
  return qualifier === undefined ? base : `${base}.${qualifier}`;
}
export function unavailableText(reason: ApprovalReason): string {
  return `Unavailable: ${reason.phrase} (${reason.code} @ ${reason.refusingLayer}).`;
}
export function decisionCommandKind(kind: ApprovalDecisionKind): RuntimeCommandKind {
  return kind === "EXPANSION" ? "graph.approve" : "approval.decide";
}
function control(
  request: ApprovalControlRequest,
  state: ApprovalControlState,
  refusedBy: ApprovalGuardId | null,
  reason: ApprovalReason | null,
  commandId: string | null,
  authority: ApprovalAuthorityPresentation | null,
): ApprovalControl {
  return Object.freeze({
    authority, commandId, commandKind: request.commandKind,
    destructive: request.destructive === true,
    disabledText: reason === null ? null : unavailableText(reason), label: request.label,
    reasonCode: reason?.code ?? null, reasonPhrase: reason?.phrase ?? null, refusedBy,
    refusingLayer: reason?.refusingLayer ?? null, state,
    testId: controlTestId(request.commandKind, request.qualifier),
  });
}
function refusal(
  record: ApprovalDecisionRecord,
  affordance: NextAllowedCommand,
): readonly [ApprovalGuardId, ApprovalReason] | null {
  if (record.lifecycle !== "PENDING") {
    return ["RECORD_LIFECYCLE", APPROVAL_REASONS.LIFECYCLE_CLOSED];
  }
  if (record.validity === "INVALIDATED") {
    return ["RECORD_VALIDITY", APPROVAL_REASONS.INVALIDATED];
  }
  if (record.validity === "SUPERSEDED") {
    return ["RECORD_VALIDITY", APPROVAL_REASONS.SUPERSEDED];
  }
  if (affordance.graphRevisionHash === undefined) {
    return ["REVISION_HASH", APPROVAL_REASONS.HASH_UNPINNED];
  }
  if (affordance.graphRevisionHash !== record.exactRevisionHash) {
    return ["REVISION_HASH", APPROVAL_REASONS.HASH_MISMATCH];
  }
  return null;
}
interface AuthorityEvaluation {
  readonly presentation: ApprovalAuthorityPresentation | null;
  readonly reason: ApprovalReason | null;
}
function snapshotRequest(context: ApprovalAuthorityContext): ApprovalAuthorityRequest {
  const rawGate = context.gate;
  const rawPolicy = context.policy;
  if (rawGate === undefined || rawPolicy === undefined || rawPolicy === null) {
    throw new Error("authority context omitted a required field");
  }
  const policy = Object.freeze({ ...rawPolicy }) as ApprovalPolicy;
  if (rawGate === null) return Object.freeze({ gate: null, policy });
  const supplied = rawGate.grant;
  const grant = supplied === null || supplied === undefined
    ? supplied
    : Object.freeze({ ...supplied });
  const gate = Object.freeze({ ...rawGate, grant }) as HumanAuthorityGate;
  return Object.freeze({ gate, policy });
}
function authorityReason(refusal: ApprovalAuthorityRefusal): ApprovalReason {
  const canonical = approvalReason(refusal.code, AUTHORITY_PHRASES[refusal.code]);
  return refusal.layer === canonical.refusingLayer ? canonical : APPROVAL_REASONS.MALFORMED_AUTHORITY;
}
function normalizeReason(value: unknown): ApprovalReason {
  try {
    const supplied = value as ApprovalReason;
    if (typeof supplied.phrase !== "string") throw new Error("invalid phrase");
    const canonical = approvalReason(supplied.code, supplied.phrase);
    return supplied.refusingLayer === canonical.refusingLayer
      ? canonical : APPROVAL_REASONS.MALFORMED_AUTHORITY;
  } catch {
    return APPROVAL_REASONS.MALFORMED_AUTHORITY;
  }
}
function evaluateAuthority(
  context: ApprovalAuthorityContext | undefined,
  truthClass: ApprovalDecisionRecord["truthClass"],
): AuthorityEvaluation | null {
  if (context === undefined) return null;
  try {
    if (typeof context !== "object" || context === null) throw new Error("invalid context");
    const request = snapshotRequest(context);
    const result = decideApprovalAuthority(request);
    const presentation = Object.freeze({
      gate: request.gate, grant: result.ok ? result.grant : null,
      policy: request.policy, result, truthClass,
    });
    return Object.freeze({ presentation, reason: result.ok ? null : authorityReason(result) });
  } catch {
    return Object.freeze({ presentation: null, reason: APPROVAL_REASONS.MALFORMED_AUTHORITY });
  }
}
function resolveOne(
  input: ApprovalGatingInput,
  request: ApprovalControlRequest,
  authority: AuthorityEvaluation | null,
): ApprovalControl {
  const testId = controlTestId(request.commandKind, request.qualifier);
  const affordance = input.affordances.find((entry) =>
    entry.commandKind === request.commandKind && entry.targetAggregateId === input.targetAggregateId);
  if (affordance === undefined) {
    const supplied = input.reasons?.[testId];
    return supplied === undefined
      ? control(request, "ABSENT", "AFFORDANCE_ABSENT", null, null, authority?.presentation ?? null)
      : control(request, "DISABLED", "AFFORDANCE_ABSENT", normalizeReason(supplied), null,
        authority?.presentation ?? null);
  }
  if (authority?.reason !== null && authority?.reason !== undefined) {
    return control(request, "DISABLED", "AUTHORITY_CONTEXT", authority.reason, null, authority.presentation);
  }
  const refused = refusal(input.record, affordance);
  return refused === null
    ? control(request, "ENABLED", null, null, affordance.commandId, authority?.presentation ?? null)
    : control(request, "DISABLED", refused[0], refused[1], null, authority?.presentation ?? null);
}
export function resolveApprovalControls(input: ApprovalGatingInput): readonly ApprovalControl[] {
  const authority = evaluateAuthority(input.authority, input.record.truthClass);
  const controls: ApprovalControl[] = [];
  const seen = new Set<string>();
  for (const request of input.requests) {
    const id = controlTestId(request.commandKind, request.qualifier);
    if (seen.has(id)) continue;
    seen.add(id);
    controls.push(resolveOne(input, request, authority));
  }
  return Object.freeze(controls);
}
export function isSubmittable(control: ApprovalControl): boolean {
  return control.state === "ENABLED" && control.commandId !== null;
}
