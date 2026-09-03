import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * The durable shapes of GIT LANDING: what the wrapper's lander records when it
 * commits a verified node's files into the project's repository, and the
 * baseline it observed before the seat started so only the seat's own changes
 * are ever committed.
 *
 * Both records are the daemon's own facts, minted under a reserved principal
 * and an `internal.*` command kind, never dispatched from the wire. They mirror
 * the verifier receipt: exact keys, deterministic ids, a decoder that refuses
 * anything it did not write. A landing that did not happen is recorded as a
 * REFUSED receipt with its code — an absent landing is not a false one.
 */

export const NODE_LANDER_PRINCIPAL_ID = "daemon:node-lander" as const;
export const LANDING_RECEIPT_VERSION = "moe-landing-receipt/1" as const;
export const LANDING_BASELINE_VERSION = "moe-landing-baseline/1" as const;
export const LANDING_RECEIPT_COMMAND_KIND = "internal.repository.landing_receipt" as const;
export const LANDING_BASELINE_COMMAND_KIND = "internal.repository.landing_baseline" as const;

/** The blob id `git hash-object` gives a working-tree file, or this for a path that is gone. */
export const DELETED_BLOB = "DELETED" as const;

export interface LandingBaselineEntry {
  readonly blobId: string;
  readonly path: string;
}

/** Every dirty path in the workspace, with its content id, the moment the seat was staffed. */
export interface LandingBaselineV1 {
  readonly entries: readonly LandingBaselineEntry[];
  readonly observedAt: string;
  readonly projectId: string;
  readonly subjectRef: string;
  readonly version: typeof LANDING_BASELINE_VERSION;
  readonly workspace: string;
}

export interface LandingCommit {
  readonly branch: string;
  readonly files: readonly string[];
  readonly message: string;
  readonly parentSha: string | null;
  readonly sha: string;
}

export interface LandingRefusal {
  readonly code: string;
  readonly detail: string;
}

export interface LandingReceiptV1 {
  readonly commit: LandingCommit | null;
  readonly decidedAt: string;
  readonly outcome: "COMMITTED" | "REFUSED";
  readonly projectId: string;
  readonly receiptId: string;
  readonly refusal: LandingRefusal | null;
  readonly subjectRef: string;
  readonly verifierReceiptId: string;
  readonly version: typeof LANDING_RECEIPT_VERSION;
  readonly workspace: string;
}

export type LandingReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: LandingReceiptV1 }>
  | Readonly<{ readonly code: "LANDING_RECEIPT_INVALID"; readonly ok: false }>;

export type LandingBaselineDecodeResult =
  | Readonly<{ readonly baseline: LandingBaselineV1; readonly ok: true }>
  | Readonly<{ readonly code: "LANDING_BASELINE_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RECEIPT_KEYS = [
  "commit", "decidedAt", "outcome", "projectId", "receiptId", "refusal", "subjectRef",
  "verifierReceiptId", "version", "workspace",
] as const;
const COMMIT_KEYS = ["branch", "files", "message", "parentSha", "sha"] as const;
const REFUSAL_KEYS = ["code", "detail"] as const;
const BASELINE_KEYS = [
  "entries", "observedAt", "projectId", "subjectRef", "version", "workspace",
] as const;
const ENTRY_KEYS = ["blobId", "path"] as const;

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

function text(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function hash(parts: readonly JsonValue[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
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

/** The aggregate every landing fact for a node lands on: beside the node, never on it. */
export function landingAggregateId(subjectRef: string): string {
  return `landing:${subjectRef}`;
}

/** One landing per verifier receipt: the id is a pure function of that receipt. */
export function landingReceiptId(
  projectId: string, subjectRef: string, verifierReceiptId: string,
): string {
  return hash([LANDING_RECEIPT_VERSION, "receipt-id", projectId, subjectRef, verifierReceiptId]);
}

/** One baseline per staffing: keyed by the landing aggregate's version at observation. */
export function landingBaselineId(
  projectId: string, subjectRef: string, aggregateVersion: number,
): string {
  return hash([LANDING_BASELINE_VERSION, "baseline-id", projectId, subjectRef, aggregateVersion]);
}

function parseStringList(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(ref)) return null;
  return value;
}

function parseCommit(value: JsonValue | undefined): LandingCommit | null {
  if (!isObject(value) || !exact(value, COMMIT_KEYS)) return null;
  const files = parseStringList(value["files"]);
  const parentSha = value["parentSha"];
  if (files === null || files.length === 0 || !ref(value["branch"]) || !ref(value["message"])
    || !(parentSha === null || (typeof parentSha === "string" && GIT_OBJECT_ID.test(parentSha)))
    || typeof value["sha"] !== "string" || !GIT_OBJECT_ID.test(value["sha"])) return null;
  return { branch: value["branch"], files, message: value["message"], parentSha, sha: value["sha"] };
}

function parseRefusal(value: JsonValue | undefined): LandingRefusal | null {
  if (!isObject(value) || !exact(value, REFUSAL_KEYS)) return null;
  if (!ref(value["code"]) || !text(value["detail"])) return null;
  return { code: value["code"], detail: value["detail"] };
}

export function decodeLandingReceiptBytes(input: unknown): LandingReceiptDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, RECEIPT_KEYS)) {
    return { code: "LANDING_RECEIPT_INVALID", ok: false };
  }
  const value = decoded.value;
  const outcome = value["outcome"];
  const commit = value["commit"] === null ? null : parseCommit(value["commit"]);
  const refusal = value["refusal"] === null ? null : parseRefusal(value["refusal"]);
  if (value["version"] !== LANDING_RECEIPT_VERSION || !ref(value["projectId"])
    || !ref(value["subjectRef"]) || !ref(value["decidedAt"]) || !ref(value["workspace"])
    || !HEX64.test(String(value["receiptId"])) || !HEX64.test(String(value["verifierReceiptId"]))
    || (outcome !== "COMMITTED" && outcome !== "REFUSED")
    || (outcome === "COMMITTED") !== (commit !== null)
    || (outcome === "REFUSED") !== (refusal !== null)
    || (value["commit"] !== null && commit === null)
    || (value["refusal"] !== null && refusal === null)) {
    return { code: "LANDING_RECEIPT_INVALID", ok: false };
  }
  const receiptId = value["receiptId"] as string;
  const verifierReceiptId = value["verifierReceiptId"] as string;
  if (receiptId !== landingReceiptId(value["projectId"], value["subjectRef"], verifierReceiptId)) {
    return { code: "LANDING_RECEIPT_INVALID", ok: false };
  }
  const receipt: LandingReceiptV1 = {
    commit,
    decidedAt: value["decidedAt"],
    outcome,
    projectId: value["projectId"],
    receiptId,
    refusal,
    subjectRef: value["subjectRef"],
    verifierReceiptId,
    version: LANDING_RECEIPT_VERSION,
    workspace: value["workspace"],
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}

function parseEntries(value: JsonValue | undefined): readonly LandingBaselineEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: LandingBaselineEntry[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !exact(entry, ENTRY_KEYS) || !ref(entry["path"])) return null;
    const blobId = entry["blobId"];
    if (blobId !== DELETED_BLOB && (typeof blobId !== "string" || !GIT_OBJECT_ID.test(blobId))) {
      return null;
    }
    entries.push({ blobId, path: entry["path"] });
  }
  return entries;
}

export function decodeLandingBaselineBytes(input: unknown): LandingBaselineDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, BASELINE_KEYS)) {
    return { code: "LANDING_BASELINE_INVALID", ok: false };
  }
  const value = decoded.value;
  const entries = parseEntries(value["entries"]);
  if (value["version"] !== LANDING_BASELINE_VERSION || entries === null
    || !ref(value["projectId"]) || !ref(value["subjectRef"]) || !ref(value["observedAt"])
    || !ref(value["workspace"])) {
    return { code: "LANDING_BASELINE_INVALID", ok: false };
  }
  const baseline: LandingBaselineV1 = {
    entries,
    observedAt: value["observedAt"],
    projectId: value["projectId"],
    subjectRef: value["subjectRef"],
    version: LANDING_BASELINE_VERSION,
    workspace: value["workspace"],
  };
  return { baseline: freezeDeep(baseline), ok: true };
}
