import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { RELEASE_DECIDE_CODES } from "./release-decide-contracts.js";
import type { ReleaseDecideCode } from "./release-decide-contracts.js";

/**
 * The durable shape of a RELEASE DECISION: what the daemon records when an operator's
 * `release.decide` either opened a proof-carrying pull request or refused to.
 *
 * It is the daemon's own fact, minted under a reserved principal and an `internal.*`
 * command kind, never dispatched from the wire — the same posture as the landing and
 * verifier receipts it mirrors: exact keys, a deterministic id, and a decoder that
 * refuses anything it did not write.
 *
 * A release that did not happen is recorded as a REFUSED receipt carrying its code. An
 * absent receipt and a false one are not the same thing, and the worst outcome available
 * here is a refused release that recorded success — so the RELEASED/REFUSED split is
 * enforced by the DECODER rather than left to the callers' good manners.
 */

export const RELEASE_RECEIPT_PRINCIPAL_ID = "daemon:release" as const;
export const RELEASE_RECEIPT_VERSION = "moe-release-receipt/1" as const;
export const RELEASE_RECEIPT_COMMAND_KIND = "internal.release.receipt" as const;

export interface ReleaseReceiptV1 {
  /** sha256 of the STORED dossier markdown — the exact bytes that became the PR body. */
  readonly dossierSha256: string;
  readonly goalId: string;
  readonly outcome: "RELEASED" | "REFUSED";
  readonly prUrl: string | null;
  readonly projectId: string;
  readonly receiptId: string;
  readonly refusalCode: ReleaseDecideCode | null;
  readonly sha: string;
  readonly version: typeof RELEASE_RECEIPT_VERSION;
}

export type ReleaseReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: ReleaseReceiptV1 }>
  | Readonly<{ readonly code: "RELEASE_RECEIPT_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS = [
  "dossierSha256", "goalId", "outcome", "prUrl", "projectId", "receiptId", "refusalCode",
  "sha", "version",
] as const;

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

/** The sha256 of the dossier markdown, over the SAME utf8 bytes the PR body carries. */
export function dossierSha256(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * The id of one release DECISION.
 *
 * Keyed by outcome and refusal code as well as (project, goal, sha), and the reason is a
 * behaviour the ledger's replay path would otherwise break: the ledger answers
 * `replayed: true` for an id it already holds and never appends a second event. Were the
 * id `f(projectId, goalId, sha)` alone, an operator whose first attempt refused
 * RELEASE_PR_FAILED — `gh` not installed — would fix `gh`, retry the SAME sha, and have
 * the success silently replay the stored refusal. The same argument one level down is why
 * the code is in the derivation too: refusing RELEASE_REMOTE_MISSING and later
 * RELEASE_PR_FAILED at one sha are different facts and must not overwrite each other.
 *
 * What this preserves is the idempotence that actually matters: re-recording the SAME
 * decision replays it, and a goal accumulates at most one record per distinct outcome.
 */
export function releaseReceiptId(
  projectId: string,
  goalId: string,
  sha: string,
  outcome: ReleaseReceiptV1["outcome"],
  refusalCode: ReleaseDecideCode | null,
): string {
  return hash([
    RELEASE_RECEIPT_VERSION, "receipt-id", projectId, goalId, sha, outcome, refusalCode,
  ]);
}

function isReleaseCode(value: JsonValue | undefined): value is ReleaseDecideCode {
  return typeof value === "string"
    && (RELEASE_DECIDE_CODES as readonly string[]).includes(value);
}

/**
 * THE TWO STRUCTURAL INVARIANTS, checked here rather than trusted:
 *
 * - RELEASED carries a non-empty `prUrl` and a NULL `refusalCode`;
 * - REFUSED carries a NULL `prUrl` and a `refusalCode` drawn from the closed set in
 *   release-decide-contracts.ts.
 *
 * Both are written as `(outcome === X) !== (field !== null)` so neither direction can pass
 * by accident: a forged RELEASED-with-null-prUrl and a forged REFUSED-carrying-a-prUrl are
 * both refused, and so is a refusalCode this vocabulary never minted.
 */
export function decodeReleaseReceiptBytes(input: unknown): ReleaseReceiptDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, RECEIPT_KEYS)) {
    return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  }
  const value = decoded.value;
  const outcome = value["outcome"];
  const rawUrl = value["prUrl"];
  const rawCode = value["refusalCode"];
  const prUrl = rawUrl === null ? null : (ref(rawUrl) ? rawUrl : undefined);
  const refusalCode = rawCode === null ? null : (isReleaseCode(rawCode) ? rawCode : undefined);
  if (value["version"] !== RELEASE_RECEIPT_VERSION || !ref(value["projectId"])
    || !ref(value["goalId"]) || !ref(value["sha"]) || prUrl === undefined
    || refusalCode === undefined || !HEX64.test(String(value["dossierSha256"]))
    || !HEX64.test(String(value["receiptId"]))
    || (outcome !== "RELEASED" && outcome !== "REFUSED")
    || (outcome === "RELEASED") !== (prUrl !== null)
    || (outcome === "REFUSED") !== (refusalCode !== null)) {
    return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  }
  const receiptId = value["receiptId"] as string;
  if (receiptId !== releaseReceiptId(
    value["projectId"], value["goalId"], value["sha"], outcome, refusalCode,
  )) {
    return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  }
  const receipt: ReleaseReceiptV1 = {
    dossierSha256: value["dossierSha256"] as string,
    goalId: value["goalId"],
    outcome,
    prUrl,
    projectId: value["projectId"],
    receiptId,
    refusalCode,
    sha: value["sha"],
    version: RELEASE_RECEIPT_VERSION,
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}
