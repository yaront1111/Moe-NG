import type { NextAllowedCommand } from "@moe/contracts";

import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";

/**
 * Presentation contracts for the canonical board. These are NOT wire DTOs: no daemon
 * response is shaped like this and nothing here parses one. They describe what a caller
 * must already have projected and already have truth-classified before this surface can
 * draw it.
 *
 * The board deliberately carries three separate things per card: the opaque aggregate
 * the record came from, its exact phase, and the daemon's display placement. Folding
 * phase into a column in the client is the bug this shape exists to prevent — a
 * placement may contradict a phase, and the contradiction must remain visible.
 */
export const BOARD_COLUMNS = ["plan", "ready", "executing", "review", "accepted"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * `terminated` is a region, not a sixth phase, and `null` means the daemon did not place
 * this record. An unplaced record is shown in an explicit unmapped region rather than
 * guessed into a lane or dropped.
 */
export type BoardPlacement = BoardColumn | "terminated" | null;

export const BOARD_FRONTIER_LANES = [
  "READY_NOW", "UNBLOCK_NEXT", "INTENTIONAL_WAIT", "UNSAFE_OR_UNKNOWN",
] as const;
export type BoardFrontierLaneId = (typeof BOARD_FRONTIER_LANES)[number];

export interface BoardCardProjection {
  /** Aggregate id the daemon's own commands target; never derived from `nodeId`. */
  readonly actionTargetId: string;
  readonly activitySilence: SuppliedFact;
  readonly blockerOwner: SuppliedFact;
  readonly blockerReason: SuppliedFact;
  readonly blockerType: SuppliedFact;
  readonly budgetBasis: SuppliedFact;
  readonly budgetSpent: SuppliedFact;
  readonly criticalPath: SuppliedFact;
  readonly disposition: SuppliedFact;
  readonly held: SuppliedFact;
  readonly latestClaim: SuppliedFact;
  readonly leaseEpoch: SuppliedFact;
  readonly leaseExpiry: SuppliedFact;
  readonly leaseState: SuppliedFact;
  readonly nodeId: string;
  readonly owner: SuppliedFact;
  /** The exact phase the daemon assigned. Never folded, never inferred from placement. */
  readonly phase: SuppliedFact;
  readonly placement: BoardPlacement;
  readonly progress: SuppliedFact;
  readonly qualification: SuppliedFact;
  readonly renewalSilence: SuppliedFact;
  readonly slack: SuppliedFact;
  /** Opaque to this layer: it is displayed and compared, never interpreted. */
  readonly sourceAggregate: string;
  readonly suspect: SuppliedFact;
  readonly title: string;
  readonly waitOwner: SuppliedFact;
  readonly waitReason: SuppliedFact;
  readonly waitRecheck: SuppliedFact;
}

export interface BoardFrontierLane {
  readonly cursor: SuppliedFact;
  readonly graphEpoch: SuppliedFact;
  readonly idleCapacity: SuppliedFact;
  readonly lane: BoardFrontierLaneId;
  readonly readinessExplanation: SuppliedFact;
  readonly summary: SuppliedFact;
}

export interface BoardJoinSummary {
  readonly inputs: SuppliedFact;
  readonly joinId: string;
  readonly summary: SuppliedFact;
}

export type BoardCommandHandler = (command: NextAllowedCommand) => void;

export interface BoardSurfaceProps {
  readonly appliedCursorLabel?: string | undefined;
  readonly cards: readonly BoardCardProjection[];
  readonly degraded?: boolean | undefined;
  readonly frontier: readonly BoardFrontierLane[];
  readonly joins: readonly BoardJoinSummary[];
  /**
   * Lanes the daemon authoritatively reported empty at a loaded cursor. Absence of cards
   * is not this: a lane with no data is unknown, and unknown never collapses.
   */
  readonly loadedEmptyColumns: readonly BoardColumn[];
  readonly loading?: boolean | undefined;
  readonly onActivateCommand?: BoardCommandHandler | undefined;
  readonly onOpenCard?: ((nodeId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly onShowTerminatedChange?: ((value: boolean) => void) | undefined;
  readonly showTerminated: boolean;
}

export interface BoardCardProps {
  readonly card: BoardCardProjection;
  readonly onActivateCommand?: BoardCommandHandler | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
}
