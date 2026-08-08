import type { ControlRoomClientSurface } from "@moe/control-room-client";

/**
 * Vocabulary for the control-room data adapters.
 *
 * The adapters FETCH AND SHAPE. They never compute a transition, never derive truth
 * strength, and never infer a status the daemon did not state. Everything the UI shows
 * about state or confidence arrives already computed, and the only thing this layer adds
 * is the distinction between "the daemon said X" and "the daemon said nothing".
 *
 * That ban is enforced structurally rather than by convention: `data-ban.test.ts` asserts
 * the exact file list under this directory, the exact import specifier list of every
 * production file here, and the absence of every named computation identifier.
 */

/** Query and command kinds, taken from the gated client so no second list exists. */
export type QueryKind = keyof ControlRoomClientSurface["queries"];
export type CommandKind = keyof ControlRoomClientSurface["commands"];

export interface WireRequest {
  readonly body: string;
  readonly protocolVersion: string;
}

export type DaemonResponse =
  | { readonly code: string; readonly ok: false }
  | { readonly ok: true; readonly payload: unknown };

/** The transport is injected: this layer opens no socket and holds no endpoint. */
export interface DaemonTransport {
  sendCommand(request: WireRequest): DaemonResponse;
  sendQuery(request: WireRequest): DaemonResponse;
}

/**
 * How a displayed field was sourced. `DAEMON_STATED` means the payload carried it;
 * `ABSENT` means it did not, which stays UNKNOWN and gains no authority. There is no
 * third arm, because a third arm would be an inference.
 */
export type FieldProvenance = "ABSENT" | "DAEMON_STATED";

export const UNSTATED = "UNKNOWN" as const;

/**
 * How many records one read may shape. The daemon is the trust anchor for truth, but an
 * unbounded map over a network payload still lets a single oversized response allocate
 * without limit, so the bound lives on the receiving side too.
 */
export const MAX_VIEW_RECORDS = 1_000;

export interface ViewRecord {
  readonly id: string;
  readonly lifecycleProvenance: FieldProvenance;
  readonly lifecycleState: string;
  readonly truthClass: string;
  readonly truthProvenance: FieldProvenance;
}

export interface ReadRefused {
  readonly code: string;
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export interface ReadDelivered {
  readonly ok: true;
  readonly outcome: "DELIVERED";
  readonly records: readonly ViewRecord[];
}

export type ReadResult = ReadDelivered | ReadRefused;

export interface CommandAccepted {
  readonly ok: true;
  readonly outcome: "DISPATCHED";
  readonly payload: unknown;
}

export interface CommandRefused {
  readonly code: string;
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export type CommandDispatchResult = CommandAccepted | CommandRefused;

export const ADVISORY_MESSAGE_KINDS = Object.freeze(["SESSION", "TERMINAL"] as const);

export type AdvisoryMessageKind = (typeof ADVISORY_MESSAGE_KINDS)[number];

export interface AdvisoryMessage {
  readonly kind: AdvisoryMessageKind;
  readonly text: string;
}

/**
 * What a session or terminal message can ever produce. It carries no command affordance
 * and no state, so free-form text has no path to a state change except by a caller
 * separately choosing a daemon-issued affordance and dispatching it.
 */
export interface AdvisoryReceipt {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly kind: AdvisoryMessageKind;
  readonly outcome: "RECORDED";
}

export interface ControlRoomDataAdapter {
  dispatchCommand(
    kind: CommandKind,
    affordance: unknown,
    caller: unknown,
  ): CommandDispatchResult;
  read(kind: QueryKind, caller: unknown): ReadResult;
  receiveAdvisoryMessage(message: AdvisoryMessage): AdvisoryReceipt;
}
