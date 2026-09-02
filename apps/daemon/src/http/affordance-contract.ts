import type { NextAllowedCommand } from "@moe/contracts";

import type { PlanningAuthorityByRun } from "./affordance-planning-authorities.js";

/**
 * The affordance surface: what the daemon offers next, derived from its own
 * durable ledger and from nothing else.
 *
 * A ChainStep reports one wired command kind's standing — COMMITTED with the
 * durable aggregate version, READY with a daemon-minted NextAllowedCommand, or
 * BLOCKED naming exactly the missing prerequisite kinds. The surface never
 * invents payload facts: for creation-shaped kinds whose subject the caller
 * names, the DEVELOPMENT default-subject convention (documented on
 * `DEFAULT_SUBJECTS` in affordance-read.ts) pins the aggregate the offered
 * expectedVersion was read from.
 */

export const AFFORDANCE_SURFACE_LAYER = "AFFORDANCE_SURFACE" as const;
export const AFFORDANCE_PROJECT_MISMATCH = "AFFORDANCE_PROJECT_MISMATCH" as const;

/**
 * The pseudo-kind for a deliverable code node. It is not a runtime command —
 * delivery happens through review.submit and integration.accept_output against
 * the node's subjectRef — but it IS a claimable, staffable unit of board work,
 * so it appears as a step with the shared work-item key convention.
 */
export const NODE_DELIVER_KIND = "node.deliver" as const;

/** An operator-authored code node behind an approved goal. */
export interface NodeSpec {
  readonly nodeRef: string;
  readonly title: string;
}

export const CHAIN_STEP_STATUSES = Object.freeze(["BLOCKED", "COMMITTED", "READY"] as const);
export type ChainStepStatus = (typeof CHAIN_STEP_STATUSES)[number];

/**
 * An active durable claim on a step. The work-item id convention is
 * `${kind}@${aggregateId ?? "-"}` — the same key the live board renders — so
 * agents and humans fence the same register.
 */
export interface ChainStepClaim {
  readonly claimedBy: string;
  readonly expiresAt: string;
  /** Durable work-claim aggregate version, used for exact release/renew CAS. */
  readonly version: number;
}

export interface ChainStep {
  readonly aggregateId: string | null;
  readonly claim: ChainStepClaim | null;
  /** Current durable version of `work/${kind}@${aggregateId ?? "-"}`, active or not. */
  readonly claimAggregateVersion: number;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly status: ChainStepStatus;
  readonly version: number | null;
}

export interface AffordanceSurface {
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly outcome: "SURFACE";
  /**
   * Canonical planning authority material per eligible run, derived from the SAME durable offers
   * and bindings as `planningGoalRefs` so the two can never disagree. Empty when the daemon holds
   * no configured principal or no unambiguous node roster — an omission, never a fallback.
   */
  readonly planningAuthorityByRun: PlanningAuthorityByRun;
  /** Per-run durable binding under which every planning offer is answered. */
  readonly planningGoalRefs: Readonly<Record<string, string>>;
  /** Durable goal bound to the default planning run; null when absent or ambiguous. */
  readonly planningGoalRef: string | null;
  readonly steps: readonly ChainStep[];
}

export interface AffordanceRefused {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export function affordanceProjectRefusal(): AffordanceRefused {
  return Object.freeze({
    code: AFFORDANCE_PROJECT_MISMATCH,
    detail: "the authenticated principal is bound to another project",
    layer: AFFORDANCE_SURFACE_LAYER,
    outcome: "REFUSED" as const,
  });
}

export type AffordanceSurfaceResult = AffordanceRefused | AffordanceSurface;

/** Synchronous, like SubscriptionPort: the listener stays free of await chains. */
export interface AffordancePort {
  /** The single project this port answers for. The surface names no project of
   *  its own, so a request that names a DIFFERENT one must be refused rather
   *  than silently answered for this one. */
  readonly boundProjectId: string;
  readSurface(): AffordanceSurfaceResult;
}

/**
 * A present `projectId` that is not the bound one is a request for a project
 * this daemon does not serve. Answering it with this daemon's surface would be
 * a truth defect — the answer names no project, so the caller would read it as
 * being about the project they asked for. Absent or matching is fine.
 */
export function affordanceProjectMismatch(
  request: { readonly projectId?: string },
  boundProjectId: string,
): boolean {
  return request.projectId !== undefined && request.projectId !== boundProjectId;
}

/**
 * Structural only, mirroring `readEventRequest`: an empty object is the whole
 * request today; a present `projectId` must at least be a string. Anything
 * else is malformed and refused by the listener, not here.
 */
export function readAffordanceRequest(
  body: Uint8Array,
): { readonly projectId?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const draft = parsed as Record<string, unknown>;
  const projectId = draft["projectId"];
  if (projectId !== undefined && typeof projectId !== "string") return null;
  return projectId === undefined ? {} : { projectId };
}
