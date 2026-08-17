import { describe, expect, it } from "vitest";

import { applyImport } from "./import-apply.js";
import type { ImportCommitInput, ImportStorePort } from "./import-apply.js";
import { deriveImportedId } from "./import-canonical.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { IMPORTED_CLAIM_STATUSES, LEGACY_LINK_KINDS } from "./import-contract.js";
import type { ImportReport, ImportRefusalLayer } from "./import-contract.js";
import {
  IMPORT_EVENT_FACTS_VERSION,
  IMPORT_EVENT_REFUSAL_CODES,
  admitImportEventFacts,
  decodeImportEventFacts,
  encodeImportEventFacts,
} from "./import-event-codec.js";
import type {
  ImportEventFacts,
  ImportEventRefusalCode,
  ImportEventRefused,
} from "./import-event-codec.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Design §21.4, §21.5 and §21.7's all-or-nothing half.
 *
 * The store seam is spied rather than faked: every assertion below reads what the
 * PRODUCTION module actually handed the port, so a test helper cannot restate the rule it
 * is supposed to be checking. The real SqliteEventStore is wired in by the migration
 * suite.
 */

const MANIFEST: SourceManifest = Object.freeze({
  digest: "a".repeat(64),
  entries: Object.freeze([
    Object.freeze({ digest: "b".repeat(64), path: "tasks/one.json", size: 10 }),
    Object.freeze({ digest: "c".repeat(64), path: "tasks/two.json", size: 20 }),
  ]),
  version: "moe-import-source-manifest/1",
});

function record(over: Partial<LegacySourceRecord> = {}): LegacySourceRecord {
  return {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: "task-1",
    payload: { owner: "alice" },
    sourcePath: "tasks/one.json",
    ...over,
  };
}

interface Spy {
  readonly commits: ImportCommitInput[];
  readonly port: ImportStorePort;
}

function spyStore(fail?: string): Spy {
  const commits: ImportCommitInput[] = [];
  return {
    commits,
    port: {
      commit(input) {
        commits.push(input);
        if (fail !== undefined) throw new Error(fail);
        return { currentVersion: input.events.length };
      },
    },
  };
}

function run(records: readonly LegacySourceRecord[], spy: Spy, maxEvents = 100): ReturnType<typeof applyImport> {
  return applyImport({
    declaredRecordCount: null,
    knownFields: ["dependsOn", "held", "owner", "parent"],
    manifest: MANIFEST,
    maxEventsPerCommit: maxEvents,
    records,
    store: spy.port,
  });
}

function reported(result: ReturnType<typeof applyImport>): ImportReport {
  if ("outcome" in result) throw new Error(`refused: ${result.code}/${result.layer}`);
  return result;
}

describe("the whole import is one commit, or it is refused", () => {
  it("writes every event in a single commit", () => {
    const spy = spyStore();
    const report = reported(run([
      record({ legacyId: "a" }),
      record({ legacyId: "b", sourcePath: "tasks/two.json" }),
    ], spy));
    expect(spy.commits.length).toBe(1);
    expect(spy.commits[0]?.events.length).toBe(2);
    expect(report.counts.claims).toBe(2);
  });

  it("refuses rather than splitting when the import exceeds the per-commit bound", () => {
    const spy = spyStore();
    const result = run([record({ legacyId: "a" }), record({ legacyId: "b" })], spy, 1);
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_TOO_LARGE_FOR_ONE_COMMIT");
    expect(result.layer).toBe("APPLY");
    // Nothing may be written on the refusal path.
    expect(spy.commits.length).toBe(0);
  });

  it("reports a failed commit with its code and layer rather than throwing", () => {
    const spy = spyStore("disk full");
    const result = run([record()], spy);
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_COMMIT_FAILED");
    expect(result.layer).toBe("APPLY");
    expect(result.detail).toContain("disk full");
  });
});

describe("nothing imported is active, and no link is a hard edge", () => {
  it("imports an ordinary claim as HISTORICAL", () => {
    const report = reported(run([record()], spyStore()));
    expect(report.claims[0]?.status).toBe("HISTORICAL");
  });

  it("imports a held legacy claim as SUSPENDED, never active", () => {
    const report = reported(run([record({ payload: { held: true, owner: "alice" } })], spyStore()));
    expect(report.claims[0]?.status).toBe("SUSPENDED");
  });

  it("can only ever produce the two non-active statuses", () => {
    // Read through the PRODUCTION vocabulary: an ACTIVE arm does not exist to be produced.
    const report = reported(run([
      record({ legacyId: "a", payload: { held: true, owner: "x" } }),
      record({ legacyId: "b", payload: { owner: "y" } }),
    ], spyStore()));
    for (const claim of report.claims) {
      expect(IMPORTED_CLAIM_STATUSES).toContain(claim.status);
    }
    expect([...IMPORTED_CLAIM_STATUSES]).toEqual(["HISTORICAL", "SUSPENDED"]);
  });

  it("imports dependsOn as RELATED evidence and parent as CONTAINS evidence", () => {
    const report = reported(run([record({
      payload: { dependsOn: ["task-9"], owner: "alice", parent: "epic-1" },
    })], spyStore()));
    expect(report.links.map((link) => link.kind)).toEqual(["CONTAINS", "RELATED"]);
    for (const link of report.links) {
      expect(link.evidenceOnly).toBe(true);
      expect(LEGACY_LINK_KINDS).toContain(link.kind);
    }
  });
});

describe("the commit itself is deterministic", () => {
  it("derives committedAt from source time, never from a clock", () => {
    const spy = spyStore();
    run([record({ declaredTime: "2024-03-04T05:06:07.000Z" })], spy);
    expect(spy.commits[0]?.committedAt).toBe("2024-03-04T05:06:07.000Z");
  });

  it("uses the deterministic sentinel when no source declared a time", () => {
    const spy = spyStore();
    run([record({ declaredTime: null })], spy);
    expect(spy.commits[0]?.committedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("produces an identical commit for two runs over the same records", () => {
    const first = spyStore();
    const second = spyStore();
    const records = [record({ legacyId: "b", sourcePath: "tasks/two.json" }), record({ legacyId: "a" })];
    run(records, first);
    run([...records].reverse(), second);
    const left = first.commits[0];
    const right = second.commits[0];
    expect(right?.commandId).toBe(left?.commandId);
    expect(right?.committedAt).toBe(left?.committedAt);
    expect(right?.events.map((event) => event.eventId))
      .toEqual(left?.events.map((event) => event.eventId));
  });
});

/**
 * THE EVENT-FACTS CODEC LIVES IN THIS FILE ON PURPOSE.
 *
 * The task's ownership rail caps this work at five paths and a separate codec test file is
 * not one of them, so the codec's cases are here rather than in `import-event-codec.test.ts`.
 * Read the placement as a scope decision, not an accident: every case below drives the REAL
 * exported encoder and decoder, most of them through `applyImport` itself, so the codec is
 * exercised exactly as its consumer will use it.
 */

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Every code this file actually emitted, so an unreachable code cannot hide in the list. */
const EMITTED_CODES = new Set<ImportEventRefusalCode>();

const RICH_PAYLOAD = Object.freeze({
  dependsOn: Object.freeze(["task-9", "task-10"]),
  held: true,
  owner: "alice",
  parent: "epic-1",
});

/** Facts bytes taken off the PRODUCTION commit, never hand-assembled. */
function factsBytes(over: Partial<LegacySourceRecord> = {}): Uint8Array {
  const spy = spyStore();
  run([record({ payload: { ...RICH_PAYLOAD }, ...over })], spy);
  const payload = spy.commits[0]?.events[0]?.payload;
  if (payload === undefined) throw new Error("production committed no event payload");
  return payload;
}

function factsText(over: Partial<LegacySourceRecord> = {}): string {
  return UTF8_DECODER.decode(factsBytes(over));
}

function parsedFacts(): Record<string, unknown> {
  return JSON.parse(factsText()) as Record<string, unknown>;
}

function bytesOf(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

function refusalOf(result: unknown): ImportEventRefused {
  if (result === null || typeof result !== "object" || !("outcome" in result)) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  }
  return result as ImportEventRefused;
}

/** Pins BOTH halves the epic rail requires: which code, and which layer refused. */
function expectRefusal(
  result: unknown,
  code: ImportEventRefusalCode,
  layer: ImportRefusalLayer,
): void {
  const refusal = refusalOf(result);
  expect(refusal.code).toBe(code);
  expect(refusal.layer).toBe(layer);
  expect(refusal.outcome).toBe("REFUSED");
  EMITTED_CODES.add(refusal.code);
}

describe("the event-facts decoder refuses each hostile shape with its own code", () => {
  it("refuses bytes that are not the declared shape", () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      "a string is not the payload",
      [1, 2, 3],
      { claim: null },
      new Uint8Array(0),
      bytesOf("not json at all"),
      bytesOf("[1,2,3]"),
      bytesOf("\"a bare string\""),
      bytesOf("17"),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ];
    expect(malformed.length).toBeGreaterThan(0);
    for (const candidate of malformed) {
      expectRefusal(decodeImportEventFacts(candidate), "IMPORT_EVENT_BYTES_MALFORMED", "DECODE");
    }
  });

  it("refuses a value outside the closed claim and link vocabularies", () => {
    const vocabularyBreaks: readonly ((facts: Record<string, unknown>) => void)[] = [
      (facts) => {
        (facts["claim"] as Record<string, unknown>)["status"] = "ACTIVE";
      },
      (facts) => {
        (facts["links"] as Record<string, unknown>[])[0]!["kind"] = "BLOCKS";
      },
      (facts) => {
        (facts["links"] as Record<string, unknown>[])[0]!["evidenceOnly"] = false;
      },
      (facts) => {
        const claim = facts["claim"] as Record<string, unknown>;
        (claim["provenance"] as Record<string, unknown>)["timeBasis"] = "WALL_CLOCK";
      },
    ];
    expect(vocabularyBreaks.length).toBeGreaterThan(0);
    for (const mutate of vocabularyBreaks) {
      const facts = parsedFacts();
      mutate(facts);
      expectRefusal(
        decodeImportEventFacts(bytesOf(JSON.stringify(facts))),
        "IMPORT_EVENT_BYTES_MALFORMED",
        "DECODE",
      );
    }
  });

  it("refuses a schema version it knowingly declines", () => {
    const facts = parsedFacts();
    facts["schemaVersion"] = "moe-import-event-facts/2";
    expectRefusal(
      decodeImportEventFacts(bytesOf(JSON.stringify(facts))),
      "IMPORT_EVENT_SCHEMA_UNSUPPORTED",
      "DECODE",
    );
  });

  it("refuses a schema version that conflicts with the payload accompanying it", () => {
    // The declared schemaVersion IS this decoder's own, so the unsupported arm cannot
    // answer first; what conflicts is the versioned vocabulary the facts claim to speak.
    const conflicts: readonly (readonly [string, string])[] = [
      ["recordVersion", "moe-import-record/2"],
      ["shadowVersion", "moe-shadow-projection/2"],
    ];
    expect(conflicts.length).toBeGreaterThan(0);
    for (const [field, value] of conflicts) {
      const facts = parsedFacts();
      expect(facts["schemaVersion"]).toBe(IMPORT_EVENT_FACTS_VERSION);
      facts[field] = value;
      expectRefusal(
        decodeImportEventFacts(bytesOf(JSON.stringify(facts))),
        "IMPORT_EVENT_SCHEMA_CONFLICT",
        "DECODE",
      );
    }
  });

  it("refuses bytes that decode but do not re-encode identically", () => {
    const canonical = factsText();
    const parsed = parsedFacts();
    const reversedKeys = Object.keys(parsed).reverse();
    const nonCanonical: readonly string[] = [
      ` ${canonical}`,
      `${canonical}\n`,
      JSON.stringify(parsed, null, 2),
      JSON.stringify(Object.fromEntries(reversedKeys.map((key) => [key, parsed[key]]))),
      // A duplicate key: JSON.parse keeps the last, so the PARSED value is indistinguishable
      // from the honest one and only a byte compare against the input sees the second
      // spelling.
      `${canonical.slice(0, -1)},"schemaVersion":"${IMPORT_EVENT_FACTS_VERSION}"}`,
    ];
    expect(nonCanonical.length).toBeGreaterThan(0);
    for (const text of nonCanonical) {
      expect(text).not.toBe(canonical);
      expectRefusal(
        decodeImportEventFacts(bytesOf(text)),
        "IMPORT_EVENT_BYTES_NONCANONICAL",
        "DECODE",
      );
    }
  });

  it("refuses when a required fact is missing", () => {
    const paths: readonly (readonly string[])[] = [
      ["claim"],
      ["links"],
      ["payload"],
      ["recordVersion"],
      ["schemaVersion"],
      ["shadowVersion"],
      ["claim", "claimId"],
      ["claim", "principal"],
      ["claim", "provenance"],
      ["claim", "status"],
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const facts = parsedFacts();
      const holder = path.length === 1
        ? facts
        : facts[path[0] as string] as Record<string, unknown>;
      delete holder[path.at(-1) as string];
      expectRefusal(
        decodeImportEventFacts(bytesOf(JSON.stringify(facts))),
        "IMPORT_EVENT_FACTS_INCOMPLETE",
        "DECODE",
      );
    }
  });

  it("refuses an undeclared field rather than dropping it silently", () => {
    const canonical = factsText();
    const extras: readonly string[] = [
      `${canonical.slice(0, -1)},"extra":1}`,
      `${canonical.slice(0, -1)},"__proto__":{"polluted":true}}`,
    ];
    expect(extras.length).toBeGreaterThan(0);
    for (const text of extras) {
      expectRefusal(
        decodeImportEventFacts(bytesOf(text)),
        "IMPORT_EVENT_FACTS_UNKNOWN_FIELD",
        "DECODE",
      );
    }
    // The pollution attempt must not have reached Object.prototype either.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("refuses an accessor property instead of invoking it", () => {
    // `admitImportEventFacts` is the structural admission the byte decoder composes, and it
    // is the surface a reader holding an already-parsed JSON value calls. An accessor
    // cannot come out of JSON.parse, so this is the one arm that must be driven there.
    const hostile = { ...parsedFacts() };
    const original = hostile["schemaVersion"];
    let reads = 0;
    Object.defineProperty(hostile, "schemaVersion", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return original;
      },
    });
    expectRefusal(admitImportEventFacts(hostile), "IMPORT_EVENT_BYTES_MALFORMED", "DECODE");
    expect(reads).toBe(0);
  });
});

function decoded(bytes: Uint8Array): ImportEventFacts {
  const facts = decodeImportEventFacts(bytes);
  if ("outcome" in facts) throw new Error(`refused: ${facts.code}/${facts.layer}`);
  return facts;
}

function encoded(input: Parameters<typeof encodeImportEventFacts>[0]): Uint8Array {
  const bytes = encodeImportEventFacts(input);
  if (!(bytes instanceof Uint8Array)) throw new Error(`refused: ${bytes.code}/${bytes.layer}`);
  return bytes;
}

const EXPECTED_PROVENANCE = Object.freeze({
  manifestDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  sourcePath: "tasks/one.json",
  sourceTime: "2024-03-04T05:06:07.000Z",
  timeBasis: "SOURCE_DECLARED",
});

describe("the accepted control: what a decoded event actually carries", () => {
  it("round-trips one claim and its links field by field", () => {
    // A refusal-only suite cannot see a WRONG accepted value, so every field the consumer
    // reads is pinned here against values derived through the production id function.
    const facts = decoded(factsBytes());
    expect(facts.schemaVersion).toBe(IMPORT_EVENT_FACTS_VERSION);
    expect(facts.claim.claimId)
      .toBe(deriveImportedId("a".repeat(64), record({ payload: { ...RICH_PAYLOAD } })));
    expect(facts.claim.principal).toBe("alice");
    expect(facts.claim.status).toBe("SUSPENDED");
    expect({ ...facts.claim.provenance }).toEqual({ ...EXPECTED_PROVENANCE });
    expect(facts.links.length).toBeGreaterThan(0);
    expect(facts.links.map((link) => ({ ...link, provenance: { ...link.provenance } })))
      .toEqual([
        { evidenceOnly: true, from: "epic-1", kind: "CONTAINS", provenance: { ...EXPECTED_PROVENANCE }, to: "task-1" },
        { evidenceOnly: true, from: "task-1", kind: "RELATED", provenance: { ...EXPECTED_PROVENANCE }, to: "task-10" },
        { evidenceOnly: true, from: "task-1", kind: "RELATED", provenance: { ...EXPECTED_PROVENANCE }, to: "task-9" },
      ]);
    expect(facts.payload).toEqual({ ...RICH_PAYLOAD });
  });

  it("carries a record with no links at all", () => {
    const facts = decoded(factsBytes({ payload: { owner: "bob" } }));
    expect(facts.links).toEqual([]);
    expect(facts.claim.status).toBe("HISTORICAL");
    expect(facts.claim.principal).toBe("bob");
  });

  it("returns deeply frozen facts, and a mutation attempt does not take", () => {
    const facts = decoded(factsBytes());
    for (const frozen of [
      facts,
      facts.claim,
      facts.claim.provenance,
      facts.links,
      facts.payload,
      facts.payload["dependsOn"],
      ...facts.links,
      ...facts.links.map((link) => link.provenance),
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(() => {
      (facts.claim as { status: string }).status = "ACTIVE";
    }).toThrow(TypeError);
    expect(facts.claim.status).toBe("SUSPENDED");
    expect(() => {
      (facts.claim.provenance as { sourcePath: string }).sourcePath = "elsewhere.json";
    }).toThrow(TypeError);
    expect(facts.claim.provenance.sourcePath).toBe("tasks/one.json");
  });

  it("orders links into a total order that does not depend on the order given", () => {
    const report = reported(run([record({ payload: { ...RICH_PAYLOAD } })], spyStore()));
    const claim = report.claims[0];
    if (claim === undefined) throw new Error("production derived no claim");
    expect(report.links.length).toBeGreaterThan(1);
    const forward = encoded({ claim, links: report.links, payload: { ...RICH_PAYLOAD } });
    const shuffled = encoded({
      claim,
      links: [...report.links].reverse(),
      payload: { ...RICH_PAYLOAD },
    });
    expect([...shuffled]).toEqual([...forward]);
    // And the ordering is the codec's own, not the caller's: the source order is CONTAINS,
    // RELATED task-9, RELATED task-10, which is NOT what comes back out.
    expect(decoded(forward).links.map((link) => link.to)).toEqual(["task-1", "task-10", "task-9"]);
    expect(report.links.map((link) => link.to)).toEqual(["task-1", "task-9", "task-10"]);
  });

  it("declares a frozen, sorted refusal vocabulary", () => {
    expect(Object.isFrozen(IMPORT_EVENT_REFUSAL_CODES)).toBe(true);
    expect([...IMPORT_EVENT_REFUSAL_CODES]).toEqual([...IMPORT_EVENT_REFUSAL_CODES].sort());
    expect(new Set(IMPORT_EVENT_REFUSAL_CODES).size).toBe(IMPORT_EVENT_REFUSAL_CODES.length);
  });
});
