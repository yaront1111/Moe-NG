import type { NextAllowedCommand } from "@moe/contracts";

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

export const CHAIN_STEP_STATUSES = Object.freeze(["BLOCKED", "COMMITTED", "READY"] as const);
export type ChainStepStatus = (typeof CHAIN_STEP_STATUSES)[number];

export interface ChainStep {
  readonly aggregateId: string | null;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly status: ChainStepStatus;
  readonly version: number | null;
}

export interface AffordanceSurface {
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly outcome: "SURFACE";
  readonly steps: readonly ChainStep[];
}

export interface AffordanceRefused {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export type AffordanceSurfaceResult = AffordanceRefused | AffordanceSurface;

/** Synchronous, like SubscriptionPort: the listener stays free of await chains. */
export interface AffordancePort {
  readSurface(): AffordanceSurfaceResult;
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
