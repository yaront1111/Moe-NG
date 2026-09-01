import type { SqliteEventStore } from "@moe/store";

import { digestOf } from "./recovery-incarnation-contract.js";
import {
  RECOVERY_KEY_EPOCH_COMMAND_KIND,
  RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
} from "./recovery-key-provider-contract.js";
import {
  RECOVERY_SUCCESSION_COMMAND_KIND,
  decodeSuccessionRecord,
  successionAggregateId,
} from "./recovery-succession-contract.js";
import type {
  RecoveryDurableWriteRequest,
  RecoverySuccessionRecord,
} from "./recovery-succession-contract.js";

/**
 * The two durable writes this provider makes, and the one durable read that
 * makes a dead process's epoch findable again.
 *
 * Nothing here is a second durability substrate: every row goes through the same
 * `SqliteEventStore` the incarnation anchor already uses. What is genuinely new
 * is ADDRESSABILITY. A process that died holds nothing, and every incarnation
 * ref is entropy-derived, so no ref can be recomputed from the restore command.
 * The pointer aggregate is the only thing derivable from what a restarting
 * daemon still has, turning "the epoch survived" into "the epoch can be found".
 *
 * Only PUBLIC bytes are written, exactly as `recovery-incarnation-anchor.ts`
 * documents: refs, digests, a generation counter. No key material, ever.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The one durable row that turns a restore command id into an epoch.
 * `origin` is the STABLE epoch identity; `head` is the incarnation the next
 * successor must descend from; `generation` is the aggregate version that
 * produced it, so an advance can only be written against the version it read.
 */
export interface RecoveryKeyEpochPointer {
  readonly schemaVersion: typeof RECOVERY_KEY_EPOCH_SCHEMA_VERSION;
  readonly restoreCommandId: string;
  readonly originIncarnationRef: string;
  readonly headIncarnationRef: string;
  readonly generation: number;
}

export const RECOVERY_KEY_EPOCH_AGGREGATE_PREFIX = "recovery-key-epoch:" as const;

/**
 * Digested rather than concatenated: `restoreCommandId` is caller-chosen, and a
 * raw suffix would let a caller steer the aggregate id onto another namespace.
 * `digestOf` is domain-separated and length-framed, so two (project, command)
 * pairs cannot be slid into one another.
 */
export const keyEpochAggregateId = (projectId: string, restoreCommandId: string): string =>
  `${RECOVERY_KEY_EPOCH_AGGREGATE_PREFIX}${digestOf("key-epoch-pointer", projectId, restoreCommandId)}`;

const HEX64 = /^[0-9a-f]{64}$/;
const POINTER_KEYS = Object.freeze([
  "generation",
  "headIncarnationRef",
  "originIncarnationRef",
  "restoreCommandId",
  "schemaVersion",
]);

/** Serialized in ONE fixed field order, never from the caller's object. */
export const encodeKeyEpochPointer = (pointer: RecoveryKeyEpochPointer): Uint8Array =>
  encoder.encode(
    JSON.stringify({
      generation: pointer.generation,
      headIncarnationRef: pointer.headIncarnationRef,
      originIncarnationRef: pointer.originIncarnationRef,
      restoreCommandId: pointer.restoreCommandId,
      schemaVersion: pointer.schemaVersion,
    }),
  );

/**
 * A bounded exact-shape decode, not a cast. A drifted, truncated or extended row
 * decodes to null, and the reader below turns that into UNREADABLE rather than
 * ABSENT: treating a damaged pointer as "no epoch yet" would silently mint a
 * SECOND epoch for one restore command, which is the fork this chain exists to
 * prevent.
 */
export const decodeKeyEpochPointer = (bytes: Uint8Array): RecoveryKeyEpochPointer | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== POINTER_KEYS.length || !keys.every((key) => POINTER_KEYS.includes(key))) {
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  if (fields["schemaVersion"] !== RECOVERY_KEY_EPOCH_SCHEMA_VERSION) return null;
  for (const key of ["headIncarnationRef", "originIncarnationRef"]) {
    const value: unknown = fields[key];
    if (typeof value !== "string" || !HEX64.test(value)) return null;
  }
  const generation: unknown = fields["generation"];
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    return null;
  }
  const restoreCommandId: unknown = fields["restoreCommandId"];
  if (typeof restoreCommandId !== "string" || restoreCommandId.length === 0) return null;
  return Object.freeze(parsed as unknown as RecoveryKeyEpochPointer);
};

/**
 * Three distinct facts, never two. ABSENT is a cold start, PRESENT is a reopen,
 * and UNREADABLE is a refusal — collapsing UNREADABLE into ABSENT is the bug
 * that forks an epoch, so they are separate members by construction.
 */
export type RecoveryKeyEpochPointerRead =
  | { readonly state: "ABSENT" }
  | { readonly state: "PRESENT"; readonly pointer: RecoveryKeyEpochPointer }
  | { readonly state: "UNREADABLE" };

const ABSENT = Object.freeze({ state: "ABSENT" as const });
const UNREADABLE = Object.freeze({ state: "UNREADABLE" as const });

/**
 * Reads the pointer aggregate directly rather than scanning the decision log:
 * the aggregate id is computable from the restore command alone, which is the
 * whole point of digesting it. The LAST event wins, and its generation must
 * equal the number of events before it — a row claiming a generation the
 * aggregate never reached is a drifted row, not a newer truth. `readEvents` is
 * bounded at MAX_PAGE_SIZE (1000) and THROWS past it rather than truncating, so
 * a 1001st open fails loudly instead of refusing on an invented mismatch.
 */
export function readKeyEpochPointer(
  store: SqliteEventStore,
  projectId: string,
  restoreCommandId: string,
): RecoveryKeyEpochPointerRead {
  const events = store.readEvents(keyEpochAggregateId(projectId, restoreCommandId));
  if (events.length === 0) return ABSENT;
  const latest = events[events.length - 1];
  if (latest === undefined) return UNREADABLE;
  const pointer = decodeKeyEpochPointer(latest.payload);
  if (pointer === null) return UNREADABLE;
  if (pointer.generation !== events.length - 1) return UNREADABLE;
  if (pointer.restoreCommandId !== restoreCommandId) return UNREADABLE;
  return Object.freeze({ pointer, state: "PRESENT" as const });
}

/**
 * Advances the pointer, single-shot against the version it was read at.
 * `expectedVersion: pointer.generation` is the enforcement: two processes racing
 * to reopen one epoch both read generation N, and the STORE lets exactly one
 * write N+1. The loser is refused rather than forking the chain.
 *
 * The command id names the generation AND the head it advances to, on the
 * terms `commitSuccession` already set: the ledger raises IDEMPOTENCY_CONFLICT
 * as a THROW when one command id is reused for different request bytes, and it
 * does so BEFORE the expected-version check. A generation-only id would make
 * two cold starts minting rival heads throw at each other instead of letting
 * the store refuse the loser, while an identical retry still replays under its
 * own id.
 *
 * No try/catch, matching `anchorIncarnation`: the version conflict is RETURNED
 * as a NO_BUSINESS_EFFECT decision, and a catch-all would report a real store
 * fault as a benign duplicate.
 */
export function writeKeyEpochPointer(
  store: SqliteEventStore,
  request: RecoveryDurableWriteRequest,
  pointer: RecoveryKeyEpochPointer,
): boolean {
  const aggregateId = keyEpochAggregateId(request.projectId, pointer.restoreCommandId);
  const bytes = encodeKeyEpochPointer(pointer);
  const commandId = `${aggregateId}:${String(pointer.generation)}:${pointer.headIncarnationRef}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_KEY_EPOCH_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      { eventId: `${commandId}:advanced`, eventType: "RecoveryKeyEpochAdvanced", payload: bytes },
    ],
    expectedVersion: pointer.generation,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({ head: pointer.headIncarnationRef, intent: "ADVANCE" }),
    ),
    targetAggregateId: aggregateId,
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}

/**
 * The successor a predecessor was ALREADY succeeded by, read from the
 * predecessor-keyed succession aggregate.
 *
 * This is what makes the pointer a hint rather than the sole authority, and it
 * is load-bearing for crash-resume: anchoring, recording the succession and
 * advancing the pointer are three writes, and a process that died between the
 * second and the third leaves a head that has already been succeeded. Without
 * this read the retry would try to succeed it again, lose to `expectedVersion:
 * 0` forever, and wedge the epoch permanently.
 */
export function readRecordedSuccessor(
  store: SqliteEventStore,
  predecessorIncarnationRef: string,
): RecoverySuccessionRecord | null {
  for (const event of store.readEvents(successionAggregateId(predecessorIncarnationRef))) {
    const record = decodeSuccessionRecord(event.payload);
    // The aggregate is keyed on the predecessor, so a row filed under one
    // predecessor while naming another is dropped rather than followed.
    if (record !== null && record.predecessorIncarnationRef === predecessorIncarnationRef) {
      return record;
    }
  }
  return null;
}

/**
 * Records the succession, byte-for-byte on the terms `recovery-succession.ts`
 * already set: same command kind, same predecessor-keyed aggregate, same
 * `expectedVersion: 0`, same `recovery-succeed:<pred>:<succ>` command id. Its
 * own writer is module-private, so this is the only way to compose the four
 * exported succession functions AND keep the successor's live handle; matching
 * the terms exactly means the STORE still refuses a second succession from one
 * predecessor no matter which writer got there first.
 */
export function commitSuccessionRecord(
  store: SqliteEventStore,
  request: RecoveryDurableWriteRequest,
  record: RecoverySuccessionRecord,
): boolean {
  const bytes = encoder.encode(JSON.stringify(record));
  const commandId = `recovery-succeed:${record.predecessorIncarnationRef}:${record.successorIncarnationRef}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_SUCCESSION_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      { eventId: `${commandId}:recorded`, eventType: "RecoverySuccessionRecorded", payload: bytes },
    ],
    expectedVersion: 0,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({
        predecessorIncarnationRef: record.predecessorIncarnationRef,
        successorIncarnationRef: record.successorIncarnationRef,
      }),
    ),
    targetAggregateId: successionAggregateId(record.predecessorIncarnationRef),
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}
