import { describe, expect, it } from "vitest";

import {
  LIVE_QUIESCE_EVIDENCE_LAYER,
  deriveLiveQuiesceEvidenceDigest,
  serializeLiveQuiesceEvidenceCanonical,
} from "./cutover-quiesce-evidence.js";

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
