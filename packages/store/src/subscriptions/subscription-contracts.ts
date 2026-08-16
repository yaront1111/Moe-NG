import type { CursorPage, StoredEvent } from "../store-contracts.js";
import type { DataRecord } from "../store-internals.js";
import type {
  SNAPSHOT_DOC_VERSION, SUBSCRIBER_DOC_VERSION,
} from "./subscription-doc-codec.js";

export {
  MAX_SUBSCRIPTION_DOC_BYTES, MAX_SUBSCRIPTION_FILTER_ENTRIES, SNAPSHOT_DOC_VERSION,
  SUBSCRIBER_DOC_VERSION, decodeSnapshotDoc, decodeSubscriberDoc, encodeSnapshotDoc,
  encodeSubscriberDoc, formatPosition, parsePosition, plainRecord,
} from "./subscription-doc-codec.js";

/** The two durable doc shapes. A cursor is stored under the consumer's own subscriber id;
 *  the baseline a consumer rebuilds from is stored under the reserved snapshot sentinel. */
export interface SubscriptionCursor {
  readonly generation: number; readonly position: string;
}
export interface SubscriberDocFields {
  /** Event types the consumer registered an interest in. Recorded durably and returned to the
   *  consumer; readSubscriptionPage deliberately does NOT apply it, so cursor positions stay
   *  total over the projection's output and page boundaries stay comparable between readers. */
  readonly filter: readonly string[];
  readonly generation: number; readonly position: string; readonly projection: string;
}
export interface SnapshotDocFields {
  readonly checkpoint: string; readonly generation: number; readonly projection: string;
  readonly state: DataRecord; readonly stateDigest: string;
}
export interface SubscriberDoc {
  readonly cursor: SubscriptionCursor; readonly filter: readonly string[];
  readonly projection: string; readonly receiptDigest: string;
  readonly version: typeof SUBSCRIBER_DOC_VERSION;
}
export interface SnapshotDoc {
  readonly checkpoint: string; readonly generation: number; readonly projection: string;
  readonly receiptDigest: string; readonly state: DataRecord; readonly stateDigest: string;
  readonly version: typeof SNAPSHOT_DOC_VERSION;
}

/**
 * The public shape of a subscription: what a consumer hands in, and the frozen discriminated
 * outcome it gets back. Payload fields live only on the arm that owns them — `events` and
 * `nextCursor` exist solely on PAGE, `snapshot` solely on CURSOR_GAP — so a consumer cannot
 * read a page value off an unnarrowed result. Every gap arm carries the baseline snapshot,
 * because a gap a consumer cannot rebuild from is a dead end, not an answer.
 */

/** Sentinel subscriber id prefix reserved for baseline snapshot rows. `requireIdentifier`
 *  has no charset whitelist, so a slash is a legal identifier character and every entry
 *  point must refuse this prefix itself. */
export const SNAPSHOT_SUBSCRIBER_PREFIX = "moe-snapshot/" as const;

export type SubscriptionLayer = "INPUT" | "SOURCE" | "STATE";
export type SubscriptionCode =
  | "SUBSCRIPTION_CURSOR_NOT_ISSUED" | "SUBSCRIPTION_CURSOR_REGRESSION"
  | "SUBSCRIPTION_GENERATION_BASELINE_MISSING"
  | "SUBSCRIPTION_GENERATION_MISSING" | "SUBSCRIPTION_INPUT_INVALID"
  | "SUBSCRIPTION_NOT_REGISTERED" | "SUBSCRIPTION_SNAPSHOT_REGRESSION"
  | "SUBSCRIPTION_SNAPSHOT_STALE" | "SUBSCRIPTION_STATE_CORRUPT" | "SUBSCRIPTION_STORE_BUSY";
export type SubscriptionGapCause =
  | "CURSOR_AHEAD" | "CURSOR_CORRUPT" | "GENERATION_CHANGED" | "HISTORY_PRUNED";

/** The rebuild point for one projection: `checkpoint` is the exact projection position that
 *  `state` describes. Advancing a generation carries one of these per covered projection. */
export interface GenerationBaseline {
  readonly checkpoint: bigint; readonly projection: string;
  readonly state: DataRecord; readonly stateDigest: string;
}
/** What a caller publishes once a projection applied a batch. `generation` is the generation
 *  the caller believes is current, and is compared-and-set against the durable one. */
export interface SnapshotPublishInput extends GenerationBaseline {
  readonly generation: number;
}
/** Structural view of the ledger read seam, so this module depends on the page shape rather
 *  than on the store class or on any projection module. */
export interface SubscriptionEventSource {
  readEventsAfter(
    afterGlobalPosition: bigint, limit?: number, maxDecodedBytes?: number,
  ): CursorPage<StoredEvent, bigint>;
}

export interface RegisterSubscriptionInput {
  readonly at: string; readonly filter?: readonly string[]; readonly projection: string;
  /** SNAPSHOT (default) seats at the baseline checkpoint; ORIGIN seats at 0 and is available
   *  only while the whole ledger is still retained. */
  readonly startMode?: "ORIGIN" | "SNAPSHOT";
  readonly subscriberId: string;
}
export interface AcknowledgeInput {
  readonly cursor: SubscriptionCursor; readonly subscriberId: string;
}
export interface AdvanceGenerationInput {
  readonly at: string; readonly baselines: readonly GenerationBaseline[];
  readonly reason: string;
}
export interface ReseatInput {
  readonly projection: string; readonly subscriberId: string;
}
/** `projection` is required rather than read from the cursor doc: a corrupt cursor is exactly
 *  the case where the stored projection cannot be read, and the gap it produces must still
 *  carry that projection's baseline snapshot. */
export interface SubscriptionPageRequest extends ReseatInput {
  readonly limit?: number; readonly maxDecodedBytes?: number;
}

export interface SubscriptionPage {
  readonly checkpoint: bigint; readonly events: readonly StoredEvent[];
  readonly hasMore: boolean; readonly nextCursor: SubscriptionCursor | null;
  readonly outcome: "PAGE";
}
export interface SubscriptionGap {
  readonly cause: SubscriptionGapCause; readonly lastGoodCursor: SubscriptionCursor | null;
  readonly outcome: "CURSOR_GAP"; readonly snapshot: SnapshotDoc;
}
export interface SubscriptionRefused {
  readonly code: SubscriptionCode; readonly detail: string;
  readonly layer: SubscriptionLayer; readonly outcome: "REFUSED";
}
export interface SubscriptionSeated {
  readonly cursor: SubscriptionCursor; readonly outcome: "REGISTERED" | "RESEATED";
  readonly snapshot: SnapshotDoc;
}
export interface SubscriptionAcknowledged {
  readonly cursor: SubscriptionCursor; readonly outcome: "ACKNOWLEDGED";
}
export interface SubscriptionPublished {
  readonly outcome: "PUBLISHED"; readonly snapshot: SnapshotDoc;
}
export interface SubscriptionAdvanced {
  readonly generation: number; readonly outcome: "ADVANCED";
}

export type SubscriptionPageResult = SubscriptionGap | SubscriptionPage | SubscriptionRefused;
export type SubscriptionSeatResult = SubscriptionRefused | SubscriptionSeated;
export type SubscriptionAckResult = SubscriptionAcknowledged | SubscriptionRefused;
export type SubscriptionPublishResult = SubscriptionPublished | SubscriptionRefused;
export type SubscriptionAdvanceResult = SubscriptionAdvanced | SubscriptionRefused;

export function refuse(
  code: SubscriptionCode, layer: SubscriptionLayer, detail: string,
): SubscriptionRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

export function snapshotSubscriberId(projection: string): string {
  return `${SNAPSHOT_SUBSCRIBER_PREFIX}${projection}`;
}

export function isReservedSubscriberId(subscriberId: string): boolean {
  return subscriberId.startsWith(SNAPSHOT_SUBSCRIBER_PREFIX);
}
