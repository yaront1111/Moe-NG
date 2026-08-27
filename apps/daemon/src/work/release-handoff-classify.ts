/**
 * How an upstream reader's verdict becomes one of this builder's eight refusal classes, and
 * which durable aggregates the builder holds a horizon over
 * (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * IT LIVES APART FROM THE READS ON PURPOSE. Classification is the one rule every source
 * shares, and the aggregate roster is the one thing the BUILDER needs without needing any
 * read at all. Keeping both here lets `release-handoff-sources.ts` be nothing but the seven
 * reads, and keeps every file in this family well inside the per-file cap.
 *
 * CLASSIFICATION NEVER RESTAMPS. The class says which of eight repairs this is; the
 * upstream code and layer ride alongside it verbatim, so a reader of the refusal can always
 * see which authority actually answered. Collapsing the two would turn six distinguishable
 * failures into one indistinguishable one.
 */

import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import { deriveAttemptJournalAggregateId } from "../journal/journal-contracts.js";
import { deriveProviderRunAggregateId } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRef } from "@moe/runner";
import {
  deriveFoundationArtifactAggregateId,
} from "./foundation-artifact-ledger.js";
import {
  deriveFoundationCaptureAggregateId, deriveFoundationCaptureRef,
} from "./foundation-capture-context-ledger.js";
import { deriveFoundationContextAggregateId } from "./foundation-context-manifest-identity.js";
import { refuseHandoff } from "./release-handoff-contracts.js";
import type {
  ReleaseHandoffCode, ReleaseHandoffIdentity, ReleaseHandoffRefused, ReleaseHandoffSource,
} from "./release-handoff-contracts.js";
import { deriveAttemptStepAggregateId } from "./step-lifecycle-contracts.js";

/**
 * Upstream code to refusal class, BY SUFFIX, because every durable reader in this daemon
 * already names its failures with the same endings.
 *
 * ORDER MATTERS: `_HORIZON_MOVED` and `_DIGEST_MISMATCH` are tested before the shorter
 * endings they contain, so a code ending in both never falls to the wrong class.
 *
 * The default is MALFORMED rather than a silent pass — an unrecognised code still REFUSES,
 * and its text travels verbatim so nothing is lost. `release-handoff-classify.test.ts` pins
 * each source module's PUBLISHED code roster against this map, both directions, so a reader
 * that adds a new ending is caught here rather than arriving downstream classified as
 * something it is not.
 */
const SUFFIX_CLASSES: readonly (readonly [string, ReleaseHandoffCode])[] = Object.freeze([
  ["_HORIZON_MOVED", "RELEASE_HANDOFF_SOURCE_HORIZON_MOVED"],
  ["_ABSENT", "RELEASE_HANDOFF_SOURCE_ABSENT"],
  ["_UNREADABLE", "RELEASE_HANDOFF_SOURCE_UNREADABLE"],
  ["_AMBIGUOUS", "RELEASE_HANDOFF_SOURCE_AMBIGUOUS"],
  ["_STALE", "RELEASE_HANDOFF_SOURCE_STALE"],
  // BEFORE the bare `_MISMATCH`, and the ordering is the whole point: a DIGEST mismatch is
  // a record that stopped covering its own content — MALFORMED — while a project, binding
  // or attempt mismatch is a record about something else. Classified FOREIGN, a corrupt
  // journal would send an operator hunting an attempt that was never involved.
  ["_DIGEST_MISMATCH", "RELEASE_HANDOFF_SOURCE_MALFORMED"],
  ["_MISMATCH", "RELEASE_HANDOFF_SOURCE_FOREIGN"],
  ["_UNEXPECTED", "RELEASE_HANDOFF_SOURCE_FOREIGN"],
  ["_UNKNOWN", "RELEASE_HANDOFF_SOURCE_UNREADABLE"],
] as const);

/** The suffixes this map recognises, exported so a roster test can enumerate them rather
 *  than restating them and drifting from the map it is meant to be checking. */
export const HANDOFF_CLASS_SUFFIXES: readonly string[] =
  Object.freeze(SUFFIX_CLASSES.map(([suffix]) => suffix));

export function classifyUpstream(code: string): ReleaseHandoffCode {
  for (const [suffix, mapped] of SUFFIX_CLASSES) {
    if (code.endsWith(suffix)) return mapped;
  }
  return "RELEASE_HANDOFF_SOURCE_MALFORMED";
}

/** This daemon's own stamp for a disagreement THIS module detected between two durable
 *  sources. It is not a reader's code, so it must not wear a reader's layer. */
export const HANDOFF_CROSS_CHECK_LAYER = "DAEMON_RELEASE_HANDOFF_CROSS_CHECK" as const;

/** The upstream verdict, classified but NEVER restamped. */
export const carrySourceRefusal = (
  source: ReleaseHandoffSource, code: string, layer: string,
): ReleaseHandoffRefused => refuseHandoff(classifyUpstream(code), source, { code, layer });

/** Two sources describing the SAME attempt differently. Distinct from FOREIGN, which is one
 *  source describing ANOTHER attempt: they demand different repairs. */
export const refuseConflict = (
  source: ReleaseHandoffSource, detail: string,
): ReleaseHandoffRefused => refuseHandoff(
  "RELEASE_HANDOFF_SOURCE_CONFLICTING", source,
  { code: detail, layer: HANDOFF_CROSS_CHECK_LAYER });

export const refuseForeign = (
  source: ReleaseHandoffSource, detail: string,
): ReleaseHandoffRefused => refuseHandoff(
  "RELEASE_HANDOFF_SOURCE_FOREIGN", source,
  { code: detail, layer: HANDOFF_CROSS_CHECK_LAYER });

export const isHandoffRefusal = (value: object): value is ReleaseHandoffRefused =>
  "ok" in value && (value as { ok: unknown }).ok === false;

/**
 * The six aggregates the builder reads directly, so ONE horizon can be held over exactly
 * them and no more. Every id is derived through its owning production derivation — none is
 * rebuilt here — so an aggregate this list names is the same aggregate the source read.
 *
 * The provider-run id joins only after its strict reader discovers the durable run ref; the
 * terminal-evidence deriver is absent because it already guards its own moved horizon.
 */
export function handoffAggregateIds(
  binding: FoundationAttemptBinding, identity: ReleaseHandoffIdentity,
  providerRunRef?: ProviderRunRef,
): readonly string[] {
  const ids = [
    deriveAttemptStepAggregateId(binding.activationDigest),
    deriveAttemptJournalAggregateId(binding.activationDigest),
    deriveFoundationCaptureAggregateId(deriveFoundationCaptureRef({
      attemptAggregateId: binding.activationAggregateId, attemptId: binding.attemptId,
      nodeKey: identity.nodeKey, projectId: identity.projectId, sessionId: identity.sessionId,
    })),
    deriveFoundationContextAggregateId({
      attemptRef: binding.attemptId, projectId: identity.projectId,
      sessionId: identity.sessionId,
    }),
    deriveFoundationArtifactAggregateId(binding.activationAggregateId),
  ];
  if (providerRunRef !== undefined) ids.push(deriveProviderRunAggregateId(providerRunRef));
  return Object.freeze(ids);
}
