import type { CursorPage, StoredEvent } from "../store-contracts.js";
import type {
  ProjectionCheckpoint, ProjectionFoldCode, ProjectionFoldLayer, ProjectionReducer, ProjectionState,
} from "./projection-fold.js";
import type { StoredEventUpcaster } from "./projection-upcast.js";

/**
 * Public shape of the projection rebuild driver: what a caller hands in, and the frozen
 * discriminated outcome it gets back. `checkpoint`, `pages`, `state`, and `stateDigest` live
 * only on the REBUILT arm, so a consumer cannot read a projection value off an unnarrowed
 * result and seat a live cursor on a rebuild that actually refused.
 */

/** Structural view of the ledger read seam, so the driver depends on the page contract
 *  rather than on `SqliteEventStore` — the same shape `RelayCommitSeam` takes. */
export interface ProjectionLedgerSource {
  readEventsAfter(
    afterGlobalPosition: bigint, limit: number,
  ): CursorPage<StoredEvent, bigint>;
}

export interface ProjectionRebuildRequest {
  readonly name: string;
  /** Events per ledger page; defaults to 100 and is bounded by the store's page size. */
  readonly pageLimit?: number;
  readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly source: ProjectionLedgerSource;
  /** The projection's origin state, folded from global position 0. Defaults to `{}`; a
   *  projection whose live relay started from a richer origin must pass the same value or
   *  the rebuilt digest legitimately differs. */
  readonly state?: ProjectionState;
  readonly upcaster: StoredEventUpcaster;
}

export type ProjectionRebuildLayer = "INPUT" | "PROJECTION" | "STATE";
export type ProjectionRebuildCode =
  | "PROJECTION_REBUILD_FOLD_REFUSED" | "PROJECTION_REBUILD_INPUT_INVALID"
  | "PROJECTION_REBUILD_STATE_CONFLICT" | "PROJECTION_REBUILD_WRITE_FAILED";

/** The fold's own verdict, kept verbatim so "which layer refused" survives the rebuild. */
export interface ProjectionRebuildFoldDetail {
  readonly code: ProjectionFoldCode; readonly eventId: string | null;
  readonly layer: ProjectionFoldLayer;
}
export interface ProjectionRebuilt {
  readonly checkpoint: ProjectionCheckpoint; readonly outcome: "REBUILT";
  readonly pages: number; readonly state: ProjectionState; readonly stateDigest: string;
}
export interface ProjectionRebuildRefused {
  readonly code: ProjectionRebuildCode; readonly detail: string;
  readonly fold: ProjectionRebuildFoldDetail | null;
  readonly layer: ProjectionRebuildLayer; readonly outcome: "REFUSED";
}
export type ProjectionRebuildResult = ProjectionRebuilt | ProjectionRebuildRefused;
