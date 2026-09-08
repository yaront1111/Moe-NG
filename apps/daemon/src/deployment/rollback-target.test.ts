import { describe, expect, it } from "vitest";

import type { EnvironmentDeployState } from "./deploy-ledger.js";
import {
  DEPLOY_BUILD_FAILED, DEPLOY_ENGINE_STAMP, DEPLOY_RECEIPT_VERSION, deployReceiptId,
} from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";
import { resolveRollbackTarget } from "./rollback-target.js";

const PROJECT = "proj-rollback-target";
const ENVIRONMENT = "staging";
const HEX64 = /^[0-9a-f]{64}$/u;

function receipt(
  decisionId: string,
  overrides: Partial<Pick<DeployReceiptV1, "imageDigest" | "outcome" | "refusal" | "sha">> = {},
): DeployReceiptV1 {
  const refused = overrides.outcome === "REFUSED";
  return Object.freeze({
    decidedAt: `2026-09-08T00:00:0${decisionId.slice(-1)}.000Z`,
    decisionId,
    environment: ENVIRONMENT,
    imageDigest: refused ? null : `sha256:${decisionId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    outcome: "DEPLOYED" as const,
    projectId: PROJECT,
    receiptId: deployReceiptId(PROJECT, ENVIRONMENT, decisionId),
    refusal: refused
      ? { code: DEPLOY_BUILD_FAILED, detail: "boom", layer: DEPLOY_ENGINE_STAMP }
      : null,
    releaseDecision: null,
    sha: `${decisionId}0`.repeat(20).slice(0, 40),
    url: null,
    version: DEPLOY_RECEIPT_VERSION,
    ...overrides,
  });
}

/** The ledger's own shape: `previous` is POSITIONAL over the raw list, refusals included. */
function state(receipts: readonly DeployReceiptV1[]): EnvironmentDeployState {
  const current = receipts[receipts.length - 1];
  if (current === undefined) throw new Error("a deploy state always has a current receipt");
  return Object.freeze({
    current, previous: receipts[receipts.length - 2] ?? null, receipts: Object.freeze([...receipts]),
  });
}

describe("resolveRollbackTarget", () => {
  it("names the OLDER of two successful deploys, because the newer one is running", () => {
    const older = receipt("a");
    const newer = receipt("b");

    const target = resolveRollbackTarget(state([older, newer]));

    expect(target?.toReceiptRef).toBe(older.receiptId);
    expect(target?.sha).toBe(older.sha);
    expect(target?.imageDigest).toBe(older.imageDigest);
  });

  it("skips a trailing REFUSED receipt: [DEPLOYED A, DEPLOYED B, REFUSED C] targets A", () => {
    // THE ARM `rollbackSha` GETS WRONG. Positional `previous` here is B — the receipt still
    // running — because the refusal C never replaced it.
    const a = receipt("a");
    const b = receipt("b");
    const c = receipt("c", { outcome: "REFUSED" });
    const ledger = state([a, b, c]);

    const target = resolveRollbackTarget(ledger);

    expect(target?.toReceiptRef).toBe(a.receiptId);
    expect(target?.toReceiptRef).not.toBe(b.receiptId);
    expect(target?.toReceiptRef).not.toBe(c.receiptId);
    expect(ledger.previous?.receiptId).toBe(b.receiptId);
  });

  it("answers null for [DEPLOYED A, REFUSED B]: A is running and nothing sits behind it", () => {
    const a = receipt("a");
    const b = receipt("b", { outcome: "REFUSED" });

    expect(resolveRollbackTarget(state([a, b]))).toBeNull();
  });

  it("skips a DEPLOYED receipt carrying no image digest", () => {
    const digestless = receipt("a", { imageDigest: null });
    const older = receipt("b");
    const running = receipt("c");

    const target = resolveRollbackTarget(state([digestless, older, running]));

    expect(target?.toReceiptRef).toBe(older.receiptId);
    expect(target?.toReceiptRef).not.toBe(digestless.receiptId);
  });

  it("answers null when a digest-less receipt leaves fewer than two spendable deploys", () => {
    expect(resolveRollbackTarget(state([receipt("a", { imageDigest: null }), receipt("b")]))).toBeNull();
  });

  it("answers null for one deploy, for an empty history and for no state at all", () => {
    expect(resolveRollbackTarget(state([receipt("a")]))).toBeNull();
    expect(resolveRollbackTarget(Object.freeze({
      current: receipt("a"), previous: null, receipts: Object.freeze([]),
    }))).toBeNull();
    expect(resolveRollbackTarget(null)).toBeNull();
  });

  it("returns a toReceiptRef the rollback handler's 64-hex payload gate admits by construction", () => {
    const target = resolveRollbackTarget(state([receipt("a"), receipt("b")]));

    expect(target).not.toBeNull();
    expect(target?.toReceiptRef).toMatch(HEX64);
  });
});
