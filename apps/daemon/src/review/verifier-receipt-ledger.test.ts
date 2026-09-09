import { afterEach, describe, expect, it } from "vitest";

import {
  NODE_VERIFIER_PRINCIPAL_ID,
  readVerifierReceipt,
  recordVerifierReceipt,
} from "./verifier-receipt-ledger.js";
import {
  VERIFIER_RECEIPT_COMMAND_KIND,
  decodeVerifierReceiptBytes,
  verifierReceiptId,
} from "./verifier-receipt-contracts.js";
import { readReviewLedger } from "./review-read-model.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  calibration,
  closeStores,
  envelope,
  openStore,
  packageItems,
  policyInput,
  send,
  submitPayload,
} from "./review-test-fixtures.js";

afterEach(closeStores);

const authority = () => ({
  calibration: calibration(),
  packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
  policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
});

function seedCleanRound(store: ReturnType<typeof openStore>, subjectRef = SUBJECT_REF): void {
  const submitted = send(store, envelope(
    "review.submit",
    0,
    submitPayload(1, [], { subjectRef }),
    `cmd-clean-${subjectRef}`,
  ));
  if (!submitted.ok) throw new Error(submitted.code);
}

function sourceFor(store: ReturnType<typeof openStore>) {
  const latest = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1);
  if (latest === undefined) throw new Error("missing receipt source");
  return {
    aggregateVersion: latest.aggregateVersion,
    decisionId: latest.decisionId,
    resultSha256: latest.resultSha256,
  };
}

describe("durable verifier receipts", () => {
  it("binds the receipt to the immutable tested workspace and rejects altered binding bytes", () => {
    const store = openStore();
    seedCleanRound(store);
    const workspaceBinding = {
      branchRef: "refs/heads/main", dirtySha256: "d".repeat(64), headSha: "1".repeat(40), root: "/workspace",
      treeSha: "2".repeat(40), version: "moe-verified-workspace/1" as const,
    };
    const input = {
      authority: authority(), decidedAt: "2026-08-16T00:00:00.000Z",
      execution: { byteCount: 12, outputSha256: "a".repeat(64), test: "pnpm test", workspace: "/workspace", workspaceBinding },
      projectId: PROJECT_ID, source: sourceFor(store), subjectRef: SUBJECT_REF,
    };
    const recorded = recordVerifierReceipt(store, input);
    expect(recorded.ok, recorded.ok ? "" : recorded.code).toBe(true);
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.receipt.execution.workspaceBinding).toEqual(workspaceBinding);
    for (const corrupt of [null, { ...workspaceBinding, treeSha: "3".repeat(40) }, { ...workspaceBinding, extra: 1 }]) {
      expect(decodeVerifierReceiptBytes(new TextEncoder().encode(JSON.stringify({
        ...recorded.receipt, execution: { ...recorded.receipt.execution, workspaceBinding: corrupt },
      })))).toEqual({ code: "VERIFIER_RECEIPT_INVALID", ok: false });
    }
    expect(recordVerifierReceipt(store, { ...input, execution: {
      ...input.execution, workspaceBinding: { ...workspaceBinding, treeSha: "3".repeat(40) },
    } })).toEqual({ code: "VERIFIER_RECEIPT_STALE", ok: false });
  });

  it("records the receipt immediately after the clean source round and reads it exactly", () => {
    const store = openStore();
    seedCleanRound(store);

    const recorded = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2026-08-16T00:00:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: sourceFor(store),
      subjectRef: SUBJECT_REF,
    });

    expect(recorded.ok, recorded.ok ? "" : recorded.code).toBe(true);
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.decision.previousVersion).toBe(1);
    expect(recorded.decision.currentVersion).toBe(2);
    const loaded = readVerifierReceipt(store, PROJECT_ID, recorded.receipt.receiptId);
    expect(loaded.ok, loaded.ok ? "" : loaded.code).toBe(true);
    if (!loaded.ok) throw new Error(loaded.code);
    expect(loaded.receipt).toEqual(recorded.receipt);
    expect(loaded.receiptSha256).toBe(recorded.decision.resultSha256);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version).toBe(2);

    const replay = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2030-01-01T00:00:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: sourceFor(store),
      subjectRef: SUBJECT_REF,
    });
    expect(replay.ok, replay.ok ? "" : replay.code).toBe(true);
    if (!replay.ok) throw new Error(replay.code);
    expect(replay.disposition).toBe("REPLAYED");
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version).toBe(2);
  });

  it("does not replay a historical receipt after another decision advances the aggregate", () => {
    const store = openStore();
    seedCleanRound(store);
    const recorded = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2026-08-16T00:00:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: sourceFor(store),
      subjectRef: SUBJECT_REF,
    });
    if (!recorded.ok) throw new Error(recorded.code);
    const bytes = new TextEncoder().encode("{}");
    const advanced = store.commitExpectedVersionDecision({
      commandKind: "internal.test.advance",
      committedResultBytes: bytes,
      correlationId: "advance-after-receipt",
      decidedAt: "2026-08-16T00:01:00.000Z",
      events: [{
        eventId: "advance-after-receipt-event",
        eventType: "InternalTestAdvanced",
        payload: bytes,
      }],
      expectedVersion: 2,
      key: {
        commandId: "advance-after-receipt",
        principalId: NODE_VERIFIER_PRINCIPAL_ID,
        projectId: PROJECT_ID,
      },
      requestBytes: bytes,
      targetAggregateId: SUBJECT_REF,
    });
    expect(advanced.decision.effectDisposition).toBe("EFFECTS_COMMITTED");

    const replay = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2026-08-16T00:02:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: sourceFor(store),
      subjectRef: SUBJECT_REF,
    });
    expect(replay).toEqual({ code: "VERIFIER_RECEIPT_STALE", ok: false });
  });

  it("refuses to mint a receipt when the latest review round is not clean", () => {
    const store = openStore();
    const submitted = send(store, envelope("review.submit", 0, submitPayload(1)));
    if (!submitted.ok) throw new Error(submitted.code);

    const recorded = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2026-08-16T00:00:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: sourceFor(store),
      subjectRef: SUBJECT_REF,
    });

    expect(recorded).toEqual({ code: "VERIFIER_SOURCE_NOT_CLEAN", ok: false });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version).toBe(1);
  });

  it("refuses when a newer clean submission lands after the verifier captured its source", () => {
    const store = openStore();
    seedCleanRound(store);
    const captured = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
    if (captured === undefined) throw new Error("missing captured source");
    const newer = send(store, envelope(
      "review.submit",
      1,
      submitPayload(2, []),
      "cmd-newer-clean-round",
    ));
    if (!newer.ok) throw new Error(newer.code);

    const recorded = recordVerifierReceipt(store, {
      authority: authority(),
      decidedAt: "2026-08-16T00:00:00.000Z",
      execution: {
        byteCount: 12,
        outputSha256: "a".repeat(64),
        test: "pnpm test",
        workspace: "/workspace",
      },
      projectId: PROJECT_ID,
      source: {
        aggregateVersion: captured.aggregateVersion,
        decisionId: captured.decisionId,
        resultSha256: captured.resultSha256,
      },
      subjectRef: SUBJECT_REF,
    });

    expect(recorded).toEqual({ code: "VERIFIER_RECEIPT_STALE", ok: false });
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version).toBe(2);
  });

  it("fails closed when the service-principal decision contains malformed receipt bytes", () => {
    const store = openStore();
    seedCleanRound(store);
    const source = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
    if (source === undefined) throw new Error("missing source round");
    const receiptId = verifierReceiptId(PROJECT_ID, SUBJECT_REF, source.decisionId);
    store.commitExpectedVersionDecision({
      commandKind: VERIFIER_RECEIPT_COMMAND_KIND,
      committedResultBytes: new TextEncoder().encode("{}"),
      correlationId: "tamper",
      decidedAt: "2026-08-16T00:00:00.000Z",
      events: [{
        eventId: `${receiptId}-bad`,
        eventType: "VerifierReceiptRecorded",
        payload: new TextEncoder().encode("{}"),
      }],
      expectedVersion: 1,
      key: {
        commandId: receiptId,
        principalId: NODE_VERIFIER_PRINCIPAL_ID,
        projectId: PROJECT_ID,
      },
      requestBytes: new TextEncoder().encode("{}"),
      targetAggregateId: SUBJECT_REF,
    });

    expect(readVerifierReceipt(store, PROJECT_ID, receiptId)).toEqual({
      code: "VERIFIER_RECEIPT_INVALID",
      ok: false,
    });
  });
});
