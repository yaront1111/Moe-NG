/**
 * Durable commit tests for the provider-run telemetry ledger.
 *
 * WHY A REAL `SqliteEventStore` AND NOT A FAKE. The property under test on the
 * replay paths IS the store's own replay identity — `identifyExpectedVersionRequest`
 * hashes the key, commandKind, targetAggregateId, expectedVersion and requestBytes
 * and NOT the events array. A fake would reimplement exactly the thing being
 * checked, so every replay case below drives an unmodified store.
 *
 * THE ONE PLACE THE PORT IS INSTRUMENTED, and why it has to be. Corrupt durable
 * bytes are unreachable through any real sequence: the only writer that can leave
 * an event under a REPLAYABLE decision is this ledger itself, and it only ever
 * writes codec-sealed bytes. So the four read-back cases plant durable events
 * through `plantedRead`, which delegates `commitExpectedVersionDecision` and
 * `getCommandDecision` to the REAL store and overrides `readEvents` alone. Commit
 * and decision authority stay real; only the bytes the reader finds are chosen.
 * The ambiguity case does NOT need it — a second event is appended through the
 * real store's own `commit`.
 *
 * Every store is opened inside its `it` and closed in a `finally`: a handle held
 * into teardown kills the vitest worker outright.
 */

import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import { decodeProviderRunRecord, encodeProviderRunRecord } from "./provider-run-codec.js";
import {
  PROVIDER_RUN_COMMAND_KIND,
  PROVIDER_RUN_EVENT_TYPE,
  PROVIDER_RUN_RECORD_VERSION,
  deriveProviderRunAggregateId,
} from "./provider-run-contracts.js";
import type { ProviderRunRecord, ProviderRunStore } from "./provider-run-contracts.js";
import {
  commitProviderRunRecord,
  deriveProviderRunEventId,
} from "./provider-run-ledger.js";
import type { ProviderRunCommitInput, ProviderRunCommitResult } from "./provider-run-ledger.js";
import { PROVIDER_RUN_LEDGER_CODES, PROVIDER_RUN_LEDGER_LAYERS } from "./provider-run-refusals.js";
import type { ProviderRunRefusal } from "./provider-run-refusals.js";

const PROJECT_ID = "provider-run-ledger-project";

/** Every provider fact in the fixture is an honest blind, which is a legal run. */
const blind: ProviderFactUnknown = {
  known: false,
  code: "TELEMETRY_USAGE_ABSENT",
  layer: "TELEMETRY_RESULT",
};

const REF: ProviderRunRef = {
  provider: "claude",
  runRef: "run-1",
  effectIntentId: "effect-1",
  attemptRef: "attempt-1",
  epoch: 1,
};

const record = (overrides: Partial<ProviderRunRecord> = {}): ProviderRunRecord => ({
  recordVersion: PROVIDER_RUN_RECORD_VERSION,
  providerRunRef: REF,
  launch: {
    kind: "REFUSED",
    truthClass: "UNKNOWN",
    reasonCode: null,
    reasonLayer: null,
    exit: null,
    effectDigest: null,
    activationDigest: null,
    runtimeBindingDigest: null,
    quotedRuntimeDigest: null,
    freshRuntimeDigest: null,
    pinnedClosureDigest: null,
    observationDigest: null,
    startedAt: null,
    completedAt: null,
  },
  declared: blind,
  observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
  terminal: "UNKNOWN",
  infrastructure: "EXIT_UNOBSERVED",
  tokens: {
    inputTokens: blind,
    outputTokens: blind,
    cacheCreationInputTokens: blind,
    cacheReadInputTokens: blind,
    coverage: "UNKNOWN",
  },
  steps: { turns: blind, coverage: "UNKNOWN" },
  sequence: { known: true, value: 3 },
  concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: null,
  usage: [],
  usageRefusals: [],
  upstreamRefusal: null,
  stdoutReceiptDigest: blind,
  stderrReceiptDigest: blind,
  recordDigest: "",
  ...overrides,
});

/**
 * Same run identity, materially different body. Same `providerRunRef` means the
 * SAME derived aggregate, so this is the drift the store's replay identity is
 * blind to rather than a different run.
 */
const drifted = (): ProviderRunRecord => record({ sequence: { known: true, value: 9 } });

const KEY: CommandDecisionKey = {
  commandId: "command-1",
  principalId: "principal-1",
  projectId: PROJECT_ID,
};

const REQUEST_BYTES = new TextEncoder().encode("provider-run-request-1");

const input = (overrides: Partial<ProviderRunCommitInput> = {}): ProviderRunCommitInput => ({
  correlationId: "correlation-1",
  decidedAt: "2026-01-01T00:00:00.000Z",
  key: KEY,
  record: record(),
  requestBytes: REQUEST_BYTES,
  ...overrides,
});

function refused(result: ProviderRunCommitResult): ProviderRunRefusal {
  if (result.ok) throw new Error("expected a refusal, but the ledger accepted the commit");
  return result;
}

function accepted(result: ProviderRunCommitResult): Extract<ProviderRunCommitResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a commit, got ${result.code} at ${result.layer}`);
  return result;
}

function sealed(value: ProviderRunRecord): { bytes: Uint8Array; digest: string } {
  const encoded = encodeProviderRunRecord(value);
  if (!encoded.ok) throw new Error(`fixture must encode, got ${encoded.code}`);
  return { bytes: encoded.bytes, digest: encoded.digest };
}

/**
 * A port whose commit and decision surface is the REAL store and whose
 * `readEvents` answers with planted durable bytes. See the module note: no real
 * sequence can place corrupt bytes under a replayable decision.
 */
function plantedRead(store: SqliteEventStore, events: readonly StoredEvent[]): ProviderRunStore {
  return {
    commitExpectedVersionDecision: (value) => store.commitExpectedVersionDecision(value),
    getCommandDecision: (key) => store.getCommandDecision(key),
    readEvents: () => events,
  };
}

/** A durable event carrying exactly the bytes a case wants the reader to find. */
function plantedEvent(payload: Uint8Array, eventType: string = PROVIDER_RUN_EVENT_TYPE): StoredEvent {
  return {
    aggregateId: deriveProviderRunAggregateId(REF),
    aggregateSequence: 1,
    commandId: KEY.commandId,
    committedAt: "2026-01-01T00:00:00.000Z",
    domainSchemaVersion: "1",
    eventId: deriveProviderRunEventId(REF),
    eventType,
    globalPosition: 1n,
    metadata: new Uint8Array(0),
    payload,
    payloadCodecVersion: "opaque/1",
    recordVersion: "moe-event-record/1",
    requestSha256: "0".repeat(64),
  } as unknown as StoredEvent;
}

function openStore(): SqliteEventStore {
  return SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
}

describe("commitProviderRunRecord — first commit", () => {
  it("commits one content-bound event on the derived aggregate and answers COMMITTED", () => {
    const store = openStore();
    try {
      const result = accepted(commitProviderRunRecord(store, input()));
      const expected = sealed(record());

      expect(result.disposition).toBe("COMMITTED");
      expect(result.aggregateId).toBe(deriveProviderRunAggregateId(REF));
      expect(result.digest).toBe(expected.digest);
      expect(result.record.recordDigest).toBe(expected.digest);

      const events = store.readEvents(result.aggregateId);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(PROVIDER_RUN_EVENT_TYPE);
      expect(new Uint8Array(events[0]?.payload ?? new Uint8Array())).toStrictEqual(expected.bytes);
    } finally {
      store.close();
    }
  });

  /**
   * THE BINDING ASSERTION the identity promotion exists for. Every read below comes
   * from the STORE, never from `input()` or from the returned result: an assertion
   * against the writer's own argument echoes whatever the writer sent and stays green
   * however far the durable kind drifts. The expected value is IMPORTED, never retyped
   * here -- a test literal would be a second owner of the command identity, which is
   * exactly what promoting the constant is meant to prevent.
   */
  it("binds the exported command kind onto every durable artifact of the commit", () => {
    const store = openStore();
    try {
      const result = accepted(commitProviderRunRecord(store, input()));

      const events = store.readEvents(result.aggregateId);
      expect(events).toHaveLength(1);
      expect(events[0]?.decisionTrace?.commandKind).toBe(PROVIDER_RUN_COMMAND_KIND);

      const decision = store.getCommandDecision(KEY);
      expect(decision?.commandKind).toBe(PROVIDER_RUN_COMMAND_KIND);

      // The decision's own committed-effect record NAMES the event it sealed, and that
      // event's trace is then read back and compared. Going through the effect record
      // rather than trusting index 0 is what makes this a third INDEPENDENT binding
      // instead of a restatement of the first assertion.
      //
      // `getCommandReceipt` is deliberately not used: it is addressed by an INTERNAL
      // derived id (`internalReceiptCommandId(decisionId)`), not by the caller's
      // `commandId`, and that derivation is not exported from the store package. A test
      // that rebuilt the string would be reimplementing store authority inside the test.
      expect(decision?.businessEventIds).toHaveLength(1);
      const sealedId = decision?.businessEventIds[0];
      const named = events.find((event: StoredEvent) => event.eventId === sealedId);
      expect(named?.decisionTrace?.commandKind).toBe(PROVIDER_RUN_COMMAND_KIND);
    } finally {
      store.close();
    }
  });

  it("mints no digest of its own — the durable digest is the codec's", () => {
    const store = openStore();
    try {
      // A caller-supplied digest is outside the codec's digest domain, so it must
      // not survive into the durable bytes and must not change them.
      const result = accepted(
        commitProviderRunRecord(store, input({ record: record({ recordDigest: "f".repeat(64) }) })),
      );
      expect(result.digest).toBe(sealed(record()).digest);
      expect(result.record.recordDigest).toBe(sealed(record()).digest);
    } finally {
      store.close();
    }
  });

  /**
   * One aggregate per run is what makes expectedVersion 0 a conflict check rather
   * than a blanket "only one run ever". Without this, a derivation that collapsed
   * every run onto a constant identity would still pass every single-run case.
   */
  it("keeps two distinct runs on separate aggregates, each committing at version 0", () => {
    const store = openStore();
    try {
      const second = record({ providerRunRef: { ...REF, attemptRef: "attempt-2" } });
      const first = accepted(commitProviderRunRecord(store, input()));
      const other = accepted(
        commitProviderRunRecord(
          store,
          input({ key: { ...KEY, commandId: "command-2" }, record: second }),
        ),
      );

      expect(other.disposition).toBe("COMMITTED");
      expect(other.aggregateId).not.toBe(first.aggregateId);
      expect(store.readEvents(first.aggregateId)).toHaveLength(1);
      expect(store.readEvents(other.aggregateId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("derives the event id deterministically from the run identity, never the digest", () => {
    const store = openStore();
    try {
      const first = deriveProviderRunEventId(REF);
      expect(deriveProviderRunEventId({ ...REF })).toBe(first);
      // Content-addressing would collide two distinct runs with identical bodies.
      expect(first).not.toBe(sealed(record()).digest);
      // A different run identity is a different event id.
      expect(deriveProviderRunEventId({ ...REF, attemptRef: "attempt-2" })).not.toBe(first);

      const result = accepted(commitProviderRunRecord(store, input()));
      expect(store.readEvents(result.aggregateId)[0]?.eventId).toBe(first);
    } finally {
      store.close();
    }
  });
});

describe("commitProviderRunRecord — replay", () => {
  it("answers an identical replay with the STORED record read back from the aggregate", () => {
    const store = openStore();
    try {
      const first = accepted(commitProviderRunRecord(store, input()));
      const replay = accepted(commitProviderRunRecord(store, input()));

      expect(replay.disposition).toBe("REPLAYED");
      expect(replay.digest).toBe(first.digest);
      // The answer must be the DURABLE bytes decoded, so it matches the event.
      const durable = store.readEvents(replay.aggregateId)[0]?.payload ?? new Uint8Array();
      expect(new Uint8Array(durable)).toStrictEqual(sealed(record()).bytes);
      expect(replay.record.recordDigest).toBe(first.digest);
      expect(store.readEvents(replay.aggregateId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("leaves the durable command kind untouched when an identical commit replays", () => {
    const store = openStore();
    try {
      accepted(commitProviderRunRecord(store, input()));
      const replay = accepted(commitProviderRunRecord(store, input()));
      expect(replay.disposition).toBe("REPLAYED");

      // A replay seals no second decision, so the kind on the durable artifacts is
      // still the one the FIRST commit wrote -- read back, not echoed.
      const events = store.readEvents(replay.aggregateId);
      expect(events).toHaveLength(1);
      expect(events[0]?.decisionTrace?.commandKind).toBe(PROVIDER_RUN_COMMAND_KIND);
      expect(store.getCommandDecision(KEY)?.commandKind).toBe(PROVIDER_RUN_COMMAND_KIND);
    } finally {
      store.close();
    }
  });

  /**
   * THE REPLAY-ECHO KILLER. Cited by the step-5 drill by this exact name.
   *
   * The store's replay identity does not cover the events array, so the same key
   * and the same requestBytes carrying a DIFFERENT record replay cleanly at the
   * store while describing a run nobody committed. An implementation that echoes
   * the caller's record on REPLAYED returns ok here and every other assertion in
   * this file still passes.
   */
  it("refuses a replay whose record drifted, and leaves the durable bytes untouched", () => {
    const store = openStore();
    try {
      const first = accepted(commitProviderRunRecord(store, input()));
      const result = refused(commitProviderRunRecord(store, input({ record: drifted() })));

      expect(result.outcome).toBe("REFUSED");
      expect(result.code).toBe("PROVIDER_RUN_REPLAY_DIVERGED");
      expect(result.layer).toBe("PROVIDER_RUN_LEDGER");
      // No store call refused, so there is no store code to preserve.
      expect(result.storeCode).toBeNull();

      const events = store.readEvents(first.aggregateId);
      expect(events).toHaveLength(1);
      expect(new Uint8Array(events[0]?.payload ?? new Uint8Array())).toStrictEqual(
        sealed(record()).bytes,
      );
      expect(sealed(drifted()).digest).not.toBe(first.digest);
    } finally {
      store.close();
    }
  });

  it("reads past a foreign event type on the aggregate rather than calling it ambiguous", () => {
    const store = openStore();
    try {
      const first = accepted(commitProviderRunRecord(store, input()));
      store.commit({
        aggregateId: first.aggregateId,
        commandBytes: new TextEncoder().encode("foreign-command"),
        commandId: "foreign-command-1",
        committedAt: "2026-01-01T00:00:01.000Z",
        events: [
          {
            eventId: "foreign-event-1",
            eventType: "SomeOtherThingHappened",
            payload: new TextEncoder().encode("not a provider run"),
          },
        ],
        expectedVersion: 1,
      });

      const replay = accepted(commitProviderRunRecord(store, input()));
      expect(replay.disposition).toBe("REPLAYED");
      expect(replay.digest).toBe(first.digest);
    } finally {
      store.close();
    }
  });

  it("refuses as AMBIGUOUS when a second provider-run event shares the aggregate", () => {
    const store = openStore();
    try {
      const first = accepted(commitProviderRunRecord(store, input()));
      store.commit({
        aggregateId: first.aggregateId,
        commandBytes: new TextEncoder().encode("second-command"),
        commandId: "second-command-1",
        committedAt: "2026-01-01T00:00:01.000Z",
        events: [
          {
            eventId: "provider-run-duplicate-1",
            eventType: PROVIDER_RUN_EVENT_TYPE,
            payload: sealed(drifted()).bytes,
          },
        ],
        expectedVersion: 1,
      });

      const result = refused(commitProviderRunRecord(store, input()));
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.code).toBe("PROVIDER_RUN_EVIDENCE_AMBIGUOUS");
      expect(result.layer).toBe("PROVIDER_RUN_READER");
    } finally {
      store.close();
    }
  });
});

describe("commitProviderRunRecord — unreadable durable evidence", () => {
  const UNREADABLE = [
    {
      name: "malformed",
      codecCode: "PROVIDER_RUN_BYTES_MALFORMED",
      payload: () => new TextEncoder().encode("{not json at all"),
    },
    {
      // Shares the codec code with `malformed`, and that is the honest result
      // rather than a weaker test: a truncated frame IS a framing failure. The
      // per-fixture assertion below records that instead of implying three
      // distinct reasons where the codec only has two.
      name: "truncated",
      codecCode: "PROVIDER_RUN_BYTES_MALFORMED",
      payload: () => sealed(record()).bytes.subarray(0, 40),
    },
    {
      // An authentic frame whose trailing digest has been swapped for another
      // valid-looking one: it survives framing and refuses on the digest, which
      // is what makes it a genuinely different failure from the two above.
      name: "digest-mismatched",
      codecCode: "PROVIDER_RUN_DIGEST_MISMATCH",
      payload: () => {
        const bytes = Uint8Array.from(sealed(record()).bytes);
        bytes.set(new TextEncoder().encode("a".repeat(64)), bytes.byteLength - 64);
        return bytes;
      },
    },
  ] as const;

  expect(UNREADABLE.length, "the unreadable sweep must generate cases").toBe(3);

  /**
   * The ledger deliberately collapses all three to RECORD_UNREADABLE, so the
   * codec is the ONLY place their difference is observable. Without this the
   * sweep below could be one failure wearing three names — which is what a first
   * draft of it actually was, until this assertion said so.
   */
  it("refuses each unreadable fixture at the codec with its own recorded code", () => {
    const codes = UNREADABLE.map((durable) => {
      const decoded = decodeProviderRunRecord(durable.payload());
      if (decoded.ok) throw new Error(`${durable.name} must not decode`);
      expect(decoded.layer, durable.name).toBe("PROVIDER_RUN_CODEC");
      expect(decoded.code, durable.name).toBe(durable.codecCode);
      return decoded.code;
    });
    // Two, not three: truncation and garbage both fail framing. Pinned so that a
    // fixture drifting onto an already-covered path shows up here.
    expect(new Set(codes).size, "the sweep must cover more than one codec path").toBe(2);
  });

  for (const durable of UNREADABLE) {
    it(`answers UNKNOWN for ${durable.name} durable bytes without gaining authority`, () => {
      const store = openStore();
      try {
        accepted(commitProviderRunRecord(store, input()));
        const port = plantedRead(store, [plantedEvent(durable.payload())]);

        const result = refused(commitProviderRunRecord(port, input()));
        expect(result.outcome).toBe("UNKNOWN");
        expect(result.code).toBe("PROVIDER_RUN_RECORD_UNREADABLE");
        expect(result.layer).toBe("PROVIDER_RUN_READER");
        expect(result.storeCode).toBeNull();
      } finally {
        store.close();
      }
    });
  }

  it("answers ABSENT when the replayed aggregate carries no provider-run event", () => {
    const store = openStore();
    try {
      accepted(commitProviderRunRecord(store, input()));
      const port = plantedRead(store, []);

      const result = refused(commitProviderRunRecord(port, input()));
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.code).toBe("PROVIDER_RUN_EVIDENCE_ABSENT");
      expect(result.layer).toBe("PROVIDER_RUN_READER");
    } finally {
      store.close();
    }
  });

  it("answers EVENT_TYPE_UNEXPECTED when the only event on the aggregate is foreign", () => {
    const store = openStore();
    try {
      accepted(commitProviderRunRecord(store, input()));
      const port = plantedRead(store, [
        plantedEvent(sealed(record()).bytes, "SomeOtherThingHappened"),
      ]);

      const result = refused(commitProviderRunRecord(port, input()));
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.code).toBe("PROVIDER_RUN_EVENT_TYPE_UNEXPECTED");
      expect(result.layer).toBe("PROVIDER_RUN_READER");
    } finally {
      store.close();
    }
  });
});

describe("commitProviderRunRecord — refusals from other authorities", () => {
  /**
   * A DISTINCT command against a run that already committed. The aggregate head
   * is at version 1 and this ledger pins expectedVersion 0, so the STORE decides
   * it. The assertion pins WHICH constraint answered: the expected-version check
   * returns a NO_BUSINESS_EFFECT decision before `domain_events.event_id`
   * uniqueness is ever consulted.
   */
  it("is rejected on the aggregate head, keeping the store's own code verbatim", () => {
    const store = openStore();
    try {
      accepted(commitProviderRunRecord(store, input()));
      const result = refused(
        commitProviderRunRecord(
          store,
          input({ key: { ...KEY, commandId: "command-2" }, record: drifted() }),
        ),
      );

      expect(result.outcome).toBe("REFUSED");
      expect(result.code).toBe("PROVIDER_RUN_EXPECTED_VERSION_CONFLICT");
      expect(result.layer).toBe("PROVIDER_RUN_LEDGER");
      // Flattened into the ledger code, a conflict and a reused event id would be
      // the same fact. They are not.
      expect(result.storeCode).toBe("EXPECTED_VERSION_CONFLICT");
      expect(store.readEvents(deriveProviderRunAggregateId(REF))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("returns a codec refusal unchanged rather than re-wrapping which layer refused", () => {
    const store = openStore();
    try {
      const result = refused(
        commitProviderRunRecord(store, input({ record: { not: "a record" } as never })),
      );

      expect(result.outcome).toBe("REFUSED");
      expect(result.code).toBe("PROVIDER_RUN_RECORD_MALFORMED");
      expect(result.layer).toBe("PROVIDER_RUN_CODEC");
      expect(store.readEvents(deriveProviderRunAggregateId(REF))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("surfaces a thrown store error as a refusal carrying the store's code", () => {
    const store = openStore();
    try {
      store.close();
      const result = refused(commitProviderRunRecord(store, input()));

      expect(result.outcome).toBe("REFUSED");
      expect(result.code).toBe("PROVIDER_RUN_STORE_UNAVAILABLE");
      expect(result.layer).toBe("PROVIDER_RUN_LEDGER");
      expect(result.storeCode).toBe("STORE_CLOSED");
    } finally {
      // Closing twice is the documented idempotent path; the finally stays so no
      // exit path can leak a handle into teardown.
      store.close();
    }
  });
});

describe("provider-run ledger vocabulary", () => {
  it("uses only codes and layers the frozen vocabulary declares", () => {
    const used = [
      "PROVIDER_RUN_REPLAY_DIVERGED",
      "PROVIDER_RUN_EVIDENCE_AMBIGUOUS",
      "PROVIDER_RUN_EVIDENCE_ABSENT",
      "PROVIDER_RUN_EVENT_TYPE_UNEXPECTED",
      "PROVIDER_RUN_RECORD_UNREADABLE",
      "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT",
      "PROVIDER_RUN_STORE_UNAVAILABLE",
    ] as const;
    expect(used.length, "the vocabulary sweep must generate cases").toBe(7);
    for (const code of used) expect(PROVIDER_RUN_LEDGER_CODES).toContain(code);
    for (const layer of ["PROVIDER_RUN_LEDGER", "PROVIDER_RUN_READER"] as const) {
      expect(PROVIDER_RUN_LEDGER_LAYERS).toContain(layer);
    }
  });
});
