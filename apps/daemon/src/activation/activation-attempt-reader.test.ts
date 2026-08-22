/**
 * `readFoundationActivationByAttempt` — the durable activation binding for one
 * attempt, derived from committed evidence and nothing else.
 *
 * EVERY ACCEPTED ACTIVATION HERE IS COMMITTED BY `runEffectActivateCommand`.
 * `activation-ledger-fixtures.record()` is deliberately unused: its grant is
 * codec-legal but `validateActivationCommit`-incoherent, so a suite seeded from
 * it could only ever exercise refusals — and a refusal-only suite is passed by a
 * reader that refuses everything, which is the worst bug here wearing the safest
 * mask. The accepted controls are what make the refusal table mean anything.
 *
 * THE READER IS PROVEN READ-ONLY BY MEASUREMENT, not by its port's shape. Every
 * non-race case snapshots the raw event horizon, the raw event count, the raw
 * command-decision count, the queried aggregate's version and receipt, and the
 * database file's size and mtime, then asserts the read moved none of them. The
 * raw counts are asserted POSITIVE first: a snapshot comparison over two empty
 * measurements proves nothing at all.
 *
 * `principalId` is deliberately never the lease's `ownerSessionRef`. The whole
 * point of this reader is that the owner session comes from the durable lease,
 * so a fixture that let the two coincide could not tell the two apart.
 */

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandReceipt,
  CursorPage,
  DurableStoreErrorCode,
  EffectsCommittedDecision,
  SqliteEventStore,
  StoreHealth,
  StoredEvent,
} from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "./activation-attempt-reader.js";
import type { ActivationAttemptStore } from "./activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation-ingress.js";
import { encodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "./activation-ledger-reader.js";
import {
  FOUNDATION_ACTIVATION_BINDING_LAYER,
  foundationBindingAbsent,
  foundationBindingUnknown,
} from "./foundation-activation-transition.js";
import type { FoundationBindingUnknownCode } from "./foundation-activation-transition.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";

const encoder = new TextEncoder();
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
/** Wall SECONDS; the scheduler's overdue rule is `seconds > deadline`. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;

interface ActivationSpec {
  /** Free of every other identity, which is exactly why it needs a reader. */
  readonly attemptId: string;
  readonly epoch: number;
  readonly sessionId: string;
  readonly slug: string;
}

/**
 * The exact `effect.activate` request body the daemon ingress accepts, with the
 * four fields this suite varies threaded through it. Nothing here computes a
 * grant, a digest or an aggregate id: the ingress does, which is what makes the
 * committed bytes real evidence rather than a fixture agreeing with itself.
 */
function activationBytes(spec: ActivationSpec): Uint8Array {
  const { attemptId, epoch, sessionId, slug } = spec;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface Activated {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly spec: ActivationSpec;
}

/** Commits one activation through production ingress and refuses to guess. */
function activate(store: SqliteEventStore, spec: ActivationSpec): Activated {
  const outcome = runEffectActivateCommand(store, activationBytes(spec));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  return {
    aggregateId: deriveActivationAggregateId(`agg-${spec.slug}`, `idem-${spec.slug}`),
    commandId: `cmd-activate-${spec.slug}`,
    spec,
  };
}

function openStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-attempt-reader-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

/** The durable digest, read back through the production history reader. */
function digestOf(store: SqliteEventStore, aggregateId: string): string {
  const history = readFoundationActivationHistory(
    aggregateId, store.readEvents(aggregateId), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  return history.history.record.activationDigest;
}

interface Snapshot {
  readonly databaseBytes: number;
  readonly databaseMtimeMs: number;
  readonly decisions: number;
  readonly events: number;
  readonly horizon: string;
}

function snapshot(store: SqliteEventStore): Snapshot {
  const path = store.getHealth().databasePath;
  if (path === null) throw new Error("this suite requires a file-backed store");
  const stat = statSync(path);
  let events = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readEventsAfter(cursor, 200);
    events += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  let decisions = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    decisions += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return {
    databaseBytes: stat.size, databaseMtimeMs: stat.mtimeMs, decisions, events,
    horizon: store.readEventHorizon().toString(),
  };
}

/** Positive by assertion, not by hope: an all-zero snapshot compares equal to
 *  itself and would let a WRITING reader pass this suite unnoticed. */
function positiveSnapshot(store: SqliteEventStore): Snapshot {
  const taken = snapshot(store);
  expect(taken.events).toBeGreaterThan(0);
  expect(taken.decisions).toBeGreaterThan(0);
  expect(BigInt(taken.horizon)).toBeGreaterThan(0n);
  expect(taken.databaseBytes).toBeGreaterThan(0);
  return taken;
}

const BOUND_KEYS = Object.freeze([
  "activationAggregateId", "activationDigest", "attemptId", "effectIntentId", "epoch",
  "ownerSessionRef", "projectId", "status",
]);

afterEach(cleanupRestoreHarnesses);

describe("readFoundationActivationByAttempt accepts a committed activation", () => {
  it("returns the durable binding for the queried attempt and moves nothing", () => {
    const store = openStore("bound");
    const target = activate(store, {
      attemptId: "attempt-target", epoch: 41, sessionId: "session-owner", slug: "target",
    });
    activate(store, {
      attemptId: "attempt-other", epoch: 9, sessionId: "session-other", slug: "other",
    });
    // The owner session is the DURABLE lease's, never the requesting principal.
    expect(target.spec.sessionId).not.toBe(PRINCIPAL_ID);
    const before = positiveSnapshot(store);
    const versionBefore = store.getAggregateVersion(target.aggregateId);
    // The RECEIPT is keyed by the store's internal command id, which is NOT the
    // request command id the decision key carries; swapping them reads null.
    const targetEvent = store.readEvents(target.aggregateId)[0];
    if (targetEvent === undefined) throw new Error("the target committed no event");
    const receiptBefore = store.getCommandReceipt(targetEvent.commandId);
    expect(receiptBefore).not.toBeNull();
    expect(targetEvent.commandId).not.toBe(target.commandId);

    const result = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-target");

    expect(result).toEqual({
      activationAggregateId: target.aggregateId,
      activationDigest: digestOf(store, target.aggregateId),
      attemptId: "attempt-target",
      effectIntentId: "intent-target",
      epoch: 41,
      ownerSessionRef: "session-owner",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(Object.keys(result).sort()).toEqual([...BOUND_KEYS]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.values(result).every((value) => Object(value) !== value)).toBe(true);
    // A repeated read of unchanged bytes is the same answer, byte for byte.
    expect(JSON.stringify(readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-target")))
      .toBe(JSON.stringify(result));
    expect(snapshot(store)).toEqual(before);
    expect(store.getAggregateVersion(target.aggregateId)).toBe(versionBefore);
    expect(store.getCommandReceipt(targetEvent.commandId)).toEqual(receiptBefore);
  });

  it("distinguishes two committed attempts instead of answering the first", () => {
    const store = openStore("distinct");
    const first = activate(store, {
      attemptId: "attempt-first", epoch: 2, sessionId: "session-first", slug: "first",
    });
    const second = activate(store, {
      attemptId: "attempt-second", epoch: 77, sessionId: "session-second", slug: "second",
    });
    const before = positiveSnapshot(store);

    const answer = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-second");

    expect(answer).toEqual({
      activationAggregateId: second.aggregateId,
      activationDigest: digestOf(store, second.aggregateId),
      attemptId: "attempt-second",
      effectIntentId: "intent-second",
      epoch: 77,
      ownerSessionRef: "session-second",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(answer).not.toMatchObject({ activationAggregateId: first.aggregateId });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readFoundationActivationByAttempt reports a durable absence", () => {
  it("answers the existing exact ABSENT bytes while other activations exist", () => {
    const store = openStore("absent");
    activate(store, {
      attemptId: "attempt-present", epoch: 5, sessionId: "session-present", slug: "present",
    });
    const before = positiveSnapshot(store);

    const missing = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-missing");

    expect(missing).toEqual(foundationBindingAbsent("FOUNDATION_BINDING_NOT_FOUND"));
    expect(missing).toEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND",
      layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
      status: "ABSENT",
    });
    expect(Object.keys(missing).sort()).toEqual(["code", "layer", "status"]);
    expect(Object.isFrozen(missing)).toBe(true);
    // An always-ABSENT reader cannot pass: the same store answers BOUND here.
    expect(readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-present").status)
      .toBe("BOUND");
    expect(snapshot(store)).toEqual(before);
  });
});

/* ---------------------------------------------------------------------------
 * Uniqueness across a page boundary, provenance, horizon-bounded termination,
 * and a real concurrent writer. Every hostile case below is a THIN READ-ONLY
 * DECORATOR over a store seeded by production ingress: the bytes stay real,
 * exactly one fact drifts, and a guard no honest fixture can reach is reached
 * by planting the row a production writer would never emit.
 * ------------------------------------------------------------------------- */

type Port = ActivationAttemptStore;

function decorate(store: SqliteEventStore, overrides: Partial<Port>): Port {
  return {
    getCommandDecision:
      overrides.getCommandDecision ??
      ((key: CommandDecisionKey): CommandDecisionRecord | null => store.getCommandDecision(key)),
    getCommandReceipt:
      overrides.getCommandReceipt ??
      ((commandId: string): CommandReceipt | null => store.getCommandReceipt(commandId)),
    getHealth: overrides.getHealth ?? ((): StoreHealth => store.getHealth()),
    readEventHorizon: overrides.readEventHorizon ?? ((): bigint => store.readEventHorizon()),
    readEvents:
      overrides.readEvents ??
      ((aggregateId: string): readonly StoredEvent[] => store.readEvents(aggregateId)),
    readEventsByTypeAfter:
      overrides.readEventsByTypeAfter ??
      ((eventType: string, after: bigint, limit?: number): CursorPage<StoredEvent, bigint> =>
        store.readEventsByTypeAfter(eventType, after, limit)),
  };
}

const mapPage = (
  page: CursorPage<StoredEvent, bigint>, map: (event: StoredEvent) => StoredEvent,
): CursorPage<StoredEvent, bigint> =>
  ({ hasMore: page.hasMore, items: page.items.map(map), nextCursor: page.nextCursor });

const PAGE_LIMIT = 100;

function indexedActivations(store: SqliteEventStore): readonly StoredEvent[] {
  const all: StoredEvent[] = [];
  for (let cursor = 0n; ; ) {
    const page = store.readEventsByTypeAfter(ACTIVATION_LEDGER_EVENT_TYPE, cursor, PAGE_LIMIT);
    all.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return all;
}

const unknownOf = (
  code: FoundationBindingUnknownCode, storeCode: DurableStoreErrorCode | null = null,
): Readonly<Record<string, unknown>> =>
  ({ code, layer: FOUNDATION_ACTIVATION_BINDING_LAYER, status: "UNKNOWN", storeCode });

const UNKNOWN_KEYS = Object.freeze(["code", "layer", "status", "storeCode"]);

function expectUnknown(
  result: unknown, code: FoundationBindingUnknownCode,
  storeCode: DurableStoreErrorCode | null = null,
): void {
  expect(result).toEqual(unknownOf(code, storeCode));
  expect(Object.keys(result as object).sort()).toEqual([...UNKNOWN_KEYS]);
  expect(Object.isFrozen(result)).toBe(true);
}

/* -------------------------------------------------------------------------
 * Uniqueness and cross-page completeness over 102 real activations.
 * ----------------------------------------------------------------------- */

const DUPLICATE_ATTEMPT = "attempt-shared";
const UNRELATED_ACTIVATIONS = 99;

interface Ledger {
  readonly duplicates: readonly Activated[];
  readonly indexed: readonly StoredEvent[];
  readonly pageTwo: Activated;
  readonly store: SqliteEventStore;
}

/**
 * 99 unrelated activations, then TWO different activation aggregates carrying
 * the SAME attempt at indexed positions 100 and 101 — deliberately straddling
 * the 100-item page boundary — then one unique activation at 102. A reader that
 * returns its first hit, or that stops at the end of page one, answers BOUND
 * where the durable evidence is ambiguous.
 */
function seedLedger(label: string): Ledger {
  const store = openStore(label);
  for (let index = 0; index < UNRELATED_ACTIVATIONS; index += 1) {
    activate(store, {
      attemptId: `attempt-u${index}`, epoch: index + 1, sessionId: `session-u${index}`,
      slug: `u${index}`,
    });
  }
  const duplicates = [
    activate(store, {
      attemptId: DUPLICATE_ATTEMPT, epoch: 500, sessionId: "session-dup-a", slug: "dup-a",
    }),
    activate(store, {
      attemptId: DUPLICATE_ATTEMPT, epoch: 501, sessionId: "session-dup-b", slug: "dup-b",
    }),
  ];
  const pageTwo = activate(store, {
    attemptId: "attempt-page-two", epoch: 777, sessionId: "session-page-two", slug: "page-two",
  });
  const indexed = indexedActivations(store);
  // The seed is asserted, not assumed: a layout that silently drifted to 101
  // activations would move the duplicates onto one page and quietly retire the
  // only case that proves the scan crosses a page boundary.
  expect(indexed.length).toBe(UNRELATED_ACTIVATIONS + 3);
  expect(indexed[99]?.aggregateId).toBe(duplicates[0]?.aggregateId);
  expect(indexed[100]?.aggregateId).toBe(duplicates[1]?.aggregateId);
  expect(indexed[101]?.aggregateId).toBe(pageTwo.aggregateId);
  return { duplicates, indexed, pageTwo, store };
}

interface Counted {
  readonly pages: () => number;
  readonly port: Port;
}

function counting(store: SqliteEventStore): Counted {
  let pages = 0;
  const port = decorate(store, {
    readEventsByTypeAfter: (
      eventType: string, after: bigint, limit?: number,
    ): CursorPage<StoredEvent, bigint> => {
      pages += 1;
      return store.readEventsByTypeAfter(eventType, after, limit);
    },
  });
  return { pages: (): number => pages, port };
}

describe("readFoundationActivationByAttempt scans past its first hit", () => {
  it("refuses two activations sharing one attempt across the page boundary", () => {
    const ledger = seedLedger("ambiguous");
    const before = positiveSnapshot(ledger.store);
    const counted = counting(ledger.store);

    const answer = readFoundationActivationByAttempt(counted.port, PROJECT_ID, DUPLICATE_ATTEMPT);

    expectUnknown(answer, "FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
    expect(counted.pages()).toBeGreaterThanOrEqual(2);
    expect(snapshot(ledger.store)).toEqual(before);
  }, 120_000);

  it("binds a unique activation that only appears on the second page", () => {
    const ledger = seedLedger("page-two");
    const before = positiveSnapshot(ledger.store);
    const counted = counting(ledger.store);

    const answer = readFoundationActivationByAttempt(
      counted.port, PROJECT_ID, "attempt-page-two");

    expect(answer).toEqual({
      activationAggregateId: ledger.pageTwo.aggregateId,
      activationDigest: digestOf(ledger.store, ledger.pageTwo.aggregateId),
      attemptId: "attempt-page-two",
      effectIntentId: "intent-page-two",
      epoch: 777,
      ownerSessionRef: "session-page-two",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(counted.pages()).toBeGreaterThanOrEqual(2);
    expect(snapshot(ledger.store)).toEqual(before);
  }, 120_000);
});

/* -------------------------------------------------------------------------
 * Provenance: every candidate is verified before the attempt is compared.
 * ----------------------------------------------------------------------- */

interface Planted {
  readonly aggregateId: string;
  readonly decision: EffectsCommittedDecision;
  readonly event: StoredEvent;
  readonly record: ActivationLedgerRecord;
  readonly store: SqliteEventStore;
}

const PLANTED_ATTEMPT = "attempt-planted";

function plant(label: string): Planted {
  const store = openStore(label);
  const target = activate(store, {
    attemptId: PLANTED_ATTEMPT, epoch: 12, sessionId: "session-planted", slug: "planted",
  });
  const events = store.readEvents(target.aggregateId);
  const event = events[0];
  if (event === undefined) throw new Error("the planted activation committed no event");
  const decision = store.getCommandDecision({
    commandId: target.commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  });
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("the planted activation has no committed decision");
  }
  const history = readFoundationActivationHistory(target.aggregateId, events, PROJECT_ID);
  if (!history.ok) throw new Error("the planted activation is unreadable");
  return {
    aggregateId: target.aggregateId, decision, event, record: history.history.record, store,
  };
}

const traceOf = (event: StoredEvent): NonNullable<StoredEvent["decisionTrace"]> => {
  const { decisionTrace } = event;
  if (decisionTrace === undefined) throw new Error("a committed activation carries a trace");
  return decisionTrace;
};

/** Replaces the planted candidate wherever the reader can meet it. */
function serving(planted: Planted, forged: StoredEvent): Partial<Port> {
  return {
    readEvents: (aggregateId: string): readonly StoredEvent[] =>
      aggregateId === planted.aggregateId ? [forged] : planted.store.readEvents(aggregateId),
    readEventsByTypeAfter: (
      eventType: string, after: bigint, limit?: number,
    ): CursorPage<StoredEvent, bigint> =>
      mapPage(planted.store.readEventsByTypeAfter(eventType, after, limit),
        (event) => (event.eventId === planted.event.eventId ? forged : event)),
  };
}

/** Only the INDEXED candidate drifts; the aggregate history stays real. */
function indexedOnly(planted: Planted, drift: (event: StoredEvent) => StoredEvent): Partial<Port> {
  return {
    readEventsByTypeAfter: (
      eventType: string, after: bigint, limit?: number,
    ): CursorPage<StoredEvent, bigint> =>
      mapPage(planted.store.readEventsByTypeAfter(eventType, after, limit),
        (event) => (event.eventId === planted.event.eventId ? drift(event) : event)),
  };
}

/**
 * A forged record RESEALED BY THE PRODUCTION CODEC, with the command decision's
 * committed result bytes moved to match. Without the matching decision the
 * refusal would come from the result-linkage guard and never reach the lease and
 * activation guards these cases exist to exercise.
 */
function resealed(
  planted: Planted, mutate: (record: ActivationLedgerRecord) => unknown,
): Partial<Port> {
  const encoded = encodeActivationLedgerRecord(mutate(planted.record));
  if (!encoded.ok) throw new Error(`the forged record is not encodable: ${encoded.code}`);
  const forged: StoredEvent = { ...planted.event, payload: encoded.bytes };
  return {
    ...serving(planted, forged),
    getCommandDecision: (key: CommandDecisionKey): CommandDecisionRecord | null =>
      key.commandId === planted.decision.key.commandId
        ? { ...planted.decision, resultBytes: encoded.bytes }
        : planted.store.getCommandDecision(key),
  };
}

const throwsStore = (code: DurableStoreErrorCode) => (): never => {
  throw new DurableStoreError(code, "hostile decorator");
};
const throwsPlain = (): never => {
  throw new Error("hostile decorator");
};

interface HostileCase {
  readonly code: FoundationBindingUnknownCode;
  readonly name: string;
  readonly overrides: (planted: Planted) => Partial<Port>;
  readonly storeCode?: DurableStoreErrorCode;
}

const HOSTILE: readonly HostileCase[] = [
  {
    code: "FOUNDATION_BINDING_PROJECT_MISMATCH",
    name: "the store health names a foreign project",
    overrides: (planted) => ({
      getHealth: (): StoreHealth => ({ ...planted.store.getHealth(), projectId: "project-foreign" }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the store health throws a durable store error",
    overrides: () => ({ getHealth: throwsStore("STORE_CLOSED") as () => StoreHealth }),
    storeCode: "STORE_CLOSED",
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the store health throws a plain error",
    overrides: () => ({ getHealth: throwsPlain as () => StoreHealth }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the horizon read throws a durable store error",
    overrides: () => ({ readEventHorizon: throwsStore("STORE_BUSY") as () => bigint }),
    storeCode: "STORE_BUSY",
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the horizon is not a bigint",
    overrides: () => ({ readEventHorizon: (): bigint => 12 as unknown as bigint }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the horizon is negative",
    overrides: () => ({ readEventHorizon: (): bigint => -1n }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the indexed page read throws a durable store error",
    overrides: () => ({
      readEventsByTypeAfter: throwsStore("STORE_CORRUPT") as () => CursorPage<StoredEvent, bigint>,
    }),
    storeCode: "STORE_CORRUPT",
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the indexed page read throws a plain error",
    overrides: () => ({
      readEventsByTypeAfter: throwsPlain as () => CursorPage<StoredEvent, bigint>,
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page is not an object",
    overrides: () => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        null as unknown as CursorPage<StoredEvent, bigint>,
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page items are not an array",
    overrides: () => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: false, items: "nope", nextCursor: null } as unknown as
          CursorPage<StoredEvent, bigint>),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page hasMore flag is not a boolean",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: "yes", items: [planted.event], nextCursor: planted.event.globalPosition } as
          unknown as CursorPage<StoredEvent, bigint>),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page cursor is neither a bigint nor null",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: false, items: [planted.event], nextCursor: 5 } as unknown as
          CursorPage<StoredEvent, bigint>),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page serves more items than the page size",
    overrides: (planted) => ({
      readEventsByTypeAfter: (_type: string, after: bigint): CursorPage<StoredEvent, bigint> => {
        const items = Array.from({ length: PAGE_LIMIT + 1 }, (_value, index) =>
          ({ ...planted.event, globalPosition: after + BigInt(index + 1) }));
        return { hasMore: false, items, nextCursor: after + BigInt(items.length) };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page repeats a global position",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: false, items: [planted.event, planted.event],
          nextCursor: planted.event.globalPosition }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the page walks backwards",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> => {
        const second = { ...planted.event, globalPosition: planted.event.globalPosition - 1n };
        return { hasMore: false, items: [planted.event, second], nextCursor: second.globalPosition };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "an indexed event sits beyond the captured horizon",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> => {
        const beyond = planted.store.readEventHorizon() + 1n;
        return { hasMore: false, items: [{ ...planted.event, globalPosition: beyond }],
          nextCursor: beyond };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the filtered page serves a foreign event type",
    overrides: (planted) =>
      indexedOnly(planted, (event) => ({ ...event, eventType: "SomethingElseHappened" })),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the cursor does not name the last served position",
    overrides: (planted) => ({
      readEventsByTypeAfter: (): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: true, items: [planted.event],
          nextCursor: planted.event.globalPosition + 7n }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "an empty page still claims there is more",
    overrides: () => ({
      readEventsByTypeAfter: (_type: string, after: bigint): CursorPage<StoredEvent, bigint> =>
        ({ hasMore: true, items: [], nextCursor: after }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the horizon moves between capture and the final check",
    overrides: (planted) => {
      let reads = 0;
      return {
        readEventHorizon: (): bigint => {
          reads += 1;
          return planted.store.readEventHorizon() + (reads > 1 ? 1n : 0n);
        },
      };
    },
  },
  {
    code: "FOUNDATION_BINDING_PROJECT_MISMATCH",
    name: "the indexed event carries a foreign project trace",
    overrides: (planted) =>
      indexedOnly(planted, (event) => ({
        ...event, decisionTrace: { ...traceOf(event), projectId: "project-foreign" },
      })),
  },
  {
    code: "FOUNDATION_BINDING_PROJECT_MISMATCH",
    name: "the indexed event carries no decision trace at all",
    overrides: (planted) =>
      indexedOnly(planted, (event) => {
        const clone: Record<string, unknown> = { ...event };
        delete clone["decisionTrace"];
        return clone as unknown as StoredEvent;
      }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the trace names a command kind this ledger never writes",
    overrides: (planted) =>
      indexedOnly(planted, (event) => ({
        ...event, decisionTrace: { ...traceOf(event), commandKind: "activation.committed" },
      })),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the command decision is missing",
    overrides: () => ({ getCommandDecision: (): CommandDecisionRecord | null => null }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the command decision read throws a durable store error",
    overrides: () => ({
      getCommandDecision: throwsStore("STORE_UNAVAILABLE") as () => CommandDecisionRecord | null,
    }),
    storeCode: "STORE_UNAVAILABLE",
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision was written under a foreign command kind",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, commandKind: "activation.committed" }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision targets another aggregate",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, targetAggregateId: "aggregate-elsewhere" }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision did not move the aggregate from zero to one",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord => ({ ...planted.decision, currentVersion: 2 }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision observed a version it did not expect",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord => ({ ...planted.decision, observedVersion: 3 }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision names no single business event",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, businessEventIds: [] }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision published an outbox message",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, outboxMessageIds: ["message-1"] }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision result bytes are not the indexed payload",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, resultBytes: new Uint8Array([1, 2, 3]) }),
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision request hash disagrees with its own trace",
    overrides: (planted) => ({
      getCommandDecision: (): CommandDecisionRecord =>
        ({ ...planted.decision, requestSha256: "b".repeat(64) }),
    }),
  },
  {
    // Both operands non-binary is the ONE arrangement that reaches `.every`: a
    // single drifted payload short-circuits on a length that no longer matches.
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the decision and the indexed event both carry a non-binary payload",
    overrides: (planted) => {
      const payload = {} as unknown as Uint8Array;
      return {
        ...serving(planted, { ...planted.event, payload }),
        getCommandDecision: (): CommandDecisionRecord =>
          ({ ...planted.decision, resultBytes: payload }),
      };
    },
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the command receipt is missing",
    overrides: () => ({ getCommandReceipt: (): CommandReceipt | null => null }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the command receipt read throws a durable store error",
    overrides: () => ({
      getCommandReceipt: throwsStore("STORE_SCHEMA_INVALID") as () => CommandReceipt | null,
    }),
    storeCode: "STORE_SCHEMA_INVALID",
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt names another aggregate",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null ? null : { ...receipt, aggregateId: "aggregate-elsewhere" };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt names no single event",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null ? null : { ...receipt, eventIds: [] };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt and the decision disagree about the effect hash",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null ? null : { ...receipt, effectSha256: "c".repeat(64) };
      },
    }),
  },
  {
    // The decision's request hash and the event's are DIFFERENT DIGEST DOMAINS.
    // A reader that compared one to both would accept this substitution.
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt carries the decision request hash instead of the effect one",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null
          ? null : { ...receipt, requestSha256: planted.decision.requestSha256 };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt did not move the aggregate from zero to one",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null ? null : { ...receipt, previousVersion: 1 };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the receipt records no commit time",
    overrides: (planted) => ({
      getCommandReceipt: (commandId: string): CommandReceipt | null => {
        const receipt = planted.store.getCommandReceipt(commandId);
        return receipt === null ? null : { ...receipt, committedAt: "" };
      },
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    name: "the aggregate read throws a durable store error",
    overrides: () => ({
      readEvents: throwsStore("STORE_BUSY") as () => readonly StoredEvent[],
    }),
    storeCode: "STORE_BUSY",
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
    name: "the aggregate holds no event at all",
    overrides: () => ({ readEvents: (): readonly StoredEvent[] => [] }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
    name: "the aggregate's first event is not the indexed candidate",
    overrides: (planted) => ({
      readEvents: (): readonly StoredEvent[] =>
        [{ ...planted.event, eventId: "grant-elsewhere" }],
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
    name: "the aggregate's first event is not at sequence one",
    overrides: (planted) => ({
      readEvents: (): readonly StoredEvent[] => [{ ...planted.event, aggregateSequence: 2 }],
    }),
  },
  {
    code: "FOUNDATION_BINDING_SCAN_INCOMPLETE",
    name: "the aggregate history reaches beyond the captured horizon",
    overrides: (planted) => ({
      readEvents: (): readonly StoredEvent[] =>
        [{ ...planted.event, globalPosition: planted.store.readEventHorizon() + 1n }],
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS",
    name: "the aggregate history is longer than a launch history can be",
    overrides: (planted) => ({
      readEvents: (): readonly StoredEvent[] => Array.from({ length: 5 }, () => planted.event),
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
    name: "the indexed event is valid but the aggregate history is not",
    overrides: (planted) => ({
      readEvents: (): readonly StoredEvent[] => [
        planted.event,
        { ...planted.event, aggregateSequence: 2, eventId: "tail-1",
          eventType: "SomethingElseHappened" },
      ],
    }),
  },
  {
    code: "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
    name: "the durable lease does not parse",
    overrides: (planted) =>
      resealed(planted, (record) => ({ ...record, lease: { ...record.lease, state: "NOT_A_STATE" } })),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the effect intent is bound to a different lease than the record's",
    overrides: (planted) =>
      resealed(planted, (record) => ({
        ...record,
        effectIntent: {
          ...record.effectIntent,
          leaseBinding: { ...record.effectIntent.leaseBinding, epoch: record.lease.epoch + 1 },
        },
      })),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the recorded activation digest is not the one the commit derives",
    overrides: (planted) =>
      resealed(planted, (record) => ({ ...record, activationDigest: "d".repeat(64) })),
  },
  {
    code: "FOUNDATION_BINDING_ACTIVATION_INCOHERENT",
    name: "the recorded attempt is not RUNNING",
    overrides: (planted) =>
      resealed(planted, (record) => ({
        ...record, attempt: { ...record.attempt, state: "SUCCEEDED" },
      })),
  },
];

describe("readFoundationActivationByAttempt fails closed on unverifiable evidence", () => {
  // A sweep that silently generates zero cases passes while testing nothing.
  it("has a nonempty hostile table covering every unknown code", () => {
    expect(HOSTILE.length).toBeGreaterThan(0);
    expect(new Set(HOSTILE.map((entry) => entry.code)).size).toBe(6);
    expect(HOSTILE.filter((entry) => entry.storeCode !== undefined).length).toBeGreaterThan(0);
    // The UNKNOWN body is the production one plus `storeCode`, so a drift in the
    // shared layer or code vocabulary reddens here rather than passing silently.
    for (const code of new Set(HOSTILE.map((entry) => entry.code))) {
      const mine = unknownOf(code);
      const { storeCode: _extra, ...shared } = mine;
      expect(shared).toEqual(foundationBindingUnknown(code));
      expect(_extra).toBeNull();
    }
  });

  for (const entry of HOSTILE) {
    it(`answers ${entry.code} when ${entry.name}`, () => {
      const planted = plant("hostile");
      const before = positiveSnapshot(planted.store);
      const port = decorate(planted.store, entry.overrides(planted));

      const answer = readFoundationActivationByAttempt(port, PROJECT_ID, PLANTED_ATTEMPT);

      expectUnknown(answer, entry.code, entry.storeCode ?? null);
      expect(snapshot(planted.store)).toEqual(before);
    }, 30_000);
  }

  it("verifies an unrelated candidate before it compares the queried attempt", () => {
    const store = openStore("unrelated");
    const kept = activate(store, {
      attemptId: "attempt-keep", epoch: 3, sessionId: "session-keep", slug: "keep",
    });
    const junk = activate(store, {
      attemptId: "attempt-junk", epoch: 4, sessionId: "session-junk", slug: "junk",
    });
    const junkEvent = store.readEvents(junk.aggregateId)[0];
    if (junkEvent === undefined) throw new Error("the junk activation committed no event");
    const before = positiveSnapshot(store);

    // The queried attempt's OWN evidence is untouched; an unrelated row is not.
    const port = decorate(store, {
      getCommandReceipt: (commandId: string): CommandReceipt | null =>
        commandId === junkEvent.commandId ? null : store.getCommandReceipt(commandId),
    });

    expectUnknown(
      readFoundationActivationByAttempt(port, PROJECT_ID, "attempt-keep"),
      "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
    );
    // ...and the same query over the undecorated store still binds, so the
    // refusal above is the unrelated row's, not a reader that refuses everything.
    expect(readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-keep")).toMatchObject({
      activationAggregateId: kept.aggregateId, status: "BOUND",
    });
    expect(snapshot(store)).toEqual(before);
  }, 30_000);

  it("keeps the decision and effect request hashes in separate domains", () => {
    const planted = plant("domains");
    const trace = traceOf(planted.event);
    const receipt = planted.store.getCommandReceipt(planted.event.commandId);
    expect(receipt).not.toBeNull();
    expect(planted.decision.requestSha256).toBe(trace.requestSha256);
    expect(receipt?.requestSha256).toBe(planted.event.requestSha256);
    // The two domains genuinely differ; a reader comparing one hash to both
    // would pass this file while accepting a substituted receipt.
    expect(planted.decision.requestSha256).not.toBe(planted.event.requestSha256);
    // ...and so do the two command ids: the decision's key names the request,
    // the event's names the store-internal effect the receipt is filed under.
    expect(planted.event.commandId).not.toBe(trace.commandId);
  }, 30_000);
});

const LONG_QUERY = "q".repeat(401);

describe("readFoundationActivationByAttempt refuses an unusable query", () => {
  const QUERIES: readonly { readonly attemptId: string; readonly name: string;
    readonly projectId: string }[] = [
    { attemptId: PLANTED_ATTEMPT, name: "an empty project", projectId: "" },
    { attemptId: PLANTED_ATTEMPT, name: "an oversized project", projectId: LONG_QUERY },
    { attemptId: "", name: "an empty attempt", projectId: PROJECT_ID },
    { attemptId: LONG_QUERY, name: "an oversized attempt", projectId: PROJECT_ID },
    { attemptId: "attempt-\uD800", name: "an ill-formed attempt", projectId: PROJECT_ID },
  ];

  it("has a nonempty query table", () => {
    expect(QUERIES.length).toBeGreaterThan(0);
  });

  for (const query of QUERIES) {
    it(`answers QUERY_INVALID for ${query.name}`, () => {
      const planted = plant("query");
      const before = positiveSnapshot(planted.store);

      expectUnknown(
        readFoundationActivationByAttempt(planted.store, query.projectId, query.attemptId),
        "FOUNDATION_BINDING_QUERY_INVALID",
      );
      expect(snapshot(planted.store)).toEqual(before);
    }, 30_000);
  }
});

/* -------------------------------------------------------------------------
 * Termination comes from the captured horizon, not from page/candidate caps.
 * ----------------------------------------------------------------------- */

/**
 * THE NUMBERS ARE WRITTEN OUT ON PURPOSE, exactly as the launch-authority suite
 * pins its twin: the scan used to stop after 64 pages of 100 = 6,400 candidates
 * and refuse SCAN_INCOMPLETE forever after — a cap on TOTAL PROJECT ACTIVATIONS,
 * not on anything about the queried attempt, so one busy append-only ledger
 * bricked every attempt lookup at once. Deriving these from surviving constants
 * would make the proof move with the bound it exists to bury.
 */
const OLD_SCAN_CEILING = 6_400;
const CANDIDATES_PAST_THE_OLD_CEILING = 6_500;
const OLD_PAGE_CEILING = 64;

describe("readFoundationActivationByAttempt is bounded by the horizon alone", () => {
  it("binds an attempt whose activation sits past the retired 6,400 ceiling", () => {
    const planted = plant("past-ceiling");
    // A SECOND real activation supplies the verifiable non-matching bulk: every
    // filler candidate must survive `verifyCandidate` for the walk to reach the
    // match, so what is being proved is reach, not refusal.
    const filler = activate(planted.store, {
      attemptId: "attempt-filler", epoch: 7, sessionId: "session-filler", slug: "filler",
    });
    const fillerEvent = planted.store.readEvents(filler.aggregateId)[0];
    if (fillerEvent === undefined) throw new Error("the filler activation committed no event");
    const before = positiveSnapshot(planted.store);
    const horizon = BigInt(CANDIDATES_PAST_THE_OLD_CEILING + 1);
    let served = 0;
    // A WELL-FORMED walk the retired ceilings could never finish: 6,500 real
    // verifiable filler candidates ahead of the ONE match, under a horizon that
    // never moves and a cursor that always names the last served position. A
    // scan that truncated silently would answer NOT_FOUND — a confident wrong
    // answer — and the retired caps refused SCAN_INCOMPLETE here, forever.
    const port = decorate(planted.store, {
      readEventHorizon: (): bigint => horizon,
      readEventsByTypeAfter: (_type: string, after: bigint): CursorPage<StoredEvent, bigint> => {
        if (after >= BigInt(CANDIDATES_PAST_THE_OLD_CEILING)) {
          served += 1;
          return {
            hasMore: false, items: [{ ...planted.event, globalPosition: horizon }],
            nextCursor: horizon,
          };
        }
        const items = Array.from({ length: PAGE_LIMIT }, (_value, index) =>
          ({ ...fillerEvent, globalPosition: after + BigInt(index + 1) }));
        served += items.length;
        return { hasMore: true, items, nextCursor: after + BigInt(PAGE_LIMIT) };
      },
    });

    const answer = readFoundationActivationByAttempt(port, PROJECT_ID, PLANTED_ATTEMPT);

    expect(answer).toEqual({
      activationAggregateId: planted.aggregateId,
      activationDigest: planted.record.activationDigest,
      attemptId: PLANTED_ATTEMPT,
      effectIntentId: "intent-planted",
      epoch: 12,
      ownerSessionRef: "session-planted",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(served).toBeGreaterThan(OLD_SCAN_CEILING);
    expect(snapshot(planted.store)).toEqual(before);
  }, 180_000);

  it("ends a pager that never stops claiming more at the horizon, not a page count", () => {
    const planted = plant("endless-pager");
    const before = positiveSnapshot(planted.store);
    // The synthetic horizon must clear every REAL position: `verifyCandidate`
    // re-reads the planted aggregate and refuses history beyond the horizon.
    expect(planted.store.readEventHorizon()).toBeLessThan(200n);
    let served = 0;
    // ONE real candidate per page, forever: past the retired 64-page ceiling the
    // pager still claims more with a strictly advancing cursor, so nothing but
    // the captured horizon can end this walk. 200 single-row pages against a
    // horizon of 200 is the whole assertion.
    const port = decorate(planted.store, {
      readEventHorizon: (): bigint => 200n,
      readEventsByTypeAfter: (_type: string, after: bigint): CursorPage<StoredEvent, bigint> => {
        served += 1;
        return {
          hasMore: true, items: [{ ...planted.event, globalPosition: after + 1n }],
          nextCursor: after + 1n,
        };
      },
    });

    const missing = readFoundationActivationByAttempt(
      port, PROJECT_ID, "attempt-never-committed");

    expect(missing).toEqual(foundationBindingAbsent("FOUNDATION_BINDING_NOT_FOUND"));
    expect(served).toBe(200);
    expect(served).toBeGreaterThan(OLD_PAGE_CEILING);
    expect(snapshot(planted.store)).toEqual(before);
  }, 60_000);
});

/* -------------------------------------------------------------------------
 * A real second connection committing between horizon capture and the pages.
 * ----------------------------------------------------------------------- */

interface RaceWriter {
  readonly result: Promise<string>;
  readonly started: Promise<void>;
  readonly worker: Worker;
}

/**
 * A REAL concurrent writer, not a scheduled callback: this reader is fully
 * synchronous, so nothing on this isolate's task queue could ever run inside it.
 * The writer opens its own SQLite connection in a worker thread, commits through
 * production ingress, CLOSES ITS HANDLE, and only then releases the parent —
 * which is what keeps the Windows temp-tree cleanup from racing a live file.
 */
function startRaceWriter(
  databasePath: string, gate: SharedArrayBuffer, bytes: Uint8Array,
): RaceWriter {
  const ingressUrl = pathToFileURL(join(import.meta.dirname, "activation-ingress.ts")).href;
  const storeUrl = import.meta.resolve("@moe/store");
  const script = `
    import { parentPort, workerData } from "node:worker_threads";
    import { runEffectActivateCommand } from ${JSON.stringify(ingressUrl)};
    import { SqliteEventStore } from ${JSON.stringify(storeUrl)};
    const { bytes, databasePath, gate, projectId } = workerData;
    const flags = new Int32Array(gate);
    const store = SqliteEventStore.openForProject(databasePath, projectId);
    parentPort.postMessage({ kind: "STARTED" });
    Atomics.wait(flags, 0, 0);
    let detail;
    try {
      const outcome = runEffectActivateCommand(store, bytes);
      detail = outcome.ok ? "COMMITTED" : "REFUSED:" + outcome.code;
    } catch (error) {
      detail = "THREW:" + String(error);
    } finally {
      store.close();
    }
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    parentPort.postMessage({ detail, kind: "RESULT" });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
    execArgv: ["--experimental-strip-types"],
    workerData: { bytes, databasePath, gate, projectId: PROJECT_ID },
  });
  let resolveStarted!: () => void;
  let resolveResult!: (value: string) => void;
  const rejecters: ((error: Error) => void)[] = [];
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejecters.push(reject);
  });
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejecters.push(reject);
  });
  worker.on("message", (message: { detail?: string; kind: string }) => {
    if (message.kind === "STARTED") resolveStarted();
    else if (message.kind === "RESULT") resolveResult(message.detail ?? "MISSING");
  });
  const fail = (error: Error): void => {
    for (const reject of rejecters) reject(error);
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`race writer exited with code ${code}`));
  });
  return { result, started, worker };
}

describe("readFoundationActivationByAttempt refuses a ledger that grew under it", () => {
  it("answers SCAN_INCOMPLETE when a second connection commits past the horizon",
    async () => {
      const store = openStore("race");
      activate(store, {
        attemptId: "attempt-race", epoch: 21, sessionId: "session-race", slug: "race",
      });
      const databasePath = store.getHealth().databasePath;
      if (databasePath === null) throw new Error("this case requires a file-backed store");
      const before = positiveSnapshot(store);
      const gate = new SharedArrayBuffer(8);
      const flags = new Int32Array(gate);
      const writer = startRaceWriter(databasePath, gate, activationBytes({
        attemptId: "attempt-intruder", epoch: 22, sessionId: "session-intruder", slug: "intruder",
      }));
      await writer.started;

      const midway: { value: Snapshot | null } = { value: null };
      const port = decorate(store, {
        readEventHorizon: (): bigint => {
          const horizon = store.readEventHorizon();
          if (midway.value !== null) return horizon;
          Atomics.store(flags, 0, 1);
          Atomics.notify(flags, 0);
          expect(Atomics.wait(flags, 1, 0, 120_000)).not.toBe("timed-out");
          midway.value = snapshot(store);
          return horizon;
        },
      });

      const answer = readFoundationActivationByAttempt(port, PROJECT_ID, "attempt-race");

      expect(await writer.result).toBe("COMMITTED");
      await writer.worker.terminate();
      expectUnknown(answer, "FOUNDATION_BINDING_SCAN_INCOMPLETE");
      // The intruder really landed, and the reader added nothing on top of it.
      expect(midway.value).not.toBeNull();
      expect(midway.value?.events).toBeGreaterThan(before.events);
      expect(snapshot(store)).toEqual(midway.value);
    }, 180_000);
});
