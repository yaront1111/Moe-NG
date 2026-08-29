import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";

import { boundGoalOf } from "./live-board-feed.js";
import { dispatchPreparedPayload } from "./live-command-dispatch.js";
import { recordDispatchEffort } from "./live-effort-edge.js";
import { payloadFor } from "./live-dispatch-payloads.js";

/**
 * Dispatch = the daemon's affordance handed back through the generated builder.
 *
 * The builder validates the affordance and mints the envelope; this module adds only the caller
 * half (payload, correlation, digest, credential) and reports the daemon's answer verbatim. The
 * UI never moves a card on the strength of a dispatch — the next surface poll does, because
 * only the ledger moves cards. The payloads themselves live in live-dispatch-payloads.ts and are
 * re-exported here, so every caller this module already had keeps its one import.
 *
 * THE IDENTITY IS THE OFFER'S. The daemon offers the planning commands once per durable goal;
 * this module reads the target off the offer it was handed and refuses rather than falling back
 * to the card the operator happened to be looking at.
 */

export { DEV_PAYLOADS, payloadFor } from "./live-dispatch-payloads.js";

export interface DispatchReport {
  /** The daemon's own answer text: resultCode, refusal code, or transport code. */
  readonly detail: string;
  readonly ok: boolean;
  readonly stage: "ANSWERED" | "BUILD_REFUSED" | "UNDELIVERED";
}

/** The kinds the daemon offers once per durable goal, each carrying its own target. */
const PLANNING_KINDS: readonly string[] =
  Object.freeze(["approval.decide", "goal.close", "plan.propose"]);

/**
 * The exact answer a board gives itself when the daemon offered a planning command for a run it
 * has bound to no durable goal. It names the refusing layer, like every daemon refusal this
 * board repeats, so a reader can tell a CALLER-side refusal from the daemon's own.
 */
const PLANNING_BINDING_ABSENT = "PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH";

export interface DispatchInput {
  readonly affordance: Record<string, unknown>;
  readonly aggregateId: string | null;
  readonly client: ControlRoomClientSurface;
  readonly kind: string;
  /**
   * The daemon's OWN run -> durable goal bindings, one per goal it answers a planning offer for
   * (`SurfaceFrame.planningGoalRefs`). Absent reads as bound nothing, which authors no planning
   * command at all: there is no default, no first entry and no singular fallback.
   */
  readonly planningGoalRefs?: Readonly<Record<string, string>> | undefined;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
  /** The step's surface version; absent reads as the first commit. */
  readonly version?: number | null | undefined;
}

/** One own, enumerable, non-empty string data property. An accessor answers null. */
function ownNonEmptyString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    const found: unknown = descriptor.value;
    return typeof found === "string" && found !== "" ? found : null;
  } catch {
    return null;
  }
}

interface PlanningTarget {
  readonly goalRef: string | null;
  readonly target: string;
}

/**
 * THE IDENTITY SELECTOR, and the only one. For a planning kind the target is the OFFER's own
 * `targetAggregateId` - never `input.aggregateId`, which is the card the operator was looking at
 * and can name a sibling's run. plan.propose additionally needs the goal the daemon bound to that
 * exact run; an unbound run, an absent map or an offer that names no target authors nothing.
 */
function planningTargetOf(input: DispatchInput): PlanningTarget | null {
  const target = ownNonEmptyString(input.affordance, "targetAggregateId");
  if (target === null) return null;
  if (input.kind !== "plan.propose") return { goalRef: null, target };
  const goalRef = boundGoalOf(input.planningGoalRefs, target);
  return goalRef === null ? null : { goalRef, target };
}

export async function dispatchAffordance(input: DispatchInput): Promise<DispatchReport> {
  // A side record of what the surface demanded of the operator, taken before anything
  // can refuse: the human already decided by handing the card back, whatever the daemon
  // then answers. It returns void and cannot throw, so every line below is unchanged.
  recordDispatchEffort({
    affordance: input.affordance, aggregateId: input.aggregateId, commandKind: input.kind,
  });
  const planning = PLANNING_KINDS.includes(input.kind) ? planningTargetOf(input) : null;
  if (planning === null && PLANNING_KINDS.includes(input.kind)) {
    return { detail: PLANNING_BINDING_ABSENT, ok: false, stage: "BUILD_REFUSED" };
  }
  const payload = payloadFor(
    input.kind, planning?.target ?? input.aggregateId, input.version ?? null,
    planning?.goalRef ?? null,
  );
  if (payload === null) {
    return { detail: "no development payload for this kind", ok: false, stage: "BUILD_REFUSED" };
  }
  // The builder, the digest, the transport and the answer decoder are the SHARED production
  // path (live-command-dispatch.ts). A second copy here is how the two halves drifted: this
  // one read `ok: true` and believed it, while the shared one demands the daemon's exact
  // accepted shape and its own commandId back. Only the outward stage vocabulary is this
  // module's, so the callers it already had do not change.
  const report = await dispatchPreparedPayload(input, payload);
  const stage = report.stage === "BUILD_REFUSED" || report.stage === "UNDELIVERED"
    ? report.stage
    : "ANSWERED";
  return { detail: report.detail, ok: report.ok, stage };
}
