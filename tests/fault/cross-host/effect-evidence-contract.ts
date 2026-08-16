/**
 * The canonical cross-host evidence protocol: receipts, verification, aggregation.
 *
 * This module classifies EVIDENCE, never a platform. Every platform, activation,
 * cancellation, crash, doctor and distribution judgement is made by the
 * production surface that owns it; what lives here is the binding between one
 * exact source commit, one exact distribution, one verified executing host, and
 * the raw schedule that host actually ran.
 *
 * Two layers can refuse and they are never spelled the same way:
 * `CROSS_HOST_COLLECTOR` refuses to EMIT a receipt on a host that cannot be
 * proven to be the requested one; `CROSS_HOST_AGGREGATOR` refuses to ACCEPT a
 * receipt whose bindings do not recompute. A caller-selected host field, an
 * artifact name, or a directory a file happened to be downloaded into confers no
 * authority: the row is derived from the verified doctor identity inside the
 * signed-over bytes and from nothing else.
 */

import { createHash } from "node:crypto";

export const CROSS_HOST_RECEIPT_VERSION = "moe-cross-host-receipt/1" as const;
export const CROSS_HOST_AGGREGATE_VERSION = "moe-cross-host-aggregate/1" as const;
export const CROSS_HOST_CONSUMER_TASK_ID = "task-22cfca91c5134b24aaf3e5734444fb93" as const;
export const CROSS_HOST_EXPECTED_CASE_COUNT = 21;

/** The only two host rows. A third OS would be a new row, never a relabelled one. */
export const CROSS_HOST_HOST_SLOTS = Object.freeze(["linux", "darwin"] as const);
export type CrossHostSlot = (typeof CROSS_HOST_HOST_SLOTS)[number];

export const CROSS_HOST_LAYERS = Object.freeze(
  ["CROSS_HOST_COLLECTOR", "CROSS_HOST_AGGREGATOR"] as const,
);
export type CrossHostLayer = (typeof CROSS_HOST_LAYERS)[number];

export const CROSS_HOST_ERROR_CODES = Object.freeze([
  "CROSS_HOST_RECEIPT_MALFORMED",
  "CROSS_HOST_HOST_UNVERIFIABLE",
  "CROSS_HOST_HOST_MISMATCH",
  "CROSS_HOST_SOURCE_MISMATCH",
  "CROSS_HOST_DISTRIBUTION_MISMATCH",
  "CROSS_HOST_RUNTIME_UNVERIFIABLE",
  "CROSS_HOST_SCHEDULE_INCOMPLETE",
  "CROSS_HOST_SCHEDULE_DIGEST_MISMATCH",
  "CROSS_HOST_RAW_RECEIPT_MISMATCH",
  "CROSS_HOST_RECEIPT_DIGEST_MISMATCH",
  "CROSS_HOST_RECEIPT_MISSING",
  "CROSS_HOST_RECEIPT_DUPLICATE",
] as const);
export type CrossHostErrorCode = (typeof CROSS_HOST_ERROR_CODES)[number];

export interface CrossHostFailure {
  readonly ok: false;
  readonly code: CrossHostErrorCode;
  readonly layer: CrossHostLayer;
  readonly hostSlot: CrossHostSlot | null;
  readonly message: string;
}

export function crossHostFailure(
  code: CrossHostErrorCode,
  layer: CrossHostLayer,
  hostSlot: CrossHostSlot | null,
  message: string,
): CrossHostFailure {
  return Object.freeze({ ok: false as const, code, layer, hostSlot, message });
}

export function isCrossHostSlot(value: unknown): value is CrossHostSlot {
  return typeof value === "string" && (CROSS_HOST_HOST_SLOTS as readonly string[]).includes(value);
}

// --- canonical bytes --------------------------------------------------------

/**
 * Sorted-key UTF-8 JSON. Two receipts binding the same facts produce the same
 * bytes, so a digest over them is a digest over the facts rather than over one
 * serializer's key order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalize(record[key]);
  }
  return out;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

// --- receipt shape ----------------------------------------------------------

export interface CrossHostSource {
  readonly commitSha: string;
  readonly objectFormat: string;
}

export interface CrossHostComponent {
  readonly name: string;
  readonly manifestDigest: string;
  readonly assetDigest: string;
}

export interface CrossHostDistribution {
  readonly componentCount: number;
  readonly components: readonly CrossHostComponent[];
  readonly aggregateDigest: string;
}

export interface CrossHostReceiptBody {
  readonly receiptVersion: typeof CROSS_HOST_RECEIPT_VERSION;
  readonly hostSlot: CrossHostSlot;
  readonly consumerTaskId: typeof CROSS_HOST_CONSUMER_TASK_ID;
  readonly source: CrossHostSource;
  readonly distribution: CrossHostDistribution;
  readonly doctor: {
    readonly os: string;
    readonly arch: string;
    readonly nodeVersion: string;
    readonly pnpmVersion: string;
    readonly reportDigest: string;
  };
  readonly kernel: { readonly release: string };
  readonly runtime: {
    readonly closureKind: string;
    readonly pinningMethod: string;
    readonly observationDigest: string;
    readonly truthClass: string;
  };
  readonly schedule: {
    readonly scheduleDigest: string;
    readonly fixtureDigest: string;
    readonly configDigest: string;
    readonly workflowDigest: string;
    readonly lockfileDigest: string;
  };
  readonly timestamps: { readonly startedAt: string; readonly completedAt: string };
  readonly cases: readonly Record<string, unknown>[];
  readonly caseDigest: string;
}

export interface CrossHostReceipt extends CrossHostReceiptBody {
  readonly receiptDigest: string;
}

export const CROSS_HOST_BODY_KEYS = Object.freeze([
  "caseDigest", "cases", "consumerTaskId", "distribution", "doctor", "hostSlot",
  "kernel", "receiptVersion", "runtime", "schedule", "source", "timestamps",
] as const);

export const CROSS_HOST_CASE_KEYS = Object.freeze([
  "boundary", "code", "elapsedMs", "launchedPid", "layer", "schedule", "truthClass",
] as const);

export function sealHostReceipt(body: CrossHostReceiptBody): CrossHostReceipt {
  return Object.freeze({ ...body, receiptDigest: canonicalDigest(body) });
}

export function receiptFileName(receipt: CrossHostReceipt): string {
  return `receipt-${receipt.receiptDigest}.json`;
}

export interface CrossHostExpectation {
  readonly source: CrossHostSource;
  readonly distribution: CrossHostDistribution;
}

/**
 * Exact-key decoding: an unexpected own key is a refusal, never something to
 * ignore. A receipt that carries one extra field is not the receipt whose digest
 * was computed, and accepting it would let a binding be added after the fact.
 */
export function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const own = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    return null;
  }
  return record;
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isDigestText(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** The exact-key sets every bound sub-record is decoded against. */
export const RECEIPT_KEYS = Object.freeze([...CROSS_HOST_BODY_KEYS, "receiptDigest"]);
export const SOURCE_KEYS = Object.freeze(["commitSha", "objectFormat"]);
export const COMPONENT_KEYS = Object.freeze(["assetDigest", "manifestDigest", "name"]);
export const DISTRIBUTION_KEYS = Object.freeze(["aggregateDigest", "componentCount", "components"]);
export const DOCTOR_KEYS = Object.freeze(["arch", "nodeVersion", "os", "pnpmVersion", "reportDigest"]);
export const RUNTIME_KEYS = Object.freeze(["closureKind", "observationDigest", "pinningMethod", "truthClass"]);
export const SCHEDULE_KEYS = Object.freeze([
  "configDigest", "fixtureDigest", "lockfileDigest", "scheduleDigest", "workflowDigest",
]);
export const TIMESTAMP_KEYS = Object.freeze(["completedAt", "startedAt"]);

/** The universe a schedule digest covers: which cases ran, not what they found. */
export function scheduleUniverseOf(cases: readonly Record<string, unknown>[]): unknown {
  return cases.map((entry) => ({ boundary: entry["boundary"], schedule: entry["schedule"] }));
}
