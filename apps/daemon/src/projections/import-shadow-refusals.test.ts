import { IMPORT_EVENT_FACTS_VERSION } from "@moe/import";
import type { StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import { IMPORT_SHADOW_READ_LAYER, IMPORT_SHADOW_REFUSAL_CODES } from "./import-shadow-contracts.js";
import type { ImportShadowRead, ImportShadowStorePort } from "./import-shadow-contracts.js";
import { readImportShadowProjection } from "./import-shadow-reader.js";
import {
  DIGEST,
  aggregateOf,
  bytesOf,
  capturedCommit,
  commitRaw,
  payloadObjectOf,
  recordOf,
  seedImport,
  withPayload,
  withStore,
} from "./import-shadow-test-fixtures.js";

/**
 * The refusal matrix.
 *
 * WHICH LAYER ANSWERED IS ITSELF AN ASSERTION. Two layers can refuse here: `@moe/import`'s
 * decoder at its own `DECODE` layer, and this adapter at `DAEMON_IMPORT_SHADOW`. A test that
 * only checked `ok === false` would stay green if the daemon started answering first and
 * swallowed the decoder's finer diagnosis — malformed bytes would become indistinguishable
 * from an unsupported schema and nothing would notice. Every case below therefore pins the
 * exact code AND the exact layer, and asserts no partial projection escaped.
 *
 * Hostile rows are built by capturing the commit PRODUCTION `applyImport` would have made and
 * mutating ONE thing, so each refusal is evidence about that one mutation rather than about a
 * payload invented from scratch.
 */

/**
 * A CLOSED roster, so a code added without an emitter and a case cannot slip in. Every member
 * below is asserted reachable somewhere in this file or in the reader/compare suites.
 */
describe("import shadow reader — the declared refusal vocabulary", () => {
  it("declares exactly the nine codes this adapter can answer with", () => {
    expect([...IMPORT_SHADOW_REFUSAL_CODES]).toEqual([
      "IMPORT_SHADOW_ABSENT",
      "IMPORT_SHADOW_BINDING_MISMATCH",
      "IMPORT_SHADOW_EVENT_UNSUPPORTED",
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      "IMPORT_SHADOW_HORIZON_DRIFT",
      "IMPORT_SHADOW_INPUT_INVALID",
      "IMPORT_SHADOW_LEGACY_UNREADABLE",
      "IMPORT_SHADOW_SCHEMA_UNSUPPORTED",
      "IMPORT_SHADOW_STORE_UNREADABLE",
    ]);
    expect(Object.isFrozen(IMPORT_SHADOW_REFUSAL_CODES)).toBe(true);
  });
});

function refused(read: ImportShadowRead): Extract<ImportShadowRead, { ok: false }> {
  if (read.ok) throw new Error("expected a refusal, got a projection");
  expect(Object.hasOwn(read, "projection")).toBe(false);
  expect(Object.hasOwn(read, "entities")).toBe(false);
  expect(read.advisoryOnly).toBe(true);
  expect(read.authority).toBe("NONE");
  return read;
}

/** A port that serves the real store's rows after one doctoring pass. */
function portOver(
  store: ImportShadowStorePort,
  over: Partial<ImportShadowStorePort>,
): ImportShadowStorePort {
  return {
    readEventHorizon: over.readEventHorizon ?? (() => store.readEventHorizon()),
    readEvents: over.readEvents ?? ((aggregateId) => store.readEvents(aggregateId)),
  };
}

describe("import shadow reader — upstream decoder refusals keep their own code and layer", () => {
  const upstream: readonly (readonly [string, string, (payload: Record<string, unknown>) => Uint8Array])[] = [
    ["truncated bytes", "IMPORT_EVENT_BYTES_MALFORMED", (facts) => bytesOf(facts).slice(0, 12)],
    [
      "noncanonical key order",
      "IMPORT_EVENT_BYTES_NONCANONICAL",
      (facts) => bytesOf(Object.fromEntries(Object.entries(facts).reverse())),
    ],
    [
      "a missing declared key",
      "IMPORT_EVENT_FACTS_INCOMPLETE",
      (facts) => bytesOf(Object.fromEntries(Object.entries(facts).filter(([key]) => key !== "payload"))),
    ],
    [
      "an undeclared key",
      "IMPORT_EVENT_FACTS_UNKNOWN_FIELD",
      (facts) => bytesOf({ ...facts, smuggled: "x" }),
    ],
    [
      "an unsupported facts schema",
      "IMPORT_EVENT_SCHEMA_UNSUPPORTED",
      (facts) => bytesOf({ ...facts, schemaVersion: "moe-import-event-facts/99" }),
    ],
    [
      "a conflicting record version",
      "IMPORT_EVENT_SCHEMA_CONFLICT",
      (facts) => bytesOf({ ...facts, recordVersion: "moe-import-record/99" }),
    ],
  ];

  it("generates every declared upstream case", () => {
    expect(upstream.length).toBe(6);
  });

  it.each(upstream)("refuses %s as %s at the DECODE layer", (_name, code, corrupt) => {
    withStore((store) => {
      const captured = capturedCommit(DIGEST, [recordOf()]);
      commitRaw(store, withPayload(captured, corrupt(payloadObjectOf(captured))));
      const read = refused(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      expect(read.code).toBe(code);
      // The decoder's OWN layer, not the daemon's. A daemon layer here would mean the
      // adapter restamped an upstream diagnosis into a coarser local one.
      expect(read.layer).toBe("DECODE");
      expect(read.layer).not.toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });
});

describe("import shadow reader — daemon-local refusals", () => {
  it("refuses an event type outside the legacy.<kind>.imported shape", () => {
    withStore((store) => {
      const captured = capturedCommit(DIGEST, [recordOf()]);
      const [first] = captured.events;
      if (first === undefined) throw new Error("no event captured");
      commitRaw(store, { ...captured, events: [{ ...first, eventType: "board.task.created" }] });
      const read = refused(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      expect(read.code).toBe("IMPORT_SHADOW_EVENT_UNSUPPORTED");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  it("refuses an envelope domainSchemaVersion that is not the payload's own", () => {
    withStore((store) => {
      const captured = capturedCommit(DIGEST, [recordOf()]);
      const [first] = captured.events;
      if (first === undefined) throw new Error("no event captured");
      expect(first.domainSchemaVersion).toBe(IMPORT_EVENT_FACTS_VERSION);
      // The cast is load-bearing and honest. `ImportEventDraft.domainSchemaVersion` is the
      // LITERAL type, so no production writer can stamp a wrong envelope — but the store
      // column is a plain string, and an older or foreign writer can put anything in it. The
      // guard under test exists for exactly those rows, so the case has to reach past the
      // type to plant one.
      commitRaw(store, {
        ...captured,
        events: [{
          ...first,
          domainSchemaVersion: "moe-domain-schema/0" as unknown as typeof IMPORT_EVENT_FACTS_VERSION,
        }],
      });
      const read = refused(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      expect(read.code).toBe("IMPORT_SHADOW_SCHEMA_UNSUPPORTED");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  it("refuses a row whose provenance names another import", () => {
    withStore((store) => {
      const foreign = capturedCommit("e".repeat(64), [recordOf()]);
      commitRaw(store, { ...foreign, aggregateId: aggregateOf(DIGEST) });
      const read = refused(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      expect(read.code).toBe("IMPORT_SHADOW_BINDING_MISMATCH");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  it("refuses a sequence hole rather than reconstructing across it", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [
        recordOf(),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const holed = portOver(store, {
        readEvents: (aggregateId) => store.readEvents(aggregateId)
          .map((event: StoredEvent) => ({ ...event, aggregateSequence: event.aggregateSequence + 1 })),
      });
      const read = refused(readImportShadowProjection(holed, { manifestDigest: DIGEST }));

      expect(read.code).toBe("IMPORT_SHADOW_EVIDENCE_MALFORMED");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  it("refuses a horizon that moved during the read rather than mixing two states", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      let reads = 0;
      const drifting = portOver(store, {
        readEventHorizon: () => {
          reads += 1;
          return store.readEventHorizon() + BigInt(reads - 1);
        },
      });
      const read = refused(readImportShadowProjection(drifting, { manifestDigest: DIGEST }));

      expect(reads).toBe(2);
      expect(read.code).toBe("IMPORT_SHADOW_HORIZON_DRIFT");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  it("refuses an unreadable store rather than letting the throw escape", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const broken = portOver(store, {
        readEvents: () => { throw new Error("STORE_CORRUPT: page checksum mismatch"); },
      });
      const read = refused(readImportShadowProjection(broken, { manifestDigest: DIGEST }));

      expect(read.code).toBe("IMPORT_SHADOW_STORE_UNREADABLE");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(read.detail).toContain("STORE_CORRUPT: page checksum mismatch");
    });
  });
});

/**
 * The generated sweep. `cases.length` is asserted BEFORE any outcome: a sweep that silently
 * generates zero cases passes while testing nothing.
 */
describe("import shadow reader — generated hostile sweep", () => {
  const digests: readonly (readonly [string, unknown, string])[] = [
    ["empty", "", "IMPORT_SHADOW_INPUT_INVALID"],
    ["non-string null", null, "IMPORT_SHADOW_INPUT_INVALID"],
    ["non-string number", 12, "IMPORT_SHADOW_INPUT_INVALID"],
    ["non-string object", { toString: () => DIGEST }, "IMPORT_SHADOW_INPUT_INVALID"],
    ["oversized", "a".repeat(4096), "IMPORT_SHADOW_INPUT_INVALID"],
    ["non-NFC", `${"a".repeat(63)}́`, "IMPORT_SHADOW_INPUT_INVALID"],
    ["path-shaped", "../../../etc/passwd", "IMPORT_SHADOW_INPUT_INVALID"],
    ["__proto__", "__proto__", "IMPORT_SHADOW_INPUT_INVALID"],
    ["uppercase hex", "A".repeat(64), "IMPORT_SHADOW_INPUT_INVALID"],
    ["NUL-bearing", `${"a".repeat(63)} `, "IMPORT_SHADOW_INPUT_INVALID"],
    ["well-formed but unseeded", "f".repeat(64), "IMPORT_SHADOW_ABSENT"],
  ];

  it("generates a nonempty case set", () => {
    expect(digests.length).toBeGreaterThan(0);
    expect(digests.length).toBe(11);
  });

  it.each(digests)("refuses the %s manifestDigest as %s", (_name, digest, code) => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const read = refused(readImportShadowProjection(
        store,
        { manifestDigest: digest as string },
      ));

      expect(read.code).toBe(code);
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });

  const ports: readonly (readonly [string, string, Partial<ImportShadowStorePort>])[] = [
    [
      "a throwing readEvents",
      "IMPORT_SHADOW_STORE_UNREADABLE",
      { readEvents: () => { throw new Error("readEvents exploded"); } },
    ],
    [
      "a throwing readEventHorizon",
      "IMPORT_SHADOW_STORE_UNREADABLE",
      { readEventHorizon: () => { throw new Error("readEventHorizon exploded"); } },
    ],
    [
      "a readEvents answering with a non-list",
      "IMPORT_SHADOW_STORE_UNREADABLE",
      { readEvents: () => undefined as unknown as readonly StoredEvent[] },
    ],
    [
      "a list carrying a null row",
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      { readEvents: () => [null] as unknown as readonly StoredEvent[] },
    ],
    [
      "a row whose aggregateSequence is not a number",
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      {
        readEvents: () => [{ aggregateSequence: "1" }] as unknown as readonly StoredEvent[],
      },
    ],
    [
      "a row with a throwing eventType accessor",
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      {
        readEvents: () => [Object.defineProperty(
          { aggregateSequence: 1 },
          "eventType",
          { get: () => { throw new Error("accessor exploded"); } },
        )] as unknown as readonly StoredEvent[],
      },
    ],
  ];

  it("generates a nonempty port case set", () => {
    expect(ports.length).toBeGreaterThan(0);
    expect(ports.length).toBe(6);
  });

  it.each(ports)("refuses %s as %s rather than throwing", (_name, code, over) => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const read = refused(readImportShadowProjection(portOver(store, over), { manifestDigest: DIGEST }));

      expect(read.code).toBe(code);
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });
});
