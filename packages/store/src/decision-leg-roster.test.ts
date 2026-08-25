import { describe, expect, it } from "vitest";

import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import {
  DECISION_LEDGER_LAYER,
  DECISION_LEG_ROSTER_VERSION,
  MAX_DECISION_LEG_ROSTER_BYTES,
  DecisionLedgerIntegrityError,
  decisionLegReceiptCommandId,
  decodeDecisionLegRoster,
  encodeDecisionLegRoster,
  identifyDecisionLegRoster,
  snapshotDecisionLegRoster,
} from "./decision-leg-roster.js";
import { legReceiptCommandId } from "./store-digests.js";

const DECISION_ID = "ab".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function receiptId(index: number): string {
  return `moe-internal:decision-effect:${DECISION_ID}${index === 0 ? "" : `:leg:${index}`}`;
}

function committedLeg(index: number, aggregateId = `aggregate-${index}`) {
  return {
    aggregateId,
    expectedVersion: index,
    index,
    receiptCommandId: receiptId(index),
    receiptEffectSha256: String(index + 4).padStart(2, "0").repeat(32),
    receiptRequestSha256: String(index + 1).padStart(2, "0").repeat(32),
  };
}

function noEffectLeg(index: number, aggregateId = `aggregate-${index}`) {
  return {
    aggregateId,
    expectedVersion: index,
    index,
    receiptCommandId: null,
    receiptEffectSha256: null,
    receiptRequestSha256: null,
  };
}

const INVALID_RECEIPT_INDEXES = [-1, MAX_DECISION_LEGS, Number.NaN] as const;

const THREE_LEG_AUTHORITY_FORMS = [
  ["committed", [0, 1, 2].map((index) => committedLeg(index)), "67a1e8eccd7ce65f51f2f16b920a024a1348b2f7b3d4a85ed3d353800aceb997"],
  ["no-business-effect", [0, 1, 2].map((index) => noEffectLeg(index)), "ee9e195cdd5744164ff6bce97aa83b464536165b4dc8a7fdb9d1a7adc4aad411"],
] as const;

function roster(legs: readonly unknown[]): Record<string, unknown> {
  return { version: DECISION_LEG_ROSTER_VERSION, decisionId: DECISION_ID, count: legs.length, legs };
}

function captureCorrupt(run: () => unknown): DecisionLedgerIntegrityError {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(DecisionLedgerIntegrityError);
  if (!(caught instanceof DecisionLedgerIntegrityError)) throw new Error("expected integrity error");
  expect(caught).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
  expect(caught.message).toBe("STORE_CORRUPT: decision leg roster is corrupt");
  return caught;
}

function encodedJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function oneLegTuple(): unknown[] {
  return [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 1, [[
    0, "aggregate-0", 0, receiptId(0), "01".repeat(32), "04".repeat(32),
  ]]];
}

describe("decision leg roster canonical surface", () => {
  it("pins constants, error identity, and receipt-id parity", () => {
    expect(DECISION_LEG_ROSTER_VERSION).toBe("moe-decision-leg-roster/1");
    expect(DECISION_LEDGER_LAYER).toBe("DECISION_LEDGER");
    expect(MAX_DECISION_LEG_ROSTER_BYTES).toBe(32_768);
    expect(MAX_DECISION_LEGS).toBe(8);

    expect(Array.from({ length: MAX_DECISION_LEGS }, (_, index) => index)).not.toHaveLength(0);
    for (let index = 0; index < MAX_DECISION_LEGS; index += 1) {
      expect(decisionLegReceiptCommandId(DECISION_ID, index)).toBe(legReceiptCommandId(DECISION_ID, index));
    }
    expect(INVALID_RECEIPT_INDEXES).toHaveLength(3);
    expect(INVALID_RECEIPT_INDEXES.length).toBeGreaterThan(0);
    for (const invalid of INVALID_RECEIPT_INDEXES) {
      captureCorrupt(() => decisionLegReceiptCommandId(DECISION_ID, invalid));
    }
    captureCorrupt(() => decisionLegReceiptCommandId(DECISION_ID.toUpperCase(), 0));
  });

  it("round-trips one committed leg byte-identically without aliasing", () => {
    const input = roster([committedLeg(0)]);
    const snapshot = snapshotDecisionLegRoster(input);
    const expectedText = JSON.stringify(oneLegTuple());

    expect(snapshot).toEqual(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.legs)).toBe(true);
    expect(Object.isFrozen(snapshot.legs[0])).toBe(true);
    expect(decoder.decode(encodeDecisionLegRoster(snapshot))).toBe(expectedText);
    expect(identifyDecisionLegRoster(snapshot)).toBe("40e2336afdeaab13f474151a074ee39bed0ab5992c62e58ad8f5344f06a0c79e");
    const decoded = decodeDecisionLegRoster(encodeDecisionLegRoster(snapshot));
    expect(decoded).toEqual(snapshot);
    expect(encodeDecisionLegRoster(decoded)).toEqual(encodeDecisionLegRoster(snapshot));

    (input.legs as Array<Record<string, unknown>>)[0]!["aggregateId"] = "moved";
    expect(snapshot.legs[0]!.aggregateId).toBe("aggregate-0");
  });

  it("pins the three-leg authority-form matrix denominator", () => {
    expect(THREE_LEG_AUTHORITY_FORMS).toHaveLength(2);
    expect(THREE_LEG_AUTHORITY_FORMS.length).toBeGreaterThan(0);
    expect(THREE_LEG_AUTHORITY_FORMS.map(([name]) => name)).toEqual(["committed", "no-business-effect"]);
  });

  it.each(THREE_LEG_AUTHORITY_FORMS)("round-trips a frozen three-leg %s roster", (_name, legs, expectedDigest) => {
    const snapshot = snapshotDecisionLegRoster(roster(legs));
    const bytes = encodeDecisionLegRoster(snapshot);

    expect(snapshot.count).toBe(3);
    expect(snapshot.legs.map((leg) => leg.index)).toEqual([0, 1, 2]);
    expect(decodeDecisionLegRoster(bytes)).toEqual(snapshot);
    expect(encodeDecisionLegRoster(decodeDecisionLegRoster(bytes))).toEqual(bytes);
    expect(identifyDecisionLegRoster(snapshot)).toBe(expectedDigest);
    expect(snapshot.legs.every(Object.isFrozen)).toBe(true);
  });

  it("binds every leg field and both nullable receipt digests into identity", () => {
    const original = roster([committedLeg(0)]);
    const digest = identifyDecisionLegRoster(snapshotDecisionLegRoster(original));
    const mutations = [
      roster([{ ...committedLeg(0), aggregateId: "substituted" }]),
      roster([{ ...committedLeg(0), expectedVersion: 1 }]),
      roster([{ ...committedLeg(0), receiptRequestSha256: "ff".repeat(32) }]),
      roster([{ ...committedLeg(0), receiptEffectSha256: "ee".repeat(32) }]),
    ];

    expect(mutations).not.toHaveLength(0);
    for (const mutation of mutations) {
      expect(identifyDecisionLegRoster(snapshotDecisionLegRoster(mutation))).not.toBe(digest);
    }
  });
});

describe("decision leg roster hostile snapshots", () => {
  const cases: readonly [string, () => unknown][] = [
    ["zero legs", () => roster([])],
    ["nine legs", () => roster(Array.from({ length: 9 }, (_, i) => noEffectLeg(i)))],
    ["declared count mismatch", () => ({ ...roster([noEffectLeg(0)]), count: 2 })],
    ["sparse legs", () => ({ ...roster([noEffectLeg(0)]), count: 2, legs: Object.assign(new Array(2), { 0: noEffectLeg(0) }) })],
    ["reordered indexes", () => roster([noEffectLeg(1), noEffectLeg(0)])],
    ["duplicate aggregates", () => roster([noEffectLeg(0, "same"), noEffectLeg(1, "same")])],
    ["duplicate receipt ids", () => roster([committedLeg(0), { ...committedLeg(1), receiptCommandId: receiptId(0) }])],
    ["wrong receipt id", () => roster([{ ...committedLeg(0), receiptCommandId: "wrong" }])],
    ["index-zero alias", () => roster([{ ...committedLeg(0), receiptCommandId: `${receiptId(0)}:leg:0` }])],
    ["negative fence", () => roster([{ ...noEffectLeg(0), expectedVersion: -1 }])],
    ["unsafe fence", () => roster([{ ...noEffectLeg(0), expectedVersion: Number.MAX_SAFE_INTEGER + 1 }])],
    ["uppercase decision digest", () => ({ ...roster([noEffectLeg(0)]), decisionId: DECISION_ID.toUpperCase() })],
    ["malformed receipt digest", () => roster([{ ...committedLeg(0), receiptRequestSha256: "0".repeat(63) }])],
    ["uppercase receipt digest", () => roster([{ ...committedLeg(0), receiptEffectSha256: "AA".repeat(32) }])],
    ["mixed-null request", () => roster([{ ...committedLeg(0), receiptRequestSha256: null }])],
    ["mixed-null effect", () => roster([{ ...committedLeg(0), receiptEffectSha256: null }])],
    ["mixed-null id", () => roster([{ ...committedLeg(0), receiptCommandId: null }])],
    ["missing roster key", () => ({ version: DECISION_LEG_ROSTER_VERSION, decisionId: DECISION_ID, count: 1 })],
    ["extra roster key", () => ({ ...roster([noEffectLeg(0)]), extra: true })],
    ["missing leg key", () => { const { index: _index, ...leg } = noEffectLeg(0); return roster([leg]); }],
    ["extra leg key", () => roster([{ ...noEffectLeg(0), extra: true }])],
    ["symbol key", () => Object.assign(roster([noEffectLeg(0)]), { [Symbol("extra")]: true })],
    ["custom roster prototype", () => Object.assign(Object.create({}), roster([noEffectLeg(0)]))],
    ["proxy roster", () => new Proxy(roster([noEffectLeg(0)]), {})],
    ["custom array prototype", () => ({ ...roster([noEffectLeg(0)]), legs: Object.setPrototypeOf([noEffectLeg(0)], Object.create(Array.prototype)) })],
    ["proxy array", () => ({ ...roster([noEffectLeg(0)]), legs: new Proxy([noEffectLeg(0)], {}) })],
    ["array extra key", () => ({ ...roster([noEffectLeg(0)]), legs: Object.assign([noEffectLeg(0)], { extra: true }) })],
    ["custom leg prototype", () => roster([Object.assign(Object.create({}), noEffectLeg(0))])],
    ["proxy leg", () => roster([new Proxy(noEffectLeg(0), {})])],
    ["513-byte id", () => roster([noEffectLeg(0, `${"é".repeat(256)}a`)])],
    ["NUL id", () => roster([noEffectLeg(0, "bad\0id")])],
    ["unpaired surrogate id", () => roster([noEffectLeg(0, "bad\ud800id")])],
  ];

  it("refuses every generated hostile shape with no partial roster", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const [name, make] of cases) {
      const error = captureCorrupt(() => snapshotDecisionLegRoster(make()));
      expect(error.message, name).not.toContain(DECISION_ID);
    }
  });

  it("never invokes accessors and refuses revoked proxies", () => {
    let reads = 0;
    const accessorRoster = Object.defineProperty(roster([noEffectLeg(0)]), "count", { get: () => { reads += 1; return 1; } });
    const accessorArray = [noEffectLeg(0)];
    Object.defineProperty(accessorArray, "0", { get: () => { reads += 1; return noEffectLeg(0); } });
    const accessorLeg = Object.defineProperty(noEffectLeg(0), "aggregateId", { get: () => { reads += 1; return "aggregate-0"; } });
    const revoked = Proxy.revocable(roster([noEffectLeg(0)]), {});
    revoked.revoke();

    const hostileAccessorValues = [
      accessorRoster,
      { ...roster([noEffectLeg(0)]), legs: accessorArray },
      roster([accessorLeg]),
      revoked.proxy,
    ];

    expect(hostileAccessorValues).toHaveLength(4);
    expect(hostileAccessorValues.length).toBeGreaterThan(0);
    for (const value of hostileAccessorValues) {
      captureCorrupt(() => snapshotDecisionLegRoster(value));
    }
    expect(reads).toBe(0);
  });

  it("accepts the exact 512-byte UTF-8 identifier boundary", () => {
    const aggregateId = "é".repeat(256);
    const snapshot = snapshotDecisionLegRoster(roster([noEffectLeg(0, aggregateId)]));
    expect(encoder.encode(snapshot.legs[0]!.aggregateId)).toHaveLength(512);
  });

  it("keeps eight worst-case escaped identifiers inside the byte ceiling", () => {
    const legs = Array.from({ length: MAX_DECISION_LEGS }, (_, index) =>
      noEffectLeg(index, String.fromCharCode(index + 1).repeat(512)));
    const bytes = encodeDecisionLegRoster(snapshotDecisionLegRoster(roster(legs)));
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_DECISION_LEG_ROSTER_BYTES);
    expect(decodeDecisionLegRoster(bytes).legs).toHaveLength(MAX_DECISION_LEGS);
  });
});

describe("decision leg roster hostile bytes", () => {
  it("refuses malformed, noncanonical, shared, detached, proxy, and oversized bytes", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const detached = new Uint8Array([1, 2, 3]);
    structuredClone(detached.buffer, { transfer: [detached.buffer as ArrayBuffer] });
    const cases: readonly [string, unknown][] = [
      ["empty", new Uint8Array()],
      ["invalid UTF-8", new Uint8Array([0xc3, 0x28])],
      ["invalid JSON", encoder.encode("{")],
      ["trailing JSON", encoder.encode(`${JSON.stringify(oneLegTuple())}x`)],
      ["noncanonical whitespace", encoder.encode(` ${JSON.stringify(oneLegTuple())}`)],
      ["wrong tuple", encodedJson({ roster: oneLegTuple() })],
      ["extra tuple item", encodedJson([...oneLegTuple(), null])],
      ["shared", shared],
      ["detached", detached],
      ["proxy", new Proxy(new Uint8Array([1]), {})],
      ["oversized", new Uint8Array(MAX_DECISION_LEG_ROSTER_BYTES + 1)],
    ];

    expect(cases.length).toBeGreaterThan(0);
    for (const [name, bytes] of cases) {
      const error = captureCorrupt(() => decodeDecisionLegRoster(bytes));
      expect(error.message, name).not.toContain(DECISION_ID);
    }
  });

  it("refuses count, order, removal, and receipt-binding tuple mutations", () => {
    const mutations = [
      [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 2, oneLegTuple()[3]],
      [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 2, [[1, "aggregate-1", 1, null, null, null], [0, "aggregate-0", 0, null, null, null]]],
      [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 1, []],
      ["moe-decision-leg-roster/0", DECISION_ID, 1, oneLegTuple()[3]],
      [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 1, [[0, "aggregate-0", 0, receiptId(0), null, "04".repeat(32)]]],
      [DECISION_LEG_ROSTER_VERSION, DECISION_ID, 1, [[0, "aggregate-0", 0, receiptId(0), "01".repeat(32), null]]],
    ];

    expect(mutations).not.toHaveLength(0);
    for (const mutation of mutations) captureCorrupt(() => decodeDecisionLegRoster(encodedJson(mutation)));
  });
});
