import type { NextAllowedCommand } from "@moe/contracts";

import { journeyAuthority } from "../planning/journey-authority-bodies.js";

/**
 * The per-run planning authority material the affordance surface carries.
 *
 * WHY IT EXISTS. The browser must dispatch `plan.propose` with canonical authority bodies and the
 * graph bytes they bind to. Those are produced by Node-only codecs (`createPlanRevision`,
 * `createAcceptanceContract`, `encodeGraphContent`), so a browser-side copy would be a SECOND
 * verifier of the same facts — two spellings of one hash, drifting silently. The daemon derives
 * the material from its own durable offers and bindings and hands it over verbatim; the browser
 * validates shape and binding and uses the bytes unchanged.
 *
 * WHAT THIS MODULE IS NOT. It is not a producer of authority. `journeyAuthority` is the sole
 * canonical producer (rail 3): this module only ASSEMBLES its declared input from server facts and
 * CARRIES its returned bytes and digests through untouched. No hash is computed, recomputed,
 * rotated or re-encoded here, and none ever should be — a digest computed in this file would be
 * the very second verifier the carrier exists to prevent.
 *
 * FAIL CLOSED BY OMISSION. Every input is a server fact that may be missing or ambiguous. When one
 * is, the run simply gets NO entry. There is no DEFAULT_* subject, no project-owner author, no
 * first-node selection, no caller-supplied identity, no static digest and no operator-local
 * fallback anywhere below: an absent entry is the honest answer, and the browser refuses locally
 * on it rather than dispatching material the daemon would reject.
 */

/**
 * The exact offer kinds whose target run earns material. Both name the PLANNING RUN aggregate.
 * `goal.close` and the two compiler kinds target the GOAL aggregate and are deliberately absent —
 * keying on them would put a goal id in a map whose keys are runs. `approval.decide_intent` is
 * absent too: it is always co-offered with `approval.decide` against the same run, so admitting it
 * could not widen the key set, only blur what this roster means.
 */
export const PLANNING_AUTHORITY_ELIGIBLE_KINDS: readonly string[] = Object.freeze([
  "approval.decide", "plan.propose",
]);

/**
 * One run's material. Exactly seven members: four are `journeyAuthority`'s own return, carried
 * unchanged, and three (`goalRef`, `graphRevisionRef`, `runId`) are the BINDING this module
 * contributes, so the consumer can prove which run and goal the bodies were sealed for without
 * re-deriving anything.
 */
export interface PlanningAuthorityEntry {
  readonly authority: Record<string, unknown>;
  readonly goalRef: string;
  readonly graphContentBytesBase64: string;
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  readonly runId: string;
  readonly submissionHash: string;
}

export type PlanningAuthorityByRun = Readonly<Record<string, PlanningAuthorityEntry>>;

export interface PlanningAuthorityInput {
  /**
   * The composed merged-node roster. EXACTLY ONE node earns material: a journey graph is
   * single-node by construction, so zero leaves nothing to plan and two or more would force a
   * choice this module has no authority to make.
   *
   * Structurally typed on the one member actually read, rather than importing `NodeSpec` from
   * affordance-contract.ts — that file names this module's `PlanningAuthorityByRun`, and a
   * type-only pair of edges is still a pair a later non-type import could close into a cycle.
   */
  readonly nodes: readonly { readonly nodeRef: string }[];
  /** The surface's current planning offers, unfiltered. */
  readonly offers: readonly NextAllowedCommand[];
  /** The durable run-to-goal bindings, from the same resolution that minted `offers`. */
  readonly planningGoalRefs: Readonly<Record<string, string>>;
  /** The daemon's configured principal. Absent means no material at all. */
  readonly principalId?: string | undefined;
}

const EMPTY: PlanningAuthorityByRun = Object.freeze({});

/** Derived deterministically from the run so two builds over one world are byte-identical, and
 *  so a consumer can join the material back to its run without a second lookup. */
const graphRevisionRefFor = (runId: string): string => `${runId}-graph-revision`;

/**
 * The runs that earn material: an eligible offer AND a durable goal binding, both required.
 *
 * `Object.hasOwn` rather than `in`: `planningGoalRefs` is a plain record built from durable
 * aggregate ids, and `in` would answer true for inherited members like `constructor`, minting an
 * entry for a run no goal ever bound.
 */
function eligibleRunIds(input: PlanningAuthorityInput): readonly string[] {
  const runIds = new Set<string>();
  for (const offer of input.offers) {
    if (!PLANNING_AUTHORITY_ELIGIBLE_KINDS.includes(offer.commandKind)) continue;
    if (!Object.hasOwn(input.planningGoalRefs, offer.targetAggregateId)) continue;
    runIds.add(offer.targetAggregateId);
  }
  return [...runIds].sort();
}

/**
 * Seals one run's material through the canonical producer.
 *
 * THE CATCH IS DELIBERATE AND NARROW. `journeyAuthority` signals refusal by throwing — a malformed
 * node key, a criterion the acceptance codec will not admit, an author the plan codec refuses. A
 * throw escaping here would take down the ENTIRE affordance surface for one unusable node spec,
 * turning a per-run omission into a total outage and breaking every unrelated card on the board.
 * Omitting the one run is the fail-closed answer that rail 2 asks for; the browser then refuses
 * locally for want of material, which is exactly the state a missing binding produces.
 */
function sealFor(
  runId: string, goalRef: string, authorRef: string, nodeRef: string,
): PlanningAuthorityEntry | null {
  const graphRevisionRef = graphRevisionRefFor(runId);
  let sealed;
  try {
    sealed = journeyAuthority({
      authorRef,
      criterionIds: [`${goalRef}-criterion`],
      graphRevisionRef,
      idPrefix: runId,
      nodeIds: [nodeRef],
      stepDescription: `Plan ${goalRef} on ${runId}.`,
    });
  } catch {
    return null;
  }
  // Carried, not rebuilt: the four producer members pass through by reference/value untouched.
  return Object.freeze({
    authority: sealed.authority,
    goalRef,
    graphContentBytesBase64: sealed.graphContentBytesBase64,
    graphContentHash: sealed.graphContentHash,
    graphRevisionRef,
    runId,
    submissionHash: sealed.submissionHash,
  });
}

/**
 * The map, keyed by planning run.
 *
 * Both whole-map guards mirror `soleLegacyPlanningSubject`'s shape in affordance-read.ts: an
 * ambiguous answer returns nothing rather than picking an entry. A missing principal and an
 * ambiguous node roster are facts about the DAEMON, not about any one run, so they empty the map
 * rather than trimming it.
 */
export function resolvePlanningAuthorities(
  input: PlanningAuthorityInput,
): PlanningAuthorityByRun {
  const authorRef = input.principalId;
  if (authorRef === undefined) return EMPTY;
  const [node, ...extra] = input.nodes;
  if (node === undefined || extra.length > 0) return EMPTY;

  const byRun: Record<string, PlanningAuthorityEntry> = {};
  for (const runId of eligibleRunIds(input)) {
    const goalRef = input.planningGoalRefs[runId];
    if (goalRef === undefined) continue;
    const entry = sealFor(runId, goalRef, authorRef, node.nodeRef);
    if (entry !== null) byRun[runId] = entry;
  }
  return Object.freeze(byRun);
}
