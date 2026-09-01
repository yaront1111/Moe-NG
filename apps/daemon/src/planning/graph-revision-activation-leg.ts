import type { JsonValue, RuntimeError } from "@moe/contracts";
import { reduceGraphRevision, replayGraphRevisionEvents } from "@moe/core";
import type {
  GraphActivationBinding,
  GraphRevisionCommand,
  GraphRevisionEvent,
  GraphRevisionState,
} from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { graphRevisionAggregateId } from "./active-graph-projection.js";

/**
 * The initial active-graph transition, as ONE decision leg on the graph-revision aggregate.
 *
 * `graph-revision-reducer.ts:11-15` names the missing production piece in its own header:
 * "Initial activation is therefore THREE reducer results the daemon must commit in one atomic
 * transaction". Until this module the daemon committed only the goal's, so `reduceGraphRevision`
 * had no production caller at all and `readCurrentActiveGraph` could never answer for a real
 * project — every graph-revision history in the tree was written by a test fixture.
 *
 * NOTHING HERE DECIDES. The lifecycle, the binding equality, the `graphEpoch === 1` rule and
 * every refusal are the core reducer's; this module folds the durable facts into commands, stops
 * at the first rejection, and hands the resulting events to the store as a fenced leg. The fold
 * runs against `undefined` because an initial activation is by definition the aggregate's whole
 * history: a revision that already has events is not being activated for the first time, and
 * saying so is a refusal rather than an append.
 *
 * THE WRITE-SIDE ONE-ACTIVE GUARD lives here, ahead of the fold. `active-graph-projection.ts`
 * detects a split brain on the READ side and refuses to hand out authority during it, which is
 * the right answer once two ACTIVE revisions exist — but detection is not prevention. The
 * reducer cannot see its siblings (it is pure and touches only its own aggregate), so a
 * project-wide invariant needs a project-wide read, and this is the only place that read can
 * happen before the bytes land.
 */

/** Closed so `refuse` type-checks it against `SERVICE_REFUSED_BY` at every call site. */
const LAYER = "GRAPH_REVISION_ACTIVATION" as const;

export type GraphRevisionActivationLayer = typeof LAYER;

/**
 * Refusals this module originates. Core reducer verdicts are NOT restated here: they travel out
 * under the core's own code and the `GRAPH_REVISION` aggregate layer, so an operator can tell
 * "the daemon would not start this" from "the kernel refused the transition".
 */
export const GRAPH_REVISION_ACTIVATION_CODES = Object.freeze([
  "GRAPH_REVISION_ALREADY_RECORDED",
  "GRAPH_REVISION_PROJECT_HAS_ACTIVE",
  "GRAPH_REVISION_SIBLING_UNREADABLE",
] as const);

export type GraphRevisionActivationCode = (typeof GRAPH_REVISION_ACTIVATION_CODES)[number];

export interface GraphRevisionActivationRefusal {
  readonly code: GraphRevisionActivationCode;
  readonly layer: GraphRevisionActivationLayer;
  readonly ok: false;
}

/** A core rejection, forwarded with the aggregate that produced it rather than restamped. */
export interface GraphRevisionActivationCoreRefusal {
  readonly error: RuntimeError;
  readonly layer: "GRAPH_REVISION";
  readonly ok: false;
}

export interface GraphRevisionActivationAccepted {
  readonly leg: ExpectedVersionDecisionLeg;
  readonly ok: true;
  /** The revision state the fold arrived at, for the decision's committed result. */
  readonly state: GraphRevisionState;
}

export type GraphRevisionActivationResult =
  | GraphRevisionActivationAccepted
  | GraphRevisionActivationCoreRefusal
  | GraphRevisionActivationRefusal;

export interface GraphRevisionActivationInput {
  /** The server-composed five-member binding. Never a caller value. */
  readonly binding: GraphActivationBinding;
  /** The core's OWN decided approval identity, never a payload field. */
  readonly approvalRef: string;
  /** `HUMAN` when a human decided the approval; anything else is the daemon's own verification. */
  readonly actorKind: unknown;
  readonly commandId: string;
  readonly goalRef: string;
  readonly planHash: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly store: SqliteEventStore;
  readonly submissionRef: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Exactly 1 for an initial activation — `validActivationEpoch` accepts no other value. */
const INITIAL_GRAPH_EPOCH = 1;

const refused = (code: GraphRevisionActivationCode): GraphRevisionActivationRefusal =>
  Object.freeze({ code, layer: LAYER, ok: false as const });

/**
 * `strongTruth` admits exactly two classes. Which one this is comes from the DECIDED approval
 * record's actor kind, so a daemon-verified approval cannot present itself as a human one.
 */
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

/**
 * No sibling of this project may already be ACTIVE. An unreadable sibling refuses too: a history
 * that cannot be replayed MIGHT be the active one, and treating "cannot tell" as "not active" is
 * exactly how a second ACTIVE revision gets written.
 *
 * THIS IS A READ, NOT A FENCE, and the difference is disclosed rather than papered over. Two
 * activations for the SAME goal serialise on the goal leg's expectedVersion, so the common race
 * cannot produce two ACTIVE revisions. Two activations for DIFFERENT goals in one project share
 * no fenced aggregate, so a sufficiently narrow interleaving could pass both of these reads. The
 * outcome is fail-closed rather than fail-open: `readCurrentActiveGraph` then answers
 * ACTIVE_GRAPH_SPLIT_BRAIN and withholds authority from everyone until an operator resolves it.
 * Closing the window needs a project-scoped fenced aggregate, which this row does not own.
 */
function projectHasActive(
  store: SqliteEventStore,
  projectId: string,
): GraphRevisionActivationRefusal | null {
  const prefix = graphRevisionAggregateId(projectId, "");
  for (const aggregateId of store.enumerateAggregateIdsByPrefix(prefix)) {
    const replayed = replayGraphRevisionEvents(historyOf(store, aggregateId));
    if (!replayed.ok) return refused("GRAPH_REVISION_SIBLING_UNREADABLE");
    if (replayed.state.lifecycle === "ACTIVE") return refused("GRAPH_REVISION_PROJECT_HAS_ACTIVE");
  }
  return null;
}

/**
 * The three commands, in the order the lifecycle requires. Every field is a durable fact or a
 * server-composed one: the content identity comes off the run's seal via the binding, the
 * submission ref off the run's own record, the approval ref off the core's decided record, and
 * the activation ref is derived from the revision so an identical approval derives an identical
 * command rather than a new one.
 */
function commandChain(input: GraphRevisionActivationInput): readonly GraphRevisionCommand[] {
  const truthClass = truthClassFor(input.actorKind);
  return [
    {
      commandId: `${input.commandId}-graph-revision-create`,
      expectedVersion: 0,
      goalRef: input.goalRef,
      graphContentHash: input.binding.graphHash,
      kind: "graph_revision.create",
      planHash: input.planHash,
      revisionId: input.revisionId,
    },
    {
      commandId: `${input.commandId}-graph-revision-submit`,
      expectedVersion: 1,
      kind: "graph_revision.submit",
      witness: { submissionRef: input.submissionRef, truthClass },
    },
    {
      activation: {
        ...input.binding,
        activationRef: `graph-activation:${input.revisionId}`,
        graphEpoch: INITIAL_GRAPH_EPOCH,
        truthClass,
      },
      approval: { ...input.binding, approvalRef: input.approvalRef, truthClass },
      commandId: `${input.commandId}-graph-approve`,
      expectedVersion: 2,
      kind: "graph.approve",
    },
  ] as unknown as readonly GraphRevisionCommand[];
}

interface Folded {
  readonly events: readonly GraphRevisionEvent[];
  readonly state: GraphRevisionState;
}

function fold(
  chain: readonly GraphRevisionCommand[],
): Folded | GraphRevisionActivationCoreRefusal {
  let state: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const command of chain) {
    const verdict = reduceGraphRevision(state, command);
    if (!verdict.ok) {
      return Object.freeze({ error: verdict.error, layer: verdict.layer, ok: false as const });
    }
    state = verdict.state;
    events.push(...verdict.events);
  }
  // Unreachable while `chain` is non-empty; the narrowing is what keeps that a type fact.
  if (state === undefined) throw new Error("graph revision fold produced no state");
  return { events, state };
}

/**
 * Build the leg, or say why no initial activation is representable. Never appends: every path
 * here is a read or a pure fold, so a refusal leaves nothing durable behind and the caller can
 * abandon the whole decision with zero residue.
 */
export function buildGraphRevisionActivationLeg(
  input: GraphRevisionActivationInput,
): GraphRevisionActivationResult {
  const aggregateId = graphRevisionAggregateId(input.projectId, input.revisionId);
  if (input.store.readEvents(aggregateId).length > 0) {
    return refused("GRAPH_REVISION_ALREADY_RECORDED");
  }
  const conflict = projectHasActive(input.store, input.projectId);
  if (conflict !== null) return conflict;
  const folded = fold(commandChain(input));
  if ("ok" in folded) return folded;
  return Object.freeze({
    leg: Object.freeze({
      aggregateId,
      events: folded.events.map((event) => ({
        eventId: `${input.commandId}-${event.kind}`,
        eventType: event.kind,
        payload: encoder.encode(JSON.stringify(event as unknown as JsonValue)),
      })),
      // A first history and nothing else: the emptiness check above and this fence are the same
      // claim stated to two different authorities, and the store's is the one that wins a race.
      expectedVersion: 0,
    }),
    ok: true as const,
    state: folded.state,
  });
}
