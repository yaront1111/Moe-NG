/**
 * THE MUTATION MATRIX: one arm per refusal branch of the strict reader.
 *
 * WHY A SECOND FILE. `foundation-context-manifest-reader.test.ts` tells the
 * narrative — an accepted read, the headline refusals, invariance, reopen. This
 * file is the exhaustive per-branch sweep, and the two read very differently:
 * mixing them buries the narrative under thirty near-identical arms.
 *
 * WHAT A "MUTATION" IS HERE. Every arm hands the reader an OTHERWISE-VALID
 * durable state with EXACTLY ONE field wrong — the shape a corrupted store row,
 * a partially applied commit, or a hand-edited database actually has. The seam
 * is the narrow read port, because that is precisely where a tampered store
 * differs from an honest one. A drill that deletes a whole proof block must
 * redden a NAMED arm here; that is what this file exists for.
 *
 * EVERY ARM ASSERTS THE EXACT CODE AND THE LAYER. "It refused" is one added
 * guard away from vacuous, and this reader has several layers that can answer.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt,
  EffectsCommittedDecision, StoredEvent,
} from "@moe/store";
import { renderContext, selectContext } from "@moe/context";
import type { ContextRenderManifest } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { deriveFoundationContextRecordDigest } from "./foundation-context-manifest-codec.js";
import type { FoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import {
  deriveFoundationContextAggregateId, deriveFoundationContextDecisionKey,
} from "./foundation-context-manifest-identity.js";
import type {
  FoundationContextSelectionIdentity, FoundationContextSlotIdentity,
} from "./foundation-context-manifest-identity.js";
import { commitFoundationContextManifest } from "./foundation-context-manifest-ledger.js";
import { compareBinding } from "./foundation-context-manifest-proofs.js";
import {
  FOUNDATION_CONTEXT_READER, FOUNDATION_CONTEXT_STRICT_CODES, readFoundationContextManifest,
} from "./foundation-context-manifest-reader.js";
import type {
  FoundationContextReadPort, FoundationContextStrictCode,
} from "./foundation-context-manifest-reader.js";

const PROJECT_ID = "proj-context-reader-0001";
const SESSION_ID = "session-0000000000000001";
const ATTEMPT_REF = "attempt-0000000000000001";

const SLOT: FoundationContextSlotIdentity = Object.freeze({
  attemptRef: ATTEMPT_REF, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

function manifestFor(text: string): ContextRenderManifest {
  const selected = selectContext({
    byteBudget: 4_096, exclusions: [], optional: [],
    mandatory: [{ id: "m-1", section: "brief", content: text, kind: "MANDATORY" }],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`fixture selection refused: ${selected.code}`);
  return renderContext(selected.selection).manifest;
}

const OUTER = Object.freeze({
  configurationDigest: "c".repeat(64), graphContentHash: "a".repeat(64), graphEpoch: 3,
  graphRevisionRef: "graph-revision-1", inputManifestDigest: "d".repeat(64), nodeKey: "dev-c",
});

function candidate(): Record<string, unknown> {
  const fields = { ...OUTER, ...SLOT, manifest: manifestFor("the task") };
  return { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) };
}

function bindingOf(record: FoundationContextManifestRecord): FoundationContextSelectionIdentity {
  return Object.freeze({
    attemptRef: record.attemptRef, configurationDigest: record.configurationDigest,
    graphContentHash: record.graphContentHash, graphEpoch: record.graphEpoch,
    graphRevisionRef: record.graphRevisionRef, inputManifestDigest: record.inputManifestDigest,
    nodeKey: record.nodeKey, projectId: record.projectId, sessionId: record.sessionId,
  });
}

const stores: SqliteEventStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length > 0) {
    try { stores.pop()?.close(); } catch { /* a closed store is the goal */ }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    }
  }
});

function openStore(): SqliteEventStore {
  const directory = mkdtempSync(join(tmpdir(), "moe-context-matrix-"));
  directories.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  stores.push(store);
  return store;
}

function readPort(store: SqliteEventStore): FoundationContextReadPort {
  return {
    getCommandDecision: (key: CommandDecisionKey) => store.getCommandDecision(key),
    getCommandReceipt: (commandId: string) => store.getCommandReceipt(commandId),
    readEvents: (aggregateId: string) => store.readEvents(aggregateId),
  };
}

/** The whole honest durable state, seeded through the LEDGER'S OWN WRITER. */
interface Sealed {
  readonly aggregateId: string;
  readonly binding: FoundationContextSelectionIdentity;
  readonly decision: EffectsCommittedDecision;
  readonly event: StoredEvent;
  readonly port: FoundationContextReadPort;
  readonly receipt: CommandReceipt;
  readonly record: FoundationContextManifestRecord;
  readonly store: SqliteEventStore;
}

function seal(): Sealed {
  const store = openStore();
  const committed = commitFoundationContextManifest(store, {
    candidate: candidate(), decidedAt: "2026-08-19T00:00:00.000Z",
  });
  if (!committed.ok) throw new Error(`fixture commit refused: ${committed.code}`);
  const { record } = committed;
  const aggregateId = deriveFoundationContextAggregateId(record);
  const event = store.readEvents(aggregateId)[0];
  if (event === undefined) throw new Error("fixture wrote no event");
  const decision = store.getCommandDecision(deriveFoundationContextDecisionKey(record));
  // Narrowed, never cast: every mutation below starts from a decision the STORE
  // committed, so an arm can differ from reality only in the field it names.
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("fixture decision did not commit effects");
  }
  const receipt = store.getCommandReceipt(event.commandId);
  if (receipt === null) throw new Error("fixture wrote no receipt");
  return {
    aggregateId, binding: bindingOf(record), decision, event,
    port: readPort(store), receipt, record, store,
  };
}

function traceOf(sealed: Sealed): NonNullable<StoredEvent["decisionTrace"]> {
  const trace = sealed.event.decisionTrace;
  if (trace === undefined) throw new Error("fixture event carries no decision trace");
  return trace;
}

/** Swap exactly one durable witness; every other read stays the store's own. */
function portWith(
  sealed: Sealed,
  patch: {
    decision?: CommandDecisionRecord | null;
    event?: StoredEvent;
    receipt?: CommandReceipt | null;
  },
): FoundationContextReadPort {
  return {
    getCommandDecision: (key: CommandDecisionKey) =>
      (patch.decision === undefined ? sealed.port.getCommandDecision(key) : patch.decision),
    getCommandReceipt: (commandId: string) =>
      (patch.receipt === undefined ? sealed.port.getCommandReceipt(commandId) : patch.receipt),
    readEvents: (aggregateId: string) =>
      (patch.event === undefined ? sealed.port.readEvents(aggregateId) : [patch.event]),
  };
}

function refusalOf(
  port: FoundationContextReadPort,
  slot: FoundationContextSlotIdentity,
  binding: FoundationContextSelectionIdentity,
): { code: FoundationContextStrictCode; layer: string } {
  const result = readFoundationContextManifest(port, slot, binding);
  if (result.ok) throw new Error("expected a refusal, got an accepted read");
  return { code: result.code, layer: result.layer };
}

type Arm = readonly [string, (sealed: Sealed) => FoundationContextReadPort];

const DECISION_ARMS: readonly Arm[] = [
  ["effectDisposition is not EFFECTS_COMMITTED", (s) => portWith(s, {
    // The one cast in this file, and it is the point of the arm: a store row
    // that claims it never committed cannot be produced by a real commit.
    decision: { ...s.decision, effectDisposition: "NO_BUSINESS_EFFECT" } as
      unknown as CommandDecisionRecord,
  })],
  ["a second business event rode along", (s) => portWith(s, {
    decision: { ...s.decision, businessEventIds: [s.event.eventId, "extra-event-1"] },
  })],
  ["the business event is not this event", (s) => portWith(s, {
    decision: { ...s.decision, businessEventIds: ["some-other-event-1"] },
  })],
  ["an outbox message was emitted", (s) => portWith(s, {
    decision: { ...s.decision, outboxMessageIds: ["outbox-1"] },
  })],
  ["expectedVersion is not the pre-context version", (s) => portWith(s, {
    decision: { ...s.decision, expectedVersion: 1 },
  })],
  ["commandKind is not the context seal", (s) => portWith(s, {
    decision: { ...s.decision, commandKind: "foundation.attempt.record" },
  })],
  ["targetAggregateId names another aggregate", (s) => portWith(s, {
    decision: { ...s.decision, targetAggregateId: `${s.aggregateId}-other` },
  })],
  ["resultBytes are not the bytes that were appended", (s) => portWith(s, {
    decision: { ...s.decision, resultBytes: new Uint8Array([1, 2, 3]) },
  })],
  ["requestSha256 disagrees with the event's own decision trace", (s) => portWith(s, {
    decision: { ...s.decision, requestSha256: "f".repeat(64) },
  })],
];

const RECEIPT_ARMS: readonly Arm[] = [
  ["aggregateId names another aggregate", (s) => portWith(s, {
    receipt: { ...s.receipt, aggregateId: `${s.aggregateId}-other` },
  })],
  ["previousVersion is not 0", (s) => portWith(s, {
    receipt: { ...s.receipt, previousVersion: 1 },
  })],
  ["currentVersion is not 1", (s) => portWith(s, {
    receipt: { ...s.receipt, currentVersion: 2 },
  })],
  ["more than one event was appended", (s) => portWith(s, {
    receipt: { ...s.receipt, eventIds: [s.event.eventId, "extra-event-1"] },
  })],
  ["the appended event is not this event", (s) => portWith(s, {
    receipt: { ...s.receipt, eventIds: ["some-other-event-1"] },
  })],
  ["an outbox message was emitted", (s) => portWith(s, {
    receipt: { ...s.receipt, outboxMessageIds: ["outbox-1"] },
  })],
  ["effectSha256 disagrees with the decision", (s) => portWith(s, {
    receipt: { ...s.receipt, effectSha256: "e".repeat(64) },
  })],
  ["commandId is not the command that appended the event", (s) => portWith(s, {
    receipt: { ...s.receipt, commandId: "moe-internal:decision-effect:0000" },
  })],
  ["requestSha256 is not the appending command's", (s) => portWith(s, {
    receipt: { ...s.receipt, requestSha256: "b".repeat(64) },
  })],
];

const EVENT_ARMS: readonly Arm[] = [
  ["aggregateId is not the DERIVED aggregate", (s) => portWith(s, {
    event: { ...s.event, aggregateId: `${s.aggregateId}-other` },
  })],
  ["aggregateSequence is not the first append", (s) => portWith(s, {
    event: { ...s.event, aggregateSequence: 2 },
  })],
  ["eventId is not the DERIVED event id", (s) => portWith(s, {
    event: { ...s.event, eventId: "foundation-context-not-derived-1" },
  })],
  ["domainSchemaVersion is a schema these bytes do not speak", (s) => portWith(s, {
    event: { ...s.event, domainSchemaVersion: "foundation-context-manifest.v0" },
  })],
  ["the decision trace is absent entirely", (s) => {
    const { decisionTrace: _dropped, ...untraced } = s.event;
    return portWith(s, { event: untraced });
  }],
  ["the trace names another command kind", (s) => portWith(s, {
    event: {
      ...s.event, decisionTrace: { ...traceOf(s), commandKind: "foundation.attempt.record" },
    },
  })],
  ["the trace names another command", (s) => portWith(s, {
    event: { ...s.event, decisionTrace: { ...traceOf(s), commandId: "command-other-1" } },
  })],
  ["the trace names another principal (session)", (s) => portWith(s, {
    event: { ...s.event, decisionTrace: { ...traceOf(s), principalId: "principal-other-1" } },
  })],
  ["the trace names another project", (s) => portWith(s, {
    event: { ...s.event, decisionTrace: { ...traceOf(s), projectId: "proj-other-0001" } },
  })],
];

function armSuite(code: FoundationContextStrictCode, arms: readonly Arm[]): void {
  describe(`${code} — one arm per proof branch`, () => {
    // A swept table that silently produced zero cases would pass while
    // asserting nothing, so the sweep's own size is itself an assertion.
    it("sweeps a nonempty table of arms", () => {
      expect(arms.length).toBeGreaterThan(0);
    });

    it("accepts the very same state when nothing is mutated", () => {
      const sealed = seal();

      // The positive control. Without it every arm below could be passing
      // because the FIXTURE is broken, not because a mutation was detected.
      expect(readFoundationContextManifest(sealed.port, SLOT, sealed.binding).ok).toBe(true);
    });

    for (const [name, mutate] of arms) {
      it(`refuses ${code} when ${name}`, () => {
        const sealed = seal();

        expect(refusalOf(mutate(sealed), SLOT, sealed.binding)).toEqual({
          code, layer: FOUNDATION_CONTEXT_READER,
        });
      });
    }
  });
}

armSuite("FOUNDATION_CONTEXT_READER_DECISION_INVALID", DECISION_ARMS);
armSuite("FOUNDATION_CONTEXT_READER_RECEIPT_INVALID", RECEIPT_ARMS);
armSuite("FOUNDATION_CONTEXT_READER_EVENT_INVALID", EVENT_ARMS);

/**
 * DoD 3 names SIX binding fields. Only two were pinned before, and a drill that
 * cut the comparison down to `nodeKey` and `graphEpoch` left the suite green —
 * so each field now gets an arm that mutates that field ALONE.
 *
 * The split into two codes is not cosmetic: the slot-shaped fact of WHICH node
 * this is makes a record FOREIGN, while the graph moving forward under an
 * otherwise identical slot makes it STALE. Collapsing them would let a
 * mis-selected node read as "just retry".
 */
type BindingArm = readonly [
  string, FoundationContextStrictCode,
  (binding: FoundationContextSelectionIdentity) => FoundationContextSelectionIdentity,
];

const BINDING_ARMS: readonly BindingArm[] = [
  ["nodeKey", "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH",
    (b) => ({ ...b, nodeKey: "dev-a" })],
  ["configurationDigest", "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH",
    (b) => ({ ...b, configurationDigest: "9".repeat(64) })],
  ["inputManifestDigest", "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH",
    (b) => ({ ...b, inputManifestDigest: "8".repeat(64) })],
  ["graphRevisionRef", "FOUNDATION_CONTEXT_READER_STALE",
    (b) => ({ ...b, graphRevisionRef: "graph-revision-2" })],
  ["graphContentHash", "FOUNDATION_CONTEXT_READER_STALE",
    (b) => ({ ...b, graphContentHash: "7".repeat(64) })],
  ["graphEpoch", "FOUNDATION_CONTEXT_READER_STALE",
    (b) => ({ ...b, graphEpoch: 4 })],
];

describe("the outer binding — one arm per compared field", () => {
  it("sweeps all six fields DoD 3 names", () => {
    expect(BINDING_ARMS).toHaveLength(6);
  });

  for (const [field, code, mutate] of BINDING_ARMS) {
    it(`answers ${code} when ${field} alone disagrees`, () => {
      const sealed = seal();

      expect(refusalOf(sealed.port, SLOT, mutate(sealed.binding))).toEqual({
        code, layer: FOUNDATION_CONTEXT_READER,
      });
    });
  }

  it("keeps FOREIGN and STALE distinct", () => {
    const sealed = seal();

    const foreign = refusalOf(sealed.port, SLOT, { ...sealed.binding, nodeKey: "dev-a" });
    const stale = refusalOf(sealed.port, SLOT, { ...sealed.binding, graphEpoch: 4 });

    expect(foreign.code).not.toBe(stale.code);
  });
});

/**
 * The SLOT clause of `compareBinding` — project/session/attempt — is asserted
 * against the exported production function directly, and deliberately so.
 *
 * Through the strict reader it is unreachable by construction: the aggregate is
 * DERIVED from those same three fields, so a record naming a different slot is
 * not on the aggregate that was read, and a port that plants one there is caught
 * by the derived-event-id proof first. Deleting the clause would therefore
 * change no end-to-end behaviour today — which is exactly why it needs a direct
 * arm rather than none at all.
 */
describe("compareBinding's slot clause", () => {
  const SLOT_FIELDS = ["attemptRef", "projectId", "sessionId"] as const;

  it("sweeps all three slot fields", () => {
    expect(SLOT_FIELDS).toHaveLength(3);
  });

  for (const field of SLOT_FIELDS) {
    it(`refuses BINDING_MISMATCH when the record's ${field} is not the read slot's`, () => {
      const sealed = seal();

      const verdict = compareBinding(
        sealed.record, { ...SLOT, [field]: "not-this-slot" }, sealed.binding);

      expect(verdict).toBe("FOUNDATION_CONTEXT_READER_BINDING_MISMATCH");
    });
  }

  it("agrees with the honest slot", () => {
    const sealed = seal();

    expect(compareBinding(sealed.record, SLOT, sealed.binding)).toBeNull();
  });
});

/**
 * ROSTER COVERAGE. A frozen roster can outrun its assertions: a code can be
 * added, exported and documented while no test ever reaches it — which is how
 * DECISION_INVALID and RECEIPT_INVALID sat unasserted through a green suite.
 * This sweep runs one arm per roster member and asserts the PRODUCED set equals
 * the ADVERTISED set, so a later insertion of an unreachable code reddens here.
 */
type RosterArm = readonly [FoundationContextStrictCode, () => void];

const ROSTER_ARMS: readonly RosterArm[] = [
  ["FOUNDATION_CONTEXT_READER_ABSENT", (): void => {
    const s = seal();
    expect(refusalOf(s.port, { ...SLOT, attemptRef: "attempt-0000000000000009" }, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_ABSENT");
  }],
  ["FOUNDATION_CONTEXT_READER_AMBIGUOUS", (): void => {
    const s = seal();
    // The one legitimate raw seed: the writer refuses to write this aggregate
    // twice, so the only way to reach the arm is to append underneath it.
    s.store.commit({
      aggregateId: s.aggregateId, commandBytes: new Uint8Array([9]),
      commandId: "foundation-context-duplicate-command-1",
      committedAt: "2026-08-19T00:00:01.000Z",
      events: [{
        domainSchemaVersion: "foundation-context-manifest.v1",
        eventId: "foundation-context-duplicate-1",
        eventType: "foundation.context-manifest.sealed.v1",
        payload: new Uint8Array([1, 2, 3]),
      }],
      expectedVersion: 1,
    });
    expect(refusalOf(s.port, SLOT, s.binding).code).toBe("FOUNDATION_CONTEXT_READER_AMBIGUOUS");
  }],
  ["FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED", (): void => {
    // A LONE FOREIGN-TYPED EVENT on the derived aggregate, committed for real:
    // nothing seals this slot and another producer writes there first. This is
    // the STRICT entry point's own pass-through of the durable reader's code,
    // which no other suite exercises — the ledger's suite covers only the
    // minimal reader called directly.
    const store = openStore();
    store.commit({
      aggregateId: deriveFoundationContextAggregateId(SLOT), commandBytes: new Uint8Array([7]),
      commandId: "foundation-context-foreign-command-1",
      committedAt: "2026-08-19T00:00:02.000Z",
      events: [{
        domainSchemaVersion: "moe-foreign/1", eventId: "foundation-context-foreign-1",
        eventType: "foundation.attempt.recorded.v1", payload: new Uint8Array([1]),
      }],
      expectedVersion: 0,
    });
    expect(refusalOf(readPort(store), SLOT, { ...SLOT, ...OUTER }).code)
      .toBe("FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED");
  }],
  ["FOUNDATION_CONTEXT_READER_UNREADABLE", (): void => {
    const s = seal();
    const throwing: FoundationContextReadPort = {
      ...s.port,
      readEvents: (): readonly StoredEvent[] => {
        throw Object.assign(new Error("store is corrupt"), { code: "STORE_CORRUPT" });
      },
    };
    expect(refusalOf(throwing, SLOT, s.binding).code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
  }],
  ["FOUNDATION_CONTEXT_READER_BINDING_MISMATCH", (): void => {
    const s = seal();
    expect(refusalOf(s.port, SLOT, { ...s.binding, nodeKey: "dev-a" }).code)
      .toBe("FOUNDATION_CONTEXT_READER_BINDING_MISMATCH");
  }],
  ["FOUNDATION_CONTEXT_READER_STALE", (): void => {
    const s = seal();
    expect(refusalOf(s.port, SLOT, { ...s.binding, graphEpoch: 4 }).code)
      .toBe("FOUNDATION_CONTEXT_READER_STALE");
  }],
  ["FOUNDATION_CONTEXT_READER_DECISION_MISSING", (): void => {
    const s = seal();
    expect(refusalOf(portWith(s, { decision: null }), SLOT, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_DECISION_MISSING");
  }],
  ["FOUNDATION_CONTEXT_READER_DECISION_INVALID", (): void => {
    const s = seal();
    const patched = portWith(s, { decision: { ...s.decision, outboxMessageIds: ["outbox-1"] } });
    expect(refusalOf(patched, SLOT, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_DECISION_INVALID");
  }],
  ["FOUNDATION_CONTEXT_READER_RECEIPT_MISSING", (): void => {
    const s = seal();
    expect(refusalOf(portWith(s, { receipt: null }), SLOT, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_RECEIPT_MISSING");
  }],
  ["FOUNDATION_CONTEXT_READER_RECEIPT_INVALID", (): void => {
    const s = seal();
    const patched = portWith(s, { receipt: { ...s.receipt, currentVersion: 2 } });
    expect(refusalOf(patched, SLOT, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_RECEIPT_INVALID");
  }],
  ["FOUNDATION_CONTEXT_READER_EVENT_INVALID", (): void => {
    const s = seal();
    const patched = portWith(s, { event: { ...s.event, aggregateSequence: 2 } });
    expect(refusalOf(patched, SLOT, s.binding).code)
      .toBe("FOUNDATION_CONTEXT_READER_EVENT_INVALID");
  }],
];

describe("the strict roster is exactly what the reader can answer", () => {
  it("advertises no duplicate and no unreachable code", () => {
    const advertised: readonly string[] = [...FOUNDATION_CONTEXT_STRICT_CODES];
    const covered: readonly string[] = ROSTER_ARMS.map(([code]) => code);

    // A duplicate would make the roster's own length a lie, and a member with
    // no arm would be a code the reader advertises but nothing can produce.
    expect(new Set(advertised).size).toBe(advertised.length);
    expect([...new Set(covered)].sort()).toEqual([...advertised].sort());
  });

  for (const [code, arm] of ROSTER_ARMS) {
    it(`${code} is actually produced by the reader`, () => {
      arm();
    });
  }
});
