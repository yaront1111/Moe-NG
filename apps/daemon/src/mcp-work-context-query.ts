import type { NextAllowedCommand } from "@moe/contracts";

import { AFFORDANCE_SURFACE_LAYER } from "./http/affordance-contract.js";
import type {
  AffordanceRefused, AffordanceSurface, AffordanceSurfaceResult, ChainStep,
} from "./http/affordance-contract.js";
import type { PlanningAuthorityEntry } from "./http/affordance-planning-authorities.js";
import { workItemIdFor } from "./http/affordance-read.js";
import {
  PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION,
} from "./product-contract/product-contract-command-contracts.js";

/**
 * `work.get_context`, answered for ONE work item.
 *
 * WHY IT EXISTS. The whole affordance surface is tens of kilobytes on a live board, and an MCP
 * harness truncates a result that large — measured 2026-09-04, when a real seat could not release
 * its own claim because `claimAggregateVersion` sat past the truncation point of a 60 KB dump. A
 * seat holds exactly one item, so it can name it, and the answer for one item is small enough that
 * no harness can cut the version out of it.
 *
 * WHAT IT IS NOT. It is not a second surface builder. Every fact it hands back is carried verbatim
 * from the surface the affordance port already read: the SAME `ChainStep` object, the SAME offer
 * objects, the SAME planning entry. Nothing is recomputed here, so the per-item answer and the
 * whole-surface answer can never disagree.
 */

export const SURFACE_ITEM = "SURFACE_ITEM" as const;

/**
 * The named item is not on the surface. A PRODUCT refusal in the affordance shape under the
 * EXISTING `AFFORDANCE_SURFACE_LAYER`, not a runtime-error-registry code: the registry is a closed
 * roster with five pinned consumers (two of them generated digest mirrors), and this refusal is
 * decided entirely inside the surface the affordance layer just read.
 */
export const WORK_ITEM_UNKNOWN = "WORK_ITEM_UNKNOWN" as const;

/** The port maps this to its generic `queryRefusal()`; it carries no `outcome`, so a caller can
 *  tell it apart from a product refusal by the absence of that key alone. */
export interface InputInvalid {
  readonly code: "INPUT_INVALID";
}

/** One work item's whole answer: the step, plus only what the daemon offers on ITS aggregate. */
export interface SurfaceItem {
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly outcome: typeof SURFACE_ITEM;
  readonly planningAuthority: PlanningAuthorityEntry | null;
  readonly planningGoalRef: string | null;
  /** When the surface this answer was cut from was read. */
  readonly readAt: string;
  readonly step: ChainStep;
}

export type WorkContextAnswer =
  | AffordanceSurfaceResult
  | InputInvalid
  | SurfaceItem;

const INPUT_INVALID: InputInvalid = Object.freeze({ code: "INPUT_INVALID" as const });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How much of the caller's id the refusal echoes back. A real work-item id is
 * `${kind}@${aggregateId}` and fits easily; the cap exists because the id is UNBOUNDED wire
 * input on a query path that does no bounded decode, so echoing it whole would let a caller
 * choose the size of the daemon's own answer.
 */
const ECHOED_ID_MAX = 200;

function workItemUnknown(workItemId: string): AffordanceRefused {
  const echoed = workItemId.length <= ECHOED_ID_MAX
    ? workItemId
    : `${workItemId.slice(0, ECHOED_ID_MAX)}...`;
  return Object.freeze({
    code: WORK_ITEM_UNKNOWN,
    detail: `no step on the surface has workItemId ${echoed}`,
    layer: AFFORDANCE_SURFACE_LAYER,
    outcome: "REFUSED" as const,
  });
}

/**
 * `Object.hasOwn`, never `in` or a bare index: both maps are WIRE-SHAPED records keyed by durable
 * aggregate ids, so an attacker-supplied id of `constructor` or `__proto__` would otherwise resolve
 * an inherited member and hand back a function — the same hazard `dispatchQueryBytes` guards its
 * handler table against.
 */
function ownEntry<T>(map: Readonly<Record<string, T>>, key: string | null): T | null {
  if (key === null || !Object.hasOwn(map, key)) return null;
  return map[key] ?? null;
}

/**
 * The goal a step plans. A run-keyed step (`plan.propose@run-…`) reads it from the run→goal
 * map. A COMPILER step is keyed on the goal ITSELF (`planning.submit_decomposition@goal-…`),
 * so that map can never answer it and the aggregate is the goal — a real seat read
 * `planningGoalRef: null` beside its READY compiler offer and suspected a missing planning
 * authority (2026-09-05). The offer's schema is the marker: only compiler kinds carry it.
 */
function plannedGoalOf(
  surface: AffordanceSurface, step: ChainStep, offers: readonly NextAllowedCommand[],
): string | null {
  const keyed = ownEntry(surface.planningGoalRefs, step.aggregateId);
  if (keyed !== null) return keyed;
  const compiler = offers.some(
    (offer) => offer.inputSchemaVersion === PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION,
  );
  return compiler ? step.aggregateId : null;
}

/**
 * `targetAggregateId` is `NextAllowedCommand`'s subject field (packages/contracts/src/runtime/
 * runtime-affordance.ts:27). Filtering here is what keeps the answer small: an offer for another
 * aggregate is not an offer this seat can act on.
 */
function offersFor(
  offers: readonly NextAllowedCommand[], aggregateId: string | null,
): readonly NextAllowedCommand[] {
  if (aggregateId === null) return Object.freeze([]);
  return Object.freeze(offers.filter((offer) => offer.targetAggregateId === aggregateId));
}

/**
 * The FIRST match wins. A surface cannot legitimately carry two steps with the same kind and
 * aggregate — `workItemIdFor` is the claim ledger's own key, so a duplicate would be two rows
 * fencing one register — and picking the first is the only choice that stays deterministic if one
 * ever appears. It is never an error the caller can act on, so it is not reported as one.
 */
function stepFor(surface: AffordanceSurface, workItemId: string): ChainStep | undefined {
  return surface.steps.find(
    (step) => workItemIdFor(step.kind, step.aggregateId) === workItemId,
  );
}

/**
 * Pure: the caller owns the clock and the bytes.
 *
 * The payload-less form returns the surface OBJECT IT WAS GIVEN, by reference. That is load-bearing
 * rather than an optimisation — every existing caller's response bytes are pinned to that exact
 * object, and rebuilding it (even a spread that changed nothing but key order) would move them.
 */
export function answerWorkContextQuery(
  payload: unknown, surface: AffordanceSurfaceResult, readAt: string,
): WorkContextAnswer {
  if (surface.outcome !== "SURFACE") return surface;
  if (payload === undefined) return surface;
  if (!isPlainRecord(payload)) return INPUT_INVALID;
  if (!Object.hasOwn(payload, "workItemId")) return surface;

  const workItemId = payload["workItemId"];
  if (typeof workItemId !== "string" || workItemId.length === 0) return INPUT_INVALID;

  const step = stepFor(surface, workItemId);
  if (step === undefined) return workItemUnknown(workItemId);

  // KEY ORDER IS LOAD-BEARING, not style. `step` — and with it `claim` and
  // `claimAggregateVersion` — is serialised FIRST because a harness that truncates a large
  // result cuts from the END. `planningAuthority` carries `graphContentBytesBase64`, which is
  // as big as the graph, so any other order would put the version this row exists to expose
  // behind the one member that can grow without bound.
  const offers = offersFor(surface.nextAllowedCommands, step.aggregateId);
  return Object.freeze({
    step,
    outcome: SURFACE_ITEM,
    readAt,
    nextAllowedCommands: offers,
    planningGoalRef: plannedGoalOf(surface, step, offers),
    planningAuthority: ownEntry(surface.planningAuthorityByRun, step.aggregateId),
  });
}
