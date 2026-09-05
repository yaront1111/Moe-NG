import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ProductContractRevisionRef } from "@moe/core";
import { decodeCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { CRITERION_SCHEMA_VERSION } from "./criterion-contracts.js";
import type { CriterionApprovedRecord, CriterionCheck } from "./criterion-contracts.js";

export const criterionHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const criterionBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
export const criterionObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const criterionExact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const criterionText = (value: unknown, max = 256): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max && value.isWellFormed() && !value.includes("\0") && value.normalize("NFC") === value;
export const criterionHex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export const criterionGitSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
export function criterionContractRef(value: unknown): ProductContractRevisionRef | null {
  if (!criterionObject(value) || !criterionExact(value, ["contractId", "revisionId", "revisionDigest"])
    || !criterionText(value["contractId"]) || !criterionText(value["revisionId"]) || !criterionHex(value["revisionDigest"])) return null;
  return { contractId: value["contractId"], revisionId: value["revisionId"], revisionDigest: value["revisionDigest"] };
}
export const sameCriterionRef = (a: ProductContractRevisionRef, b: ProductContractRevisionRef): boolean =>
  a.contractId === b.contractId && a.revisionId === b.revisionId && a.revisionDigest === b.revisionDigest;
export function decodeCriterionCheck(value: unknown): CriterionCheck | null {
  if (!criterionObject(value) || !criterionExact(value, ["checkId", "checkVersion", "program", "args", "timeoutMs"])
    || !criterionText(value["checkId"], 128) || !criterionText(value["checkVersion"], 128)
    || !criterionText(value["program"], 260) || !isAbsolute(value["program"]) || !Array.isArray(value["args"])
    || value["args"].length > 128 || !value["args"].every((arg) => typeof arg === "string" && arg.length <= 4096
      && arg.isWellFormed() && !arg.includes("\0") && arg.normalize("NFC") === arg)
    || !Number.isSafeInteger(value["timeoutMs"]) || (value["timeoutMs"] as number) < 1000
    || (value["timeoutMs"] as number) > 1800000) return null;
  return { checkId: value["checkId"], checkVersion: value["checkVersion"], program: value["program"],
    args: Object.freeze([...value["args"]] as string[]), timeoutMs: value["timeoutMs"] as number };
}
export function decodeCriterionApproved(value: unknown): CriterionApprovedRecord | null {
  if (!criterionObject(value) || !criterionExact(value, ["version", "binding", "criterionId", "criterionDigest", "approval", "programSha256", "approvedBy"])
    || value["version"] !== CRITERION_SCHEMA_VERSION || !criterionText(value["criterionId"])
    || !criterionHex(value["criterionDigest"]) || !criterionHex(value["programSha256"]) || !criterionText(value["approvedBy"])) return null;
  const binding = decodeCompiledContractBinding(criterionBytes(value["binding"]));
  const approval = value["approval"];
  if (binding === null || !criterionObject(approval) || !criterionExact(approval,
    ["checkId", "checkVersion", "program", "args", "timeoutMs", "approvalId", "executorDigest"])
    || !criterionText(approval["approvalId"]) || !criterionHex(approval["executorDigest"])) return null;
  const check = decodeCriterionCheck({ checkId: approval["checkId"], checkVersion: approval["checkVersion"],
    program: approval["program"], args: approval["args"], timeoutMs: approval["timeoutMs"] });
  return check === null ? null : { version: CRITERION_SCHEMA_VERSION, binding, criterionId: value["criterionId"],
    criterionDigest: value["criterionDigest"], programSha256: value["programSha256"], approvedBy: value["approvedBy"],
    approval: { ...check, approvalId: approval["approvalId"], executorDigest: approval["executorDigest"] } };
}
export const sameCriterionBinding = (a: CriterionApprovedRecord["binding"], b: CriterionApprovedRecord["binding"]): boolean =>
  a.version === b.version && a.projectId === b.projectId && a.goalRef === b.goalRef
    && a.planningRunRef === b.planningRunRef && a.graphContentHash === b.graphContentHash
    && a.submissionHash === b.submissionHash && sameCriterionRef(a.contractRef, b.contractRef);
