import type { RepositoryExecutionCode, RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionPhase, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import type { RepositoryContainmentLedger } from "./repository-containment-witness.js";

export const REPOSITORY_DELIVERY_LAYER = "REPOSITORY_DELIVERY" as const;
export const REPOSITORY_DELIVERY_REFUSAL_CODES = Object.freeze([
  "REPOSITORY_IDENTITY_UNKNOWN", "REPOSITORY_EXECUTION_BUSY", "REPOSITORY_EXECUTION_UNKNOWN",
  "REPOSITORY_EXECUTION_OWNER_MISMATCH", "REPOSITORY_EXECUTION_REVISION_CONFLICT",
  "REPOSITORY_EXECUTION_TRANSITION_INVALID", "REPOSITORY_EXECUTION_BASELINE_MISMATCH",
  "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH", "REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE",
  "REPOSITORY_DELIVERY_LANDING_REQUIRED", "REPOSITORY_DELIVERY_WORKSPACE_REQUIRED",
  "REPOSITORY_DELIVERY_CLOSED",
] as const);
export type RepositoryDeliveryRefusal = Readonly<{ ok: false; layer: typeof REPOSITORY_DELIVERY_LAYER;
  code: RepositoryExecutionCode | typeof REPOSITORY_DELIVERY_REFUSAL_CODES[number];
  /** Who holds the repository and why, for the operator; never authority. */
  detail?: string }>;
/**
 * REFUSED_NO_EFFECT is a refusal decided BEFORE any landing intent was journaled: HEAD was never
 * touched and nothing is owed on the checkout, so ownership can be given back. REFUSED keeps its
 * meaning — a refusal that may have left a partial effect behind — and still contains the root.
 * REPLANNED is a human REPLAN: the node's review never resumes, so once its seat is contained it
 * holds the checkout for nothing and gives it back on the same proof as a holder between attempts.
 */
export type RepositoryDeliveryFacts = "READY" | "SUBMITTED" | "ACCEPTED" | "LANDED" | "REFUSED" | "REFUSED_NO_EFFECT" | "REPLANNED" | "UNKNOWN";
export interface RepositoryDeliveryConfig {
  readonly baseline: (nodeRef: string, reservedRoot: string) => Promise<string | null>;
  /** Whether the checkout holds nothing uncommitted. Absent = an idle holder never yields. */
  readonly clean?: ((reservedRoot: string) => Promise<boolean>) | undefined;
  /** The controller's own proofs that a seat or a verifier closed, kept durably; absent = memory only. */
  readonly containment?: RepositoryContainmentLedger | undefined;
  /** The operator's words for who holds the repository; absent = the bare code. */
  readonly describeHolder?: ((nodeRef: string, phase: RepositoryExecutionPhase) => string) | undefined;
  /** Whether the owning runtime has begun closing; re-read after the awaited baseline. */
  readonly closed?: (() => boolean) | undefined;
  /**
   * The goal whose approved publish has not yet held the repository, or null. A FREE
   * repository is not acquired for a delivery while one is named: deliveries and the
   * publisher share one reservation, the delivery pass runs first, and without this a
   * publish starved behind the node queue for as long as nodes kept arriving (UnAI
   * 2026-09-18: node 4 took the repository the pass node 3 released it, the operator's
   * publish still waiting). Only a publish that has journaled NO intent counts — once the
   * publisher holds the reservation the ordinary BUSY path already applies, and a wedged
   * effect must never stall every delivery. Absent = deliveries never yield.
   */
  readonly publishWaiting?: (() => string | null) | undefined;
  readonly controller: RepositoryExecutionController;
  /** The handle is what lets a refusal be told apart from a refusal that journaled nothing. */
  readonly facts: (nodeRef: string, handle?: RepositoryExecutionHandle) => RepositoryDeliveryFacts;
  readonly isProcessAlive: (pid: number) => boolean;
  /** RETRY is permitted only for a known refusal before any commit/ref effect. */
  readonly land: (nodeRef: string, baselineId: string, reservedRoot: string, handle: RepositoryExecutionHandle) => Promise<"RETRY" | void>;
  readonly port: RepositoryExecutionPort;
  readonly projectId: string;
  /** Both durable claim and staffing evidence must permit retirement. */
  readonly retired: (nodeRef: string) => boolean;
  readonly storeId: string;
  /**
   * Brings the project's branch into the node's own tree, on EVERY staffing, once the root is
   * proved this node's and before the baseline and the seat (node-tree-sync.ts). Answers the text
   * the seat must read when the merge conflicts, else null. Absent = trees are never synced.
   */
  readonly sync?: ((nodeRef: string, reservedRoot: string) => Promise<string | null>) | undefined;
  readonly verify: (nodeRef: string, reservedRoot: string) => Promise<void>;
  readonly workspaces: () => readonly string[];
}
export function deliveryRefusal(code: RepositoryDeliveryRefusal["code"], detail?: string): RepositoryDeliveryRefusal {
  return detail === undefined ? { ok: false, code, layer: REPOSITORY_DELIVERY_LAYER }
    : { ok: false, code, layer: REPOSITORY_DELIVERY_LAYER, detail };
}
