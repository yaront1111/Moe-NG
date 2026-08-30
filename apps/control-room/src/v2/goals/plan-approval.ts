import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type {
  CommandAffordance, ControlRoomClientSurface, ControlRoomTransport,
} from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";

/**
 * PLAN APPROVAL: the affordance gate, then the daemon's own approval wire.
 *
 * TWO SEPARATIONS ARE LOAD-BEARING, and they are what make this module small.
 *
 * 1. THE AUTHORITY IS THE DAEMON'S OFFER, never the browser's opinion. Nothing
 *    here decides that a plan may be approved: `authorizeApproval` looks for the
 *    daemon's own `approval.decide_intent` affordance BOUND TO THIS RUN on the
 *    surface frame, and withholds with a stable code when it is absent. An enabled
 *    button is a CONSEQUENCE of that grant; it is never its source. A caller-shaped
 *    HUMAN_APPROVED marker, an operator flag, or the caller-authored
 *    `approval.decide` offer are all NOT grants - `approval.decide`'s payload
 *    demands an `activation`/`record` pair this browser would have to invent, and
 *    inventing one is exactly how a UI ends up authorizing itself.
 *
 * 2. THE WIRE IS `approval.decide_intent`, the DAEMON-OWNED seam (task-6646f888).
 *    Its whole payload is { decision, decisionReason, dependencyChanges, runId }:
 *    identity and human-authored intent, no witness. The daemon MINTS the human-review
 *    witness from the authenticated principal (`daemon-command-edges.ts`), so no payload
 *    can present one. This module therefore composes no authority, no truthClass and no actor.
 *
 * REFUSALS NAME THE LAYER THAT ANSWERED. Three different mechanisms can refuse a
 * click and they are kept distinguishable on purpose: this gate
 * (`PLAN_APPROVAL_LAYER`), the generated builder (`PLAN_APPROVAL_BUILD_LAYER`) and
 * delivery (`PLAN_APPROVAL_TRANSPORT_LAYER`). A daemon refusal travels back
 * UNRESTAMPED, carrying the code and layer of whichever authority answered.
 *
 * KNOWN PRODUCER GAP, measured at HEAD 24ac4ae9 and disclosed rather than papered
 * over: `approval.decide_intent` is ROUTED by the daemon
 * (`daemon-command-registry.ts:221`) but is offered NOWHERE in
 * `apps/daemon/src/http` - `affordance-planning-offers.ts:83` mints only
 * `approval.decide | goal.close | plan.propose`. Until that producer offers the
 * intent kind, this gate withholds APPROVAL_AFFORDANCE_ABSENT against a live
 * daemon and the control renders disabled with that reason. Minting the affordance
 * locally to light the button would be fabricating the approval route.
 */

/** This module's own layer: the affordance gate, before anything is built or sent. */
export const PLAN_APPROVAL_LAYER = "CONTROL_ROOM_PLAN_APPROVAL";
/** The generated command builder's layer. */
export const PLAN_APPROVAL_BUILD_LAYER = "CONTROL_ROOM_COMMAND_BUILD";
/** The transport's layer: the request never reached an authority. */
export const PLAN_APPROVAL_TRANSPORT_LAYER = "CONTROL_ROOM_TRANSPORT";

/** The DAEMON-OWNED approval wire. The caller-authored `approval.decide` is not it. */
export const APPROVAL_COMMAND_KIND = "approval.decide_intent" as const;

/** The one decision this screen sends; `decisionReason` stays null for a plain approve. */
const APPROVE_DECISION = "APPROVE";

/**
 * Every reason this gate can withhold approval. Exhaustive and stable: each is
 * rendered to the operator verbatim beside `PLAN_APPROVAL_LAYER`, so a code added
 * here without a producing branch would advertise a refusal nothing can reach.
 */
export const PLAN_APPROVAL_WITHHELD_CODES = Object.freeze([
  "APPROVAL_AFFORDANCE_ABSENT",
  "APPROVAL_AFFORDANCE_SUBJECT_MISMATCH",
  "APPROVAL_SURFACE_NOT_CONNECTED",
  "APPROVAL_SURFACE_UNREAD",
] as const);

export type PlanApprovalWithheldCode = (typeof PLAN_APPROVAL_WITHHELD_CODES)[number];

export interface ApprovalGrant {
  /** The daemon's `NextAllowedCommand`, carried VERBATIM. Never minted here. */
  readonly affordance: Readonly<Record<string, unknown>>;
  /** The DURABLE planning run this grant was offered for. */
  readonly runId: string;
}

export type ApprovalAuthorization =
  | { readonly grant: ApprovalGrant; readonly status: "AUTHORIZED" }
  | {
    readonly code: PlanApprovalWithheldCode;
    readonly layer: typeof PLAN_APPROVAL_LAYER;
    readonly status: "WITHHELD";
  };

function withheld(code: PlanApprovalWithheldCode): ApprovalAuthorization {
  return Object.freeze({ code, layer: PLAN_APPROVAL_LAYER, status: "WITHHELD" as const });
}

/**
 * The daemon's word on whether THIS run may be approved right now.
 *
 * The subject match is on the DURABLE run the offer names, so an offer minted for
 * another run cannot approve this one; that is a different, louder failure than a
 * missing offer and carries its own code.
 */
export function authorizeApproval(
  frame: SurfaceFrame | null, runId: string,
): ApprovalAuthorization {
  if (frame === null) return withheld("APPROVAL_SURFACE_UNREAD");
  if (frame.outcome !== "SURFACE" || frame.connection !== "CONNECTED") {
    return withheld("APPROVAL_SURFACE_NOT_CONNECTED");
  }
  const approvals = frame.offers.filter(
    (candidate) => candidate["commandKind"] === APPROVAL_COMMAND_KIND,
  );
  if (approvals.length === 0) return withheld("APPROVAL_AFFORDANCE_ABSENT");
  const bound = runId === ""
    ? undefined
    : approvals.find((candidate) => candidate["targetAggregateId"] === runId);
  if (bound === undefined) return withheld("APPROVAL_AFFORDANCE_SUBJECT_MISMATCH");
  return Object.freeze({ grant: Object.freeze({ affordance: bound, runId }), status: "AUTHORIZED" as const });
}

export type PlanApprovalOutcome =
  | { readonly commandId: string; readonly ok: true }
  | { readonly code: string; readonly layer: string; readonly ok: false };

export interface PlanApprovalPort {
  /** Calls the real typed command. Only a grant the daemon offered can reach it. */
  readonly submit: (grant: ApprovalGrant) => Promise<PlanApprovalOutcome>;
}

/**
 * Exactly what the dispatch needs, so a `LiveSetup` satisfies it structurally
 * without this module depending on the whole live configuration.
 */
export interface PlanApprovalWire {
  readonly client: Pick<ControlRoomClientSurface, "commands">;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The refusing authority's OWN code and layer, never rewritten and never summarised. */
function refusalOf(value: unknown): PlanApprovalOutcome | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  if (typeof code !== "string" || code === "") return null;
  const layer = value["layer"];
  return Object.freeze({
    code, layer: typeof layer === "string" && layer !== "" ? layer : "DAEMON", ok: false as const,
  });
}

function answerOf(response: unknown, commandId: string): PlanApprovalOutcome {
  if (!isRecord(response)) {
    return { code: "APPROVAL_ANSWER_UNREADABLE", layer: PLAN_APPROVAL_LAYER, ok: false };
  }
  if (response["ok"] === true) return { commandId, ok: true };
  return refusalOf(response["refusal"]) ?? refusalOf(response["error"])
    ?? { code: "APPROVAL_REFUSED", layer: "DAEMON", ok: false };
}

export function createPlanApprovalPort(wire: PlanApprovalWire): PlanApprovalPort {
  return Object.freeze({
    submit: async (grant: ApprovalGrant): Promise<PlanApprovalOutcome> => {
      // The explicit empty tuple is this authenticated human's assertion that approval changes
      // no dependencies. It is never a daemon default; the witness remains server-minted.
      const payload = {
        decision: APPROVE_DECISION,
        decisionReason: null,
        dependencyChanges: { additions: [], challenges: [], removals: [] },
        runId: grant.runId,
      };
      const requestDigest = await sha256Hex(JSON.stringify(payload));
      const built = wire.client.commands[APPROVAL_COMMAND_KIND](
        grant.affordance as unknown as CommandAffordance<typeof APPROVAL_COMMAND_KIND>,
        {
          correlationId: `ui-approve-${requestDigest.slice(0, 16)}`,
          payload,
          requestDigest,
          sessionCredential: wire.sessionCredential,
        },
      );
      if (!built.ok) {
        return { code: built.error.code, layer: PLAN_APPROVAL_BUILD_LAYER, ok: false };
      }
      const envelope = built.envelope as RuntimeCommandEnvelope;
      const sent = await wire.transport.sendCommand(envelope);
      if (!sent.delivered) {
        return { code: sent.code, layer: PLAN_APPROVAL_TRANSPORT_LAYER, ok: false };
      }
      return answerOf(sent.response, envelope.commandId);
    },
  });
}
