/**
 * THE DURABLE RECEIPT, read back from a REAL store through the production reader.
 *
 * Every arm asserts against `readPreviewReceipt`'s output, never against the object handed to
 * the writer — the writer returns what the store HOLDS precisely so a test cannot pass on an
 * intention that never persisted.
 */
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { readPreviewReceipt, recordPreviewReceipt } from "./preview-ledger.js";
import {
  PREVIEW_RECEIPT_COMMAND_KIND, PREVIEW_RECEIPT_VERSION, PREVIEW_RUNNER_PRINCIPAL_ID,
  decodePreviewReceiptBytes, previewAggregateId, previewCaptureDirectory, previewReceiptId,
  previewReceiptLayer,
} from "./preview-receipt-contracts.js";
import type { PreviewReceiptV1 } from "./preview-receipt-contracts.js";

afterEach(closeStores);

const GOAL = "goal-preview-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-05T12:00:00.000Z";
const PREFIX = previewCaptureDirectory(GOAL, SHA);

const encoder = new TextEncoder();

const startedInput = () => ({
  code: null,
  decidedAt: DECIDED_AT,
  goalId: GOAL,
  pid: 4242,
  projectId: PROJECT_ID,
  screenshots: [{ journeyRef: "journey-home", path: `${PREFIX}/journey-home.png` }],
  sha: SHA,
  url: "http://127.0.0.1:5173",
});

const refusedInput = () => ({
  code: "PREVIEW_COMMAND_MISSING" as const,
  decidedAt: DECIDED_AT,
  goalId: GOAL,
  pid: null,
  projectId: PROJECT_ID,
  screenshots: [],
  sha: SHA,
  url: null,
});

/** Bytes shaped like a receipt, so a decoder arm can perturb ONE member at a time. */
function receiptBytes(overrides: Partial<Record<keyof PreviewReceiptV1, unknown>>): Uint8Array {
  return encoder.encode(JSON.stringify({
    code: null,
    decidedAt: DECIDED_AT,
    goalId: GOAL,
    outcome: "STARTED",
    pid: 4242,
    projectId: PROJECT_ID,
    receiptId: previewReceiptId(PROJECT_ID, GOAL, SHA),
    screenshots: [{ journeyRef: "journey-home", path: `${PREFIX}/journey-home.png` }],
    sha: SHA,
    url: "http://127.0.0.1:5173",
    version: PREVIEW_RECEIPT_VERSION,
    ...overrides,
  }));
}

describe("a STARTED preview receipt", () => {
  it("reads back with EVERY member intact, on the goal's own preview aggregate", () => {
    const store = openStore();
    const recorded = recordPreviewReceipt(store, startedInput());
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.replayed).toBe(false);

    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL, SHA));
    if (!read.ok) throw new Error(read.code);
    expect(read.receipt).toStrictEqual({
      code: null,
      decidedAt: DECIDED_AT,
      goalId: GOAL,
      outcome: "STARTED",
      pid: 4242,
      projectId: PROJECT_ID,
      receiptId: previewReceiptId(PROJECT_ID, GOAL, SHA),
      screenshots: [{ journeyRef: "journey-home", path: `${PREFIX}/journey-home.png` }],
      sha: SHA,
      url: "http://127.0.0.1:5173",
      version: PREVIEW_RECEIPT_VERSION,
    });
    // BESIDE the goal, never on it: a preview must not move a version the planner reads against.
    expect(store.getAggregateVersion(GOAL)).toBe(0);
    expect(store.getAggregateVersion(previewAggregateId(GOAL))).toBe(1);
  });

  it("carries no layer, because nothing refused", () => {
    const store = openStore();
    const recorded = recordPreviewReceipt(store, startedInput());
    if (!recorded.ok) throw new Error(recorded.code);
    expect(previewReceiptLayer(recorded.receipt)).toBeNull();
  });
});

describe("a REFUSED preview receipt", () => {
  it("carries its CODE and NO url — an operator cannot click into nothing", () => {
    const store = openStore();
    const recorded = recordPreviewReceipt(store, refusedInput());
    if (!recorded.ok) throw new Error(recorded.code);

    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL, SHA));
    if (!read.ok) throw new Error(read.code);
    expect(read.receipt.outcome).toBe("REFUSED");
    expect(read.receipt.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(read.receipt.url).toBeNull();
    expect(read.receipt.pid).toBeNull();
    expect(read.receipt.screenshots).toStrictEqual([]);
    // The LAYER is re-derived from the vocabulary's closed map, never stored beside the code.
    expect(previewReceiptLayer(read.receipt)).toBe("RUNNER");
  });

  it("is a RECORD, not an absence: the refusal is durable and readable", () => {
    const store = openStore();
    const before = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL, SHA));
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error("unexpected receipt");
    expect(before.code).toBe("PREVIEW_RECEIPT_NOT_FOUND");

    recordPreviewReceipt(store, refusedInput());

    const after = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL, SHA));
    expect(after.ok).toBe(true);
  });
});

describe("the receipt id is a pure function of (projectId, goalId, sha)", () => {
  it("is STABLE across a repeated run, so a restart starts no second server", () => {
    // The property the id exists for: the run behind a receipt BINDS A PORT, and a second id
    // would start a second server that could not bind against the first.
    const store = openStore();
    const first = recordPreviewReceipt(store, startedInput());
    const second = recordPreviewReceipt(store, startedInput());
    if (!first.ok || !second.ok) throw new Error("record failed");

    expect(second.replayed).toBe(true);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.receipt).toStrictEqual(first.receipt);
    // ONE decision, not two: the replay wrote nothing.
    expect(store.getAggregateVersion(previewAggregateId(GOAL))).toBe(1);
  });

  it("REPLAYS THE FIRST OUTCOME rather than overwriting it with a later one", () => {
    // A refusal for a revision already previewed must not erase the STARTED receipt an operator
    // may be looking at.
    const store = openStore();
    const first = recordPreviewReceipt(store, startedInput());
    const second = recordPreviewReceipt(store, refusedInput());
    if (!first.ok || !second.ok) throw new Error("record failed");
    expect(second.replayed).toBe(true);
    expect(second.receipt.outcome).toBe("STARTED");
    expect(second.receipt.url).toBe("http://127.0.0.1:5173");
  });

  it("differs for a different sha, project or goal", () => {
    const base = previewReceiptId(PROJECT_ID, GOAL, SHA);
    expect(previewReceiptId(PROJECT_ID, GOAL, `${SHA.slice(0, 39)}b`)).not.toBe(base);
    expect(previewReceiptId(PROJECT_ID, "goal-other", SHA)).not.toBe(base);
    expect(previewReceiptId("project-other", GOAL, SHA)).not.toBe(base);
  });

  it("is written under the runner's reserved principal and internal command kind", () => {
    const store = openStore();
    recordPreviewReceipt(store, startedInput());
    const decision = store.getCommandDecision({
      commandId: previewReceiptId(PROJECT_ID, GOAL, SHA),
      principalId: PREVIEW_RUNNER_PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(decision?.commandKind).toBe(PREVIEW_RECEIPT_COMMAND_KIND);
    expect(decision?.targetAggregateId).toBe(previewAggregateId(GOAL));
  });
});

describe("the decoder refuses a receipt it did not write", () => {
  it("refuses a REFUSED receipt that still advertises a url", () => {
    // The exact half-built shape the equivalence checks exist to make impossible.
    expect(decodePreviewReceiptBytes(receiptBytes({
      code: "PREVIEW_COMMAND_MISSING", outcome: "REFUSED", pid: null, screenshots: [],
    })).ok).toBe(false);
  });

  it("refuses a STARTED receipt with no url, and one with no pid", () => {
    expect(decodePreviewReceiptBytes(receiptBytes({ url: null })).ok).toBe(false);
    expect(decodePreviewReceiptBytes(receiptBytes({ pid: null })).ok).toBe(false);
  });

  it("refuses a STARTED receipt that also carries a refusal code", () => {
    expect(decodePreviewReceiptBytes(receiptBytes({ code: "PREVIEW_START_TIMEOUT" })).ok).toBe(false);
  });

  it("refuses a REFUSED receipt carrying screenshots of a product that never started", () => {
    expect(decodePreviewReceiptBytes(receiptBytes({
      code: "PREVIEW_COMMAND_MISSING", outcome: "REFUSED", pid: null, url: null,
    })).ok).toBe(false);
  });

  it("refuses a code outside the vocabulary's closed map", () => {
    expect(decodePreviewReceiptBytes(receiptBytes({
      code: "PREVIEW_MADE_UP", outcome: "REFUSED", pid: null, screenshots: [], url: null,
    })).ok).toBe(false);
  });

  it("refuses a screenshot path outside THIS run's own directory", () => {
    for (const path of [
      ".moe-next/previews/other-goal/other-sha/shot.png",
      `${PREFIX}/../../escape.png`,
      `${PREFIX}\\windows.png`,
      "shot.png",
    ]) {
      expect(decodePreviewReceiptBytes(receiptBytes({
        screenshots: [{ journeyRef: "j", path }],
      })).ok).toBe(false);
    }
  });

  it("refuses a receipt whose id is not the hash of its own members", () => {
    // Without this, a record could be filed under one revision while describing another.
    expect(decodePreviewReceiptBytes(receiptBytes({
      receiptId: previewReceiptId(PROJECT_ID, "goal-other", SHA),
    })).ok).toBe(false);
  });

  it("refuses an unknown key and a missing one", () => {
    const withExtra = JSON.parse(new TextDecoder().decode(receiptBytes({}))) as Record<string, unknown>;
    withExtra["severity"] = "high";
    expect(decodePreviewReceiptBytes(encoder.encode(JSON.stringify(withExtra))).ok).toBe(false);

    const withMissing = JSON.parse(new TextDecoder().decode(receiptBytes({}))) as Record<string, unknown>;
    delete withMissing["sha"];
    expect(decodePreviewReceiptBytes(encoder.encode(JSON.stringify(withMissing))).ok).toBe(false);
  });

  it("ACCEPTS the shape it does write, so the arms above are not vacuous", () => {
    const decoded = decodePreviewReceiptBytes(receiptBytes({}));
    expect(decoded.ok).toBe(true);
  });
});
