/**
 * Durable-history REPLICAS for the approved-plan / criteria readers (task-47b2dbc6).
 *
 * The store is append-only, so a "store-level byte edit" cannot rewrite a committed event in
 * place. Every negative world here is therefore built the only honest way available: drive the
 * SHIPPED journey through the production pipeline, read the three durable payloads it wrote
 * (`GoalExecutionEnabled` on the goal, `PlanningAuthorityBodiesSealed` and
 * `PlanningAuthorityEnvelopeSealed` on `planning-authority/<runId>`), then re-commit those exact
 * bytes into a FRESH store with ONE field mutated. Every operand except the mutation is
 * production-produced; nothing is hand-authored.
 *
 * The machinery is only trustworthy if an UNMUTATED replica is still accepted, which is why
 * `planning-authority-reader.test.ts` asserts that before any refusal arm. Without that positive
 * control a replica whose bytes never reached the reader would make every arm pass for the
 * wrong reason.
 */
import { createHash } from "node:crypto";

import { createPlanRevision, decodePlanRevisionBytes, encodePlanRevision } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  driveThrough,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  decodePlanningAuthorityEnvelopeBytes,
  encodePlanningAuthorityEnvelope,
} from "./planning-authority-envelope.js";
import type { PlanningAuthorityEnvelope } from "./planning-authority-envelope.js";
import { PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE } from "./planning-authority-finalize.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";

export const ACTIVATION_EVENT_TYPE = "GoalExecutionEnabled";

/**
 * The bodies event type, matched as a STRING because no site exports it — unlike the envelope
 * type, which `planning-authority-finalize.ts:48` DOES export and which is therefore imported
 * above rather than restated. The literal lives unexported at `AUTHORITY_EVENT_TYPE`
 * (planning-authority-persistence.ts:38, the writer) and `BODIES_EVENT_TYPE`
 * (planning-authority-finalize.ts:50, approval-run-binding.ts:86). Reported, not fixed: the
 * writer is off this row's owned roster.
 */
export const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type JsonRecord = Record<string, unknown>;

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
export const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const base64Bytes = (value: unknown): Uint8Array =>
  new Uint8Array(Buffer.from(String(value), "base64"));

const asRecord = (value: unknown, what: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as JsonRecord;
};

const parse = (bytes: Uint8Array, what: string): JsonRecord =>
  asRecord(JSON.parse(decoder.decode(bytes)) as unknown, what);

/** The SHIPPED world: the journey driven to the point where the goal is durably activated. */
export function approvedStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/** A goal that exists and was never activated: the journey stopped before `approval.decide`. */
export function unapprovedStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

function onlyEvent(store: SqliteEventStore, aggregateId: string, eventType: string): Uint8Array {
  const matches = store.readEvents(aggregateId).filter((event) => event.eventType === eventType);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${eventType} on ${aggregateId}, found ${String(matches.length)}`,
    );
  }
  return (matches[0] as { readonly payload: Uint8Array }).payload;
}

export const activationEventPayload = (store: SqliteEventStore): JsonRecord =>
  parse(onlyEvent(store, GOAL_ID, ACTIVATION_EVENT_TYPE), ACTIVATION_EVENT_TYPE);

export const bodiesPayload = (store: SqliteEventStore): JsonRecord =>
  parse(
    onlyEvent(store, planningAuthorityAggregateId(RUN_ID), BODIES_EVENT_TYPE),
    BODIES_EVENT_TYPE,
  );

export const envelopePayload = (store: SqliteEventStore): JsonRecord =>
  parse(
    onlyEvent(store, planningAuthorityAggregateId(RUN_ID), PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE),
    PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE,
  );

export const activationSection = (store: SqliteEventStore): JsonRecord =>
  asRecord(own(activationEventPayload(store), "activation"), "activation");

export interface ReplicaEdits {
  /** Rewrites the `activation` section of the goal event. */
  readonly activation?: (activation: JsonRecord) => JsonRecord;
  /** Rewrites the `approval` section of the goal event. */
  readonly approval?: (approval: JsonRecord) => JsonRecord;
  readonly bodies?: (payload: JsonRecord) => JsonRecord;
  /** Replaces the whole bodies-event payload bytes — for the unreadable-seal arm. */
  readonly bodiesPayloadBytes?: Uint8Array;
  readonly duplicateActivation?: boolean;
  readonly duplicateBodies?: boolean;
  readonly envelope?: (payload: JsonRecord) => JsonRecord;
  /** Replaces the whole goal-event payload bytes — for the unreadable-approval arm. */
  readonly goalPayloadBytes?: Uint8Array;
  readonly omitAuthority?: boolean;
  readonly omitEnvelope?: boolean;
}

interface Draft {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Uint8Array;
}

function commitDrafts(store: SqliteEventStore, aggregateId: string, events: readonly Draft[]): void {
  if (events.length === 0) return;
  store.commit({
    aggregateId,
    commandBytes: encoder.encode(`replica-${aggregateId}`),
    commandId: `replica-${aggregateId}`,
    committedAt: "2026-08-22T00:00:00.000Z",
    events,
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

const bytesOf = (payload: JsonRecord): Uint8Array => encoder.encode(JSON.stringify(payload));

function goalDrafts(source: SqliteEventStore, edits: ReplicaEdits): readonly Draft[] {
  let payload = activationEventPayload(source);
  if (edits.activation !== undefined) {
    payload = {
      ...payload, activation: edits.activation(asRecord(payload["activation"], "activation")),
    };
  }
  if (edits.approval !== undefined) {
    payload = { ...payload, approval: edits.approval(asRecord(payload["approval"], "approval")) };
  }
  const first: Draft = {
    eventId: `replica-${GOAL_ID}-0`,
    eventType: ACTIVATION_EVENT_TYPE,
    payload: edits.goalPayloadBytes ?? bytesOf(payload),
  };
  return edits.duplicateActivation === true
    ? [first, { ...first, eventId: `replica-${GOAL_ID}-1` }] : [first];
}

function authorityDrafts(source: SqliteEventStore, edits: ReplicaEdits): readonly Draft[] {
  if (edits.omitAuthority === true) return [];
  const bodies = edits.bodiesPayloadBytes ?? bytesOf(edits.bodies?.(bodiesPayload(source))
    ?? bodiesPayload(source));
  const drafts: Draft[] = [
    { eventId: "replica-bodies-0", eventType: BODIES_EVENT_TYPE, payload: bodies },
  ];
  if (edits.duplicateBodies === true) {
    drafts.push({ eventId: "replica-bodies-1", eventType: BODIES_EVENT_TYPE, payload: bodies });
  }
  if (edits.omitEnvelope !== true) {
    drafts.push({
      eventId: "replica-envelope-0",
      eventType: PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE,
      payload: bytesOf(edits.envelope?.(envelopePayload(source)) ?? envelopePayload(source)),
    });
  }
  return drafts;
}

/**
 * A fresh store carrying the shipped journey's three durable payloads, with at most one field
 * mutated. The ENVELOPE event is committed FIRST on the authority aggregate: the two events'
 * write order is unpinned in production, and seeding envelope-before-bodies is what makes a
 * take-first (index) selection in the reader observable rather than accidentally correct.
 */
export function replicaStore(edits: ReplicaEdits = {}): SqliteEventStore {
  const source = approvedStore();
  const goal = goalDrafts(source, edits);
  const authority = [...authorityDrafts(source, edits)].reverse();
  const store = openStore();
  commitDrafts(store, planningAuthorityAggregateId(RUN_ID), authority);
  commitDrafts(store, GOAL_ID, goal);
  return store;
}

/** The four keys `verifyApprovedRunBinding` binds; a pre-ada30c1 witness has none of them. */
export const LEGACY_KEYS = Object.freeze([
  "authorityRef", "bodiesDigest", "envelopeDigest", "runId",
] as const);

/** A witness as it was written BEFORE the binding shipped: the four keys ABSENT, not null. */
export function withoutBinding(activation: JsonRecord): JsonRecord {
  const stripped: JsonRecord = { ...activation };
  for (const key of LEGACY_KEYS) delete stripped[key];
  return stripped;
}

/**
 * ONE character of the sealed plan body, inside a value the digest covers.
 *
 * `authorRef` is required and non-empty on every revision, so the edit lands deterministically;
 * it is the same length, so the bytes stay canonical and the CANONICALIZATION check cannot be
 * what answers. What is left is the body's own carried `planHash`, which no longer covers it.
 */
export function tamperedRevisionBytes(value: unknown): string {
  const text = decoder.decode(base64Bytes(value));
  const tampered = text.replace(/"authorRef":"(.)/, (_match, first: string) =>
    `"authorRef":"${first === "a" ? "b" : "a"}`);
  if (tampered === text) throw new Error("the sealed plan body carries no authorRef to tamper");
  return Buffer.from(encoder.encode(tampered)).toString("base64");
}

/**
 * A DIFFERENT but fully valid plan-revision body: the journey's own revision re-minted through
 * `createPlanRevision` with one changed field, so core recomputes `planHash` and the bytes stay
 * canonical. Substituting it keeps both codecs green and leaves ONLY the framed bodies digest to
 * notice that the sealed bodies are not the bodies on disk.
 */
export function substituteRevisionBytes(value: unknown): string {
  const sealed = decodePlanRevisionBytes(base64Bytes(value));
  if (!sealed.ok) throw new Error(`sealed revision did not decode: ${sealed.code}`);
  const rebuilt = createPlanRevision({
    affectedCriterionIds: sealed.revision.affectedCriterionIds,
    affectedNodeIds: sealed.revision.affectedNodeIds,
    approvalState: sealed.revision.approvalState,
    authorRef: "author-substituted",
    graphBinding: sealed.revision.graphBinding,
    parentRevisionId: sealed.revision.parentRevisionId,
    rejectionRef: sealed.revision.rejectionRef,
    revisionId: sealed.revision.revisionId,
    steps: sealed.revision.steps,
    verificationRecipeRefs: sealed.revision.verificationRecipeRefs,
  });
  if (!rebuilt.ok) throw new Error(`substitute revision refused: ${rebuilt.code}`);
  const encoded = encodePlanRevision(rebuilt.revision);
  if (!encoded.ok) throw new Error(`substitute revision did not encode: ${encoded.code}`);
  return Buffer.from(encoded.bytes).toString("base64");
}

/** The shipped envelope, decoded, ready to be re-sealed as something else. */
function sealedEnvelope(): PlanningAuthorityEnvelope {
  const decoded = decodePlanningAuthorityEnvelopeBytes(
    base64Bytes(envelopePayload(approvedStore())["envelopeBytesBase64"]),
  );
  if (!decoded.ok) throw new Error(`sealed envelope did not decode: ${decoded.code}`);
  return decoded.envelope;
}

/**
 * A replica whose envelope event carries `bytes`, with that digest restated on the payload AND on
 * the goal witness. Every digest comparison the reader makes therefore AGREES, which is what
 * leaves the envelope's own content as the only thing left to refuse on.
 */
function envelopeReplicaStore(bytes: Uint8Array): SqliteEventStore {
  const digest = sha256(bytes);
  return replicaStore({
    activation: (activation) => ({ ...activation, envelopeDigest: digest }),
    envelope: (payload) => ({
      ...payload,
      envelopeBytesBase64: Buffer.from(bytes).toString("base64"),
      envelopeDigest: digest,
    }),
  });
}

/**
 * An envelope whose own `bindings.revisionId` no longer names its embedded revision. Internally
 * inconsistent, so the CODEC is what answers; hand-serialized rather than re-encoded because the
 * production encoder would refuse to produce it.
 */
export function severedEnvelopeStore(): SqliteEventStore {
  const envelope = sealedEnvelope();
  return envelopeReplicaStore(encoder.encode(JSON.stringify({
    ...envelope, bindings: { ...envelope.bindings, revisionId: "revision-other" },
  })));
}

/**
 * The FULL splice: a fully valid envelope sealed for a DIFFERENT run — both `bindings.runId` and
 * `submission.runId` moved together, so the codec's own RUN_MISMATCH check stays satisfied. Every
 * digest comparison agrees and the codec admits it; only a cross-EVENT comparison can refuse it.
 */
export function splicedEnvelopeStore(): SqliteEventStore {
  const envelope = sealedEnvelope();
  const encoded = encodePlanningAuthorityEnvelope({
    ...envelope,
    bindings: { ...envelope.bindings, runId: "run-other" },
    submission: { ...envelope.submission, runId: "run-other" },
  });
  if (!encoded.ok) throw new Error(`spliced envelope refused: ${encoded.code}`);
  return envelopeReplicaStore(encoded.bytes);
}

export { GOAL_ID, PROJECT_ID, RUN_ID };
