import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { runReviewCommand } from "../review/review-services.js";
import {
  calibration, envelope, finding, packageItems, policyInput, seedVerifierReceipt, send, submitPayload,
} from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import { recordNodeVerifierFailure } from "./node-verifier-failure-record.js";

const PROJECT_ID = "withdrawal-record", NODE_REF = "node-a", CREDENTIAL = "test-operator";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "moe-failure-record-"));
  const storePath = join(dir, "store.sqlite");
  const provider = createStoreDependencies({ credential: CREDENTIAL, principalId: "operator-local", projectId: PROJECT_ID, storePath });
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID); installTestRecoveryBinding(store);
  cleanups.push(() => { store.close(); provider.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const ledger = () => readReviewLedger(store, PROJECT_ID, NODE_REF);
  const config = { deps: provider.provide(), operatorCredential: CREDENTIAL, projectId: PROJECT_ID, store };
  return { config, ledger, store };
}
const OUTPUT = "INTEGRATION_CONFLICT: the work is safe on moe/node-a";
const capture = { byteCount: Buffer.byteLength(OUTPUT), exitCode: null, output: OUTPUT,
  sha256: createHash("sha256").update(OUTPUT).digest("hex") };
const authority = { calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
  policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) };

/** A clean round, its verifier receipt, and the acceptance naming it: the ledger sits at round + 2. */
function accept(w: ReturnType<typeof world>): string {
  const receipt = seedVerifierReceipt(w.store, NODE_REF, PROJECT_ID);
  expect(send(w.store, { ...envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: NODE_REF }, "cmd-accept"), projectId: PROJECT_ID }).ok).toBe(true);
  return receipt.receiptId;
}

it("sends a withdrawal at the CURRENT ledger version, under its own command id", () => {
  const w = world(); const receiptId = accept(w);
  const before = w.ledger(); const latest = before.rounds.at(-1)!;
  expect(before.version).toBe(latest.aggregateVersion + 2);

  expect(recordNodeVerifierFailure(w.config, NODE_REF, latest, capture, authority, receiptId)).toMatchObject({ ok: true });

  const decision = decisionsOf(w.store, 200).at(-1)!;
  expect(decision).toMatchObject({ commandKind: "review.submit", currentVersion: before.version + 1,
    key: { commandId: `delivery-withdrawn-${latest.decisionId}` }, previousVersion: before.version });
  expect(w.ledger()).toMatchObject({ accepted: undefined, unreadable: false });
  expect(w.ledger().rounds.at(-1)?.lineage.records.at(-1)?.finding.detail).toContain(OUTPUT);
});

it("would be refused stale at the source round's version, which is why it is not sent there (regression)", () => {
  const w = world(); const receiptId = accept(w);
  const latest = w.ledger().rounds.at(-1)!;

  const sent = runReviewCommand(w.store, new TextEncoder().encode(JSON.stringify({
    ...envelope("review.submit", latest.aggregateVersion, submitPayload(latest.round + 1, [finding()], { subjectRef: NODE_REF }),
      `delivery-withdrawn-${latest.decisionId}`), projectId: PROJECT_ID })), undefined, undefined,
  { aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256, withdraws: receiptId });

  expect(sent).toMatchObject({ ok: false, code: "REVIEW_EXPECTED_VERSION_STALE" });
  expect(w.ledger().accepted?.verifierReceiptId).toBe(receiptId);
});

it("keeps a plain verifier failure exactly as it was: the source round's version and the verify-failure id", () => {
  const w = world();
  expect(send(w.store, { ...envelope("review.submit", 0, submitPayload(1, [], { subjectRef: NODE_REF })), projectId: PROJECT_ID }).ok).toBe(true);
  const latest = w.ledger().rounds.at(-1)!;

  expect(recordNodeVerifierFailure(w.config, NODE_REF, latest, { ...capture, exitCode: 1 }, authority)).toMatchObject({ ok: true });

  const decision = decisionsOf(w.store, 200).at(-1)!;
  expect(decision).toMatchObject({ key: { commandId: `verify-failure-${latest.decisionId}` }, previousVersion: latest.aggregateVersion });
  const result = JSON.parse(new TextDecoder().decode(decision.resultBytes)) as Record<string, unknown>;
  expect(Object.keys(result)).not.toContain("withdrawsAcceptance");
  expect(result["verifierFailureSource"]).toEqual({
    aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256 });
  expect(w.ledger()).toMatchObject({ accepted: undefined, unreadable: false });
});

it("refuses a withdrawal that names no accepted receipt, writing nothing", () => {
  const w = world(); accept(w);
  const before = w.ledger();

  expect(recordNodeVerifierFailure(w.config, NODE_REF, before.rounds.at(-1)!, capture, authority, "verifier-receipt-of-another-node"))
    .toEqual({ ok: false, code: "REVIEW_ALREADY_ACCEPTED" });
  expect(w.ledger()).toMatchObject({ accepted: before.accepted, version: before.version });
});
