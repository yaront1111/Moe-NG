import { decodeBoundedJsonBytes } from "@moe/contracts";
import { POLICY_RISK_TIERS } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_DECISIONS, PREVIEW_FINDING_KEYS, boundedPreviewText,
  exactPreviewRecord,
} from "./preview-contracts.js";
import type { PreviewDecision, PreviewFinding } from "./preview-contracts.js";

/**
 * WHAT A COMMITTED `preview.decide` LEAVES IN THE STORE, AND HOW IT IS READ BACK.
 *
 * Split out of `preview-daemon-edge.ts` (task-b8571cfe) when carrying provenance would have taken
 * that file past the 400-line split bar. The seam is a real responsibility line, not an arbitrary
 * cut: everything here answers "what a decision RECORD is and how it decodes", while the edge
 * keeps "which gates run, in what order, before one is committed". The edge re-exports every name
 * below, so no importer moves — the same discipline `bootstrap-ledger.ts` documents for its own
 * vocabulary split.
 *
 * THE PERSISTED RECORD IS DAEMON-LOCAL AND VERSIONED, AND THAT IS WHY PROVENANCE LIVES HERE
 * RATHER THAN ON THE WIRE. `decodePreviewDecidePayload` demands APPROVE be exactly
 * `["decision","previewRef"]` (preview-contracts.ts PREVIEW_APPROVE_PAYLOAD_KEYS) and refuses any
 * extra key with PREVIEW_DECISION_INVALID, so a provenance member THERE would change a shared
 * runtime contract and rotate all four GENERATED_CONTRACT_DIGEST mirrors. A full-tree grep finds
 * no mirror, no contract package and no control-room module pinning the shape below, so a version
 * bump here costs one decoder arm and no mirror rotation.
 *
 * WHY /2 CARRIES `provenance` ALWAYS RATHER THAN OPTIONALLY. `exactPreviewRecord` enforces exact
 * arity, so "present or absent" is not a shape this decoder can express: an absent key is a
 * DIFFERENT record, not the same record with a default. The key is therefore always written, and
 * `null` is its value for a human decision. Reading `provenance === null` as "a human decided
 * this" is the whole point of the field.
 *
 * WHY /1 IS STILL READ. `readPreviewDecision` returns null on a version mismatch, so bumping alone
 * would make every decision recorded before this row unreadable — silently, and to
 * `release-durable-facts.ts` as well as to the operator's own screen. The legacy arm admits a /1
 * record with its provenance read as null, which is the TRUTH about it: no opt-in was named
 * because none could have been.
 */

export const PREVIEW_DECISION_VERSION = "moe-preview-decision/2" as const;
/** The shape written before provenance existed. READ-ONLY: nothing mints one any more. */
export const PREVIEW_DECISION_LEGACY_VERSION = "moe-preview-decision/1" as const;

export const PREVIEW_DECISION_KEYS = Object.freeze([
  "decidedAt", "decision", "findings", "goalId", "previewRef", "projectId", "provenance", "sha",
  "version",
] as const);

export const PREVIEW_DECISION_LEGACY_KEYS = Object.freeze([
  "decidedAt", "decision", "findings", "goalId", "previewRef", "projectId", "sha", "version",
] as const);

/** The opt-in an AUTOMATIC decision acted under. Exact arity, matching every other record here. */
export const PREVIEW_PROVENANCE_KEYS = Object.freeze(["action", "tier"] as const);

/**
 * WHICH STANDING OPT-IN AN AUTOMATIC DECISION ACTED UNDER.
 *
 * `action` is the policy action the engine matched — `assessTier` requires
 * `entry.action === action` (policy-evaluation.ts:157), so a decision's action IS the matched
 * opt-in's action. `tier` is the SUBJECT's effective tier, which the opt-in's declared ceiling had
 * to cover. Together they name the opt-in as precisely as core's PUBLIC surface permits:
 * `foldSlices` and `tierRank` are module-private to @moe/core (policy-public.ts exports neither),
 * so the folded entry itself is unreachable without reimplementing composition — which is exactly
 * what this slice must not do.
 */
export interface PreviewDecisionProvenance {
  readonly action: string;
  readonly tier: PolicyRiskTier;
}

export interface PreviewDecisionRecord {
  readonly decidedAt: string;
  readonly decision: PreviewDecision;
  /** Empty for APPROVE. For REJECT, every element names a node of the goal's active graph. */
  readonly findings: readonly PreviewFinding[];
  readonly goalId: string;
  readonly previewRef: string;
  readonly projectId: string;
  /** NULL for a human decision. A reviewer tells the two apart by this field and nothing else. */
  readonly provenance: PreviewDecisionProvenance | null;
  readonly sha: string;
  readonly version: typeof PREVIEW_DECISION_VERSION | typeof PREVIEW_DECISION_LEGACY_VERSION;
}

/** One finding as the STORE holds it, refused rather than read around when it does not decode. */
function persistedFinding(value: unknown): PreviewFinding | null {
  const item = exactPreviewRecord(value, PREVIEW_FINDING_KEYS);
  if (item === null || !PREVIEW_FINDING_KEYS.every((key) => boundedPreviewText(item[key]))) {
    return null;
  }
  return Object.freeze({ detail: item["detail"] as string, nodeRef: item["nodeRef"] as string });
}

/**
 * One persisted provenance value, or REFUSAL.
 *
 * THREE OUTCOMES, NOT TWO, AND THE THIRD IS WHY THIS RETURNS `undefined`. `null` is a LEGAL value
 * here — it is what a human decision records — so the usual "null means refused" convention this
 * area uses for findings would make a malformed provenance indistinguishable from an honest human
 * one, and a corrupted record would read back as "a human approved this". `undefined` is the
 * refusal, and the caller turns it into a null RECORD rather than a null FIELD.
 */
export function persistedProvenance(
  value: unknown,
): PreviewDecisionProvenance | null | undefined {
  if (value === null) return null;
  const item = exactPreviewRecord(value, PREVIEW_PROVENANCE_KEYS);
  if (item === null || !boundedPreviewText(item["action"])) return undefined;
  const tier = POLICY_RISK_TIERS.find((one) => one === item["tier"]);
  if (tier === undefined) return undefined;
  return Object.freeze({ action: item["action"] as string, tier });
}

/**
 * Decode one decision record from a decoded JSON value, at EITHER version, or refuse.
 *
 * THE CURRENT SHAPE FIRST, THE LEGACY ONE ONLY IF THAT FAILS. Both rosters are exact-arity, so the
 * two are mutually exclusive by key COUNT alone — a /2 record can never satisfy the legacy roster
 * and vice versa. The version literal is then checked against the roster that MATCHED, so a record
 * carrying /1 bytes under /2 keys (or the reverse) is refused rather than admitted under the shape
 * it merely resembles.
 */
export function decodePreviewDecisionRecord(
  value: unknown, projectId: string,
): PreviewDecisionRecord | null {
  const current = exactPreviewRecord(value, PREVIEW_DECISION_KEYS);
  const record = current ?? exactPreviewRecord(value, PREVIEW_DECISION_LEGACY_KEYS);
  const version = current === null ? PREVIEW_DECISION_LEGACY_VERSION : PREVIEW_DECISION_VERSION;
  const verdict = PREVIEW_DECISIONS.find((one) => one === record?.["decision"]);
  if (record === null || verdict === undefined || !Array.isArray(record["findings"])
    || record["version"] !== version || record["projectId"] !== projectId
    || !["decidedAt", "goalId", "previewRef", "sha"].every((k) => boundedPreviewText(record[k]))) {
    return null;
  }
  // A /1 record names no opt-in because none could have been named when it was written.
  const provenance = current === null ? null : persistedProvenance(current["provenance"]);
  if (provenance === undefined) return null;
  const findings = (record["findings"] as readonly unknown[]).map(persistedFinding);
  if (findings.some((finding) => finding === null)) return null;
  return Object.freeze({
    decidedAt: record["decidedAt"] as string,
    decision: verdict,
    findings: Object.freeze(findings as readonly PreviewFinding[]),
    goalId: record["goalId"] as string,
    previewRef: record["previewRef"] as string,
    projectId,
    provenance,
    sha: record["sha"] as string,
    version,
  });
}

/** THE PRODUCTION READ of a committed preview decision: the operator's verdict, the roster they
 *  named, and — since task-b8571cfe — WHO decided, re-validated against the record carrying them.
 *  `/activity/read` reports the VERDICT for this kind (activity-read.ts VERDICT_KINDS); the
 *  findings live here, because an activity entry states a decision's facts and carries no payload. */
export function readPreviewDecision(
  store: SqliteEventStore, projectId: string, principalId: string, commandId: string,
): PreviewDecisionRecord | null {
  let decision;
  try {
    decision = store.getCommandDecision({ commandId, principalId, projectId });
  } catch { return null; }
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== PREVIEW_DECIDE_COMMAND_KIND) return null;
  const decoded = decodeBoundedJsonBytes(decision.resultBytes);
  if (!decoded.ok) return null;
  return decodePreviewDecisionRecord(decoded.value, projectId);
}
