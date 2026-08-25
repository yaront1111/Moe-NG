/**
 * THE FIVE FENCED LEGS of one replacement supersession (task-9e52f850). Nothing here commits;
 * every function is a read or a pure fold, so a refusal at any point leaves zero durable residue.
 *
 * THREE THINGS MOVE TOGETHER OR NOTHING DOES — and the failure mode of a partial move is
 * unrecoverable rather than untidy. A predecessor marked SUPERSEDED with no ACTIVE successor leaves
 * the project with NO CURRENT GRAPH, and there is no compensating second commit that can put it
 * back, because `reduceGraphRevision` refuses every command on a SUPERSEDED aggregate
 * (`graph-revision-reducer.ts:230`). So the predecessor's supersession, the successor's activation
 * and the paired preparation's consumption are built here as legs of ONE decision and handed to the
 * store together.
 *
 * EPOCH + 1 IS RELATIVE TO THE PREDECESSOR, never a counter and never a constant. It is read off
 * the predecessor's OWN durable `graphEpoch` — the bound reference the goal issued when the
 * predecessor was activated — and the goal's `goal.advance_graph_epoch` independently requires the
 * same arithmetic against its own state, so an implementation that incremented a private counter
 * would be caught by the goal reducer rather than silently corrupting the second supersession.
 *
 * THE SUCCESSOR'S NON-GRAPH IDENTITY IS INHERITED FROM THE PREDECESSOR'S DURABLE BINDING, and this
 * is the slice's exact semantics: a CONTENT-replacement supersession. `planHash`, `submissionRef`,
 * `budgetHash`, `policyHash` and `qualityHash` come off the predecessor's committed
 * `GraphRevisionApproved` binding and its replayed state — durable facts, never request fields —
 * because this move replaces the GRAPH under an unchanged approved-plan authority, and the
 * preparation generation is the token certifying those facts have not moved. A successor sourced
 * from a NEW planning run must bind THAT run's own sealed hashes; no second approved run is
 * reachable in this tree (`readApprovedRunWitness` resolves exactly one run per goal), so composing
 * one belongs to the transport row (task-efc2ef63) the day a second run exists. Disclosed, not
 * papered over.
 */
import type { JsonValue } from "@moe/contracts";
import { reduceGraphRevision, replayGraphRevisionEvents } from "@moe/core";
import type {
  GraphActivationBinding, GraphRevisionCommand, GraphRevisionEvent, GraphRevisionState,
  SupersessionDisposition,
} from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { graphRevisionAggregateId } from "./active-graph-projection.js";
import {
  GRAPH_SUPERSEDE_CANONICALIZER_VERSIONS, refuseFromAggregate, refuseSupersede,
} from "./graph-supersede-contracts.js";
import type { GraphSupersedeRefusal } from "./graph-supersede-contracts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface SupersessionParties {
  readonly approvalRef: string;
  /** `HUMAN` when a human decided the approval; anything else is the daemon's own verification. */
  readonly actorKind: unknown;
  readonly commandId: string;
  readonly dispositions: readonly SupersessionDisposition[];
  readonly goalRef: string;
  readonly expectedGoalVersion: number;
  readonly predecessorRevisionId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly successorGraphContentHash: string;
  readonly successorRevisionId: string;
}

export interface SupersessionRevisionLegs {
  readonly ok: true;
  readonly predecessor: ExpectedVersionDecisionLeg;
  readonly successor: ExpectedVersionDecisionLeg;
  /** The successor's post-fold state, for the decision's committed result. */
  readonly successorState: GraphRevisionState;
  readonly successorGraphEpoch: number;
}

export type SupersessionRevisionLegsResult = SupersessionRevisionLegs | GraphSupersedeRefusal;

function truthClassFor(actorKind: unknown): "DAEMON_VERIFIED" | "HUMAN_APPROVED" {
  return actorKind === "HUMAN" ? "HUMAN_APPROVED" : "DAEMON_VERIFIED";
}

function historyOf(store: SqliteEventStore, aggregateId: string): readonly unknown[] {
  return store.readEvents(aggregateId).map((event) => {
    try {
      return JSON.parse(decoder.decode(event.payload)) as unknown;
    } catch {
      return null;
    }
  });
}

function legOf(
  aggregateId: string, commandId: string, events: readonly GraphRevisionEvent[],
  expectedVersion: number,
): ExpectedVersionDecisionLeg {
  return Object.freeze({
    aggregateId,
    events: events.map((event) => ({
      eventId: `${commandId}-${event.kind}`,
      eventType: event.kind,
      payload: encoder.encode(JSON.stringify(event as unknown as JsonValue)),
    })),
    expectedVersion,
  });
}

interface Folded {
  readonly events: readonly GraphRevisionEvent[];
  readonly state: GraphRevisionState;
}

function fold(
  initial: GraphRevisionState | undefined, chain: readonly GraphRevisionCommand[],
): Folded | GraphSupersedeRefusal {
  let state = initial;
  const events: GraphRevisionEvent[] = [];
  for (const command of chain) {
    const verdict = reduceGraphRevision(state, command);
    if (!verdict.ok) return refuseFromAggregate(verdict.error, verdict.layer, "GRAPH_REVISION");
    state = verdict.state;
    events.push(...verdict.events);
  }
  if (state === undefined) throw new Error("graph supersede fold produced no state");
  return { events, state };
}

/**
 * The successor's WHOLE history, folded against `undefined` at expected version 0. A successor that
 * already has events is not being activated for the first time, and the caller refuses that before
 * reaching here; the store's own fence at 0 is the same claim stated to the authority that wins a
 * race.
 */
function successorChain(
  parties: SupersessionParties, predecessor: GraphRevisionState,
  binding: GraphActivationBinding,
): readonly GraphRevisionCommand[] {
  const truthClass = truthClassFor(parties.actorKind);
  return [
    {
      commandId: `${parties.commandId}-successor-create`, expectedVersion: 0,
      goalRef: parties.goalRef, graphContentHash: parties.successorGraphContentHash,
      kind: "graph_revision.create", planHash: predecessor.planHash,
      revisionId: parties.successorRevisionId,
    },
    {
      commandId: `${parties.commandId}-successor-submit`, expectedVersion: 1,
      kind: "graph_revision.submit",
      witness: { submissionRef: predecessor.submissionRef, truthClass },
    },
    {
      activation: {
        ...binding, activationRef: `graph-supersession:${parties.successorRevisionId}`,
        graphEpoch: predecessor.graphEpoch + 1,
        succession: {
          predecessorGraphContentHash: predecessor.graphContentHash,
          predecessorGraphEpoch: predecessor.graphEpoch,
          predecessorRevisionId: predecessor.revisionId,
        },
        truthClass,
      },
      approval: { ...binding, approvalRef: parties.approvalRef, truthClass },
      commandId: `${parties.commandId}-successor-approve`, expectedVersion: 2,
      kind: "graph.approve",
    },
  ] as unknown as readonly GraphRevisionCommand[];
}

/** The predecessor's single `graph.supersede`, decided entirely by `decideSupersession`. */
function predecessorChain(
  parties: SupersessionParties, predecessor: GraphRevisionState,
): readonly GraphRevisionCommand[] {
  return [{
    commandId: `${parties.commandId}-predecessor-supersede`,
    expectedVersion: predecessor.version,
    kind: "graph.supersede",
    supersession: {
      dispositions: parties.dispositions,
      expectedPredecessor: {
        graphContentHash: predecessor.graphContentHash, graphEpoch: predecessor.graphEpoch,
        revisionId: predecessor.revisionId,
      },
      successor: {
        graphContentHash: parties.successorGraphContentHash,
        graphEpoch: predecessor.graphEpoch + 1,
        predecessorGraphContentHash: predecessor.graphContentHash,
        predecessorRevisionId: predecessor.revisionId,
        revisionId: parties.successorRevisionId,
      },
      supportedCanonicalizerVersions: [...GRAPH_SUPERSEDE_CANONICALIZER_VERSIONS],
    },
  }] as unknown as readonly GraphRevisionCommand[];
}

/**
 * Build both revision legs, or say which authority refused. The predecessor's replayed state is the
 * ONLY source of its epoch, content hash and binding — nothing is taken from the request — and a
 * history that will not replay refuses rather than being treated as an empty one.
 */
export function buildSupersessionRevisionLegs(
  parties: SupersessionParties,
): SupersessionRevisionLegsResult {
  const predecessorAggregateId = graphRevisionAggregateId(
    parties.projectId, parties.predecessorRevisionId,
  );
  const replayed = replayGraphRevisionEvents(historyOf(parties.store, predecessorAggregateId));
  if (!replayed.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_CURRENT_GRAPH_UNAVAILABLE",
      { code: replayed.code, layer: replayed.layer });
  }
  const predecessor = replayed.state;
  if (predecessor.boundHashes === null || predecessor.submissionRef === null) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
  }
  const binding: GraphActivationBinding = Object.freeze({
    ...predecessor.boundHashes,
    expectedGoalVersion: parties.expectedGoalVersion,
    graphHash: parties.successorGraphContentHash,
  });
  const successor = fold(undefined, successorChain(parties, predecessor, binding));
  if ("ok" in successor) return successor;
  const superseded = fold(predecessor, predecessorChain(parties, predecessor));
  if ("ok" in superseded) return superseded;
  return Object.freeze({
    ok: true as const,
    predecessor: legOf(predecessorAggregateId, `${parties.commandId}-predecessor`,
      superseded.events, parties.store.getAggregateVersion(predecessorAggregateId)),
    successor: legOf(
      graphRevisionAggregateId(parties.projectId, parties.successorRevisionId),
      `${parties.commandId}-successor`, successor.events, 0,
    ),
    successorGraphEpoch: predecessor.graphEpoch + 1,
    successorState: successor.state,
  });
}
