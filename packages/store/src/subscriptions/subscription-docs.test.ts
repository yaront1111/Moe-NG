import { describe, expect, it } from "vitest";

import {
  MAX_SUBSCRIPTION_DOC_BYTES,
  SNAPSHOT_DOC_VERSION,
  SNAPSHOT_SUBSCRIBER_PREFIX,
  SUBSCRIBER_DOC_VERSION,
  decodeSnapshotDoc,
  decodeSubscriberDoc,
  encodeSnapshotDoc,
  encodeSubscriberDoc,
  isReservedSubscriberId,
  parsePosition,
  snapshotSubscriberId,
} from "./subscription-contracts.js";
import type {
  SnapshotDoc,
  SnapshotDocFields,
  SubscriberDoc,
  SubscriberDocFields,
} from "./subscription-contracts.js";

const PROJECTION = "goal-count";
const STATE_DIGEST = "a".repeat(64);
const SHA256 = /^[0-9a-f]{64}$/u;

function subscriberFields(overrides: Partial<SubscriberDocFields> = {}): SubscriberDocFields {
  return {
    filter: ["goal.created"], generation: 1, position: "7", projection: PROJECTION, ...overrides,
  };
}

function snapshotFields(overrides: Partial<SnapshotDocFields> = {}): SnapshotDocFields {
  return {
    checkpoint: "7", generation: 1, projection: PROJECTION,
    state: { count: 2, last: "evt-2" }, stateDigest: STATE_DIGEST, ...overrides,
  };
}

function subscriberText(overrides: Partial<SubscriberDocFields> = {}): string {
  const text = encodeSubscriberDoc(subscriberFields(overrides));
  if (text === null) {
    throw new Error(`expected a canonical subscriber doc for ${JSON.stringify(overrides)}`);
  }
  return text;
}

function snapshotText(overrides: Partial<SnapshotDocFields> = {}): string {
  const text = encodeSnapshotDoc(snapshotFields(overrides));
  if (text === null) {
    throw new Error(`expected a canonical snapshot doc for ${JSON.stringify(overrides)}`);
  }
  return text;
}

function subscriberDoc(text: string): SubscriberDoc {
  const doc = decodeSubscriberDoc(text);
  if (doc === null) {
    throw new Error(`expected a decodable subscriber doc, got ${text}`);
  }
  return doc;
}

function snapshotDoc(text: string): SnapshotDoc {
  const doc = decodeSnapshotDoc(text);
  if (doc === null) {
    throw new Error(`expected a decodable snapshot doc, got ${text}`);
  }
  return doc;
}

/** Rewrites the parsed doc in place; key order of untouched fields is preserved. */
function tamper(text: string, edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(text) as Record<string, unknown>;
  edit(raw);
  return JSON.stringify(raw);
}

describe("subscription doc codec", () => {
  it("round-trips a subscriber doc into a frozen record", () => {
    const doc = subscriberDoc(subscriberText());

    expect(doc).toEqual({
      cursor: { generation: 1, position: "7" },
      filter: ["goal.created"],
      projection: PROJECTION,
      receiptDigest: expect.stringMatching(SHA256) as unknown as string,
      version: SUBSCRIBER_DOC_VERSION,
    });
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.cursor)).toBe(true);
    expect(Object.isFrozen(doc.filter)).toBe(true);
  });

  it("round-trips a snapshot doc into a frozen record", () => {
    const doc = snapshotDoc(snapshotText());

    expect(doc).toEqual({
      checkpoint: "7", generation: 1, projection: PROJECTION,
      receiptDigest: expect.stringMatching(SHA256) as unknown as string,
      state: { count: 2, last: "evt-2" }, stateDigest: STATE_DIGEST,
      version: SNAPSHOT_DOC_VERSION,
    });
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.state)).toBe(true);
  });

  it("digests snapshot state by content, not by key insertion order", () => {
    const ascending = snapshotText({ state: { alpha: 1, beta: 2 } });
    const descending = snapshotText({ state: { beta: 2, alpha: 1 } });

    expect(descending).toBe(ascending);
    expect(snapshotDoc(descending).receiptDigest).toBe(snapshotDoc(ascending).receiptDigest);
    expect(snapshotDoc(snapshotText({ state: { alpha: 1, beta: 3 } })).receiptDigest)
      .not.toBe(snapshotDoc(ascending).receiptDigest);
  });

  it("length-frames adjacent filter entries so a shifted character cannot collide", () => {
    const left = subscriberDoc(subscriberText({ filter: ["ab", "c"] }));
    const right = subscriberDoc(subscriberText({ filter: ["a", "bc"] }));

    expect(left.receiptDigest).not.toBe(right.receiptDigest);
  });

  it("binds the receipt digest to the cursor position", () => {
    expect(subscriberDoc(subscriberText({ position: "7" })).receiptDigest)
      .not.toBe(subscriberDoc(subscriberText({ position: "8" })).receiptDigest);
    expect(subscriberDoc(subscriberText({ generation: 1 })).receiptDigest)
      .not.toBe(subscriberDoc(subscriberText({ generation: 2 })).receiptDigest);
  });

  it("refuses a doc larger than the durable ceiling", () => {
    const state = { blob: "x".repeat(MAX_SUBSCRIPTION_DOC_BYTES) };

    expect(encodeSnapshotDoc(snapshotFields({ state }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ state: { blob: "x" } }))).not.toBeNull();
  });

  it("reserves the snapshot sentinel prefix for baseline rows", () => {
    expect(snapshotSubscriberId(PROJECTION)).toBe(`${SNAPSHOT_SUBSCRIBER_PREFIX}${PROJECTION}`);
    expect(isReservedSubscriberId(snapshotSubscriberId(PROJECTION))).toBe(true);
    expect(isReservedSubscriberId(SNAPSHOT_SUBSCRIBER_PREFIX)).toBe(true);
    expect(isReservedSubscriberId("goal-consumer")).toBe(false);
    expect(isReservedSubscriberId(`x${SNAPSHOT_SUBSCRIBER_PREFIX}`)).toBe(false);
  });
});

describe("subscription doc codec input refusals", () => {
  const cases: readonly (readonly [string, Partial<SubscriberDocFields>])[] = [
    ["a leading-zero position", { position: "007" }],
    ["an exponent position", { position: "1e3" }],
    ["a negative position", { position: "-1" }],
    ["an empty position", { position: "" }],
    ["a padded position", { position: " 1" }],
    ["a fractional position", { position: "1.0" }],
    ["a lone surrogate in the projection", { projection: "goal-\ud800" }],
    ["an empty projection", { projection: "" }],
    ["a lone surrogate in the filter", { filter: ["goal-\ud800"] }],
    ["a zero generation", { generation: 0 }],
    ["a fractional generation", { generation: 1.5 }],
  ];

  it("covers every uncanonical-input case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("refuses %s", (_label, overrides) => {
    expect(encodeSubscriberDoc(subscriberFields(overrides))).toBeNull();
  });

  it("refuses a snapshot whose state is not plain durable data", () => {
    expect(encodeSnapshotDoc(snapshotFields({ state: { at: new Date(0) } }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ state: { missing: undefined } }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ state: { nan: Number.NaN } }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ stateDigest: "not-a-digest" }))).toBeNull();
  });

  /** An encode walks the state twice — once for the digest, once for the stored text — so a
   *  value that can answer differently between reads could store a doc that never verifies. */
  it("refuses a proxy state at any depth", () => {
    const shifting = { count: 0 };
    const hostile = new Proxy(shifting, {
      getOwnPropertyDescriptor: (target, key) => {
        shifting.count += 1;
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(encodeSnapshotDoc(snapshotFields({ state: hostile }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ state: { inner: hostile } }))).toBeNull();
    expect(encodeSnapshotDoc(snapshotFields({ state: { list: [hostile] } }))).toBeNull();
  });
});

describe("subscription doc codec stored-text refusals", () => {
  const cases: readonly (readonly [string, (text: string) => string])[] = [
    ["a flipped digest", (text) => tamper(text, (raw) => {
      raw["receiptDigest"] = `b${String(raw["receiptDigest"]).slice(1)}`;
    })],
    ["a repositioned cursor", (text) => tamper(text, (raw) => {
      raw["cursor"] = { generation: 1, position: "9" };
    })],
    ["a leading-zero stored position", (text) => tamper(text, (raw) => {
      raw["cursor"] = { generation: 1, position: "007" };
    })],
    ["an exponent stored position", (text) => tamper(text, (raw) => {
      raw["cursor"] = { generation: 1, position: "1e3" };
    })],
    ["a lone surrogate stored projection", (text) => tamper(text, (raw) => {
      raw["projection"] = "goal-\ud800";
    })],
    ["an unknown doc version", (text) => tamper(text, (raw) => {
      raw["version"] = "moe-subscription/2";
    })],
    ["an extra field", (text) => tamper(text, (raw) => {
      raw["extra"] = 1;
    })],
    ["a missing field", (text) => tamper(text, (raw) => {
      delete raw["filter"];
    })],
    ["reordered keys", (text) => {
      const raw = JSON.parse(text) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(
        Object.keys(raw).reverse().map((key) => [key, raw[key]]),
      ));
    }],
    ["a non-object doc", () => JSON.stringify([1, 2])],
    ["unparseable text", () => "{"],
    ["an empty document", () => ""],
  ];

  it("covers every stored-text tamper case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("refuses %s", (_label, mutate) => {
    expect(decodeSubscriberDoc(mutate(subscriberText()))).toBeNull();
  });

  it("refuses a tampered snapshot state and a tampered snapshot digest", () => {
    expect(decodeSnapshotDoc(tamper(snapshotText(), (raw) => {
      raw["state"] = { count: 99, last: "evt-2" };
    }))).toBeNull();
    expect(decodeSnapshotDoc(tamper(snapshotText(), (raw) => {
      raw["stateDigest"] = "b".repeat(64);
    }))).toBeNull();
    expect(decodeSnapshotDoc(snapshotText())).not.toBeNull();
  });
});

describe("parsePosition", () => {
  const cases: readonly (readonly [string, bigint | null])[] = [
    ["0", 0n], ["7", 7n], ["9007199254740993", 9_007_199_254_740_993n],
    ["007", null], ["1e3", null], ["-1", null], ["", null], ["1.0", null], [" 1", null],
    ["+1", null], ["1 ", null], ["0x10", null], ["nine", null],
  ];

  it("covers every position case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("parses %s", (text, expected) => {
    expect(parsePosition(text)).toBe(expected);
  });

  it("refuses non-string positions", () => {
    expect(parsePosition(7)).toBeNull();
    expect(parsePosition(null)).toBeNull();
    expect(parsePosition(undefined)).toBeNull();
  });
});
