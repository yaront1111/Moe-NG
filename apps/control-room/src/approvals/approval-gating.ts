import { lookupRuntimeError } from "@moe/contracts";
import type {
  NextAllowedCommand,
  RuntimeAggregate,
  RuntimeCommandKind,
  RuntimeErrorCode,
} from "@moe/contracts";

import type { ApprovalDecisionKind, ApprovalDecisionRecord } from "./approval-fixtures.js";

export interface ApprovalReason {
  readonly code: RuntimeErrorCode;
  readonly phrase: string;
  readonly source: RuntimeAggregate;
}

/**
 * One refusal reason, checked against the ratified registry at construction.
 *
 * The approvals reason channel is local because the landed shell fixtures carry none, and it
 * is PROVISIONAL pending the daemon's stable reason registry (spec §13-D2). It may only name
 * a code the ratified runtime registry defines, paired with a lifecycle source that code's
 * own registry row admits: an unknown spelling resolves to the `UNKNOWN_ERROR` descriptor,
 * which is how an invented code is caught, and an empty `validSources` row is
 * source-unrestricted by contract while any other row must list the source being claimed.
 */
export function approvalReason(
  code: RuntimeErrorCode,
  source: RuntimeAggregate,
  phrase: string,
): ApprovalReason {
  const descriptor = lookupRuntimeError(code);
  if (descriptor.code !== code) {
    throw new Error(`approval reason ${code} is not a ratified runtime error code`);
  }
  const { validSources } = descriptor;
  if (validSources.length > 0 && !validSources.includes(source)) {
    throw new Error(`approval reason ${code} does not admit lifecycle source ${source}`);
  }
  return Object.freeze({ code, phrase, source });
}

/** Every reason a control can carry; each is registry-checked at module load. */
export const APPROVAL_REASONS = Object.freeze({
  CAPABILITY_DENIED: approvalReason(
    "CAPABILITY_DENIED", "APPROVAL", "your capability does not cover this decision",
  ),
  CUTOVER_STATE: approvalReason(
    "CUTOVER_STATE_INVALID", "CUTOVER", "the cutover already left the state this action requires",
  ),
  HASH_MISMATCH: approvalReason(
    "EXPECTED_VERSION_CONFLICT", "GRAPH_REVISION",
    "this record's exact revision hash is not the identity the command would act on",
  ),
  HASH_UNPINNED: approvalReason(
    "STALE_EPOCH", "GRAPH_REVISION", "the returned command pinned no revision hash to compare",
  ),
  INVALIDATED: approvalReason(
    "REVISION_REBOUND", "GRAPH_REVISION",
    "a newer revision rebound the identity this approval was given for",
  ),
  LIFECYCLE_CLOSED: approvalReason(
    "ILLEGAL_TRANSITION", "APPROVAL", "this approval has already been decided or withdrawn",
  ),
  SUPERSEDED: approvalReason(
    "SUPERSEDED_AUTHORITY", "GRAPH_REVISION", "a successor approval superseded this record",
  ),
});

/**
 * Pure gating for approval decision controls. No JSX, no state, no transport.
 *
 * Two rules produce every control here, and neither of them is a phase lookup:
 *
 *  1. Spec §12 bar 4 — an enabled control exists only because a `nextAllowedCommands`
 *     entry exists. Nothing widens a control from a lifecycle enum or a transition table.
 *  2. Design 1007 — the daemon commits the prepare BEFORE the approval action enables, so
 *     the click can never approve an identity created after it. The client therefore
 *     re-checks the record against the identity the returned command pins, and refuses on
 *     any mismatch. This is a fail-closed client refusal, not a claim of authority.
 *
 * Spec §8.1 ("no supplied reason → the control is absent, never disabled-with-guessed-text")
 * governs the leg it actually describes: a control the §5 matrix expects that the daemon did
 * not return. The stale-record guards below are local refusals of a command the daemon DID
 * return, so they carry their own registry-checked reason rather than staying silent —
 * refusing without saying why would be the dishonest reading of the same rule.
 */
export type ApprovalControlState = "ENABLED" | "DISABLED" | "ABSENT";

export type ApprovalGuardId =
  | "AFFORDANCE_ABSENT"
  | "RECORD_LIFECYCLE"
  | "RECORD_VALIDITY"
  | "REVISION_HASH";

export interface ApprovalControlRequest {
  readonly commandKind: RuntimeCommandKind;
  readonly destructive?: boolean;
  readonly label: string;
  readonly qualifier?: string;
}

export interface ApprovalControl {
  readonly commandId: string | null;
  readonly commandKind: RuntimeCommandKind;
  readonly destructive: boolean;
  readonly disabledText: string | null;
  readonly label: string;
  readonly reasonCode: string | null;
  readonly refusedBy: ApprovalGuardId | null;
  readonly state: ApprovalControlState;
  readonly testId: string;
}

export interface ApprovalGatingInput {
  readonly affordances: readonly NextAllowedCommand[];
  /** Daemon-shaped refusal reasons, keyed by the control's test ID. */
  readonly reasons?: Readonly<Record<string, ApprovalReason>>;
  readonly record: ApprovalDecisionRecord;
  readonly requests: readonly ApprovalControlRequest[];
  readonly targetAggregateId: string;
}

/**
 * Spec §1.4: `cr.action.<commandName>` with `.` replaced by `-`, qualified when one command
 * carries more than one decision. Derived from the command name, never from display text.
 */
export function controlTestId(commandKind: RuntimeCommandKind, qualifier?: string): string {
  const base = `cr.action.${commandKind.replaceAll(".", "-")}`;
  return qualifier === undefined ? base : `${base}.${qualifier}`;
}

/** Spec §8.1 copy, verbatim. */
export function unavailableText(reason: ApprovalReason): string {
  return `Unavailable: ${reason.phrase} (${reason.code}).`;
}

/**
 * Design 1007 kind routing: `graph.approve` carries expansion/revision approval; every other
 * kind is a member of the `approval.decide` typed union. Provisional pending spec §13-D1.
 */
export function decisionCommandKind(kind: ApprovalDecisionKind): RuntimeCommandKind {
  return kind === "EXPANSION" ? "graph.approve" : "approval.decide";
}

function control(
  request: ApprovalControlRequest,
  testId: string,
  state: ApprovalControlState,
  refusedBy: ApprovalGuardId | null,
  reason: ApprovalReason | null,
  commandId: string | null,
): ApprovalControl {
  return Object.freeze({
    commandId,
    commandKind: request.commandKind,
    destructive: request.destructive === true,
    disabledText: reason === null ? null : unavailableText(reason),
    label: request.label,
    reasonCode: reason === null ? null : reason.code,
    refusedBy,
    state,
    testId,
  });
}

/** The first guard that refuses, in a fixed order, with the reason that guard owns. */
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
  const pinned = affordance.graphRevisionHash;
  if (pinned === undefined) {
    return ["REVISION_HASH", APPROVAL_REASONS.HASH_UNPINNED];
  }
  if (pinned !== record.exactRevisionHash) {
    return ["REVISION_HASH", APPROVAL_REASONS.HASH_MISMATCH];
  }
  return null;
}

function resolveOne(
  input: ApprovalGatingInput,
  request: ApprovalControlRequest,
): ApprovalControl {
  const testId = controlTestId(request.commandKind, request.qualifier);
  const affordance = input.affordances.find(
    (entry) =>
      entry.commandKind === request.commandKind
      && entry.targetAggregateId === input.targetAggregateId,
  );
  if (affordance === undefined) {
    const supplied = input.reasons?.[testId];
    return supplied === undefined
      ? control(request, testId, "ABSENT", "AFFORDANCE_ABSENT", null, null)
      : control(request, testId, "DISABLED", "AFFORDANCE_ABSENT", supplied, null);
  }
  const refused = refusal(input.record, affordance);
  return refused === null
    ? control(request, testId, "ENABLED", null, null, affordance.commandId)
    : control(request, testId, "DISABLED", refused[0], refused[1], null);
}

/**
 * Resolves every requested control against the daemon's affordances and the record.
 *
 * A control is only ever `ENABLED` with a non-null `commandId`; every refusing path returns
 * `commandId: null`, so a surface physically cannot submit a stale approval even if it
 * ignores the state field.
 */
export function resolveApprovalControls(
  input: ApprovalGatingInput,
): readonly ApprovalControl[] {
  return Object.freeze(input.requests.map((request) => resolveOne(input, request)));
}

/** A control may be submitted only when it is enabled and carries a real command ID. */
export function isSubmittable(control: ApprovalControl): boolean {
  return control.state === "ENABLED" && control.commandId !== null;
}
