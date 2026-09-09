import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { PREVIEW_CODE_LAYERS } from "./preview-contracts.js";
import type { PreviewCode, PreviewLayer } from "./preview-contracts.js";

/**
 * The durable shape of A PREVIEW RUN: what the runner records when it starts the product's own
 * preview command for a goal's landed revision, drives a browser at it, and captures the
 * journeys an operator is about to judge.
 *
 * It mirrors `../repository/landing-receipt-contracts.ts` deliberately, because the two facts
 * have the same three properties and each one is load-bearing here:
 *
 *   EXACT KEYS. The decoder refuses a record it did not write rather than reading around an
 *   unknown member, so a receipt's meaning cannot drift under a later reader.
 *
 *   A DETERMINISTIC ID. `previewReceiptId` is a pure function of (projectId, goalId, sha) —
 *   the landing receipt derives its id from the verifier receipt precisely so "a wrapper restart
 *   lands nothing twice" (node-lander.ts:25-26). The preview needs the same property for a
 *   sharper reason: the run behind the receipt SPAWNS A SERVER THAT BINDS A PORT. A restart that
 *   minted a second id would start a second server, and the second one would fail to bind
 *   against the first. One id per (project, goal, revision) is what makes the record replayable.
 *
 *   A REFUSAL IS A RECORD, NOT AN ABSENCE. "An absent landing is not a false one"
 *   (landing-receipt-contracts.ts header) transfers verbatim: a preview that never started is a
 *   REFUSED receipt CARRYING ITS CODE. The operator's screen must be able to say WHY there is
 *   nothing to look at, and a missing row cannot say anything.
 *
 * WHY A REFUSED RECEIPT CARRIES NO URL AND NO PID. The url is the thing an operator clicks. A
 * refusal that still advertised one would send them to a port nothing is listening on, so the
 * decoder makes the exclusion STRUCTURAL rather than conventional: outcome STARTED requires a
 * url and a pid, outcome REFUSED requires both to be null and a code to be present. Neither
 * shape can be half-built, because the check is an equivalence (`(outcome === "STARTED") !==
 * (url !== null)` refuses) rather than a pair of one-way guards.
 *
 * WHY THE CODE IS A `PreviewCode` AND NOT A STRING. `preview-contracts.ts` owns the closed
 * `PREVIEW_CODE_LAYERS` map and `previewRefusal` takes no layer argument, so a call site cannot
 * mint a code/layer pair that disagrees. This module re-derives the layer from that same map
 * instead of storing it, so a receipt cannot record a refusal whose layer contradicts the
 * vocabulary either — there is exactly one statement of which layer answers which code.
 */

export const PREVIEW_RUNNER_PRINCIPAL_ID = "daemon:preview-runner" as const;
export const PREVIEW_RECEIPT_VERSION = "moe-preview-receipt/1" as const;
export const PREVIEW_RECEIPT_COMMAND_KIND = "internal.preview.run_receipt" as const;

/** One screenshot: which journey it shows, and the file that holds its bytes. */
export interface PreviewScreenshot {
  readonly journeyRef: string;
  /** Project-relative, always under `.moe-next/previews/<goalId>/<sha>/`. */
  readonly path: string;
}

export interface PreviewReceiptV1 {
  readonly code: PreviewCode | null;
  readonly decidedAt: string;
  readonly goalId: string;
  readonly outcome: "REFUSED" | "STARTED";
  readonly pid: number | null;
  readonly projectId: string;
  readonly receiptId: string;
  readonly screenshots: readonly PreviewScreenshot[];
  readonly sha: string;
  readonly url: string | null;
  readonly version: typeof PREVIEW_RECEIPT_VERSION;
}

export type PreviewReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: PreviewReceiptV1 }>
  | Readonly<{ readonly code: "PREVIEW_RECEIPT_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS = [
  "code", "decidedAt", "goalId", "outcome", "pid", "projectId", "receiptId", "screenshots",
  "sha", "url", "version",
] as const;
const SCREENSHOT_KEYS = ["journeyRef", "path"] as const;

/** The prefix every capture of this run must sit under, and nothing may escape. */
export function previewCaptureDirectory(goalId: string, sha: string): string {
  return `.moe-next/previews/${goalId}/${sha}`;
}

/** The aggregate a preview fact lands on: BESIDE the goal, so a preview moves no goal version. */
export function previewAggregateId(goalId: string): string {
  return `preview:${goalId}`;
}

/**
 * One preview per (project, goal, revision). Deterministic, so a restarted daemon re-reads the
 * run it already recorded instead of spawning a second server against a bound port.
 */
export function previewReceiptId(projectId: string, goalId: string, sha: string): string {
  return createHash("sha256")
    .update(JSON.stringify([PREVIEW_RECEIPT_VERSION, "receipt-id", projectId, goalId, sha]), "utf8")
    .digest("hex");
}

/** The layer that answers a recorded refusal, re-derived from the vocabulary's closed map. */
export function previewReceiptLayer(receipt: PreviewReceiptV1): PreviewLayer | null {
  return receipt.code === null ? null : PREVIEW_CODE_LAYERS[receipt.code];
}

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

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Every entry must name a file under THIS run's own directory. A receipt that advertised a
 * capture outside its `<goalId>/<sha>` prefix would let one run's screen show another run's
 * pictures, so containment is checked where the bytes are read back, not only where written.
 */
function parseScreenshots(
  value: JsonValue | undefined, goalId: string, sha: string,
): readonly PreviewScreenshot[] | null {
  if (!Array.isArray(value)) return null;
  const prefix = `${previewCaptureDirectory(goalId, sha)}/`;
  const screenshots: PreviewScreenshot[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry) || !exact(entry, SCREENSHOT_KEYS)) return null;
    if (!ref(entry["journeyRef"]) || !ref(entry["path"])) return null;
    const path = entry["path"];
    if (!path.startsWith(prefix) || path.includes("..") || path.includes("\\")) return null;
    if (seen.has(path)) return null;
    seen.add(path);
    screenshots.push({ journeyRef: entry["journeyRef"], path });
  }
  return screenshots;
}

function parsePid(value: JsonValue | undefined): number | null | "INVALID" {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return "INVALID";
  return value;
}

export function decodePreviewReceiptBytes(input: unknown): PreviewReceiptDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, RECEIPT_KEYS)) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  const value = decoded.value;
  const outcome = value["outcome"];
  const started = outcome === "STARTED";
  const code = value["code"];
  const url = value["url"];
  const pid = parsePid(value["pid"]);
  if (!ref(value["goalId"]) || !ref(value["sha"]) || !ref(value["projectId"])
    || !ref(value["decidedAt"]) || value["version"] !== PREVIEW_RECEIPT_VERSION
    || !HEX64.test(String(value["receiptId"])) || pid === "INVALID"
    || (outcome !== "STARTED" && outcome !== "REFUSED")
    // Each member is tied to the outcome by an EQUIVALENCE, so neither shape can be half-built:
    // a STARTED receipt without a url, or a REFUSED one that still advertises one, both refuse.
    || started !== (url !== null) || started !== (pid !== null) || started === (code !== null)
    || (url !== null && !ref(url))
    || (code !== null && (typeof code !== "string" || !(code in PREVIEW_CODE_LAYERS)))) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  const screenshots = parseScreenshots(value["screenshots"], value["goalId"], value["sha"]);
  // A refusal captured nothing: a REFUSED receipt carrying screenshots would advertise pictures
  // of a product that never started.
  if (screenshots === null || (!started && screenshots.length > 0)) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  const receiptId = value["receiptId"] as string;
  if (receiptId !== previewReceiptId(value["projectId"], value["goalId"], value["sha"])) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  const receipt: PreviewReceiptV1 = {
    code: code === null ? null : (code as PreviewCode),
    decidedAt: value["decidedAt"],
    goalId: value["goalId"],
    outcome,
    pid: pid === null ? null : pid,
    projectId: value["projectId"],
    receiptId,
    screenshots,
    sha: value["sha"],
    url: url === null ? null : (url as string),
    version: PREVIEW_RECEIPT_VERSION,
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}
