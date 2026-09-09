import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, hex64, openStore } from "../review/review-test-fixtures.js";
import {
  readLandingReceipt, readLatestLandingBaseline, recordLandingBaseline, recordLandingReceipt,
} from "./landing-ledger.js";
import * as landingLedger from "./landing-ledger.js";
import {
  DELETED_BLOB, LANDING_RECEIPT_COMMAND_KIND, NODE_LANDER_PRINCIPAL_ID, decodeLandingBaselineBytes,
  decodeLandingReceiptBytes, landingAggregateId, landingReceiptId,
} from "./landing-receipt-contracts.js";

afterEach(closeStores);

const NODE = "node-ledger-1";
const VERIFIER_RECEIPT = hex64("cd");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

const commitInput = () => ({
  commit: { branch: "main", files: ["src/a.ts"], message: "Land\n", parentSha: null, sha: SHA },
  decidedAt: "2026-09-03T12:00:00.000Z",
  projectId: PROJECT_ID,
  refusal: null,
  subjectRef: NODE,
  verifierReceiptId: VERIFIER_RECEIPT,
  workspace: "D:/ws",
});

describe("landing receipts", () => {
  it("records a committed landing on the node's landing aggregate and reads it back verified", () => {
    const store = openStore();
    const recorded = recordLandingReceipt(store, commitInput());
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.replayed).toBe(false);
    const receiptId = landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT);
    const read = readLandingReceipt(store, PROJECT_ID, receiptId);
    if (!read.ok) throw new Error(read.code);
    expect(read.receipt.outcome).toBe("COMMITTED");
    expect(read.receipt.commit?.sha).toBe(SHA);
    expect(read.decision.commandKind).toBe(LANDING_RECEIPT_COMMAND_KIND);
    expect(read.decision.key.principalId).toBe(NODE_LANDER_PRINCIPAL_ID);
    expect(read.decision.targetAggregateId).toBe(landingAggregateId(NODE));
    // The node's own aggregate is untouched: the review ledger never sees a landing.
    expect(store.getAggregateVersion(NODE)).toBe(0);
    expect(store.getAggregateVersion(landingAggregateId(NODE))).toBe(1);
  });

  it("replays instead of recording a second landing for the same verifier receipt", () => {
    const store = openStore();
    recordLandingReceipt(store, commitInput());
    const again = recordLandingReceipt(store, {
      ...commitInput(), commit: null, refusal: { code: "NOTHING_TO_COMMIT", detail: "late" },
    });
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && again.receipt.outcome).toBe("COMMITTED");
    expect(store.getAggregateVersion(landingAggregateId(NODE))).toBe(1);
  });

  it("records a refusal as a receipt with its code", () => {
    const store = openStore();
    const recorded = recordLandingReceipt(store, {
      ...commitInput(), commit: null, refusal: { code: "LANDING_BASELINE_MISSING", detail: "none" },
    });
    expect(recorded.ok && recorded.receipt.outcome).toBe("REFUSED");
    expect(recorded.ok && recorded.receipt.refusal).toEqual({ code: "LANDING_BASELINE_MISSING", detail: "none" });
  });

  it("answers NOT_FOUND for an unknown receipt id", () => {
    const store = openStore();
    const read = readLandingReceipt(store, PROJECT_ID, hex64("99"));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("LANDING_RECEIPT_NOT_FOUND");
  });
});

describe("landing baselines", () => {
  it("returns an exact baseline identity that still selects the original attempt after retries", () => {
    const store = openStore();
    const first = recordLandingBaseline(store, {
      entries: [{ blobId: DELETED_BLOB, path: "original.ts" }], observedAt: "2026-09-03T11:00:00.000Z",
      projectId: PROJECT_ID, subjectRef: NODE, workspace: "D:/ws",
    });
    expect(first).toMatchObject({ baselineId: expect.stringMatching(/^[a-f0-9]{64}$/u), ok: true });
    if (!first.ok) throw new Error(first.code);
    recordLandingBaseline(store, {
      entries: [], observedAt: "2026-09-03T11:01:00.000Z", projectId: PROJECT_ID, subjectRef: NODE, workspace: "D:/ws",
    });
    expect(landingLedger.readLandingBaseline(store, PROJECT_ID, NODE, first.baselineId)).toEqual(first.baseline);
    expect(landingLedger.readLandingBaseline(store, PROJECT_ID, "other-node", first.baselineId)).toBeNull();
    expect(landingLedger.readLandingBaseline(store, "other-project", NODE, first.baselineId)).toBeNull();
    expect(landingLedger.readLandingBaseline(store, PROJECT_ID, NODE, "f".repeat(64))).toBeNull();
  });

  it("records a baseline per staffing and reads back the latest one", () => {
    const store = openStore();
    const first = recordLandingBaseline(store, {
      entries: [{ blobId: DELETED_BLOB, path: "gone.ts" }], observedAt: "2026-09-03T11:00:00.000Z",
      projectId: PROJECT_ID, subjectRef: NODE, workspace: "D:/ws",
    });
    expect(first.ok).toBe(true);
    const second = recordLandingBaseline(store, {
      entries: [{ blobId: "a".repeat(40), path: "dirty.ts" }], observedAt: "2026-09-03T11:30:00.000Z",
      projectId: PROJECT_ID, subjectRef: NODE, workspace: "D:/ws",
    });
    expect(second.ok).toBe(true);
    expect(readLatestLandingBaseline(store, PROJECT_ID, NODE)?.entries).toEqual([
      { blobId: "a".repeat(40), path: "dirty.ts" },
    ]);
    expect(readLatestLandingBaseline(store, PROJECT_ID, "node-other")).toBeNull();
  });

  it("still finds the latest baseline once a landing receipt sits above it", () => {
    const store = openStore();
    recordLandingBaseline(store, {
      entries: [], observedAt: "2026-09-03T11:00:00.000Z", projectId: PROJECT_ID, subjectRef: NODE,
      workspace: "D:/ws",
    });
    recordLandingReceipt(store, commitInput());
    expect(readLatestLandingBaseline(store, PROJECT_ID, NODE)?.observedAt).toBe("2026-09-03T11:00:00.000Z");
  });
});

describe("landing decoders", () => {
  it("refuse a receipt whose outcome disagrees with its commit and refusal fields", () => {
    const receiptId = landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT);
    const base = {
      commit: null, decidedAt: "2026-09-03T12:00:00.000Z", outcome: "COMMITTED", projectId: PROJECT_ID,
      receiptId, refusal: null, subjectRef: NODE, verifierReceiptId: VERIFIER_RECEIPT,
      version: "moe-landing-receipt/1", workspace: "D:/ws",
    };
    expect(decodeLandingReceiptBytes(encoder.encode(JSON.stringify(base))).ok).toBe(false);
    const refused = { ...base, outcome: "REFUSED", refusal: { code: "X", detail: "" } };
    expect(decodeLandingReceiptBytes(encoder.encode(JSON.stringify(refused))).ok).toBe(true);
    const extraKey = { ...refused, extra: 1 };
    expect(decodeLandingReceiptBytes(encoder.encode(JSON.stringify(extraKey))).ok).toBe(false);
    const wrongId = { ...refused, receiptId: hex64("ee") };
    expect(decodeLandingReceiptBytes(encoder.encode(JSON.stringify(wrongId))).ok).toBe(false);
  });

  it("refuse a baseline entry whose blob id is neither a git object id nor DELETED", () => {
    const baseline = {
      entries: [{ blobId: "not-a-blob", path: "a.ts" }], observedAt: "2026-09-03T11:00:00.000Z",
      projectId: PROJECT_ID, subjectRef: NODE, version: "moe-landing-baseline/1", workspace: "D:/ws",
    };
    expect(decodeLandingBaselineBytes(encoder.encode(JSON.stringify(baseline))).ok).toBe(false);
    const good = { ...baseline, entries: [{ blobId: "a".repeat(40), path: "a.ts" }] };
    expect(decodeLandingBaselineBytes(encoder.encode(JSON.stringify(good))).ok).toBe(true);
  });
});
