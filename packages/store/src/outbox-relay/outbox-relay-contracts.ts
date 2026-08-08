import type {
  ProjectionCheckpoint, ProjectionFoldCode, ProjectionFoldLayer, ProjectionReducer, ProjectionState,
} from "../projections/projection-fold.js";
import type { StoredEventUpcaster, UpcastFailure } from "../projections/projection-upcast.js";
import type { CommitApply } from "../event-ledger-transaction.js";
import type { CommitInput, CommitResult } from "../store-contracts.js";

/**
 * Public surface of the transactional outbox relay: what a caller hands in, and the frozen
 * discriminated outcome it gets back. Payload fields live only on the arm that owns them —
 * `checkpoint`/`state`/`stateDigest` exist solely on APPLIED — so a consumer cannot read a
 * projection value off an unnarrowed result and quietly rewind a live checkpoint.
 */

export interface OutboxRelayMessage {
  readonly headers?: Uint8Array; readonly messageId: string;
  readonly payload: Uint8Array; readonly topic: string;
}
export interface OutboxRelayProjection {
  readonly checkpoint: ProjectionCheckpoint; readonly name: string;
  readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly state: ProjectionState; readonly upcaster: StoredEventUpcaster;
}
export interface OutboxRelayRequest {
  readonly commit: CommitInput; readonly consumerId: string;
  readonly message: OutboxRelayMessage; readonly projection: OutboxRelayProjection;
}
/** Structural view of the commit seam, so the relay depends on the transaction, not the class. */
export interface RelayCommitSeam {
  commitWithApply(input: CommitInput, apply: CommitApply): CommitResult;
}

export type OutboxRelayLayer = "COMMIT" | "INBOX" | "INPUT" | "PROJECTION";
export type OutboxRelayCode =
  | "OUTBOX_RELAY_COMMIT_MISMATCH" | "OUTBOX_RELAY_INBOX_CONFLICT"
  | "OUTBOX_RELAY_INBOX_WRITE_FAILED" | "OUTBOX_RELAY_INPUT_INVALID"
  | "OUTBOX_RELAY_PROJECTION_CONFLICT" | "OUTBOX_RELAY_PROJECTION_REFUSED"
  | "OUTBOX_RELAY_PROJECTION_WRITE_FAILED";

/** The fold's own verdict, kept verbatim so "which layer refused" survives the relay. */
export interface OutboxRelayFoldDetail {
  readonly code: ProjectionFoldCode; readonly eventId: string | null;
  readonly layer: ProjectionFoldLayer; readonly upcast: UpcastFailure | null;
}
export interface OutboxRelayApplied {
  readonly checkpoint: ProjectionCheckpoint; readonly commit: CommitResult;
  readonly outcome: "APPLIED"; readonly state: ProjectionState; readonly stateDigest: string;
}
export interface OutboxRelayDeduplicated {
  /** The replayed receipt for COMMAND_RECEIPT; null for INBOX, whose append was rolled back. */
  readonly commit: CommitResult | null;
  readonly deduplicatedBy: "COMMAND_RECEIPT" | "INBOX"; readonly outcome: "ALREADY_APPLIED";
}
export interface OutboxRelayRefused {
  readonly code: OutboxRelayCode; readonly detail: string;
  readonly fold: OutboxRelayFoldDetail | null; readonly layer: OutboxRelayLayer;
  readonly outcome: "REFUSED";
}
export type OutboxRelayResult = OutboxRelayApplied | OutboxRelayDeduplicated | OutboxRelayRefused;
