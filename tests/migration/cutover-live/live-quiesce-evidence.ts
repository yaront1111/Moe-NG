/**
 * The evidence record for the LIVE legacy quiesce (task-e60b874b).
 *
 * COMPOSES, NEVER DUPLICATES (rail 3). The byte evidence — "the legacy bytes did
 * not move" — comes from `captureCutoverManifest` and `compareCutoverManifests`
 * in tests/migration/cutover/, which task-4e1fe696 owns and which already carry
 * an injectable `CutoverWalkPorts` defaulting to real node:fs. Nothing here
 * reimplements a walker or a comparison.
 *
 * SERIALIZATION IS LOAD-BEARING, not incidental. The population this row
 * quiesces includes the daemon serving the board, so the process that would
 * otherwise report the result does not survive the stop actions. The record must
 * therefore be writable to a durable file BEFORE the first stop and appendable
 * as each stop happens. That is why `serializeLiveEvidence` and
 * `writeLiveEvidence` are an explicit surface with their own arms rather than a
 * `JSON.stringify` at the call site.
 *
 * ONE SHAPE, TWO CONSUMERS — WHY THESE CANNOT DRIFT (task-2bf8fa1a, DoD 3).
 * The layer name, the seven-code refusal roster and the `LiveQuiesceEvidence`
 * record shape are DEFINED ONCE, in `packages/core/src/cutover/
 * cutover-quiesce-evidence.ts`, and imported here. They are re-exported below
 * so this lane's existing importers keep their `./live-quiesce-evidence.js`
 * specifier, but the re-exported bindings are the core bindings themselves:
 * `LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES` here is reference-identical to the core
 * export, not a copy that happens to agree. Editing the core roster changes
 * this lane's roster in the same edit, and the lane's own roster arm reds if
 * the two stop being the same seven codes.
 *
 * WHAT STAYS HERE, deliberately: `buildLiveEvidence`'s refusal wording, the
 * two-space `serializeLiveEvidence` pretty-printer for a human reader, and the
 * `writeLiveEvidence` port. Those are harness concerns. `@moe/core` owns the
 * exact parsed shape and the canonical `quiesceRecordSha256` the daemon needs;
 * this lane owns the human artifact and the injected file write.
 */

import {
  LIVE_QUIESCE_EVIDENCE_LAYER,
  LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES,
  type LiveQuiesceEvidence,
  type LiveQuiesceEvidenceRefusal,
  type LiveQuiesceEvidenceRefusalCode,
} from "@moe/core";

import type { CutoverComparisonResult } from "../cutover/cutover-compare.js";
import type { QuiesceItemResult, SweepOutcome } from "./live-quiesce-actor.js";
import type { LiveQuiesceInventory } from "./live-quiesce-inventory.js";

export { LIVE_QUIESCE_EVIDENCE_LAYER, LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES };
export type {
  LiveQuiesceEvidence,
  LiveQuiesceEvidenceRefusal,
  LiveQuiesceEvidenceRefusalCode,
};

/**
 * DoD 5. task-09008b4c's quiesce dependency must cite THIS row's live evidence.
 * Resolving that clause by task id currently reads task-4e1fe696 = DONE and
 * concludes the drill ran; it did not, because that row was approved at HARNESS
 * scope deliberately. Both ids are named here so the distinction is a value a
 * test can assert, not a caveat in a comment someone has to notice.
 */
export const QUIESCE_CITATION_TASK_ID = "task-e60b874bac924a6b9c255cb8c924041f";
export const HARNESS_ONLY_TASK_ID = "task-4e1fe696";
export const QUIESCE_CITATION_CONSUMER = "task-09008b4cb39c4a15aa661540d20e9b9b";

/** The GO_QUIESCE grant, quoted from the board rather than inferred. */
export interface GoQuiesceAuthority {
  readonly principal: string;
  readonly moment: string;
  readonly commentId: string;
}

export interface StopMoment {
  readonly itemId: string;
  readonly moment: string;
}

export interface LiveQuiesceEvidenceInput {
  readonly runMode: "LIVE";
  readonly hostFingerprint: string;
  readonly authority: GoQuiesceAuthority;
  readonly inventory: LiveQuiesceInventory;
  readonly results: readonly QuiesceItemResult[];
  readonly manifestComparison: CutoverComparisonResult;
  readonly stoppedAt: readonly StopMoment[];
}

export type LiveQuiesceEvidenceResult =
  | { readonly ok: true; readonly evidence: LiveQuiesceEvidence }
  | LiveQuiesceEvidenceRefusal;

export interface EvidenceWritePorts {
  readonly writeFile: (path: string, body: string) => void;
}

export type LiveQuiesceWriteResult =
  | { readonly ok: true; readonly path: string; readonly byteLength: number }
  | LiveQuiesceEvidenceRefusal;

const refuse = (
  code: LiveQuiesceEvidenceRefusalCode,
  detail: string,
): LiveQuiesceEvidenceRefusal => ({
  ok: false,
  layer: LIVE_QUIESCE_EVIDENCE_LAYER,
  code,
  detail,
});

const isBlank = (value: string | undefined): boolean =>
  typeof value !== "string" || value.trim().length === 0;

/**
 * Builds the record, or refuses with the exact code and this layer.
 *
 * A PARTIAL run is an ACCEPTED outcome, not a refusal: an honest partial with
 * named refusals is what DoD 3 asks for. What is refused is a record a reader
 * could misread — an item with no result, a count that does not add up, a
 * harness runMode, an unattributed authority, or byte evidence that never
 * actually compared.
 */
export const buildLiveEvidence = (
  input: LiveQuiesceEvidenceInput,
): LiveQuiesceEvidenceResult => {
  if (input.runMode !== "LIVE") {
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_RUNMODE_MISSING",
      `runMode must be "LIVE"; received ${JSON.stringify(input.runMode)}`,
    );
  }

  const { principal, moment, commentId } = input.authority;
  if (isBlank(principal) || isBlank(moment) || isBlank(commentId)) {
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_AUTHORITY_MISSING",
      "a LIVE record must quote the GO_QUIESCE principal, moment and comment id",
    );
  }

  if (input.results.length !== input.inventory.itemCount) {
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH",
      `inventory holds ${input.inventory.itemCount} items but ${input.results.length} results were supplied`,
    );
  }

  const resolved = new Set(input.results.map((result) => result.item.id));
  const unresolved = input.inventory.items
    .filter((item) => !resolved.has(item.id))
    .map((item) => item.id);
  if (unresolved.length > 0) {
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
      `item(s) ${unresolved.join(", ")} were neither stopped with an observation nor refused`,
    );
  }

  if (!("ok" in input.manifestComparison) || !input.manifestComparison.ok) {
    const detail =
      "code" in input.manifestComparison ? input.manifestComparison.code : "unknown";
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_MANIFEST_REFUSED",
      `the before/after manifest comparison refused (${detail}); there is no byte evidence to record`,
    );
  }

  const timed = new Set(input.stoppedAt.map((entry) => entry.itemId));
  const untimed = input.results
    .filter((result) => result.ok && !timed.has(result.item.id))
    .map((result) => result.item.id);
  if (untimed.length > 0) {
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING",
      `stopped item(s) ${untimed.join(", ")} carry no recorded stop moment`,
    );
  }

  const outcome: SweepOutcome =
    input.results.length === 0
      ? "EMPTY"
      : input.results.every((result) => result.ok)
        ? "COMPLETE"
        : "PARTIAL";

  return {
    ok: true,
    evidence: {
      runMode: "LIVE",
      hostFingerprint: input.hostFingerprint,
      authority: input.authority,
      inventory: input.inventory,
      results: [...input.results],
      resolvedCount: input.results.length,
      manifestComparison: input.manifestComparison,
      stoppedAt: [...input.stoppedAt],
      outcome,
      citationKey: `live-quiesce/${QUIESCE_CITATION_TASK_ID}`,
      citedBy: QUIESCE_CITATION_CONSUMER,
    },
  };
};

/** Two-space JSON so `runMode` and the citation are legible in a plain reader. */
export const serializeLiveEvidence = (evidence: LiveQuiesceEvidence): string =>
  `${JSON.stringify(evidence, null, 2)}\n`;

/**
 * Writes the record through an injected port and REFUSES rather than throwing
 * when the write fails. A durable write that silently failed would leave the
 * run with no evidence at exactly the moment the reporting process is about to
 * be stopped, so the failure has to be a value the caller can act on.
 */
export const writeLiveEvidence = (
  evidence: LiveQuiesceEvidence,
  path: string,
  ports: EvidenceWritePorts,
): LiveQuiesceWriteResult => {
  const body = serializeLiveEvidence(evidence);
  try {
    ports.writeFile(path, body);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(
      "LIVE_QUIESCE_EVIDENCE_WRITE_FAILED",
      `the durable write to ${path} failed: ${detail}`,
    );
  }
  return { ok: true, path, byteLength: Buffer.byteLength(body, "utf8") };
};
