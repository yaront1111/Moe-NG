import { join } from "node:path";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { deriveLiveQuiesceEvidenceDigest } from "@moe/core";

import { readDurableImportGeneration } from "../projections/import-generation-reader.js";
import type { ImportGenerationStorePort } from "../projections/import-generation-reader.js";

/**
 * The four-value cutover generation snapshot: the evidence a cutover activation is measured
 * against, read from durable state and composed, never derived here.
 *
 * WHY IT REFUSES INSTEAD OF DEFAULTING. This snapshot exists so an activation can be compared
 * against the generations it was decided under. A zero-filled or empty-string generation would
 * compare EQUAL to another zero-filled one, so a defaulted value does not merely lose
 * information - it silently reports "no drift" for two states that were never compared. The
 * refusal type therefore carries no `generations` field at all, mirroring
 * `ImportGenerationRefused`: the bad answer is unrepresentable rather than merely unwritten.
 * That is the same standard durable-recovery-inventory-reader.ts:312-314 states for the
 * inventory - "an inventory that answers with whatever it happened to find is the invented
 * absence this area prevents".
 *
 * WHERE THE ACTIVATION AND QUIESCE WITNESSES ACTUALLY LIVE. They are on the durable EVENTS,
 * not on `ProjectState`, which carries no witness at all (project-contract.ts:86-93), and not
 * on the folded decision ledger, which keeps only the LAST committed result per aggregate and
 * would let one witness overwrite the other. Production already reads them the way this module
 * does - provider-profile-reader-checks.ts:151 takes the latest `ProjectActivated` payload off
 * the event stream and reads `witness` from it. That module's `latestPayload` is not exported
 * and its file is outside this row's paths, so the single forward pass is mirrored here rather
 * than imported; it keeps that reader's load-bearing distinction between UNREADABLE (corrupt
 * evidence) and absent (never written), because they are different answers to an operator.
 *
 * THE CALLER SUPPLIES NO DIGEST. The request vocabulary is the project identity alone: no
 * locator, no digest and no "current" selector, because a caller-presented generation would
 * make the drift comparison compare a value against itself.
 */

export const CUTOVER_GENERATION_SNAPSHOT_LAYER = "DAEMON_CUTOVER_GENERATION" as const;

/** The four facts, in the shape task-b2548479's marker consumes them. */
export const CUTOVER_GENERATION_FACTS = Object.freeze([
  "distributionManifestSha256",
  "backupGenerationDigest",
  "quiesceRecordSha256",
  "importGenerationSha256",
] as const);

export type CutoverGenerationFact = (typeof CUTOVER_GENERATION_FACTS)[number];

/** Every code has a planned emitter; an unreachable code is a claim no test can pin. */
export const CUTOVER_GENERATION_REFUSAL_CODES = Object.freeze([
  "CUTOVER_GENERATION_BACKUP_ABSENT",
  "CUTOVER_GENERATION_DISTRIBUTION_MANIFEST_ABSENT",
  "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
  "CUTOVER_GENERATION_HORIZON_DRIFT",
  "CUTOVER_GENERATION_IMPORT_ABSENT",
  "CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT",
] as const);

export type CutoverGenerationRefusalCode = (typeof CUTOVER_GENERATION_REFUSAL_CODES)[number];

/**
 * The file the live-quiesce lane writes its evidence record to, resolved against the DAEMON's
 * own store root. It is a constant here and a config field there precisely so no caller can
 * point this reader at a record of its own choosing.
 */
export const LIVE_QUIESCE_EVIDENCE_FILENAME = "live-quiesce-evidence.json";

export interface CutoverGenerations {
  readonly backupGenerationDigest: string;
  readonly distributionManifestSha256: string;
  readonly importGenerationSha256: string;
  readonly quiesceRecordSha256: string;
}

export interface CutoverGenerationAccepted {
  readonly generations: CutoverGenerations;
  readonly ok: true;
}

/** No `generations` field: a defaulted or partial snapshot cannot be expressed. */
export interface CutoverGenerationRefused {
  readonly code: CutoverGenerationRefusalCode;
  readonly detail: string;
  readonly layer: typeof CUTOVER_GENERATION_SNAPSHOT_LAYER;
  /** WHICH of the four was unavailable, so an operator is not sent to the wrong evidence. */
  readonly missing: CutoverGenerationFact;
  readonly ok: false;
  /** The answering source's own diagnosis, forwarded rather than restamped as ours. */
  readonly upstream: Readonly<{ code: string; layer: string }> | null;
}

export type CutoverGenerationSnapshot = CutoverGenerationAccepted | CutoverGenerationRefused;

/** Read-only by construction, so this reader cannot reach a writer even by accident. */
export interface CutoverGenerationEventPort {
  readAggregateEvents(
    aggregateId: string,
    cursor: number,
    limit: number,
  ): Readonly<{
    hasMore: boolean;
    items: readonly Readonly<{ eventType: string; payload: Uint8Array }>[];
    nextCursor: number | null;
  }>;
}

export interface CutoverGenerationPorts {
  /** The daemon's own configuration. The evidence path is derived from it, never passed in. */
  readonly config: Readonly<{ storeRoot: string }>;
  readonly readFileText: (path: string) => string;
  readonly store: CutoverGenerationEventPort & ImportGenerationStorePort;
}

export interface CutoverGenerationRequest {
  readonly projectId: string;
}

const PAGE_LIMIT = 256;

function refuse(
  missing: CutoverGenerationFact,
  code: CutoverGenerationRefusalCode,
  detail: string,
  upstream: Readonly<{ code: string; layer: string }> | null = null,
): CutoverGenerationRefused {
  return Object.freeze({
    code,
    detail,
    layer: CUTOVER_GENERATION_SNAPSHOT_LAYER,
    missing,
    ok: false as const,
    upstream,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The latest committed event of one type on one aggregate, in a single forward pass.
 *
 * "UNREADABLE" is deliberately distinct from `null`: a stream whose current event does not
 * decode is corrupt evidence, which is a different answer from a stream that never carried the
 * event at all. Mirrors provider-profile-reader-checks.ts:86-103; see the module doc comment
 * for why it is mirrored rather than imported.
 */
function latestPayload(
  store: CutoverGenerationEventPort,
  aggregateId: string,
  eventType: string,
): Record<string, unknown> | "UNREADABLE" | null {
  let cursor = 0;
  let latest: Record<string, unknown> | "UNREADABLE" | null = null;
  for (;;) {
    const page = store.readAggregateEvents(aggregateId, cursor, PAGE_LIMIT);
    for (const event of page.items) {
      if (event.eventType !== eventType) continue;
      const decoded = decodeBoundedJsonBytes(event.payload);
      latest = decoded.ok && isRecord(decoded.value) ? decoded.value : "UNREADABLE";
    }
    if (!page.hasMore || page.nextCursor === null || page.nextCursor <= cursor) return latest;
    cursor = page.nextCursor;
  }
}

/** A witness field is only a fact when it is a non-blank string the store actually carried. */
function witnessField(
  payload: Record<string, unknown> | "UNREADABLE" | null,
  field: string,
): string | null {
  if (payload === null || payload === "UNREADABLE") return null;
  const witness: unknown = payload["witness"];
  if (!isRecord(witness)) return null;
  const value: unknown = witness[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readDistributionManifest(
  ports: CutoverGenerationPorts,
  request: CutoverGenerationRequest,
): string | CutoverGenerationRefused {
  const payload = latestPayload(ports.store, request.projectId, "ProjectActivated");
  if (payload === "UNREADABLE") {
    return refuse(
      "distributionManifestSha256", "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
      "the durable ProjectActivated payload does not decode; corrupt evidence is not absence",
    );
  }
  const hash = witnessField(payload, "distributionManifestHash");
  return hash ?? refuse(
    "distributionManifestSha256", "CUTOVER_GENERATION_DISTRIBUTION_MANIFEST_ABSENT",
    `no ProjectActivated witness carries a distributionManifestHash for ${request.projectId};`
      + " a defaulted manifest generation would compare equal to another defaulted one",
  );
}

function readBackupGeneration(
  ports: CutoverGenerationPorts,
  request: CutoverGenerationRequest,
): string | CutoverGenerationRefused {
  const payload = latestPayload(ports.store, request.projectId, "ProjectQuiesced");
  if (payload === "UNREADABLE") {
    return refuse(
      "backupGenerationDigest", "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
      "the durable ProjectQuiesced payload does not decode; corrupt evidence is not absence",
    );
  }
  const hash = witnessField(payload, "backupGenerationHash");
  return hash ?? refuse(
    "backupGenerationDigest", "CUTOVER_GENERATION_BACKUP_ABSENT",
    `no ProjectQuiesced witness carries a backupGenerationHash for ${request.projectId};`
      + " this is the restore controller's own generation, not the recovery inventory's seal",
  );
}

/**
 * The CANONICAL digest of the live-quiesce evidence record, never a hash of the file bytes:
 * the lane writes the file pretty-printed, and the canonical form carries no display
 * whitespace, so hashing the bytes would name a different value on every reformat.
 */
function readQuiesceRecord(ports: CutoverGenerationPorts): string | CutoverGenerationRefused {
  const path = join(ports.config.storeRoot, LIVE_QUIESCE_EVIDENCE_FILENAME);
  let text: string;
  try {
    text = ports.readFileText(path);
  } catch {
    return refuse(
      "quiesceRecordSha256", "CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT",
      `no live-quiesce evidence record is readable at ${path};`
        + " no live run has written one, and a seeded record would not be evidence",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(
      "quiesceRecordSha256", "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
      `the live-quiesce evidence record at ${path} is not valid JSON`,
    );
  }
  const derived = deriveLiveQuiesceEvidenceDigest(parsed);
  if (!derived.ok) {
    return refuse(
      "quiesceRecordSha256", "CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT",
      `@moe/core refused the live-quiesce evidence record at ${path}`,
      Object.freeze({ code: derived.code, layer: derived.layer }),
    );
  }
  return derived.quiesceRecordSha256;
}

function readImportGeneration(
  ports: CutoverGenerationPorts,
): string | CutoverGenerationRefused {
  const answer = readDurableImportGeneration(ports.store, {});
  if (answer.ok) return answer.importGenerationSha256;
  return refuse(
    "importGenerationSha256", "CUTOVER_GENERATION_IMPORT_ABSENT",
    "the durable import generation is unavailable; its own diagnosis is forwarded unchanged",
    Object.freeze({ code: answer.code, layer: answer.layer }),
  );
}

function refusalOf(value: string | CutoverGenerationRefused): CutoverGenerationRefused | null {
  return typeof value === "string" ? null : value;
}

/**
 * The store's event horizon, or a refusal. A horizon that does not read as a nonnegative
 * bigint is UNREADABLE evidence, not a zero.
 */
function readHorizon(
  ports: CutoverGenerationPorts,
): CutoverGenerationRefused | Readonly<{ at: bigint }> {
  try {
    const at: unknown = ports.store.readEventHorizon();
    if (typeof at !== "bigint" || at < 0n) {
      return refuse(
        "distributionManifestSha256", "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
        `the store horizon is not a nonnegative bigint: ${String(at)}`,
      );
    }
    return Object.freeze({ at });
  } catch {
    return refuse(
      "distributionManifestSha256", "CUTOVER_GENERATION_EVIDENCE_UNREADABLE",
      "the store horizon could not be read, so no snapshot can name a single state",
    );
  }
}

/**
 * The complete four-value snapshot for one cutover attempt, or a refusal naming the ONE fact
 * that was unavailable. Order is stable so the fact an operator is sent to is deterministic
 * rather than a race between four independent reads.
 */
export function readCutoverGenerationSnapshot(
  ports: CutoverGenerationPorts,
  request: CutoverGenerationRequest,
): CutoverGenerationSnapshot {
  // ORDER IS LOAD-BEARING. The four facts are read from four sources, so without a fence a
  // snapshot could be assembled across TWO store states - a manifest from before a
  // re-activation and a backup generation from after it. That answer names neither state and
  // would make the drift comparison compare a tree that never existed. The horizon is captured
  // BEFORE any read and re-checked as the LAST operation, the same discipline
  // import-generation-reader.ts applies for the same reason.
  const opened = readHorizon(ports);
  if ("ok" in opened) return opened;

  const distributionManifestSha256 = readDistributionManifest(ports, request);
  const distributionRefusal = refusalOf(distributionManifestSha256);
  if (distributionRefusal !== null) return distributionRefusal;

  const backupGenerationDigest = readBackupGeneration(ports, request);
  const backupRefusal = refusalOf(backupGenerationDigest);
  if (backupRefusal !== null) return backupRefusal;

  const quiesceRecordSha256 = readQuiesceRecord(ports);
  const quiesceRefusal = refusalOf(quiesceRecordSha256);
  if (quiesceRefusal !== null) return quiesceRefusal;

  const importGenerationSha256 = readImportGeneration(ports);
  const importRefusal = refusalOf(importGenerationSha256);
  if (importRefusal !== null) return importRefusal;

  const closed = readHorizon(ports);
  if ("ok" in closed) return closed;
  if (closed.at !== opened.at) {
    return refuse(
      "distributionManifestSha256", "CUTOVER_GENERATION_HORIZON_DRIFT",
      `the store horizon moved from ${String(opened.at)} to ${String(closed.at)} during the read;`
        + " a snapshot assembled across two states names neither of them",
    );
  }

  return Object.freeze({
    generations: Object.freeze({
      backupGenerationDigest: backupGenerationDigest as string,
      distributionManifestSha256: distributionManifestSha256 as string,
      importGenerationSha256: importGenerationSha256 as string,
      quiesceRecordSha256: quiesceRecordSha256 as string,
    }),
    ok: true as const,
  });
}
