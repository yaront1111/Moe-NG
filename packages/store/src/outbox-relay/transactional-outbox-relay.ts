import type { DatabaseSync } from "node:sqlite";

import { foldProjection } from "../projections/projection-fold.js";
import type {
  ProjectionCheckpoint, ProjectionReducer, ProjectionState,
} from "../projections/projection-fold.js";
import type { StoredEventUpcaster } from "../projections/projection-upcast.js";
import type { CommitApplyContext } from "../event-ledger-transaction.js";
import {
  DurableStoreError, EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION,
} from "../store-contracts.js";
import type { CommitInput, CommitResult, StoredEvent } from "../store-contracts.js";
import { snapshotCommitInput } from "../store-input-commit.js";
import {
  readOwnDataProperty, requireDataRecord, requireIdentifier,
} from "../store-input-primitives.js";
import type { DataRecord, SnapshotCommitInput } from "../store-internals.js";
import type {
  OutboxRelayApplied, OutboxRelayCode, OutboxRelayDeduplicated, OutboxRelayFoldDetail,
  OutboxRelayLayer, OutboxRelayRefused, OutboxRelayRequest, OutboxRelayResult, RelayCommitSeam,
} from "./outbox-relay-contracts.js";
import { canonicalProjectionState, digestInboxReceipt } from "./outbox-relay-digests.js";

/**
 * Transactional outbox relay. Event append, outbox enqueue, projection apply, and the
 * durable inbox receipt land in ONE SQLite transaction: the fold runs inside the commit
 * seam's apply callback, so a failure at any point leaves none of them. The relay never
 * inserts outbox_messages itself — `EventDraft.outbox` was already written by
 * writeCommitEffects under the same open transaction, and inserting again would double it.
 * Dedupe is the inbox_receipts table, not an in-memory set, so it survives a restart.
 * Every refusal names a stable code AND the layer that refused; anything the relay cannot
 * classify is rethrown, so an unproven outcome never turns into a reported success.
 */

export * from "./outbox-relay-contracts.js";

type Rolled = OutboxRelayDeduplicated | OutboxRelayRefused;
interface RelayPlan {
  readonly checkpoint: ProjectionCheckpoint; readonly commit: SnapshotCommitInput;
  readonly consumerId: string; readonly messageId: string; readonly name: string;
  readonly priorDigest: string; readonly priorState: ProjectionState;
  readonly receiptDigest: string;
  readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly upcaster: StoredEventUpcaster;
}

const INBOX_QUERY =
  "SELECT receipt_digest FROM inbox_receipts WHERE consumer_id = ? AND message_id = ?";
const INBOX_INSERT =
  "INSERT INTO inbox_receipts (consumer_id, message_id, receipt_digest) VALUES (?, ?, ?)";
const PROJECTION_QUERY =
  "SELECT last_applied_position, state_digest FROM projections WHERE projection_name = ?";
const EVENT_QUERY = `SELECT CAST(global_position AS TEXT) AS global_position, event_id,
  command_event_index FROM domain_events WHERE command_id = ? ORDER BY command_event_index`;
/** Compare-and-set: inside DO UPDATE an unqualified name reads the STORED row and
 *  `excluded` the proposed one, so a stale caller cannot overwrite newer durable state. */
const PROJECTION_UPSERT = `INSERT INTO projections
    (projection_name, last_applied_position, state_digest) VALUES (?, ?, ?)
  ON CONFLICT (projection_name) DO UPDATE SET
    last_applied_position = excluded.last_applied_position, state_digest = excluded.state_digest
  WHERE last_applied_position = ? AND state_digest IS ?`;

/** Private carrier: the only throw the relay is willing to translate back into a result. */
class RelayRollback extends Error {
  public readonly result: Rolled;

  public constructor(result: Rolled) {
    super("the outbox relay rolled its transaction back");
    this.name = "RelayRollback";
    this.result = result;
  }
}

function refuse(code: OutboxRelayCode, layer: OutboxRelayLayer, detail: string,
  fold: OutboxRelayFoldDetail | null = null): OutboxRelayRefused {
  return Object.freeze({ code, detail, fold, layer, outcome: "REFUSED" as const });
}

function rollback(result: Rolled): never { throw new RelayRollback(result); }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "SQLite refused the write";
}

function normalizeCheckpoint(value: unknown): ProjectionCheckpoint | null {
  if (typeof value !== "object" || value === null || Reflect.ownKeys(value).length !== 1) {
    return null;
  }
  const slot = Object.getOwnPropertyDescriptor(value, "globalPosition");
  const at: unknown = slot !== undefined && "value" in slot ? slot.value : null;
  return typeof at === "bigint" && at >= 0n ? Object.freeze({ globalPosition: at }) : null;
}

/** Everything is snapshotted before the transaction opens, so nothing the caller still
 *  holds a reference to can change what the fold sees or what the digests bound. */
function planRelay(request: OutboxRelayRequest): RelayPlan | OutboxRelayRefused {
  const own = (record: DataRecord, key: string): unknown => readOwnDataProperty(record, key, key);
  try {
    const ask = requireDataRecord(request, "request");
    const target = requireDataRecord(own(ask, "projection"), "projection");
    const inbox = digestInboxReceipt(own(ask, "consumerId"), own(ask, "message"));
    const prior = canonicalProjectionState(own(target, "state"));
    const checkpoint = normalizeCheckpoint(own(target, "checkpoint"));
    const upcaster = own(target, "upcaster");
    if (inbox === null || prior === null || checkpoint === null ||
        typeof (upcaster as StoredEventUpcaster | null)?.upcast !== "function") {
      return refuse("OUTBOX_RELAY_INPUT_INVALID", "INPUT",
        "consumerId, message, projection state, checkpoint, or upcaster is not usable");
    }
    return {
      checkpoint, commit: snapshotCommitInput(own(ask, "commit") as CommitInput),
      consumerId: requireIdentifier(own(ask, "consumerId"), "consumerId"),
      messageId: inbox.messageId,
      name: requireIdentifier(own(target, "name"), "projection.name"),
      priorDigest: prior.digest, priorState: prior.state, receiptDigest: inbox.digest,
      reducers: requireDataRecord(own(target, "reducers"), "projection.reducers") as
        Readonly<Record<string, ProjectionReducer>>,
      upcaster: upcaster as StoredEventUpcaster,
    };
  } catch (error) {
    return refuse("OUTBOX_RELAY_INPUT_INVALID", "INPUT", describeError(error));
  }
}

/** Runs before any reducer, so a duplicate costs no fold and writes nothing. */
function requireFreshInbox(database: DatabaseSync, plan: RelayPlan): void {
  const row = database.prepare(INBOX_QUERY).get(plan.consumerId, plan.messageId);
  if (row === undefined) { return; }
  if (row["receipt_digest"] === plan.receiptDigest) {
    rollback(Object.freeze({
      commit: null, deduplicatedBy: "INBOX" as const, outcome: "ALREADY_APPLIED" as const,
    }));
  }
  rollback(refuse("OUTBOX_RELAY_INBOX_CONFLICT", "INBOX",
    `consumer ${JSON.stringify(plan.consumerId)} already recorded ` +
    `${JSON.stringify(plan.messageId)} with different envelope bytes`));
}

/** Rebuilds exactly the batch this command just appended from its own rows plus the
 *  pre-transaction snapshot, so the fold never sees an event the commit did not write. */
function materializeEvents(
  database: DatabaseSync, plan: RelayPlan, summary: CommitResult,
): readonly StoredEvent[] {
  const rows = database.prepare(EVENT_QUERY).all(plan.commit.commandId);
  // The variable annotation (not just the arrow's) is what lets TypeScript treat a call
  // as unreachable-after, so `row` narrows to defined below.
  const mismatch: (detail: string) => never = (detail) =>
    rollback(refuse("OUTBOX_RELAY_COMMIT_MISMATCH", "COMMIT", detail));
  if (rows.length !== plan.commit.events.length) {
    mismatch(`command wrote ${rows.length} events, expected ${plan.commit.events.length}`);
  }
  return plan.commit.events.map((draft, index) => {
    const row = rows[index];
    if (row === undefined || row["event_id"] !== draft.eventId ||
        Number(row["command_event_index"]) !== index) {
      mismatch(`committed event ${index} does not match ${JSON.stringify(draft.eventId)}`);
    }
    return Object.freeze({
      aggregateId: summary.aggregateId, aggregateSequence: summary.previousVersion + index + 1,
      commandId: summary.commandId, committedAt: plan.commit.committedAt,
      domainSchemaVersion: draft.domainSchemaVersion, eventId: draft.eventId,
      eventType: draft.eventType, globalPosition: BigInt(String(row["global_position"])),
      metadata: new Uint8Array(draft.metadata), payload: new Uint8Array(draft.payload),
      payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION, recordVersion: EVENT_RECORD_VERSION,
      requestSha256: summary.requestSha256,
    });
  });
}

/** A missing row is only legal at the origin; anything else means a concurrent or stale
 *  caller would overwrite newer durable state with an older fold. */
function requireProjectionAt(database: DatabaseSync, plan: RelayPlan): void {
  const row = database.prepare(PROJECTION_QUERY).get(plan.name);
  const named = JSON.stringify(plan.name);
  const stale = (detail: string): never =>
    rollback(refuse("OUTBOX_RELAY_PROJECTION_CONFLICT", "PROJECTION", detail));
  if (row === undefined) {
    return plan.checkpoint.globalPosition === 0n
      ? undefined : stale(`projection ${named} has no durable row to resume from`);
  }
  if (row["last_applied_position"] !== String(plan.checkpoint.globalPosition)) {
    stale(`projection ${named} is not at checkpoint ${plan.checkpoint.globalPosition}`);
  }
  if (row["state_digest"] !== plan.priorDigest) {
    stale(`projection ${named} holds different state than was supplied`);
  }
}

function writeOnce(work: () => { readonly changes: bigint | number },
  code: OutboxRelayCode, layer: OutboxRelayLayer, detail: string): void {
  let changes = 0;
  try { changes = Number(work().changes); }
  catch (error) { rollback(refuse(code, layer, `${detail}: ${describeError(error)}`)); }
  if (changes !== 1) { rollback(refuse(code, layer, `${detail}: SQLite changed ${changes} rows`)); }
}

function applyRelay(plan: RelayPlan, context: CommitApplyContext): OutboxRelayApplied {
  const { database, summary } = context;
  requireFreshInbox(database, plan);
  const events = materializeEvents(database, plan, summary);
  requireProjectionAt(database, plan);
  const folded = foldProjection({
    checkpoint: plan.checkpoint, events, reducers: plan.reducers,
    state: plan.priorState, upcaster: plan.upcaster,
  });
  if (!folded.ok) {
    rollback(refuse("OUTBOX_RELAY_PROJECTION_REFUSED", "PROJECTION", folded.detail, Object.freeze({
      code: folded.code, eventId: folded.eventId, layer: folded.layer, upcast: folded.upcast,
    })));
  }
  const next = canonicalProjectionState(folded.state);
  if (next === null) {
    rollback(refuse("OUTBOX_RELAY_PROJECTION_WRITE_FAILED", "PROJECTION",
      "the folded state is not canonically representable"));
  }
  writeOnce(() => database.prepare(PROJECTION_UPSERT).run(
    plan.name, String(folded.checkpoint.globalPosition), next.digest,
    String(plan.checkpoint.globalPosition), plan.priorDigest,
  ), "OUTBOX_RELAY_PROJECTION_WRITE_FAILED", "PROJECTION",
  `projection ${JSON.stringify(plan.name)} was not advanced`);
  writeOnce(() => database.prepare(INBOX_INSERT)
    .run(plan.consumerId, plan.messageId, plan.receiptDigest),
  "OUTBOX_RELAY_INBOX_WRITE_FAILED", "INBOX",
  `inbox receipt for ${JSON.stringify(plan.messageId)} was not written`);
  // `next.state`, not `folded.state`: the returned state is then byte-for-byte the value
  // the persisted digest covers, so a caller cannot report a digest for a different object.
  return Object.freeze({
    checkpoint: folded.checkpoint, commit: summary, outcome: "APPLIED" as const,
    state: next.state, stateDigest: next.digest,
  });
}

/**
 * Relays one inbound message. Returns a frozen outcome for every failure the relay can
 * name; a store error it cannot name — including OUTCOME_UNKNOWN — is rethrown unchanged.
 */
export function relayMessage(
  store: RelayCommitSeam, request: OutboxRelayRequest,
): OutboxRelayResult {
  const plan = planRelay(request);
  if ("outcome" in plan) { return plan; }
  const recorded: OutboxRelayApplied[] = [];
  let commit: CommitResult;
  try {
    commit = store.commitWithApply(plan.commit, (context) => {
      recorded.push(applyRelay(plan, context));
    });
  } catch (error) {
    const rolled = error instanceof DurableStoreError && error.code === "PROJECTION_APPLY_FAILED"
      ? error.cause : null;
    if (rolled instanceof RelayRollback) { return rolled.result; }
    throw error;
  }
  if (commit.disposition === "REPLAYED") {
    return Object.freeze({
      commit, deduplicatedBy: "COMMAND_RECEIPT" as const, outcome: "ALREADY_APPLIED" as const,
    });
  }
  const applied = recorded.at(0);
  if (applied === undefined) {
    throw new DurableStoreError(
      "OUTCOME_UNKNOWN", "the relay committed without recording a projection outcome",
    );
  }
  return applied;
}
