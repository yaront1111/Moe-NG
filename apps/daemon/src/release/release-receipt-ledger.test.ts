import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { RELEASE_DECIDE_CODES } from "./release-decide-contracts.js";
import type { ReleaseDecideCode } from "./release-decide-contracts.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import { GOAL_ID, HEAD_SHA, OTHER_SHA } from "./release-dossier-fixtures.js";
import {
  RELEASE_RECEIPT_COMMAND_KIND, RELEASE_RECEIPT_PRINCIPAL_ID, decodeReleaseReceiptBytes,
  dossierSha256, releaseReceiptId,
} from "./release-receipt-contracts.js";
import { readReleaseReceipt, recordReleaseReceipt } from "./release-receipt-ledger.js";
import type { RecordReleaseReceiptInput } from "./release-receipt-ledger.js";

afterEach(closeStores);

const DECIDED_AT = "2026-09-06T12:00:00.000Z";
const PR_URL = "https://github.com/acme/widget/pull/7";
const MARKDOWN = "# Release dossier: widget\n\n- Goal: goal-1\n";
const DOSSIER_SHA = dossierSha256(MARKDOWN);
const AGGREGATE = releaseDossierAggregateId(GOAL_ID);

const released = (over: Partial<RecordReleaseReceiptInput> = {}): RecordReleaseReceiptInput => ({
  decidedAt: DECIDED_AT,
  dossierSha256: DOSSIER_SHA,
  goalId: GOAL_ID,
  outcome: "RELEASED",
  prUrl: PR_URL,
  projectId: PROJECT_ID,
  refusalCode: null,
  sha: HEAD_SHA,
  ...over,
});

const refused = (code: ReleaseDecideCode): RecordReleaseReceiptInput =>
  released({ outcome: "REFUSED", prUrl: null, refusalCode: code });

describe("release receipt durable bytes", () => {
  it("reads back a RELEASED receipt whose every member survives the round trip", () => {
    const store = openStore();
    const recorded = recordReleaseReceipt(store, released());
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.replayed).toBe(false);

    const read = readReleaseReceipt(store, PROJECT_ID, recorded.receipt.receiptId);
    if (!read.ok) throw new Error(read.code);
    // Each member asserted on its own: a single toStrictEqual against an object built from
    // the same literals passes even when the ledger drops a field on the way through.
    expect(read.receipt.goalId).toBe(GOAL_ID);
    expect(read.receipt.sha).toBe(HEAD_SHA);
    expect(read.receipt.projectId).toBe(PROJECT_ID);
    expect(read.receipt.dossierSha256).toBe(DOSSIER_SHA);
    expect(read.receipt.prUrl).toBe(PR_URL);
    expect(read.receipt.outcome).toBe("RELEASED");
    expect(read.receipt.refusalCode).toBeNull();
    expect(read.receipt.version).toBe("moe-release-receipt/1");
    expect(read.receipt.receiptId).toBe(recorded.receipt.receiptId);

    expect(read.decision.commandKind).toBe(RELEASE_RECEIPT_COMMAND_KIND);
    expect(read.decision.key.principalId).toBe(RELEASE_RECEIPT_PRINCIPAL_ID);
    // Beside the goal, never on it, and on the SAME aggregate the dossier lands on.
    expect(read.decision.targetAggregateId).toBe(AGGREGATE);
    expect(store.getAggregateVersion(GOAL_ID)).toBe(0);
  });

  it("records a REFUSED receipt per code, each carrying that code and NO prUrl", () => {
    expect(RELEASE_DECIDE_CODES.length).toBe(3);
    for (const code of RELEASE_DECIDE_CODES) {
      const store = openStore();
      const recorded = recordReleaseReceipt(store, refused(code));
      if (!recorded.ok) throw new Error(recorded.code);
      const read = readReleaseReceipt(store, PROJECT_ID, recorded.receipt.receiptId);
      if (!read.ok) throw new Error(read.code);
      expect(read.receipt.outcome).toBe("REFUSED");
      expect(read.receipt.refusalCode).toBe(code);
      expect(read.receipt.prUrl).toBeNull();
    }
  });

  it("replays a repeated record and appends no second event to the aggregate", () => {
    const store = openStore();
    const before = store.getAggregateVersion(AGGREGATE);
    const first = recordReleaseReceipt(store, released());
    const afterFirst = store.getAggregateVersion(AGGREGATE);
    const second = recordReleaseReceipt(store, released());
    const afterSecond = store.getAggregateVersion(AGGREGATE);
    if (!first.ok || !second.ok) throw new Error("record refused");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(before).toBe(0);
    expect(afterFirst).toBe(1);
    // The count is the assertion: one decision, one event, however often it is asked for.
    expect(afterSecond).toBe(afterFirst);
  });

  it("keeps a later RELEASED at the same sha distinct from an earlier REFUSED", () => {
    // The behaviour the id derivation exists for. An operator whose first attempt refused
    // RELEASE_PR_FAILED (no gh installed) installs it and retries the SAME sha. Were the
    // id keyed on (project, goal, sha) alone, the ledger's replay path would answer with
    // the stored REFUSAL and the successful release would never be recorded at all.
    const store = openStore();
    const first = recordReleaseReceipt(store, refused("RELEASE_PR_FAILED"));
    const second = recordReleaseReceipt(store, released());
    if (!first.ok || !second.ok) throw new Error("record refused");
    expect(second.replayed).toBe(false);
    expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
    expect(second.receipt.outcome).toBe("RELEASED");
    expect(store.getAggregateVersion(AGGREGATE)).toBe(2);
    // Two DIFFERENT refusals at one sha are likewise two facts, not one overwritten.
    expect(releaseReceiptId(PROJECT_ID, GOAL_ID, HEAD_SHA, "REFUSED", "RELEASE_PR_FAILED"))
      .not.toBe(
        releaseReceiptId(PROJECT_ID, GOAL_ID, HEAD_SHA, "REFUSED", "RELEASE_REMOTE_MISSING"),
      );
    expect(releaseReceiptId(PROJECT_ID, GOAL_ID, HEAD_SHA, "RELEASED", null))
      .not.toBe(releaseReceiptId(PROJECT_ID, GOAL_ID, OTHER_SHA, "RELEASED", null));
  });

  it("answers RELEASE_RECEIPT_NOT_FOUND for an id that was never recorded", () => {
    const read = readReleaseReceipt(
      openStore(), PROJECT_ID, releaseReceiptId(PROJECT_ID, GOAL_ID, HEAD_SHA, "RELEASED", null),
    );
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.code).toBe("RELEASE_RECEIPT_NOT_FOUND");
  });
});

describe("release receipt byte decoding", () => {
  const bytesOf = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));

  /** A body whose id always re-derives, so any refusal below comes from the INVARIANT. */
  const body = (
    outcome: "RELEASED" | "REFUSED", prUrl: string | null, refusalCode: string | null,
  ): Record<string, unknown> => ({
    dossierSha256: DOSSIER_SHA,
    goalId: GOAL_ID,
    outcome,
    prUrl,
    projectId: PROJECT_ID,
    receiptId: releaseReceiptId(
      PROJECT_ID, GOAL_ID, HEAD_SHA, outcome, refusalCode as ReleaseDecideCode | null,
    ),
    refusalCode,
    sha: HEAD_SHA,
    version: "moe-release-receipt/1",
  });

  it("accepts bytes it wrote, on both outcomes", () => {
    expect(decodeReleaseReceiptBytes(bytesOf(body("RELEASED", PR_URL, null))).ok).toBe(true);
    expect(decodeReleaseReceiptBytes(bytesOf(body("REFUSED", null, "RELEASE_PR_FAILED"))).ok)
      .toBe(true);
  });

  /**
   * Every forged shape is LABELLED, and the label is passed to `expect`. A bare
   * `expect(decoded.ok).toBe(false)` inside a loop reports "expected true to be false"
   * and leaves the reader to bisect the array to learn which shape slipped through —
   * measured, not assumed: the step-5 mutation drill produced exactly that message.
   */
  const forgeries: readonly (readonly [string, Record<string, unknown>])[] = [
    ["RELEASED with no pull request to point at", body("RELEASED", null, null)],
    ["RELEASED also carrying a refusal code", body("RELEASED", PR_URL, "RELEASE_PR_FAILED")],
    ["REFUSED carrying a prUrl (refused-but-recorded-success)",
      body("REFUSED", PR_URL, "RELEASE_PR_FAILED")],
    ["REFUSED with no code, telling a reader nothing", body("REFUSED", null, null)],
    ["REFUSED with a code this vocabulary never minted",
      body("REFUSED", null, "RELEASE_NOT_A_REAL_CODE")],
    ["RELEASED with an empty prUrl: malformed, not absent", body("RELEASED", "", null)],
  ];

  it("refuses every shape the RELEASED/REFUSED invariant forbids", () => {
    for (const [label, forged] of forgeries) {
      const decoded = decodeReleaseReceiptBytes(bytesOf(forged));
      expect(decoded.ok, label).toBe(false);
      if (decoded.ok) throw new Error(`expected a refusal: ${label}`);
      expect(decoded.code, label).toBe("RELEASE_RECEIPT_INVALID");
    }
  });

  it("refuses bytes whose id does not re-derive, and bytes with a wrong key roster", () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ["id does not re-derive from the carried sha",
        { ...body("RELEASED", PR_URL, null), sha: OTHER_SHA }],
      ["an extra key outside the closed roster", { ...body("RELEASED", PR_URL, null), extra: 1 }],
      ["a version this decoder never wrote",
        { ...body("RELEASED", PR_URL, null), version: "moe-release-receipt/2" }],
      ["a missing key", (() => {
        const { prUrl: _dropped, ...rest } = body("RELEASED", PR_URL, null);
        return rest;
      })()],
    ];
    for (const [label, forged] of cases) {
      const decoded = decodeReleaseReceiptBytes(bytesOf(forged));
      expect(decoded.ok, label).toBe(false);
      if (decoded.ok) throw new Error(`expected a refusal: ${label}`);
      expect(decoded.code, label).toBe("RELEASE_RECEIPT_INVALID");
    }
  });
});
