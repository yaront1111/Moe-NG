/**
 * Event replay for the graph revision aggregate (design section 10). Rebuilds the exact
 * `GraphRevisionState` a `GraphRevisionEvent` history represents, so a durable projection can
 * restore authority from events without reimplementing the lifecycle beside `reduceGraphRevision`.
 *
 * REPLAY RE-DERIVES, IT NEVER RE-AUTHORIZES: every fact accepted here was already decided by the
 * command reducer, so this module reuses that aggregate's validators instead of restating a witness
 * contract, and only checks the history is one the reducer could have emitted.
 * `GraphRevisionSuperseded` notably does NOT carry the original supersession request, so replay
 * checks the predecessor/epoch facts the event does carry and never re-takes the kernel's decision.
 *
 * Fails closed on its own layer with its own closed vocabulary: the aggregate's `RuntimeError`
 * codes cannot express order, identity or replay-shape faults, and `GRAPH_REVISION` is not even a
 * valid source for `IDEMPOTENCY_CONFLICT`, so a shared vocabulary would silently degrade.
 */
import type {
  GraphRevisionEvent, GraphRevisionLifecycle, GraphRevisionState,
} from "./graph-revision-contract.js";
import {
  bindingOf, sameBinding, validActivation, validBinding, validGraphRevisionState, validRefusal,
  validSubmission, validSuccessionBinding,
} from "./graph-revision-validation.js";
import { deepFreeze, exact, snapshotData, validHex64, validRef } from "./planning-snapshot.js";

export const GRAPH_REVISION_EVENT_KINDS = Object.freeze([
  "GraphRevisionActivated", "GraphRevisionApproved", "GraphRevisionCreated",
  "GraphRevisionRejected", "GraphRevisionSubmitted", "GraphRevisionSuperseded",
] as const);

export type GraphRevisionEventKind = typeof GRAPH_REVISION_EVENT_KINDS[number];

/** Names the layer that refused, matching how the reducer tags its own aggregate. */
export const CORE_GRAPH_REVISION_REPLAY = "CORE_GRAPH_REVISION_REPLAY" as const;

export const GRAPH_REVISION_REPLAY_CODES = Object.freeze([
  "GRAPH_REVISION_REPLAY_BINDING_DRIFT", "GRAPH_REVISION_REPLAY_DUPLICATE_CREATE",
  "GRAPH_REVISION_REPLAY_EPOCH_DRIFT", "GRAPH_REVISION_REPLAY_EVENT_INVALID",
  "GRAPH_REVISION_REPLAY_HISTORY_INVALID", "GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT",
  "GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION", "GRAPH_REVISION_REPLAY_MISSING_CREATE",
  "GRAPH_REVISION_REPLAY_VERSION_BREAK",
] as const);

export type GraphRevisionReplayCode = typeof GRAPH_REVISION_REPLAY_CODES[number];

export interface GraphRevisionReplayAcceptedResult {
  readonly events: readonly GraphRevisionEvent[];
  readonly ok: true;
  readonly state: GraphRevisionState;
}

export interface GraphRevisionReplayRefusal {
  readonly code: GraphRevisionReplayCode;
  readonly layer: typeof CORE_GRAPH_REVISION_REPLAY;
  readonly ok: false;
}

export type GraphRevisionReplayResult = GraphRevisionReplayAcceptedResult
  | GraphRevisionReplayRefusal;

type Data = Readonly<Record<string, unknown>>;
/** A per-kind outcome: the next state, or the exact code that refused it. */
type Applied = GraphRevisionState | GraphRevisionReplayCode;
type AppliedEventKind = Exclude<GraphRevisionEventKind, "GraphRevisionCreated">;

const EVENT_KEYS = Object.freeze({
  GraphRevisionActivated: ["commandId", "expectedGoalVersion", "goalRef", "kind", "version",
    "witness"],
  GraphRevisionApproved: ["binding", "commandId", "kind", "version"],
  GraphRevisionCreated: ["commandId", "goalRef", "graphContentHash", "kind", "planHash",
    "revisionId", "version"],
  GraphRevisionRejected: ["commandId", "kind", "version", "witness"],
  GraphRevisionSubmitted: ["commandId", "kind", "version", "witness"],
  GraphRevisionSuperseded: ["authorityHash", "commandId", "kind", "successor", "version"],
} as const satisfies Readonly<Record<GraphRevisionEventKind, readonly string[]>>);

/** The same relation `GRAPH_REVISION_TRANSITIONS` declares, expressed over emitted event kinds. */
const REPLAY_TRANSITIONS = Object.freeze({
  GraphRevisionActivated: Object.freeze(["APPROVED"]),
  GraphRevisionApproved: Object.freeze(["PENDING_APPROVAL"]),
  GraphRevisionRejected: Object.freeze(["DRAFT", "PENDING_APPROVAL", "APPROVED"]),
  GraphRevisionSubmitted: Object.freeze(["DRAFT"]),
  GraphRevisionSuperseded: Object.freeze(["ACTIVE"]),
} as const satisfies Readonly<Record<AppliedEventKind, readonly GraphRevisionLifecycle[]>>);

/** The kernel's successor binding is an intersection: it also carries its own `ACTIVE` lifecycle. */
const SUCCESSOR_KEYS = ["graphContentHash", "graphEpoch", "lifecycle",
  "predecessorGraphContentHash", "predecessorRevisionId", "revisionId"] as const;

function refuse(code: GraphRevisionReplayCode): GraphRevisionReplayRefusal {
  return Object.freeze({ code, layer: CORE_GRAPH_REVISION_REPLAY, ok: false as const });
}

/** Safe on snapshot output alone: accessors, proxies and exotic prototypes are already gone. */
function isData(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural identity over snapshot data — the only comparison a redelivered event needs. */
function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameData(item, right[index]));
  }
  if (!isData(left) || !isData(right)) return false;
  const keys = Object.keys(left).sort();
  const other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index])
    && keys.every((key) => sameData(left[key], right[key]));
}

/**
 * Epoch attribution: `validActivation` folds shape and epoch into one boolean, so the epoch relation
 * is read first to keep `EPOCH_DRIFT` distinct from a shape fault. The succession binding itself is
 * still judged by the production validator, never restated here.
 */
function epochDrifted(witness: Data): boolean {
  const graphEpoch = witness["graphEpoch"];
  if (!Number.isSafeInteger(graphEpoch)) return true;
  if (!("succession" in witness)) return graphEpoch !== 1;
  const succession = witness["succession"];
  return !validSuccessionBinding(succession)
    || graphEpoch !== succession.predecessorGraphEpoch + 1;
}

/** Content identity, refs and version floor are all judged by the aggregate's state validator. */
function applyCreated(event: Data): Applied {
  const state = {
    boundHashes: null, goalRef: event["goalRef"], graphContentHash: event["graphContentHash"],
    graphEpoch: 0, lifecycle: "DRAFT", planHash: event["planHash"],
    revisionId: event["revisionId"], submissionRef: null, version: event["version"],
  };
  return validGraphRevisionState(state) ? state : "GRAPH_REVISION_REPLAY_EVENT_INVALID";
}

function applySubmitted(current: GraphRevisionState, event: Data): Applied {
  const witness = event["witness"];
  if (!validSubmission(witness)) return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  return { ...current, lifecycle: "PENDING_APPROVAL", submissionRef: witness.submissionRef,
    version: event["version"] as number };
}

function applyApproved(current: GraphRevisionState, event: Data): Applied {
  const binding = event["binding"];
  if (!validBinding(binding)) return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  if (binding.graphHash !== current.graphContentHash) return "GRAPH_REVISION_REPLAY_BINDING_DRIFT";
  return { ...current, boundHashes: bindingOf(binding), lifecycle: "APPROVED",
    version: event["version"] as number };
}

/** The activation must bind the approved identity, this revision's content, and its own goal facts. */
function applyActivated(current: GraphRevisionState, event: Data): Applied {
  const witness = event["witness"];
  if (!isData(witness)) return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  if (epochDrifted(witness)) return "GRAPH_REVISION_REPLAY_EPOCH_DRIFT";
  if (!validActivation(witness)) return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  if (current.boundHashes === null || !sameBinding(current.boundHashes, witness)
    || witness.graphHash !== current.graphContentHash || event["goalRef"] !== current.goalRef
    || event["expectedGoalVersion"] !== witness.expectedGoalVersion) {
    return "GRAPH_REVISION_REPLAY_BINDING_DRIFT";
  }
  return { ...current, graphEpoch: witness.graphEpoch, lifecycle: "ACTIVE",
    version: event["version"] as number };
}

function applyRejected(current: GraphRevisionState, event: Data): Applied {
  if (!validRefusal(event["witness"])) return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  return { ...current, lifecycle: "REJECTED", version: event["version"] as number };
}

/** Only the facts the event carries: the predecessor tie it names, and the successor's epoch + 1. */
function applySuperseded(current: GraphRevisionState, event: Data): Applied {
  const successor = event["successor"];
  if (!validHex64(event["authorityHash"]) || !exact(successor, SUCCESSOR_KEYS)
    || !validHex64(successor["graphContentHash"]) || !validRef(successor["revisionId"])
    || !validHex64(successor["predecessorGraphContentHash"]) || successor["lifecycle"] !== "ACTIVE"
    || !validRef(successor["predecessorRevisionId"]) || !Number.isSafeInteger(successor["graphEpoch"])) {
    return "GRAPH_REVISION_REPLAY_EVENT_INVALID";
  }
  if (successor["predecessorRevisionId"] !== current.revisionId
    || successor["predecessorGraphContentHash"] !== current.graphContentHash) {
    return "GRAPH_REVISION_REPLAY_BINDING_DRIFT";
  }
  if (successor["graphEpoch"] !== current.graphEpoch + 1) {
    return "GRAPH_REVISION_REPLAY_EPOCH_DRIFT";
  }
  return { ...current, lifecycle: "SUPERSEDED", version: event["version"] as number };
}

const APPLIERS = Object.freeze({
  GraphRevisionActivated: applyActivated, GraphRevisionApproved: applyApproved,
  GraphRevisionRejected: applyRejected, GraphRevisionSubmitted: applySubmitted,
  GraphRevisionSuperseded: applySuperseded,
} as const satisfies Readonly<
  Record<AppliedEventKind, (current: GraphRevisionState, event: Data) => Applied>>);

/** Shape and identity floor every event clears before its kind is allowed to mean anything. */
function admissible(entry: unknown): entry is Data {
  return isData(entry) && GRAPH_REVISION_EVENT_KINDS.some((kind) => kind === entry["kind"])
    && exact(entry, EVENT_KEYS[entry["kind"] as GraphRevisionEventKind])
    && validRef(entry["commandId"]) && Number.isSafeInteger(entry["version"]);
}

/**
 * Folds a `GraphRevisionEvent` history into the state it represents. The whole input is snapshotted
 * once before any discriminator is read, so hostile getters and proxies cannot observe or vary the
 * decision. A byte-identical redelivery at an already-applied version is idempotently ignored; that
 * version carrying different bytes is an identity conflict, never an overwrite. A refusal returns
 * code and layer alone — never a partial state, and never partial graph authority.
 */
export function replayGraphRevisionEvents(history: unknown): GraphRevisionReplayResult {
  const snapshot = snapshotData(history);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) {
    return refuse("GRAPH_REVISION_REPLAY_HISTORY_INVALID");
  }
  const applied = new Map<number, Data>();
  const events: Data[] = [];
  let current: GraphRevisionState | undefined;
  for (const entry of snapshot.value) {
    if (!admissible(entry)) return refuse("GRAPH_REVISION_REPLAY_EVENT_INVALID");
    const kind = entry["kind"] as GraphRevisionEventKind;
    const version = entry["version"] as number;
    const seen = applied.get(version);
    if (seen !== undefined) {
      if (!sameData(seen, entry)) return refuse("GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT");
      continue;
    }
    let next: Applied;
    if (current === undefined) {
      if (kind !== "GraphRevisionCreated") return refuse("GRAPH_REVISION_REPLAY_MISSING_CREATE");
      if (version !== 1) return refuse("GRAPH_REVISION_REPLAY_VERSION_BREAK");
      next = applyCreated(entry);
    } else {
      if (kind === "GraphRevisionCreated") return refuse("GRAPH_REVISION_REPLAY_DUPLICATE_CREATE");
      if (version !== current.version + 1) return refuse("GRAPH_REVISION_REPLAY_VERSION_BREAK");
      const allowed: readonly GraphRevisionLifecycle[] = REPLAY_TRANSITIONS[kind];
      if (!allowed.includes(current.lifecycle)) return refuse("GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION");
      next = APPLIERS[kind](current, entry);
    }
    if (typeof next === "string") return refuse(next);
    current = next;
    applied.set(version, entry);
    events.push(entry);
  }
  if (current === undefined) return refuse("GRAPH_REVISION_REPLAY_MISSING_CREATE");
  return deepFreeze({
    events: Object.freeze(events) as unknown as readonly GraphRevisionEvent[],
    ok: true as const, state: current,
  });
}
