import { describe, expect, it } from "vitest";

import {
  DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT, DEPLOY_RECEIPT_VERSION, decodeDeployReceiptBytes,
  deployImageTag, deployReceiptId,
} from "./deploy-receipt-contracts.js";

/**
 * The null-pairing discipline is a VALIDATOR, not a type. `T | null` on both
 * sides merely permits the pairing; these cases are what make it a rule.
 */

const PROJECT = "project-deploy-1";
const ENVIRONMENT = "production";
const DECISION = "decision-deploy-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"b".repeat(64)}`;
const encoder = new TextEncoder();

const receiptFields = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  decidedAt: "2026-09-06T00:00:00.000Z",
  decisionId: DECISION,
  environment: ENVIRONMENT,
  imageDigest: DIGEST,
  outcome: "DEPLOYED",
  projectId: PROJECT,
  receiptId: deployReceiptId(PROJECT, ENVIRONMENT, DECISION),
  refusal: null,
  releaseDecision: null,
  sha: SHA,
  url: "https://app.example.test",
  version: DEPLOY_RECEIPT_VERSION,
  ...overrides,
});

const decode = (fields: Record<string, unknown>) =>
  decodeDeployReceiptBytes(encoder.encode(JSON.stringify(fields)));

const refused = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  receiptFields({
    imageDigest: null,
    outcome: "REFUSED",
    refusal: { code: DEPLOY_HEALTH_TIMEOUT, detail: "candidate never healthy", layer: DEPLOY_ENGINE_STAMP },
    ...overrides,
  });

describe("deployImageTag", () => {
  it("puts the sha VALUE in the tag, so a rollback can resolve the commit back", () => {
    // Asserted as a VALUE, not `toMatch(/[0-9a-f]{40}/)` — a pattern passes for the WRONG sha.
    expect(deployImageTag(ENVIRONMENT, SHA)).toBe(`moe-deploy-production:${SHA}`);
    expect(deployImageTag(ENVIRONMENT, SHA).split(":")[1]).toBe(SHA);
  });
});

describe("decodeDeployReceiptBytes", () => {
  it("round-trips a DEPLOYED receipt carrying an imageDigest and a NULL refusal", () => {
    const decoded = decode(receiptFields());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected a decoded receipt");
    expect(decoded.receipt.outcome).toBe("DEPLOYED");
    expect(decoded.receipt.imageDigest).toBe(DIGEST);
    expect(decoded.receipt.refusal).toBeNull();
    expect(decoded.receipt.sha).toBe(SHA);
    expect(decoded.receipt.environment).toBe(ENVIRONMENT);
  });

  it("round-trips a REFUSED receipt carrying its code, its layer and a NULL imageDigest", () => {
    const decoded = decode(refused());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected a decoded receipt");
    expect(decoded.receipt.outcome).toBe("REFUSED");
    expect(decoded.receipt.imageDigest).toBeNull();
    expect(decoded.receipt.refusal?.code).toBe(DEPLOY_HEALTH_TIMEOUT);
    expect(decoded.receipt.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
  });

  it("REFUSES a receipt carrying BOTH an imageDigest and a refusal", () => {
    // Without this case the shape merely PERMITS nulls on both sides, which is
    // the absence of a discipline rather than one.
    expect(decode(refused({ imageDigest: DIGEST }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    expect(decode(receiptFields({
      refusal: { code: DEPLOY_HEALTH_TIMEOUT, detail: "d", layer: DEPLOY_ENGINE_STAMP },
    }))).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
  });

  it("REFUSES a receipt carrying NEITHER an imageDigest nor a refusal", () => {
    expect(decode(receiptFields({ imageDigest: null }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    expect(decode(refused({ refusal: null }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
  });

  it("refuses a sha of the right length in the wrong alphabet, and valid hex of the wrong length", () => {
    // The anchored pattern is what stops a tag that is not a sha from ever
    // being written — cheaper to catch here than at rollback.
    const wrongAlphabet = `${"z".repeat(4)}${SHA.slice(4)}`;
    expect(wrongAlphabet).toHaveLength(40);
    expect(decode(receiptFields({ sha: wrongAlphabet }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    expect(decode(receiptFields({ sha: SHA.slice(0, 39) }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    expect(decode(receiptFields({ sha: `${SHA}ab` }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    expect(decode(receiptFields({ sha: SHA.toUpperCase() }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
  });

  it("refuses a refusal whose layer is not this engine's, and a code outside the roster", () => {
    expect(decode(refused({
      refusal: { code: DEPLOY_HEALTH_TIMEOUT, detail: "d", layer: "SOME_OTHER_LAYER" },
    }))).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
    expect(decode(refused({
      refusal: { code: "DEPLOY_INVENTED_CODE", detail: "d", layer: DEPLOY_ENGINE_STAMP },
    }))).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
  });

  it("refuses an extra key, a missing key and a receiptId the fields do not produce", () => {
    expect(decode(receiptFields({ extra: "x" }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
    const { url: _dropped, ...missing } = receiptFields();
    expect(decode(missing)).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
    expect(decode(receiptFields({ receiptId: "a".repeat(64) }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
  });

  it("refuses an image digest that is not sha256-prefixed hex", () => {
    expect(decode(receiptFields({ imageDigest: "latest" }))).toEqual({
      code: "DEPLOY_RECEIPT_INVALID", ok: false,
    });
  });
});
