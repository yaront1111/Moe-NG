/**
 * Admissible record fixtures for harness self-tests and for the campaigns downstream.
 *
 * THESE ARE INPUTS, NOT AUTHORITY. A fixture builds a record shaped like one the daemon
 * commits; it re-implements no projection rule, so a property asserted against a
 * projection can never be quietly satisfied by the fixture instead of the production
 * surface. Nothing here decides anything a record says.
 *
 * THE NUMBERS ARE CHOSEN TO BE DISCRIMINATING, not to be pretty. Each pair below is
 * deliberately unequal so that a projection reading the wrong source produces a
 * different, visible number rather than the same one by luck:
 *  - the daemon monotonic delta is 12 while its wall delta is 30, so a duration derived
 *    from wall seconds instead of the monotonic reading is a different value;
 *  - the launcher's wall stamps are hours away from the daemon's, so a duration mixing
 *    the two observers is off by orders of magnitude rather than by rounding;
 *  - quantity 4 against a 1500-micro unit price makes a derived 6000 a number that
 *    appears nowhere in the record, so a list price presented as an actual cost stands
 *    out instead of blending in.
 */

import type {
  ProjectedClockObservation, ProjectedFactUnknown, ProjectedRunRecord, ProjectedUsageRow,
} from "./benchmark-record-contracts.js";
import { PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";

/**
 * DEEPLY FROZEN, for two reasons that both bite downstream.
 *
 * The constants below are shared across every caller, and the builders embed them in the
 * records they return. An unfrozen shared fixture is the classic corruption footgun: one
 * consumer mutating `record.usage[0].measurement` would silently change what every other
 * consumer's "pristine" fixture means, and the failure would surface far from the edit.
 *
 * It is also the more faithful shape. `composeProviderRunRecord` freezes the record it
 * commits, so a frozen fixture is what a real reader actually receives. Building variants
 * by spreading is unaffected; only in-place mutation is refused, which is the point.
 */
function deepFreeze<T>(value: T): T {
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null) deepFreeze(entry);
  }
  return Object.freeze(value);
}

/** An unobserved fact carrying the producing authority's own code and layer. */
export function unknownFactFixture(code: string, layer: string): ProjectedFactUnknown {
  return deepFreeze({ known: false, code, layer });
}

/** Same boot, monotonic delta 12, wall delta 30 — the two deltas must not agree. */
export const FIXTURE_OBSERVED_START: ProjectedClockObservation = deepFreeze({
  serverWallSeconds: 1_000, bootId: "boot-a", monotonicObservation: 5_000,
});
export const FIXTURE_OBSERVED_END: ProjectedClockObservation = deepFreeze({
  serverWallSeconds: 1_030, bootId: "boot-a", monotonicObservation: 5_012,
});
/** Identical readings to FIXTURE_OBSERVED_END but a different boot, and nothing else. */
export const FIXTURE_OBSERVED_END_OTHER_BOOT: ProjectedClockObservation = deepFreeze({
  serverWallSeconds: 1_030, bootId: "boot-b", monotonicObservation: 5_012,
});

export const FIXTURE_USAGE_ROW: ProjectedUsageRow = deepFreeze({
  measurement: {
    meter: "input_tokens", quantity: 4, coverage: "COMPLETE", source: "PROVIDER_RESULT",
    providerRunRef: "run-1", sourceParserVersion: 2, sequence: 1,
    rawReceiptDigest: "a".repeat(64),
  },
  pricebookBinding: {
    pricebookRevisionRef: "pricebook-7", unitPriceMicros: 1_500, pricedAtRef: "priced-at-7",
  },
  truncated: false,
  identity: "usage-1",
});

/** A row whose quantity was never observed. `null` is unobserved and never a zero. */
export const FIXTURE_USAGE_ROW_UNMEASURED: ProjectedUsageRow = deepFreeze({
  measurement: {
    meter: "output_tokens", quantity: null, coverage: "PARTIAL", source: "PROVIDER_RESULT",
    providerRunRef: "run-1", sourceParserVersion: 2, sequence: 2,
    rawReceiptDigest: "b".repeat(64),
  },
  pricebookBinding: null,
  truncated: true,
  identity: "usage-2",
});

/** Every field observed: the arm against which an incomplete record must stay distinct. */
export function completeRunRecordFixture(): ProjectedRunRecord {
  return deepFreeze({
    recordVersion: PROJECTED_RECORD_VERSION,
    providerRunRef: {
      provider: "claude", runRef: "run-1", effectIntentId: "effect-1",
      attemptRef: "attempt-1", epoch: 3,
    },
    launch: {
      kind: "COMPLETED", truthClass: "OBSERVED", reasonCode: null, reasonLayer: null,
      effectDigest: "effect-digest", activationDigest: "activation-digest",
      runtimeBindingDigest: "runtime-binding-digest", quotedRuntimeDigest: "quoted-runtime-digest",
      freshRuntimeDigest: "fresh-runtime-digest", pinnedClosureDigest: "pinned-closure-digest",
      observationDigest: "observation-digest",
      startedAt: "2026-08-16T10:00:00.000Z", completedAt: "2026-08-16T10:00:30.000Z",
    },
    declared: {
      known: true,
      selection: {
        provider: "claude", selectedModelId: "claude-opus-5", modelSnapshotKind: "PINNED",
        modelSnapshotEvidence: "selection-evidence", reasoningEffort: "high",
        profileRevisionId: "profile-9", configurationDigest: "configuration-digest",
        policyDigest: "policy-digest", orchestrationDigest: "orchestration-digest",
        concurrencyCeiling: 4,
      },
    },
    observedModel: {
      modelId: { known: true, value: "claude-opus-5-20260101" },
      snapshotKind: "INITIALISED",
      snapshotEvidence: { known: true, value: "observed-evidence" },
    },
    terminal: "SUCCESS",
    infrastructure: "NONE",
    tokens: {
      inputTokens: { known: true, value: 120 },
      outputTokens: { known: true, value: 240 },
      cacheCreationInputTokens: { known: true, value: 10 },
      cacheReadInputTokens: { known: true, value: 20 },
      coverage: "COMPLETE",
    },
    steps: { turns: { known: true, value: 7 }, coverage: "COMPLETE" },
    sequence: { known: true, value: 2 },
    concurrency: {
      fact: "DECLARED_CEILING_ONLY",
      declaredCeiling: { known: true, value: 4 },
      achieved: unknownFactFixture(
        "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", "TELEMETRY_RESULT",
      ),
    },
    observedStart: FIXTURE_OBSERVED_START,
    observedEnd: FIXTURE_OBSERVED_END,
    usage: [FIXTURE_USAGE_ROW, FIXTURE_USAGE_ROW_UNMEASURED],
    usageRefusals: [
      {
        providerSequence: 3,
        issues: [
          { layer: "MEASUREMENT", code: "BUDGET_OBSERVATION_SEQUENCE_GAP", message: "gap" },
        ],
      },
    ],
    upstreamRefusal: null,
    stdoutReceiptDigest: { known: true, value: "c".repeat(64) },
    stderrReceiptDigest: { known: true, value: "d".repeat(64) },
    recordDigest: "e".repeat(64),
  });
}

/**
 * The same record with nothing observed. Used to prove an UNKNOWN never renders as a
 * zero and never borrows a value from the complete arm above.
 */
export function unobservedRunRecordFixture(): ProjectedRunRecord {
  const base = completeRunRecordFixture();
  const absent = unknownFactFixture("TELEMETRY_RESULT_ABSENT", "TELEMETRY_RESULT");
  return deepFreeze({
    ...base,
    declared: unknownFactFixture("TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_LAUNCH"),
    observedModel: { modelId: absent, snapshotKind: "ABSENT", snapshotEvidence: absent },
    launch: { ...base.launch, startedAt: null, completedAt: null },
    tokens: {
      inputTokens: absent, outputTokens: absent, cacheCreationInputTokens: absent,
      cacheReadInputTokens: absent, coverage: "UNKNOWN",
    },
    steps: { turns: absent, coverage: "UNKNOWN" },
    sequence: absent,
    concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: absent, achieved: absent },
    observedStart: null,
    observedEnd: null,
    usage: [FIXTURE_USAGE_ROW_UNMEASURED],
    stdoutReceiptDigest: absent,
    stderrReceiptDigest: absent,
  });
}
