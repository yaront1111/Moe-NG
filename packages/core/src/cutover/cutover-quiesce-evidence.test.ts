import { describe, expect, it } from "vitest";

import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_STRING_UTF8_BYTES,
} from "@moe/contracts";

import {
  LIVE_QUIESCE_EVIDENCE_LAYER,
  LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES,
  deriveLiveQuiesceEvidenceDigest,
  serializeLiveQuiesceEvidenceCanonical,
} from "./cutover-quiesce-evidence.js";
import {
  canonicalizeLiveQuiesceSafeValue,
  snapshotLiveQuiesceSafeValue,
  type LiveQuiesceSafeCanonicalResult,
  type LiveQuiesceSafeValueResult,
} from "./cutover-quiesce-evidence-safe-value.js";

const EVIDENCE = {
  runMode: "LIVE",
  hostFingerprint: "win32/host-a/node-24",
  authority: {
    principal: "project owner",
    moment: "2026-08-24T10:26Z",
    commentId: "comment-go-quiesce",
  },
  inventory: {
    runMode: "LIVE",
    hostFingerprint: "win32/host-a/node-24",
    itemCount: 1,
    items: [{
      kind: "PROCESS",
      id: "process-1",
      discoveredBy: "probe process-1",
      observedBefore: "process-1 answered",
    }],
    undiscoverableKinds: [],
  },
  results: [{
    ok: true,
    item: {
      kind: "PROCESS",
      id: "process-1",
      discoveredBy: "probe process-1",
      observedBefore: "process-1 answered",
    },
    stopCommand: "stop process-1",
    observedAfter: { live: false, detail: "gone" },
    pollsUsed: 1,
  }],
  resolvedCount: 1,
  manifestComparison: {
    ok: true,
    matched: true,
    differences: [],
    comparedEntryCount: 1,
  },
  stoppedAt: [{ itemId: "process-1", moment: "2026-08-28T17:00:00.000Z" }],
  outcome: "COMPLETE",
  citationKey: "live-quiesce/task-e60b874bac924a6b9c255cb8c924041f",
  citedBy: "task-09008b4cb39c4a15aa661540d20e9b9b",
} as const;

const REORDERED_EVIDENCE = {
  citedBy: EVIDENCE.citedBy,
  citationKey: EVIDENCE.citationKey,
  outcome: EVIDENCE.outcome,
  stoppedAt: EVIDENCE.stoppedAt,
  manifestComparison: EVIDENCE.manifestComparison,
  resolvedCount: EVIDENCE.resolvedCount,
  results: EVIDENCE.results,
  inventory: EVIDENCE.inventory,
  authority: {
    commentId: EVIDENCE.authority.commentId,
    moment: EVIDENCE.authority.moment,
    principal: EVIDENCE.authority.principal,
  },
  hostFingerprint: EVIDENCE.hostFingerprint,
  runMode: EVIDENCE.runMode,
} as const;

const EXPECTED_CANONICAL_JSON = [
  '{"authority":{"commentId":"comment-go-quiesce","moment":"2026-08-24T10:26Z",',
  '"principal":"project owner"},"citationKey":"live-quiesce/task-e60b874bac924a6b9c255cb8c924041f",',
  '"citedBy":"task-09008b4cb39c4a15aa661540d20e9b9b","hostFingerprint":"win32/host-a/node-24",',
  '"inventory":{"hostFingerprint":"win32/host-a/node-24","itemCount":1,"items":[{"discoveredBy":',
  '"probe process-1","id":"process-1","kind":"PROCESS","observedBefore":"process-1 answered"}],',
  '"runMode":"LIVE","undiscoverableKinds":[]},"manifestComparison":{"comparedEntryCount":1,',
  '"differences":[],"matched":true,"ok":true},"outcome":"COMPLETE","resolvedCount":1,"results":[{',
  '"item":{"discoveredBy":"probe process-1","id":"process-1","kind":"PROCESS","observedBefore":',
  '"process-1 answered"},"observedAfter":{"detail":"gone","live":false},"ok":true,"pollsUsed":1,',
  '"stopCommand":"stop process-1"}],"runMode":"LIVE","stoppedAt":[{"itemId":"process-1",',
  '"moment":"2026-08-28T17:00:00.000Z"}]}',
].join("");
const EXPECTED_DIGEST = "a94be5b8f62ea25f49e469606d45c02134e6aaf23a42f661d86444903b94fee9";
const EXPECTED_INCOMPLETE = Object.freeze({
  code: "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
  detail: "the durable live-quiesce evidence record is absent or has an incomplete shape",
  layer: LIVE_QUIESCE_EVIDENCE_LAYER,
  ok: false,
});

type HostileIssue = Extract<LiveQuiesceSafeValueResult, { readonly ok: false }>["issue"];
interface HostileCase {
  readonly issue: HostileIssue;
  readonly name: string;
  readonly value: unknown;
}

let getterReads = 0;
let iteratorReads = 0;

function deepCitationKey(): unknown {
  let value: unknown = "bottom";
  for (let depth = 0; depth < 20_000; depth += 1) value = [value];
  return value;
}

function getterEvidence(): unknown {
  const value: Record<string, unknown> = { ...EVIDENCE };
  Object.defineProperty(value, "citationKey", {
    enumerable: true,
    get: () => { getterReads += 1; throw new Error("getter invoked"); },
  });
  return value;
}

function inheritedItems(): unknown[] {
  const items: unknown[] = [...EVIDENCE.inventory.items];
  const prototype = Object.create(Array.prototype) as object;
  Object.defineProperty(prototype, Symbol.iterator, {
    value: function iterator(this: unknown[]) {
      iteratorReads += 1;
      return Array.prototype[Symbol.iterator].call(this) as ArrayIterator<unknown>;
    },
  });
  Object.setPrototypeOf(items, prototype);
  return items;
}

function revokedEvidence(): unknown {
  const revocable = Proxy.revocable({ ...EVIDENCE }, {});
  revocable.revoke();
  return revocable.proxy;
}

function oversizedEvidence(): unknown {
  const differences = Array.from({ length: 4_096 }, (_, index) => ({
    kind: "ADDED" as const,
    path: `entry-${String(index).padStart(4, "0")}-${"x".repeat(256)}`,
  }));
  const value = { ...EVIDENCE, manifestComparison: {
    ...EVIDENCE.manifestComparison, comparedEntryCount: differences.length,
    differences, matched: false,
  } };
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
    .toBeGreaterThan(MAX_JSON_BODY_BYTES);
  return value;
}

function hostileCases(): readonly HostileCase[] {
  const ownKeysProxy = new Proxy({ ...EVIDENCE }, {
    ownKeys: () => { throw new Error("ownKeys trap invoked"); },
  });
  const nonEnumerable = { ...EVIDENCE };
  Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: true });
  const sparseItems = new Array<unknown>(1);
  const extraItems: unknown[] = [...EVIDENCE.inventory.items];
  Object.defineProperty(extraItems, "extra", { enumerable: true, value: "smuggled" });
  // Divergence fixture: the own-key COUNT check cannot see this hole, because the padding
  // key restores `ownKeys.length === length + 1`. Only the per-slot presence check can.
  const paddedHoleItems: unknown[] = [...EVIDENCE.inventory.items];
  paddedHoleItems.length = 2;
  Object.defineProperty(paddedHoleItems, "pad", { enumerable: true, value: 0 });
  expect(Reflect.ownKeys(paddedHoleItems)).toHaveLength(paddedHoleItems.length + 1);
  expect(Reflect.getOwnPropertyDescriptor(paddedHoleItems, "1")).toBeUndefined();
  const cyclic: Record<string, unknown> = { ...EVIDENCE };
  cyclic.citationKey = cyclic;
  const cases = Object.freeze([
    { issue: "CYCLE", name: "self-referencing citation key", value: cyclic },
    { issue: "DEPTH_LIMIT", name: "20,000-deep nesting",
      value: { ...EVIDENCE, citationKey: deepCitationKey() } },
    { issue: "ACCESSOR", name: "enumerable throwing getter", value: getterEvidence() },
    { issue: "PROXY", name: "revoked proxy", value: revokedEvidence() },
    { issue: "PROXY", name: "ownKeys-throwing proxy", value: ownKeysProxy },
    { issue: "HOSTILE_SHAPE", name: "symbol extra",
      value: { ...EVIDENCE, [Symbol("extra")]: "smuggled" } },
    { issue: "HOSTILE_SHAPE", name: "non-enumerable extra", value: nonEnumerable },
    { issue: "HOSTILE_SHAPE", name: "inherited array behavior",
      value: { ...EVIDENCE, inventory: { ...EVIDENCE.inventory, items: inheritedItems() } } },
    { issue: "ARRAY_SHAPE", name: "sparse array",
      value: { ...EVIDENCE, inventory: { ...EVIDENCE.inventory, items: sparseItems } } },
    { issue: "ARRAY_SHAPE", name: "extra array key",
      value: { ...EVIDENCE, inventory: { ...EVIDENCE.inventory, items: extraItems } } },
    { issue: "ARRAY_SHAPE", name: "hole hidden behind a padded key count",
      value: { ...EVIDENCE, inventory: { ...EVIDENCE.inventory, items: paddedHoleItems } } },
    { issue: "STRING_LIMIT", name: "oversized scalar",
      value: { ...EVIDENCE, citationKey: "x".repeat(MAX_JSON_STRING_UTF8_BYTES + 1) } },
    { issue: "BODY_LIMIT", name: "oversized aggregate", value: oversizedEvidence() },
  ] as const satisfies readonly HostileCase[]);
  return cases;
}

function inspectSafeValue(value: unknown): LiveQuiesceSafeCanonicalResult {
  const snapshot = snapshotLiveQuiesceSafeValue(value);
  return snapshot.ok ? canonicalizeLiveQuiesceSafeValue(snapshot.value) : snapshot;
}

const requireDigest = (value: unknown): string => {
  const result = deriveLiveQuiesceEvidenceDigest(value);
  if (!result.ok) throw new Error(`fixture refused: ${result.code}`);
  return result.quiesceRecordSha256;
};

const expectIncomplete = (value: unknown): void => {
  const result = deriveLiveQuiesceEvidenceDigest(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("malformed evidence must be refused");
  expect(result.code).toBe("LIVE_QUIESCE_EVIDENCE_INCOMPLETE");
  expect(result.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
};

describe("cutover quiesce evidence canonical digest", () => {
  it("pins valid public compatibility and the pre-hardening byte golden", () => {
    expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toEqual([
      "LIVE_QUIESCE_EVIDENCE_INCOMPLETE", "LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH",
      "LIVE_QUIESCE_EVIDENCE_RUNMODE_MISSING", "LIVE_QUIESCE_EVIDENCE_AUTHORITY_MISSING",
      "LIVE_QUIESCE_EVIDENCE_MANIFEST_REFUSED", "LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING",
      "LIVE_QUIESCE_EVIDENCE_WRITE_FAILED",
    ]);
    expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toHaveLength(7);
    expect(Object.isFrozen(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES)).toBe(true);
    expect(serializeLiveQuiesceEvidenceCanonical.length).toBe(1);
    expect(deriveLiveQuiesceEvidenceDigest.length).toBe(1);
    expect(serializeLiveQuiesceEvidenceCanonical(EVIDENCE)).toEqual({
      canonicalJson: EXPECTED_CANONICAL_JSON, ok: true,
    });
    expect(deriveLiveQuiesceEvidenceDigest(EVIDENCE)).toEqual({
      ok: true, quiesceRecordSha256: EXPECTED_DIGEST,
    });
  });

  it("totally refuses every hostile own-data value at the production seam and public APIs", () => {
    const cases = hostileCases();
    expect(cases).toHaveLength(13);
    expect(new Set(cases.map(({ name }) => name)).size).toBe(13);
    expect(new Set(cases.map(({ issue }) => issue))).toEqual(new Set([
      "CYCLE", "DEPTH_LIMIT", "ACCESSOR", "PROXY", "HOSTILE_SHAPE", "ARRAY_SHAPE",
      "STRING_LIMIT", "BODY_LIMIT",
    ]));
    let exercised = 0;
    for (const { issue, name, value } of cases) {
      exercised += 1;
      const internal = inspectSafeValue(value);
      expect(internal, name).toEqual({ issue, ok: false });
      expect(Object.isFrozen(internal), name).toBe(true);
      expect(serializeLiveQuiesceEvidenceCanonical(value), name).toEqual(EXPECTED_INCOMPLETE);
      expect(deriveLiveQuiesceEvidenceDigest(value), name).toEqual(EXPECTED_INCOMPLETE);
    }
    expect(exercised).toBe(13);
    expect(getterReads).toBe(0);
    expect(iteratorReads).toBe(0);
  });

  it("still accepts schema-valid values sitting immediately below both ceilings", () => {
    const atStringCeiling = "x".repeat(MAX_JSON_STRING_UTF8_BYTES);
    expect(new TextEncoder().encode(atStringCeiling).byteLength).toBe(MAX_JSON_STRING_UTF8_BYTES);
    const scalarControl = serializeLiveQuiesceEvidenceCanonical({
      ...EVIDENCE, citationKey: atStringCeiling,
    });
    expect(scalarControl.ok).toBe(true);
    if (!scalarControl.ok) throw new Error("a scalar at the ceiling must be accepted");
    expect(scalarControl.canonicalJson).toContain(atStringCeiling);

    const differences = Array.from({ length: 3_000 }, (_, index) => ({
      kind: "ADDED" as const,
      path: `entry-${String(index).padStart(4, "0")}-${"x".repeat(256)}`,
    }));
    const bodyControl = serializeLiveQuiesceEvidenceCanonical({
      ...EVIDENCE, manifestComparison: {
        ...EVIDENCE.manifestComparison, comparedEntryCount: differences.length,
        differences, matched: false,
      },
    });
    expect(bodyControl.ok).toBe(true);
    if (!bodyControl.ok) throw new Error("a body under the ceiling must be accepted");
    const bodyBytes = new TextEncoder().encode(bodyControl.canonicalJson).byteLength;
    expect(bodyBytes).toBeGreaterThan(800_000);
    expect(bodyBytes).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES);
  });

  it("keeps the pre-existing semantic refusals distinct from the totality fence", () => {
    const stop = deriveLiveQuiesceEvidenceDigest({ ...EVIDENCE, stoppedAt: [] });
    expect(stop.ok).toBe(false);
    if (stop.ok) throw new Error("a stopped item without a moment must be refused");
    expect(stop.code).toBe("LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING");
    expect(stop.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);

    const host = deriveLiveQuiesceEvidenceDigest({
      ...EVIDENCE,
      inventory: { ...EVIDENCE.inventory, hostFingerprint: "win32/host-b/node-24" },
    });
    expect(host.ok).toBe(false);
    if (host.ok) throw new Error("an inconsistent host must be refused");
    expect(host.code).toBe("LIVE_QUIESCE_EVIDENCE_INCOMPLETE");
    expect(host.detail).toBe("host evidence is internally inconsistent");
    expect(host.detail).not.toBe(EXPECTED_INCOMPLETE.detail);
  });

  it("never mutates the caller record and re-reads it on every call", () => {
    const mutable = JSON.parse(JSON.stringify(EVIDENCE)) as {
      readonly inventory: { readonly items: unknown[] };
    };
    const before = JSON.stringify(mutable);
    const first = serializeLiveQuiesceEvidenceCanonical(mutable);

    expect(JSON.stringify(mutable)).toBe(before);
    expect(first).toEqual({ canonicalJson: EXPECTED_CANONICAL_JSON, ok: true });
    if (!first.ok) throw new Error("valid evidence must serialize");
    const accepted = first.canonicalJson;

    mutable.inventory.items.push(JSON.parse(JSON.stringify(EVIDENCE.inventory.items[0])));
    expect(first.canonicalJson).toBe(accepted);
    const second = deriveLiveQuiesceEvidenceDigest(mutable);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("the mutated record must be re-read, not cached");
    expect(second.code).toBe("LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH");
  });

  it("returns exactly the accepted key rosters, frozen, for both insertion orders", () => {
    const canonical = serializeLiveQuiesceEvidenceCanonical(REORDERED_EVIDENCE);
    const digest = deriveLiveQuiesceEvidenceDigest(REORDERED_EVIDENCE);

    expect(Object.keys(canonical).sort()).toEqual(["canonicalJson", "ok"]);
    expect(Object.keys(digest).sort()).toEqual(["ok", "quiesceRecordSha256"]);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(digest)).toBe(true);
  });

  it("is deterministic across independent serializations and key insertion order", () => {
    const first = serializeLiveQuiesceEvidenceCanonical(EVIDENCE);
    const second = serializeLiveQuiesceEvidenceCanonical(REORDERED_EVIDENCE);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("valid evidence must serialize");
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(requireDigest(EVIDENCE)).toBe(requireDigest(REORDERED_EVIDENCE));
  });

  it("changes the digest when one concrete evidence field changes", () => {
    const changed = { ...EVIDENCE, citationKey: `${EVIDENCE.citationKey.slice(0, -1)}e` };

    expect(requireDigest(changed)).not.toBe(requireDigest(EVIDENCE));
  });

  it("refuses a partial record whose result count has not reached the inventory", () => {
    const partial = { ...EVIDENCE, results: [], resolvedCount: 0, stoppedAt: [], outcome: "EMPTY" };
    const result = deriveLiveQuiesceEvidenceDigest(partial);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("partial evidence must be refused");
    expect(result.code).toBe("LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH");
    expect(result.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
  });

  it("refuses an unknown top-level key with the evidence layer and stable code", () => {
    expectIncomplete({ ...EVIDENCE, callerDigest: "0".repeat(64) });
  });

  it("refuses a missing required key with the evidence layer and stable code", () => {
    const { stoppedAt: _missing, ...incomplete } = EVIDENCE;
    expectIncomplete(incomplete);
  });

  it("derives from one evidence argument and exposes no caller-digest slot", () => {
    expect(deriveLiveQuiesceEvidenceDigest.length).toBe(1);
  });

  it("refuses absent evidence instead of returning an empty or zero digest", () => {
    expectIncomplete(undefined);
  });
});
