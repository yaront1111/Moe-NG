import { canonicalDigest, deepFreeze } from "../canonical.js";
import {
  isTerminalEffectState,
  supervisorFailure,
  SUPERVISOR_RESULT_VERSION,
  type EffectCommand,
  type EffectIntent,
  type EffectResult,
  type EffectState,
  type SupervisorErrorCode,
  type SupervisorFailure,
  type SupervisorLayer,
  type TerminalEffectState,
} from "./effect-kernel.js";
import {
  parseCommandInput,
  parseEffectIntent,
  parseEffectTombstone,
  parseSettlementEvidence,
  parseUncertaintyEvidence,
  type SettleCommand,
} from "./effect-parse.js";
import { MAX_SUPERVISOR_COUNT } from "./effect-shape.js";

/**
 * The pure effect lifecycle reducer (design lines 774-775).
 *
 * Records in, one frozen outcome out. There is no clock and no randomness here:
 * a settlement instant is a validated input, and a completion is only ever
 * adopted from evidence somebody else produced. The reducer cannot invent a
 * terminal state, which is why `settle` refuses without a reconciliation
 * reference rather than defaulting to "probably succeeded".
 *
 * `MUST_DRAIN` is a third outcome kind rather than a refusal. A caller matching
 * on refusal codes would retry a rejected command; cancelling an ACTIVE effect
 * is not a rejected command, it is an instruction to drain (design 775-779).
 */
export interface AdmittedTransition {
  readonly from: EffectState;
  readonly command: EffectCommand;
  readonly to: readonly EffectState[];
}

/**
 * The closed arc table, exported as data; no reducer below invents an edge that
 * is not listed here.
 *
 * `ACTIVE -> CANCEL_REQUESTED` (design 776) is admitted here but is NOT reachable
 * from a bare `requestCancel` command: `applyEffectCommand` still answers
 * `MUST_DRAIN` for that cell. Design 13.1 is explicit that once activation has
 * committed, a later cancel must treat effect and attempt as active and
 * drain/reconcile them, so the successor is authorised inside the drain
 * transaction — `drain-reconciliation.ts` consults this row before emitting it —
 * rather than by a lone reducer call that would move the state while the
 * external action is still live.
 */
export const ADMITTED_EFFECT_TRANSITIONS: readonly AdmittedTransition[] = deepFreeze([
  { from: "PENDING", command: "claim", to: ["CLAIMED"] },
  { from: "PENDING", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "CLAIMED", command: "arm", to: ["ARMED"] },
  { from: "CLAIMED", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ARMED", command: "activate", to: ["ACTIVE"] },
  { from: "ARMED", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ACTIVE", command: "requestCancel", to: ["CANCEL_REQUESTED"] },
  { from: "ACTIVE", command: "settle", to: ["SUCCEEDED", "FAILED", "UNKNOWN"] },
  { from: "CANCEL_REQUESTED", command: "settle", to: ["CANCELLED", "UNKNOWN"] },
] as const satisfies readonly AdmittedTransition[]);

/** Design 773: exactly the states a terminal tombstone may dominate. */
const PRE_ACTIVATION_STATES: readonly string[] = ["PENDING", "CLAIMED", "ARMED"];

function admittedArc(from: EffectState, command: EffectCommand): AdmittedTransition | undefined {
  return ADMITTED_EFFECT_TRANSITIONS.find(
    (entry) => entry.from === from && entry.command === command,
  );
}

export type LifecycleOutcome =
  | {
      readonly kind: "TRANSITIONED";
      readonly ok: true;
      readonly intent: EffectIntent;
      readonly result: EffectResult | null;
      readonly versionDelta: 1;
    }
  | {
      readonly kind: "MUST_DRAIN";
      readonly drainRequired: true;
      readonly intent: EffectIntent;
      readonly versionDelta: 0;
    }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

function refuse(
  code: SupervisorErrorCode,
  layer: SupervisorLayer,
  message: string,
  detail: { state?: string; command?: string } = {},
): LifecycleOutcome {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: supervisorFailure(code, layer, message, {
      state: detail.state ?? null,
      command: detail.command ?? null,
      leg: null,
    }),
  });
}

/** The exact value hashed into `EffectResult.settlementDigest`. */
function settlementDigestInput(settlement: unknown, uncertainty: unknown): Record<string, unknown> {
  return { settlement, uncertainty };
}

function transitioned(
  intent: EffectIntent,
  target: EffectState,
  result: EffectResult | null,
): LifecycleOutcome {
  return deepFreeze({
    kind: "TRANSITIONED" as const,
    ok: true as const,
    intent: { ...intent, state: target, version: intent.version + 1 },
    result,
    versionDelta: 1 as const,
  });
}

function adoptResult(
  intentId: string, terminalState: TerminalEffectState, outcomeClass: string,
  settlementDigest: string, adoptedAt: string,
): EffectResult {
  return deepFreeze({
    resultVersion: SUPERVISOR_RESULT_VERSION,
    intentId, terminalState, outcomeClass, settlementDigest, adoptedAt,
  });
}

/**
 * Evidence gating for `settle`. Uncertainty evidence is required for `UNKNOWN`
 * and refused for every other target, so the two cancel arcs of design 775 are
 * discriminated by what the caller can actually prove rather than by which
 * terminal state the caller would prefer.
 */
function settleIntent(intent: EffectIntent, command: SettleCommand): LifecycleOutcome {
  const at = { state: intent.state, command: "settle" };
  const no = (code: SupervisorErrorCode, message: string): LifecycleOutcome =>
    refuse(code, "LIFECYCLE", message, at);
  const arc = admittedArc(intent.state, "settle");
  if (arc === undefined) {
    return no("EFFECT_TRANSITION_NOT_ADMITTED", `${intent.state} does not admit settle`);
  }
  // A state that settles at all, asked for a terminal it cannot reach, is a
  // different mistake from a state that cannot settle — the codes stay distinct
  // so a caller learns whether to pick another target or another command.
  if (!arc.to.includes(command.target) || !isTerminalEffectState(command.target)) {
    return no(
      "EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED",
      `settling ${intent.state} as ${command.target} is not an admitted arc`,
    );
  }
  const settlement = parseSettlementEvidence(command.settlement);
  if (settlement === null) {
    return no(
      "EFFECT_SETTLEMENT_EVIDENCE_INVALID",
      "settlement requires a well-formed reconciliation reference",
    );
  }
  const uncertainty =
    command.uncertainty === null ? null : parseUncertaintyEvidence(command.uncertainty);
  if (command.target === "UNKNOWN" && uncertainty === null) {
    return no(
      "EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED",
      "an UNKNOWN settlement requires a well-formed uncertainty reference",
    );
  }
  if (command.target !== "UNKNOWN" && command.uncertainty !== null) {
    return no(
      "EFFECT_UNCERTAINTY_EVIDENCE_UNEXPECTED",
      `a ${command.target} settlement is proven, so it carries no uncertainty reference`,
    );
  }
  const digest = canonicalDigest(settlementDigestInput(settlement, uncertainty));
  const result = adoptResult(
    intent.intentId, command.target, settlement.outcomeClass, digest, command.adoptedAt,
  );
  return transitioned(intent, command.target, result);
}

export function applyEffectCommand(intentValue: unknown, commandValue: unknown): LifecycleOutcome {
  const intent = parseEffectIntent(intentValue);
  if (intent === null) {
    return refuse("EFFECT_INTENT_MALFORMED", "KERNEL", "effect intent does not parse");
  }
  const command = parseCommandInput(commandValue);
  if (command === null) {
    return refuse("EFFECT_COMMAND_MALFORMED", "KERNEL", "effect command does not parse", {
      state: intent.state,
    });
  }
  const at = { state: intent.state, command: command.kind };
  // A record at the counter ceiling still reads, but a successor above the
  // ceiling would never parse again — the intent would be stranded mid-flight.
  if (intent.version >= MAX_SUPERVISOR_COUNT) {
    return refuse("EFFECT_COUNTER_EXHAUSTED", "LIFECYCLE", "intent version counter is exhausted", at);
  }
  if (isTerminalEffectState(intent.state)) {
    const absorbed = `terminal ${intent.state} absorbs ${command.kind}`;
    return refuse("EFFECT_TERMINAL_ABSORBED", "LIFECYCLE", absorbed, at);
  }
  if (intent.state === "ACTIVE" && command.kind === "requestCancel") {
    return deepFreeze({
      kind: "MUST_DRAIN" as const,
      drainRequired: true as const,
      intent,
      versionDelta: 0 as const,
    });
  }
  if (command.kind === "settle") {
    return settleIntent(intent, command);
  }
  const target = admittedArc(intent.state, command.kind)?.to[0];
  if (target === undefined) {
    const message = `${intent.state} does not admit ${command.kind}`;
    return refuse("EFFECT_TRANSITION_NOT_ADMITTED", "LIFECYCLE", message, at);
  }
  return transitioned(intent, target, null);
}

/**
 * A terminal tombstone dominates a PRE-ACTIVATION intent only (design 773). It
 * never reaches across activation: once the effect is ACTIVE the external action
 * may already have happened, so the disposition is a drain, not a deletion.
 */
export function applyEffectTombstone(
  intentValue: unknown,
  tombstoneValue: unknown,
): LifecycleOutcome {
  const intent = parseEffectIntent(intentValue);
  if (intent === null) {
    return refuse("EFFECT_INTENT_MALFORMED", "KERNEL", "effect intent does not parse");
  }
  const tombstone = parseEffectTombstone(tombstoneValue);
  if (tombstone === null) {
    return refuse("EFFECT_TOMBSTONE_MALFORMED", "KERNEL", "effect tombstone does not parse", {
      state: intent.state,
    });
  }
  const at = { state: intent.state, command: "tombstone" };
  if (intent.version >= MAX_SUPERVISOR_COUNT) {
    return refuse("EFFECT_COUNTER_EXHAUSTED", "LIFECYCLE", "intent version counter is exhausted", at);
  }
  if (!PRE_ACTIVATION_STATES.includes(intent.state) || tombstone.intentId !== intent.intentId) {
    const message = `a tombstone does not dominate ${intent.state} for this intent`;
    return refuse("EFFECT_TOMBSTONE_DOES_NOT_DOMINATE", "LIFECYCLE", message, at);
  }
  const result = adoptResult(
    intent.intentId, "CANCELLED", tombstone.reason,
    canonicalDigest({ tombstone }), tombstone.terminalizedAt,
  );
  return transitioned(intent, "CANCELLED", result);
}
