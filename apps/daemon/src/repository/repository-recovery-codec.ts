import { types } from "node:util";
import type { RepositoryRecoveryPayload } from "./repository-recovery-contracts.js";
const keys = ["action", "decision", "expectedReservationRevision", "nodeRef", "reason"] as const;
export function decodeRepositoryRecoveryPayload(value: unknown): RepositoryRecoveryPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = (descriptors["action"]?.value === "RESUME_REVIEW" || descriptors["action"]?.value === "RELEASE_REPLANNED") ? [...keys, "expectedReviewVersion", "expectedReviewDigest"] : keys;
  if (Reflect.ownKeys(value).length !== expected.length
    || expected.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, "value"))) return null;
  const row = value as Record<string, unknown>;
  if ((row["action"] !== "ABORT_UNEXECUTED" && row["action"] !== "RECONCILE_LANDED" && row["action"] !== "RESUME_REVIEW" && row["action"] !== "RELEASE_REPLANNED") || row["decision"] !== "APPROVE"
    || typeof row["expectedReservationRevision"] !== "number" || !Number.isSafeInteger(row["expectedReservationRevision"])
    || row["expectedReservationRevision"] < 1 || typeof row["nodeRef"] !== "string" || row["nodeRef"].trim() === ""
    || row["nodeRef"].length > 4096 || /[\u0000-\u001f]/u.test(row["nodeRef"])
    || typeof row["reason"] !== "string" || row["reason"].trim() === "" || row["reason"].length > 2048) return null;
  if ((row["action"] === "RESUME_REVIEW" || row["action"] === "RELEASE_REPLANNED") && (typeof row["expectedReviewVersion"] !== "number"
    || !Number.isSafeInteger(row["expectedReviewVersion"]) || row["expectedReviewVersion"] < 1
    || typeof row["expectedReviewDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(row["expectedReviewDigest"]))) return null;
  return Object.freeze({ action: row["action"], decision: row["decision"], expectedReservationRevision: row["expectedReservationRevision"],
    nodeRef: row["nodeRef"], reason: row["reason"], ...((row["action"] === "RESUME_REVIEW" || row["action"] === "RELEASE_REPLANNED")
      ? { expectedReviewVersion: row["expectedReviewVersion"] as number, expectedReviewDigest: row["expectedReviewDigest"] as string } : {}) });
}
