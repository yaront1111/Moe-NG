/**
 * Independent verification and aggregation of host evidence receipts.
 *
 * The gate order is load-bearing and every step below is a REFUSAL, never a
 * downgrade to a weaker claim: shape before self-digest, self-digest before
 * identity, identity before source, source before distribution, distribution
 * before runtime, and the raw schedule last. Nothing later can raise an earlier
 * UNKNOWN back to PROVEN, and no field a caller chose — `hostSlot`, an artifact
 * name, a download directory — is ever the thing that decides a row. The row is
 * decided by the verified doctor identity inside the bytes whose digest
 * recomputed.
 */

import {
  CROSS_HOST_AGGREGATE_VERSION,
  CROSS_HOST_BODY_KEYS,
  CROSS_HOST_CASE_KEYS,
  CROSS_HOST_CONSUMER_TASK_ID,
  CROSS_HOST_EXPECTED_CASE_COUNT,
  CROSS_HOST_HOST_SLOTS,
  CROSS_HOST_RECEIPT_VERSION,
  canonicalDigest,
  crossHostFailure,
  exactKeys,
  isCrossHostSlot,
  isDigestText,
  isText,
  type CrossHostExpectation,
  type CrossHostFailure,
  type CrossHostReceipt,
  type CrossHostSlot,
} from "./effect-evidence-contract.js";

const RECEIPT_KEYS = Object.freeze([...CROSS_HOST_BODY_KEYS, "receiptDigest"]);
const SOURCE_KEYS = Object.freeze(["commitSha", "objectFormat"]);
const COMPONENT_KEYS = Object.freeze(["assetDigest", "manifestDigest", "name"]);
const DISTRIBUTION_KEYS = Object.freeze(["aggregateDigest", "componentCount", "components"]);
const DOCTOR_KEYS = Object.freeze(["arch", "nodeVersion", "os", "pnpmVersion", "reportDigest"]);
const RUNTIME_KEYS = Object.freeze(["closureKind", "observationDigest", "pinningMethod", "truthClass"]);
const SCHEDULE_KEYS = Object.freeze([
  "configDigest", "fixtureDigest", "lockfileDigest", "scheduleDigest", "workflowDigest",
]);
const TIMESTAMP_KEYS = Object.freeze(["completedAt", "startedAt"]);

export type VerifyHostReceiptResult =
  | { readonly ok: true; readonly receipt: CrossHostReceipt }
  | CrossHostFailure;

/** The universe a schedule digest covers: which cases ran, not what they found. */
export function scheduleUniverseOf(cases: readonly Record<string, unknown>[]): unknown {
  return cases.map((entry) => ({ boundary: entry["boundary"], schedule: entry["schedule"] }));
}

function malformed(slot: CrossHostSlot, message: string): CrossHostFailure {
  return crossHostFailure("CROSS_HOST_RECEIPT_MALFORMED", "CROSS_HOST_AGGREGATOR", slot, message);
}

function shapeRejection(body: Record<string, unknown>, slot: CrossHostSlot): CrossHostFailure | null {
  const source = exactKeys(body["source"], SOURCE_KEYS);
  const distribution = exactKeys(body["distribution"], DISTRIBUTION_KEYS);
  const doctor = exactKeys(body["doctor"], DOCTOR_KEYS);
  const kernel = exactKeys(body["kernel"], ["release"]);
  const runtime = exactKeys(body["runtime"], RUNTIME_KEYS);
  const schedule = exactKeys(body["schedule"], SCHEDULE_KEYS);
  const timestamps = exactKeys(body["timestamps"], TIMESTAMP_KEYS);
  if ([source, distribution, doctor, kernel, runtime, schedule, timestamps].includes(null)) {
    return malformed(slot, "a bound sub-record does not carry exactly its declared keys");
  }
  if (body["receiptVersion"] !== CROSS_HOST_RECEIPT_VERSION) {
    return malformed(slot, "receiptVersion is not the frozen receipt version");
  }
  if (body["consumerTaskId"] !== CROSS_HOST_CONSUMER_TASK_ID) {
    return malformed(slot, "the receipt does not name the acceptance consumer task");
  }
  if (!isCrossHostSlot(body["hostSlot"]) || !Array.isArray(body["cases"])) {
    return malformed(slot, "hostSlot is outside the frozen slots or cases is not a list");
  }
  const components = (distribution as Record<string, unknown>)["components"];
  if (!Array.isArray(components) || components.some((entry) => exactKeys(entry, COMPONENT_KEYS) === null)) {
    return malformed(slot, "a distribution component does not carry exactly its declared keys");
  }
  return null;
}

function identityRejection(body: Record<string, unknown>, slot: CrossHostSlot): CrossHostFailure | null {
  const doctor = body["doctor"] as Record<string, unknown>;
  const kernel = body["kernel"] as Record<string, unknown>;
  const usable =
    isText(doctor["os"]) && isText(doctor["arch"]) && isText(doctor["nodeVersion"]) &&
    isText(doctor["pnpmVersion"]) && isDigestText(doctor["reportDigest"]) && isText(kernel["release"]);
  if (!usable) {
    return crossHostFailure(
      "CROSS_HOST_HOST_UNVERIFIABLE", "CROSS_HOST_AGGREGATOR", slot,
      "the doctor report or kernel release does not identify a host",
    );
  }
  // Derived from the measured doctor OS, never from the caller's hostSlot field.
  if (!isCrossHostSlot(doctor["os"]) || doctor["os"] !== slot || body["hostSlot"] !== slot) {
    return crossHostFailure(
      "CROSS_HOST_HOST_MISMATCH", "CROSS_HOST_AGGREGATOR", slot,
      "the verified doctor identity does not name the slot this receipt was read for",
    );
  }
  return null;
}

function bindingRejection(
  body: Record<string, unknown>,
  slot: CrossHostSlot,
  expected: CrossHostExpectation,
): CrossHostFailure | null {
  if (canonicalDigest(body["source"]) !== canonicalDigest(expected.source)) {
    return crossHostFailure(
      "CROSS_HOST_SOURCE_MISMATCH", "CROSS_HOST_AGGREGATOR", slot,
      "the receipt was produced from a different source commit than the one checked out",
    );
  }
  if (canonicalDigest(body["distribution"]) !== canonicalDigest(expected.distribution)) {
    return crossHostFailure(
      "CROSS_HOST_DISTRIBUTION_MISMATCH", "CROSS_HOST_AGGREGATOR", slot,
      "the receipt binds a different distribution than the one rebuilt from that commit",
    );
  }
  const runtime = body["runtime"] as Record<string, unknown>;
  if (
    runtime["truthClass"] !== "PROVEN" || runtime["pinningMethod"] === "UNSUPPORTED" ||
    !isText(runtime["closureKind"]) || !isDigestText(runtime["observationDigest"])
  ) {
    return crossHostFailure(
      "CROSS_HOST_RUNTIME_UNVERIFIABLE", "CROSS_HOST_AGGREGATOR", slot,
      "the provider runtime closure was not proven and pinned on this host",
    );
  }
  return null;
}

function scheduleRejection(body: Record<string, unknown>, slot: CrossHostSlot): CrossHostFailure | null {
  const cases = body["cases"] as Record<string, unknown>[];
  const identities = new Set(cases.map((entry) => `${String(entry["boundary"])}/${String(entry["schedule"])}`));
  if (
    cases.length !== CROSS_HOST_EXPECTED_CASE_COUNT ||
    identities.size !== CROSS_HOST_EXPECTED_CASE_COUNT ||
    cases.some((entry) => exactKeys(entry, CROSS_HOST_CASE_KEYS) === null)
  ) {
    return crossHostFailure(
      "CROSS_HOST_SCHEDULE_INCOMPLETE", "CROSS_HOST_AGGREGATOR", slot,
      `the receipt does not carry ${CROSS_HOST_EXPECTED_CASE_COUNT} uniquely identified case records`,
    );
  }
  const schedule = body["schedule"] as Record<string, unknown>;
  if (schedule["scheduleDigest"] !== canonicalDigest(scheduleUniverseOf(cases))) {
    return crossHostFailure(
      "CROSS_HOST_SCHEDULE_DIGEST_MISMATCH", "CROSS_HOST_AGGREGATOR", slot,
      "the sealed schedule digest does not cover the case universe the receipt carries",
    );
  }
  if (body["caseDigest"] !== canonicalDigest(cases)) {
    return crossHostFailure(
      "CROSS_HOST_RAW_RECEIPT_MISMATCH", "CROSS_HOST_AGGREGATOR", slot,
      "the sealed case digest does not cover the raw case records the receipt carries",
    );
  }
  return null;
}

export function verifyHostReceipt(
  expectedSlot: CrossHostSlot,
  bytes: Uint8Array,
  expected: CrossHostExpectation,
): VerifyHostReceiptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return malformed(expectedSlot, "the receipt bytes are not JSON");
  }
  const whole = exactKeys(parsed, RECEIPT_KEYS);
  if (whole === null) {
    return malformed(expectedSlot, "the receipt does not carry exactly its declared keys");
  }
  const shape = shapeRejection(whole, expectedSlot);
  if (shape !== null) {
    return shape;
  }
  const { receiptDigest, ...body } = whole;
  if (receiptDigest !== canonicalDigest(body)) {
    return crossHostFailure(
      "CROSS_HOST_RECEIPT_DIGEST_MISMATCH", "CROSS_HOST_AGGREGATOR", expectedSlot,
      "the receipt's self digest does not recompute over its own bindings",
    );
  }
  const refusal =
    identityRejection(body, expectedSlot) ??
    bindingRejection(body, expectedSlot, expected) ??
    scheduleRejection(body, expectedSlot);
  return refusal ?? { ok: true as const, receipt: whole as unknown as CrossHostReceipt };
}

// --- aggregation ------------------------------------------------------------

export interface CrossHostRow {
  readonly hostSlot: CrossHostSlot;
  readonly truthClass: "PROVEN" | "UNKNOWN";
  readonly receiptDigest: string | null;
  readonly failure: CrossHostFailure | null;
}

export interface CrossHostAggregate {
  readonly aggregateVersion: typeof CROSS_HOST_AGGREGATE_VERSION;
  readonly consumerTaskId: typeof CROSS_HOST_CONSUMER_TASK_ID;
  readonly source: CrossHostExpectation["source"];
  readonly distribution: CrossHostExpectation["distribution"];
  readonly rows: readonly CrossHostRow[];
  readonly truthClass: "PROVEN" | "UNKNOWN";
  readonly aggregateDigest: string;
}

export interface AggregateInput {
  readonly expected: CrossHostExpectation;
  readonly slots: Readonly<Record<CrossHostSlot, readonly Uint8Array[]>>;
}

function rowFor(slot: CrossHostSlot, input: AggregateInput): CrossHostRow {
  const offered = input.slots[slot] ?? [];
  const unknown = (failure: CrossHostFailure): CrossHostRow =>
    ({ hostSlot: slot, truthClass: "UNKNOWN", receiptDigest: null, failure });
  if (offered.length === 0) {
    return unknown(crossHostFailure(
      "CROSS_HOST_RECEIPT_MISSING", "CROSS_HOST_AGGREGATOR", slot,
      "no host receipt was offered for this slot",
    ));
  }
  if (offered.length > 1) {
    return unknown(crossHostFailure(
      "CROSS_HOST_RECEIPT_DUPLICATE", "CROSS_HOST_AGGREGATOR", slot,
      "more than one receipt was offered for this slot and none of them is authoritative",
    ));
  }
  const verified = verifyHostReceipt(slot, offered[0] as Uint8Array, input.expected);
  return verified.ok
    ? { hostSlot: slot, truthClass: "PROVEN", receiptDigest: verified.receipt.receiptDigest, failure: null }
    : unknown(verified);
}

/**
 * Each slot is verified independently, so one absent or tampered host leaves the
 * OTHER host's valid row standing. Aggregate truth is AND over a row set whose
 * length is checked, because `every` over a truncated list is vacuously true.
 */
export function aggregateHostReceipts(input: AggregateInput): CrossHostAggregate {
  const rows = CROSS_HOST_HOST_SLOTS.map((slot) => rowFor(slot, input));
  const complete =
    rows.length === CROSS_HOST_HOST_SLOTS.length && rows.every((row) => row.truthClass === "PROVEN");
  const body = {
    aggregateVersion: CROSS_HOST_AGGREGATE_VERSION,
    consumerTaskId: CROSS_HOST_CONSUMER_TASK_ID,
    source: input.expected.source,
    distribution: input.expected.distribution,
    rows,
    truthClass: complete ? ("PROVEN" as const) : ("UNKNOWN" as const),
  };
  return Object.freeze({ ...body, aggregateDigest: canonicalDigest(body) });
}

export function aggregateFileName(aggregate: CrossHostAggregate): string {
  return `aggregate-${aggregate.aggregateDigest}.json`;
}
