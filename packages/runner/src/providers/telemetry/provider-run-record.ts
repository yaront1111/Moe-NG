/**
 * The provider-run record: one frozen, provider-NEUTRAL statement of what a run
 * was, bound from the Claude telemetry handoff and the measurement authority.
 *
 * IT MAPS, IT DOES NOT RE-DECIDE. Terminal and infrastructure classifications
 * come from the handoff's already-closed vocabularies, token and step facts from
 * what the result parser observed, concurrency verbatim including both halves,
 * and usage through `normalizeProviderUsage`, which routes every measurement
 * through @moe/scheduler. Nothing here recomputes a digest or re-classifies an
 * outcome: a second derivation could disagree with the first, and the
 * disagreeing copy would be the one a benchmark trusted.
 *
 * TWO DIGEST FAMILIES, DIFFERENT EVIDENCE. `decisionDigests`
 * (configuration/policy/orchestration) are the launch-DECISION inputs the caller
 * declared. `runtimeEvidence` (runtimeBinding/pinnedClosure/observation plus
 * profileRevisionId) is what the runtime actually WAS. They are carried side by
 * side and neither is ever derived from the other.
 *
 * MODEL AND EFFORT COME ONLY FROM THE DECLARED SELECTION. A profile revision, a
 * runtime binding digest, a pinned closure digest and the provider's own
 * observed model id are all present on this record under their own labels, and
 * none of them may stand in for the declared model or effort: a settings default
 * wearing a model's name is exactly the substitution this record exists to make
 * visible rather than plausible.
 */
import { deepFreeze } from "../../canonical.js";
import type { ClaudeModelEvidenceKind } from "../claude/claude-launch-selection.js";
import type {
  ClaudeStepObservations, ClaudeTokenObservations,
} from "./claude-result-telemetry.js";
import type {
  ClaudeDeclaredSelection, ClaudeTelemetryConcurrency, ClaudeTelemetryHandoff,
} from "./claude-telemetry-launch.js";
import {
  unknownFact,
  type ProviderConcurrencyFact, type ProviderCountCoverage, type ProviderFactUnknown,
  type ProviderInfrastructureOutcome, type ProviderQuantity, type ProviderRunRef,
  type ProviderTelemetryRefusal, type ProviderTerminalOutcome, type ProviderText,
} from "./provider-telemetry-contracts.js";
import type { ProviderUsageContext, ProviderUsageResult } from "./provider-usage-contracts.js";
import { normalizeProviderUsage } from "./provider-usage-normalization.js";

export const PROVIDER_RUN_RECORD_VERSION = "moe-provider-run-record/1" as const;

export type ProviderModelSnapshotKind = ClaudeModelEvidenceKind;

export interface ProviderRunIdentity {
  readonly providerRunRef: ProviderRunRef;
  readonly effectDigest: ProviderText;
  readonly activationDigest: ProviderText;
}
/**
 * The DECLARED model closure. `reasoningEffort` carries the declaration
 * verbatim, including the vocabulary's own `UNKNOWN` member: "the caller
 * declared no effort" is a different fact from "this record could not read the
 * declaration", and the two must stay distinguishable.
 */
export interface ProviderModelSelection {
  readonly selectedModelId: ProviderText;
  readonly snapshotKind: ProviderModelSnapshotKind;
  readonly snapshotEvidence: ProviderText;
  readonly reasoningEffort: ProviderText;
}
/** What the provider's OWN bytes said, never reconciled into the declared side. */
export interface ProviderObservedModel {
  readonly modelId: ProviderText;
  readonly snapshotKind: ProviderModelSnapshotKind;
  readonly snapshotEvidence: ProviderText;
}
export interface ProviderDecisionDigests {
  readonly configurationDigest: ProviderText;
  readonly policyDigest: ProviderText;
  readonly orchestrationDigest: ProviderText;
}
export interface ProviderRuntimeEvidence {
  readonly runtimeBindingDigest: ProviderText;
  readonly pinnedClosureDigest: ProviderText;
  readonly observationDigest: ProviderText;
  readonly profileRevisionId: ProviderText;
}
export interface ProviderTokenCounts {
  readonly inputTokens: ProviderQuantity;
  readonly outputTokens: ProviderQuantity;
  readonly cacheCreationInputTokens: ProviderQuantity;
  readonly cacheReadInputTokens: ProviderQuantity;
  readonly coverage: ProviderCountCoverage;
}
export interface ProviderStepCounts {
  readonly count: ProviderQuantity;
  readonly coverage: ProviderCountCoverage;
}
export interface ProviderRunConcurrency {
  readonly fact: ProviderConcurrencyFact;
  readonly declaredCeiling: ProviderQuantity;
  readonly achieved: ProviderQuantity;
}
export interface ProviderRunRecord {
  readonly recordVersion: typeof PROVIDER_RUN_RECORD_VERSION;
  readonly provider: ProviderRunRef["provider"];
  readonly identity: ProviderRunIdentity;
  readonly model: ProviderModelSelection;
  readonly observedModel: ProviderObservedModel;
  readonly decisionDigests: ProviderDecisionDigests;
  readonly runtimeEvidence: ProviderRuntimeEvidence;
  readonly startedAt: ProviderText;
  readonly completedAt: ProviderText;
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  readonly tokens: ProviderTokenCounts;
  readonly steps: ProviderStepCounts;
  readonly concurrency: ProviderRunConcurrency;
  readonly usage: ProviderUsageResult;
  readonly telemetryRefusal: ProviderTelemetryRefusal | null;
}

/**
 * A launch fact is `null` ONLY on an arm that produced no observation, and every
 * such arm carries the launcher's own refusal — so the absent fact inherits that
 * exact code and layer rather than a code invented here. An empty string is
 * treated as absent too: a known fact nobody can verify is worse than an honest
 * UNKNOWN.
 */
function textOf(value: string | null, absent: ProviderFactUnknown): ProviderText {
  return value === null || value === ""
    ? absent
    : deepFreeze({ known: true as const, value });
}
/**
 * The fallback INSIDE a readable selection. The selection reader admits no empty
 * field, so this is unreachable by construction — and it is still spelled with
 * the selection reader's own code rather than a launch-side one, because a field
 * that reached here would be a selection this record could not read.
 */
const SELECTION_UNREADABLE: ProviderFactUnknown =
  unknownFact("TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_INPUT");

function launchUnknown(handoff: ClaudeTelemetryHandoff): ProviderFactUnknown {
  const refusal = handoff.telemetryRefusal;
  return refusal === null
    ? unknownFact("TELEMETRY_LAUNCH_NOT_ATTEMPTED", "TELEMETRY_LAUNCH")
    : unknownFact(refusal.code, refusal.layer);
}

function modelOf(declared: ClaudeDeclaredSelection): ProviderModelSelection {
  if (!declared.known) {
    return {
      selectedModelId: declared, snapshotKind: "UNKNOWN", snapshotEvidence: declared,
      reasoningEffort: declared,
    };
  }
  const { selection } = declared;
  return {
    selectedModelId: textOf(selection.selectedModelId, SELECTION_UNREADABLE),
    snapshotKind: selection.modelSnapshotKind,
    snapshotEvidence: textOf(selection.modelSnapshotEvidence, SELECTION_UNREADABLE),
    reasoningEffort: textOf(selection.reasoningEffort, SELECTION_UNREADABLE),
  };
}

/**
 * The declared UNKNOWN arm is a `ProviderFactUnknown` in its own right, so an
 * unreadable selection makes every decision digest carry the selection reader's
 * exact code and layer instead of a launch-side one.
 */
function decisionDigestsOf(declared: ClaudeDeclaredSelection): ProviderDecisionDigests {
  if (!declared.known) {
    return {
      configurationDigest: declared, policyDigest: declared, orchestrationDigest: declared,
    };
  }
  const { selection } = declared;
  return {
    configurationDigest: textOf(selection.configurationDigest, SELECTION_UNREADABLE),
    policyDigest: textOf(selection.policyDigest, SELECTION_UNREADABLE),
    orchestrationDigest: textOf(selection.orchestrationDigest, SELECTION_UNREADABLE),
  };
}

function runtimeEvidenceOf(
  handoff: ClaudeTelemetryHandoff, absent: ProviderFactUnknown,
): ProviderRuntimeEvidence {
  const { declared, launch } = handoff;
  return {
    runtimeBindingDigest: textOf(launch.runtimeBindingDigest, absent),
    pinnedClosureDigest: textOf(launch.pinnedClosureDigest, absent),
    observationDigest: textOf(launch.observationDigest, absent),
    profileRevisionId: declared.known
      ? textOf(declared.selection.profileRevisionId, SELECTION_UNREADABLE)
      : declared,
  };
}

const tokensOf = (tokens: ClaudeTokenObservations): ProviderTokenCounts => ({
  inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens,
  cacheCreationInputTokens: tokens.cacheCreationInputTokens,
  cacheReadInputTokens: tokens.cacheReadInputTokens, coverage: tokens.coverage,
});
const stepsOf = (steps: ClaudeStepObservations): ProviderStepCounts =>
  ({ count: steps.turns, coverage: steps.coverage });
const concurrencyOf = (concurrency: ClaudeTelemetryConcurrency): ProviderRunConcurrency => ({
  fact: concurrency.fact, declaredCeiling: concurrency.declaredCeiling,
  achieved: concurrency.achieved,
});

/**
 * Builds the record. `context` threads the previous observation of the same
 * measurement stream so a redelivery is a deterministic no-op rather than a
 * second, conflicting fact; a caller with no history passes none.
 */
export function buildProviderRunRecord(
  handoff: ClaudeTelemetryHandoff, context: ProviderUsageContext = { priors: [] },
): ProviderRunRecord {
  const absent = launchUnknown(handoff);
  const { launch, providerRunRef } = handoff;
  return deepFreeze({
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    provider: providerRunRef.provider,
    identity: {
      providerRunRef: { ...providerRunRef },
      effectDigest: textOf(launch.effectDigest, absent),
      activationDigest: textOf(launch.activationDigest, absent),
    },
    model: modelOf(handoff.declared),
    observedModel: {
      modelId: handoff.observedModel.modelId,
      snapshotKind: handoff.observedModel.snapshotKind,
      snapshotEvidence: handoff.observedModel.snapshotEvidence,
    },
    decisionDigests: decisionDigestsOf(handoff.declared),
    runtimeEvidence: runtimeEvidenceOf(handoff, absent),
    startedAt: textOf(launch.startedAt, absent),
    completedAt: textOf(launch.completedAt, absent),
    terminal: handoff.terminal,
    infrastructure: handoff.infrastructure,
    tokens: tokensOf(handoff.tokens),
    steps: stepsOf(handoff.steps),
    concurrency: concurrencyOf(handoff.concurrency),
    usage: normalizeProviderUsage(handoff, context),
    telemetryRefusal: handoff.telemetryRefusal,
  });
}
