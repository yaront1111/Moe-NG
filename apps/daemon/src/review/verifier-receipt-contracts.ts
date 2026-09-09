import { createHash } from "node:crypto";

import { evaluatePolicy } from "@moe/core";
import type { PolicyEvaluationInput } from "@moe/core";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { buildReviewPackage } from "@moe/review";
import type { ReviewPackageItemInput, ReviewerCalibration } from "@moe/review";
import { decodeVerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";

/** The service identity is reserved from session ids by daemon composition. */
export const NODE_VERIFIER_PRINCIPAL_ID = "daemon:node-verifier" as const;
export const VERIFIER_RECEIPT_VERSION = "moe-verifier-receipt/1" as const;
export const VERIFIER_RECEIPT_COMMAND_KIND = "internal.integration.verifier_receipt" as const;

export interface VerifierAuthorityFacts {
  readonly calibration: ReviewerCalibration;
  /** Host-owned package facts before the daemon appends its execution receipt. */
  readonly packageItems: readonly ReviewPackageItemInput[];
  readonly policy: PolicyEvaluationInput;
}

export interface VerifierExecutionInput {
  /** Absent only on legacy receipts; absence never authorizes production landing. */
  readonly workspaceBinding?: VerifiedWorkspaceBinding;
  readonly byteCount: number;
  readonly outputSha256: string;
  readonly test: string;
  readonly workspace: string;
}

export interface VerifierReceiptSource {
  readonly aggregateVersion: number;
  readonly authors: readonly string[];
  readonly decisionId: string;
  readonly resultSha256: string;
}

export interface VerifierExecutionEvidence extends VerifierExecutionInput {
  readonly evidenceSha256: string;
  readonly exitCode: 0;
}

export interface VerifierReceiptV1 {
  readonly calibration: ReviewerCalibration;
  readonly execution: VerifierExecutionEvidence;
  readonly packageItems: readonly ReviewPackageItemInput[];
  readonly policy: PolicyEvaluationInput;
  readonly projectId: string;
  readonly proof: "PASSED";
  readonly receiptId: string;
  readonly reviewInputDigest: string;
  readonly source: VerifierReceiptSource;
  readonly subjectRef: string;
  readonly version: typeof VERIFIER_RECEIPT_VERSION;
}

export type VerifierReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: VerifierReceiptV1 }>
  | Readonly<{ readonly code: "VERIFIER_RECEIPT_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const TOP_KEYS = [
  "calibration", "execution", "packageItems", "policy", "projectId", "proof",
  "receiptId", "reviewInputDigest", "source", "subjectRef", "version",
] as const;
const SOURCE_KEYS = ["aggregateVersion", "authors", "decisionId", "resultSha256"] as const;
const EXECUTION_KEYS = [
  "byteCount", "evidenceSha256", "exitCode", "outputSha256", "test", "workspace",
] as const;
const CALIBRATION_KEYS = ["corpusRevision", "sentinelPassed", "staleness"] as const;
const ITEM_KEYS = ["digest", "kind", "locator"] as const;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hex64(value: JsonValue | undefined): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function hash(parts: readonly JsonValue[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function verifierReceiptId(
  projectId: string,
  subjectRef: string,
  sourceDecisionId: string,
): string {
  return hash([VERIFIER_RECEIPT_VERSION, "receipt-id", projectId, subjectRef, sourceDecisionId]);
}

export function verifierExecutionDigest(
  projectId: string,
  subjectRef: string,
  source: Pick<VerifierReceiptSource, "aggregateVersion" | "decisionId" | "resultSha256">,
  execution: VerifierExecutionInput,
): string {
  return hash([
    VERIFIER_RECEIPT_VERSION,
    "execution",
    projectId,
    subjectRef,
    source.decisionId,
    source.resultSha256,
    source.aggregateVersion,
    execution.workspace,
    execution.test,
    execution.outputSha256,
    execution.byteCount,
    0,
    ...(execution.workspaceBinding === undefined ? [] : [
      [execution.workspaceBinding.version, execution.workspaceBinding.root, execution.workspaceBinding.headSha,
        execution.workspaceBinding.branchRef, execution.workspaceBinding.treeSha, execution.workspaceBinding.dirtySha256],
    ]),
  ]);
}

function parseSource(value: JsonValue | undefined): VerifierReceiptSource | null {
  if (!isObject(value) || !exact(value, SOURCE_KEYS)) return null;
  const aggregateVersion = value["aggregateVersion"];
  const authors = value["authors"];
  if (!Number.isSafeInteger(aggregateVersion) || (aggregateVersion as number) < 1) return null;
  if (!Array.isArray(authors) || authors.length === 0 || !authors.every(ref)) return null;
  const canonicalAuthors = [...new Set(authors)].sort();
  if (canonicalAuthors.length !== authors.length
    || canonicalAuthors.some((author, index) => author !== authors[index])
    || canonicalAuthors.includes(NODE_VERIFIER_PRINCIPAL_ID)) return null;
  if (!ref(value["decisionId"]) || !hex64(value["resultSha256"])) return null;
  return {
    aggregateVersion: aggregateVersion as number,
    authors: canonicalAuthors,
    decisionId: value["decisionId"],
    resultSha256: value["resultSha256"],
  };
}

function parseExecution(value: JsonValue | undefined): VerifierExecutionEvidence | null {
  if (!isObject(value)) return null;
  const bound = Object.hasOwn(value, "workspaceBinding");
  if (!exact(value, bound ? [...EXECUTION_KEYS, "workspaceBinding"] : EXECUTION_KEYS)) return null;
  const workspaceBinding = bound ? decodeVerifiedWorkspaceBinding(value["workspaceBinding"]) : undefined;
  if (workspaceBinding === null) return null;
  const byteCount = value["byteCount"];
  if (!Number.isSafeInteger(byteCount) || (byteCount as number) < 0) return null;
  if (value["exitCode"] !== 0 || !hex64(value["outputSha256"])
    || !hex64(value["evidenceSha256"]) || !ref(value["test"]) || !ref(value["workspace"])) {
    return null;
  }
  return {
    ...(workspaceBinding === undefined ? {} : { workspaceBinding }),
    byteCount: byteCount as number,
    evidenceSha256: value["evidenceSha256"],
    exitCode: 0,
    outputSha256: value["outputSha256"],
    test: value["test"],
    workspace: value["workspace"],
  };
}

function parseCalibration(value: JsonValue | undefined): ReviewerCalibration | null {
  if (!isObject(value) || !exact(value, CALIBRATION_KEYS)) return null;
  if (!ref(value["corpusRevision"]) || typeof value["sentinelPassed"] !== "boolean") return null;
  const staleness = value["staleness"];
  if (staleness !== "CURRENT" && staleness !== "STALE" && staleness !== "UNKNOWN") return null;
  return {
    corpusRevision: value["corpusRevision"],
    sentinelPassed: value["sentinelPassed"],
    staleness,
  };
}

function parseItems(value: JsonValue | undefined): readonly ReviewPackageItemInput[] | null {
  if (!Array.isArray(value)) return null;
  const items: ReviewPackageItemInput[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !exact(entry, ITEM_KEYS)) return null;
    if (!hex64(entry["digest"]) || !ref(entry["kind"]) || !ref(entry["locator"])) return null;
    items.push({ digest: entry["digest"], kind: entry["kind"], locator: entry["locator"] });
  }
  return items;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Strict receipt decode. Every value later cast to a kernel type was validated by its owner. */
export function decodeVerifierReceiptBytes(input: unknown): VerifierReceiptDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, TOP_KEYS)) {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  const value = decoded.value;
  const source = parseSource(value["source"]);
  const execution = parseExecution(value["execution"]);
  const calibration = parseCalibration(value["calibration"]);
  const packageItems = parseItems(value["packageItems"]);
  const policy = value["policy"];
  if (value["version"] !== VERIFIER_RECEIPT_VERSION || source === null || execution === null
    || calibration === null || packageItems === null || !isObject(policy)
    || !ref(value["projectId"]) || !ref(value["subjectRef"]) || value["proof"] !== "PASSED"
    || !hex64(value["receiptId"]) || !hex64(value["reviewInputDigest"])) {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  if (value["receiptId"] !== verifierReceiptId(
    value["projectId"], value["subjectRef"], source.decisionId,
  )) return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  if (execution.evidenceSha256 !== verifierExecutionDigest(
    value["projectId"], value["subjectRef"], source, execution,
  )) return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  const built = buildReviewPackage(packageItems);
  if (!built.ok || built.value.reviewInputDigest !== value["reviewInputDigest"]) {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  const evaluated = evaluatePolicy(policy);
  if (!evaluated.ok || evaluated.record.action !== "integration.accept_output"
    || evaluated.record.actor !== NODE_VERIFIER_PRINCIPAL_ID
    || evaluated.record.decision !== "ALLOW") {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  const receipt: VerifierReceiptV1 = {
    calibration,
    execution,
    packageItems,
    policy: policy as unknown as PolicyEvaluationInput,
    projectId: value["projectId"],
    proof: "PASSED",
    receiptId: value["receiptId"],
    reviewInputDigest: value["reviewInputDigest"],
    source,
    subjectRef: value["subjectRef"],
    version: VERIFIER_RECEIPT_VERSION,
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}
