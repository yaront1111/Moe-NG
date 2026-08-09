import type { ProjectionState } from "@moe/store/projections/projection-fold.js";
import type {
  ProjectionRebuildRefused,
} from "@moe/store/projections/projection-rebuild-contracts.js";
import type {
  SubscriptionRefused, SubscriptionSeatResult,
} from "@moe/store/subscriptions/subscription-contracts.js";

/**
 * Public shape of the daemon's board projection pipeline: the projection name the
 * control room reads, the board's origin state, and the frozen discriminated results
 * the service returns. Every refusal a store layer produces travels through these
 * unions verbatim — the pipeline never reshapes, renames, or swallows one.
 */

export const BOARD_PROJECTION = "moe.board" as const;

/** Stable reason code thrown when the service is constructed with unusable wiring. */
export const BOARD_PROJECTION_CONFIG_INVALID = "BOARD_PROJECTION_CONFIG_INVALID" as const;

/**
 * The board's origin state at global position 0. Every rebuild MUST fold from this exact
 * value (see `ProjectionRebuildRequest.state`): the store persists only the state digest,
 * so a different origin would legitimately produce a different digest and lose the
 * rebuild's compare-and-set. JSON-plain on purpose — the snapshot doc codec admits no
 * bigint, so positions are decimal text and counts are safe integers.
 */
export const INITIAL_BOARD_STATE: ProjectionState = Object.freeze({
  aggregates: Object.freeze({}),
  byType: Object.freeze({}),
  eventTotal: 0,
  lastCommittedAt: null,
  lastPosition: "0",
});

export class BoardProjectionConfigError extends Error {
  public readonly code: typeof BOARD_PROJECTION_CONFIG_INVALID;

  public constructor(detail: string) {
    super(`${BOARD_PROJECTION_CONFIG_INVALID}: ${detail}`);
    this.name = "BoardProjectionConfigError";
    this.code = BOARD_PROJECTION_CONFIG_INVALID;
  }
}

/** A store refusal, surfaced unchanged from whichever committed layer produced it. */
export type BoardRefusal = ProjectionRebuildRefused | SubscriptionRefused;

export interface BoardBaselineReady {
  /** True when THIS call published generation 1; false when a generation already existed. */
  readonly created: boolean;
  readonly generation: number;
  readonly outcome: "BASELINE_READY";
}
export type BoardBaselineResult = BoardBaselineReady | BoardRefusal;

export interface BoardFolded {
  /** Committed events this fold advanced the checkpoint over — 0 when already caught up. */
  readonly appliedCount: number;
  readonly checkpoint: bigint;
  readonly outcome: "FOLDED";
  readonly stateDigest: string;
}
export type BoardFoldResult = BoardFolded | BoardRefusal;

export interface BoardProjectionService {
  close(): void;
  ensureBaseline(reason: string): BoardBaselineResult;
  foldOnce(): BoardFoldResult;
  registerReader(subscriberId: string): SubscriptionSeatResult;
}
