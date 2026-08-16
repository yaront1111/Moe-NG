/**
 * The activation-side provider-run composition and durable commit, driven end to
 * end through the REAL launcher, the REAL `buildProviderRunRecord` and a REAL
 * `SqliteEventStore`. Nothing below stubs the launcher, injects `deps`, or plants
 * durable bytes: every record committed here was composed from a handoff the
 * runner actually minted.
 *
 * ## `ok: true` IS NOT SUCCESS, and this is the layer where that becomes durable
 *
 * `launchClaudeWithTelemetry` reaches `ok: false` ONLY for a run reference it
 * could not snapshot. A launcher that REFUSED before any provider bytes existed,
 * and a delivery that launched no process at all, BOTH return `ok: true` carrying
 * a BLIND handoff — facts UNKNOWN, `telemetryRefusal` populated. The committability
 * decision this file pins is that blind handoffs ARE committed, because a ledger
 * that withholds them cannot distinguish a refused launch from a launch that never
 * happened; the durable falsehood would be committing one AS IF OBSERVED. So every
 * blind case below also asserts the record cannot be read as a success.
 *
 * ## WHY THERE IS NO OBSERVED CASE, measured rather than assumed
 *
 * Reaching the launcher's OBSERVED arm needs all ten `ClaudeLauncherDependencies`
 * ports, because `deps` is all-or-nothing (`entry.deps ?? CLAUDE_LAUNCHER_DEFAULTS`,
 * no merge) and the default set is off the published seam. `prepareClaudeRuntimePin`,
 * `registerLaunchLock`, `resolveDuplicateDelivery`, `intakeProcessObservation` and
 * `CLAUDE_LAUNCHER_DEFAULTS` appear in `packages/runner/src/index.ts` and
 * `surface/*.ts` only inside COMMENTS — zero exports. Running the default set
 * instead spawns a real `claude.exe`, and hand-building a handoff would be
 * reimplementing withheld runner authority (`snapshotRunRef`, `unknownFact` and
 * `telemetryRefusal` are all internal for exactly that reason). The consequence is
 * disclosed rather than papered over: on every arm reachable from apps/**, usage
 * normalization refuses at `USAGE_INPUT` before it can produce a row, so the usage
 * projection is empty in every case here. `buildProviderRunRecord` is proven to be
 * ON THE PATH by the handoff-malformed case, which reaches a COMPOSITION-layer
 * refusal that only the runner call can raise.
 *
 * ## Three layers can refuse, so no case asserts a code alone
 *
 * The composition, the codec and the ledger each answer with their own layer, and
 * the launcher answers with a fourth vocabulary entirely. Every refusal assertion
 * below pins the code AND the layer, and each fixture is valid at the earlier
 * layers so the intended one is what speaks.
 *
 * Every store is opened inside its `it` and closed in a `finally`: a handle held
 * into teardown kills the vitest worker outright.
 */
import {
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  buildProviderRunRecord,
  type ClaudeLaunchSelection,
  type ClaudeTelemetryHandoff,
  type ClaudeTelemetryLaunchResult,
  type ProviderUsageResult,
} from "@moe/runner";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey } from "@moe/store";
import { describe, expect, it } from "vitest";

import { decodeProviderRunRecord } from "../telemetry/provider-run-codec.js";
import { deriveProviderRunAggregateId } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord, ProviderRunStore } from "../telemetry/provider-run-contracts.js";
import {
  PROVIDER_RUN_LEDGER_CODES,
  PROVIDER_RUN_LEDGER_LAYERS,
} from "../telemetry/provider-run-refusals.js";
import { launchActivationProviderRun } from "./activation-telemetry-launch.js";
import {
  commitActivationProviderRun,
  composeProviderRunRecord,
  projectUsage,
} from "./activation-run-commit.js";
import type { ActivationRunCommitResult, ActivationRunClockFacts } from "./activation-run-commit.js";

const PROJECT_ID = "activation-run-commit-project";

const PROVIDER_RUN = Object.freeze({
  provider: "claude" as const,
  runRef: "run:activation:1",
  effectIntentId: "intent:1",
  attemptRef: "attempt:1",
  epoch: 3,
});

const SELECTION: ClaudeLaunchSelection = Object.freeze({
  provider: "claude",
  selectedModelId: "claude-opus-5-20260514",
  modelSnapshotKind: "DATED_SNAPSHOT",
  modelSnapshotEvidence: "claude-opus-5-20260514/build-2026-05-14",
  reasoningEffort: "high",
  profileRevisionId: "profile-revision-19",
  configurationDigest: "1c".repeat(32),
  policyDigest: "2d".repeat(32),
  orchestrationDigest: "3e".repeat(32),
  concurrencyCeiling: 4,
});

/** Parses as an `EffectClaim`: four bounded refs and a canonical UTC stamp. */
const CLAIM = Object.freeze({
  claimId: "claim-1",
  intentId: "intent-1",
  wrapperIdentity: "wrapper-1",
  lockIdentity: "lock-1",
  claimedAt: "2026-08-16T00:00:00.000Z",
});

/** `registration: null` under a RELEASED lock is the resolver's EXIT_BEFORE_LAUNCH arm. */
const DUPLICATE_DELIVERY = Object.freeze({
  claim: CLAIM,
  registration: null,
  lockState: "RELEASED",
  effectState: "ACTIVE",
});

const OPTIONS = Object.freeze({ platform: "win32" });

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    runtime: {
      quotedObservation: { observationDigest: "4f".repeat(32) },
      installedRoot: "C:\\Claude",
      pinRoot: "C:\\Claude\\pins",
      fs: null,
      facts: null,
      clock: null,
    },
    duplicateDelivery: null,
    effect: null,
    attempt: null,
    grant: null,
    claim: CLAIM,
    wrapperIdentity: "wrapper-1",
    bootstrapCredentialDigest: "ab".repeat(32),
    priorRegistration: null,
    // Names a DIFFERENT model than the selection, so the pre-open selection gate
    // refuses through a real production refusal rather than a malformed request.
    argv: [
      "--print", "hello",
      CLAUDE_LAUNCH_SELECTION_FLAGS.model, "claude-sonnet-5-20260514",
      CLAUDE_LAUNCH_SELECTION_FLAGS.effort, "high",
    ],
    cwd: "C:\\work",
    environment: { SYSTEMROOT: "C:\\Windows" },
    reconciliation: null,
    limits: { stdoutBytes: 4_096, stderrBytes: 4_096, tailBytes: 256, timeoutMs: 1_000 },
    launchSelection: SELECTION,
    ...overrides,
  };
}

/** The launcher REFUSED before any provider bytes existed. */
const refusedLaunch = async (): Promise<ClaudeTelemetryLaunchResult> =>
  launchActivationProviderRun({ providerRun: PROVIDER_RUN, request: request(), options: OPTIONS });

/** This delivery launched no process of its own. */
const notAttemptedLaunch = async (): Promise<ClaudeTelemetryLaunchResult> =>
  launchActivationProviderRun({
    providerRun: PROVIDER_RUN,
    request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
    options: OPTIONS,
  });

const malformedRefLaunch = async (): Promise<ClaudeTelemetryLaunchResult> =>
  launchActivationProviderRun({
    // A space is outside the bounded-ref alphabet /^[!-~]{1,200}$/u.
    providerRun: { ...PROVIDER_RUN, runRef: "run ref with a space" },
    request: request(),
    options: OPTIONS,
  });

const CLOCK: ActivationRunClockFacts = Object.freeze({
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: { serverWallSeconds: 1_700_000_009, bootId: "boot-1", monotonicObservation: 21 },
});

const KEY: CommandDecisionKey = Object.freeze({
  commandId: "command-1",
  principalId: "principal-1",
  projectId: PROJECT_ID,
});

const REQUEST_BYTES = new TextEncoder().encode("activation-run-commit-request-1");
const AGGREGATE = deriveProviderRunAggregateId(PROVIDER_RUN);

function openStore(): SqliteEventStore {
  return SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
}

function commitInput(
  launch: ClaudeTelemetryLaunchResult,
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof commitActivationProviderRun>[1] {
  return {
    clock: CLOCK,
    correlationId: "correlation-1",
    decidedAt: "2026-01-01T00:00:00.000Z",
    key: KEY,
    launch,
    requestBytes: REQUEST_BYTES,
    ...overrides,
  } as Parameters<typeof commitActivationProviderRun>[1];
}

function accepted(
  result: ActivationRunCommitResult,
): Extract<ActivationRunCommitResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a commit, got ${result.code} at ${result.layer}`);
  return result;
}

function refused(result: { readonly ok: boolean }): { code: string; layer: string } {
  if (result.ok) throw new Error("expected a refusal, but the call accepted");
  return result as unknown as { code: string; layer: string };
}

function handoffOf(result: ClaudeTelemetryLaunchResult): ClaudeTelemetryHandoff {
  if (!result.ok) throw new Error(`expected a handoff, received ${result.code}/${result.layer}`);
  return result.handoff;
}

/** The record as the DURABLE bytes hold it, never the in-memory value. */
function durableRecord(store: SqliteEventStore, aggregateId: string): ProviderRunRecord {
  const events = store.readEvents(aggregateId);
  if (events.length !== 1) throw new Error(`expected exactly one event, found ${events.length}`);
  const decoded = decodeProviderRunRecord(events[0]?.payload);
  if (!decoded.ok) throw new Error(`durable bytes unreadable: ${decoded.code}`);
  return decoded.record;
}

/**
 * The condition that makes a blind record committable rather than a durable
 * falsehood. Asserted on every committed record in this file, not per case: a
 * record whose facts are UNKNOWN must never present a completed run, must keep
 * the refusal that says why, and must carry no observation it never had.
 */
function assertNeverReadsAsSuccess(record: ProviderRunRecord): void {
  expect(record.upstreamRefusal).not.toBeNull();
  expect(record.terminal).not.toBe("COMPLETED");
  expect(record.infrastructure).not.toBe("NONE");
  expect(record.launch.observationDigest).toBeNull();
  expect(record.launch.startedAt).toBeNull();
  expect(record.launch.completedAt).toBeNull();
  // An unmeasured count must never arrive as a measured zero.
  expect(record.tokens.inputTokens).not.toHaveProperty("value");
  expect(record.steps.turns).not.toHaveProperty("value");
  expect(record.sequence).not.toHaveProperty("value");
  expect(record.observedModel.snapshotKind).toBe("UNKNOWN");
  expect(record.usage).toEqual([]);
}

describe("commitActivationProviderRun — the committability decision", () => {
  it("returns a malformed run ref unchanged and writes nothing durable", async () => {
    const store = openStore();
    try {
      const launch = await malformedRefLaunch();
      const result = commitActivationProviderRun(store, commitInput(launch));

      // The launcher's OWN vocabulary, unwrapped: not re-coded into this family.
      expect(result).toBe(launch);
      const seen = refused(result);
      expect(seen.code).toBe("TELEMETRY_RUN_REF_MALFORMED");
      expect(seen.layer).toBe("TELEMETRY_INPUT");
      expect(PROVIDER_RUN_LEDGER_LAYERS).not.toContain(seen.layer);

      // No aggregate, and no invented identity keyed from the malformed ref.
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
      expect(store.readEvents(
        deriveProviderRunAggregateId({ ...PROVIDER_RUN, runRef: "run ref with a space" }),
      )).toHaveLength(0);
      expect(store.getCommandDecision(KEY)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("commits a REFUSED launch as an honest blind record", async () => {
    const store = openStore();
    try {
      const result = accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      expect(result.disposition).toBe("COMMITTED");
      expect(result.aggregateId).toBe(AGGREGATE);

      const durable = durableRecord(store, AGGREGATE);
      expect(durable.terminal).toBe("REFUSED");
      expect(durable.infrastructure).toBe("LAUNCH_REFUSED");
      expect(durable.upstreamRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
      expect(durable.upstreamRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      expect(durable.launch.kind).toBe("REFUSED");
      assertNeverReadsAsSuccess(durable);
    } finally {
      store.close();
    }
  });

  it("commits a NOT_ATTEMPTED launch and keeps it distinct from a REFUSED one", async () => {
    const store = openStore();
    try {
      const result = accepted(
        commitActivationProviderRun(store, commitInput(await notAttemptedLaunch())),
      );
      expect(result.disposition).toBe("COMMITTED");

      const durable = durableRecord(store, AGGREGATE);
      expect(durable.terminal).toBe("UNKNOWN");
      expect(durable.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
      expect(durable.upstreamRefusal?.code).toBe("TELEMETRY_LAUNCH_NOT_ATTEMPTED");
      expect(durable.launch.kind).toBe("EXIT_BEFORE_LAUNCH");
      assertNeverReadsAsSuccess(durable);

      // Both arms are ok:true blind handoffs. Collapsing them would lose WHICH
      // happened, so every field that separates them is pinned as different.
      const other = composeProviderRunRecord(handoffOf(await refusedLaunch()), CLOCK);
      if (!other.ok) throw new Error("the REFUSED arm must compose");
      expect(durable.upstreamRefusal?.code).not.toBe(other.record.upstreamRefusal?.code);
      expect(durable.terminal).not.toBe(other.record.terminal);
      expect(durable.infrastructure).not.toBe(other.record.infrastructure);
      expect(durable.launch.kind).not.toBe(other.record.launch.kind);
    } finally {
      store.close();
    }
  });

  it("carries the daemon's own clock readings without touching the launcher's stamps", async () => {
    const store = openStore();
    try {
      accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      const durable = durableRecord(store, AGGREGATE);
      expect(durable.observedStart).toEqual(CLOCK.observedStart);
      expect(durable.observedEnd).toEqual(CLOCK.observedEnd);
      // Two observers, deliberately not reconciled.
      expect(durable.launch.startedAt).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("composeProviderRunRecord — provenance", () => {
  it("routes the record through @moe/runner's buildProviderRunRecord, not a local build", async () => {
    const store = openStore();
    try {
      // A handoff the runner could not have minted. `buildProviderRunRecord` reads
      // `telemetryRefusal` before anything else and throws on it, so a COMPOSITION
      // refusal proves the runner call ran. A call site that composed the record
      // locally would sail past and be answered by the CODEC instead, with a
      // different code at a different layer.
      const broken = { ok: true, handoff: {} } as unknown as ClaudeTelemetryLaunchResult;
      const result = commitActivationProviderRun(store, commitInput(broken));
      const seen = refused(result);
      expect(seen.code).toBe("PROVIDER_RUN_HANDOFF_MALFORMED");
      expect(seen.layer).toBe("PROVIDER_RUN_COMPOSITION");
      expect(PROVIDER_RUN_LEDGER_CODES).toContain(seen.code);
      // A refusal at any layer leaves NO durable event.
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
      expect(store.getCommandDecision(KEY)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("takes usage from the runner's normalization and never mints a measurement", async () => {
    const handoff = handoffOf(await refusedLaunch());
    const composed = composeProviderRunRecord(handoff, CLOCK);
    if (!composed.ok) throw new Error("a blind handoff must compose");

    // Asserted against the PRODUCTION surface, not a reimplementation of it.
    const built = buildProviderRunRecord(handoff, { priors: [] });
    expect(built.usage.ok).toBe(false);
    if (built.usage.ok) throw new Error("an unobserved interval cannot normalize");
    // Disclosed limit: every arm reachable from apps/** refuses at USAGE_INPUT
    // before a row exists, so the projection is empty here by construction.
    expect(built.usage.layer).toBe("USAGE_INPUT");
    expect(built.usage.code).toBe("PROVIDER_USAGE_INTERVAL_UNOBSERVED");
    expect(composed.record.usage).toEqual([]);
    // A USAGE_INPUT refusal is a fact of the RUN, already visible in the record's
    // own UNKNOWN launch interval, so no envelope refusal is invented for it.
    expect(composed.record.usageRefusals).toEqual([]);
  });

  it("mints no record digest — the codec is the only authority on it", async () => {
    const store = openStore();
    try {
      const composed = composeProviderRunRecord(handoffOf(await refusedLaunch()), CLOCK);
      if (!composed.ok) throw new Error("a blind handoff must compose");
      // The composition states no opinion about the digest at all.
      expect(composed.record.recordDigest).toBe("");

      const result = accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      const durable = durableRecord(store, AGGREGATE);
      expect(durable.recordDigest).toBe(result.digest);
      expect(result.record.recordDigest).toBe(result.digest);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      store.close();
    }
  });
});

/**
 * The usage projection's own arms. Only the empty one is reachable through a
 * launch this package can drive, so the two COMPOSITION-layer codes would be
 * unguarded — a refusal code with zero occurrences in a test file is a refusal
 * nothing enforces — and they are asserted against the exported production
 * function rather than a local restatement of it.
 *
 * `ProviderUsageResult` is a published @moe/runner TYPE, and these values are
 * inputs to a pure mapper: nothing here claims a run was observed, and no record
 * built from them is ever committed.
 */
const authorityRefusal = (): ProviderUsageResult => ({
  code: "PROVIDER_USAGE_AUTHORITY_REFUSED",
  layer: "USAGE_AUTHORITY",
  message: "the measurement authority refused this observation",
  ok: false,
  upstream: [
    { code: "BUDGET_OBSERVATION_SEQUENCE_REGRESSION", layer: "MEASUREMENT", message: "regressed" },
  ],
});

describe("projectUsage — the two arms no reachable launch can drive", () => {
  it("carries a scheduler-refused envelope with its sequence and issues verbatim", () => {
    const refusal = authorityRefusal();
    // A KNOWN sequence is the only field this pure mapper reads off the handoff.
    const handoff = { sequence: { known: true, value: 7 } } as unknown as ClaudeTelemetryHandoff;
    const projected = projectUsage(handoff, refusal);

    if (!projected.ok) throw new Error(`expected a projection, got ${projected.code}`);
    expect(projected.usage).toEqual([]);
    expect(projected.usageRefusals).toEqual([
      {
        issues: [
          { code: "BUDGET_OBSERVATION_SEQUENCE_REGRESSION", layer: "MEASUREMENT", message: "regressed" },
        ],
        providerSequence: 7,
      },
    ]);
  });

  it("refuses rather than defaulting an unknown provider sequence to zero", async () => {
    // A REAL blind handoff, whose sequence is genuinely unknown.
    const handoff = handoffOf(await refusedLaunch());
    expect(handoff.sequence).not.toHaveProperty("value");

    const projected = projectUsage(handoff, authorityRefusal());
    const seen = refused(projected);
    expect(seen.code).toBe("PROVIDER_RUN_USAGE_SEQUENCE_INVALID");
    expect(seen.layer).toBe("PROVIDER_RUN_COMPOSITION");
  });

  it("refuses an unreadable prior, which no record field would otherwise reveal", async () => {
    const projected = projectUsage(handoffOf(await refusedLaunch()), {
      code: "PROVIDER_USAGE_PRIOR_UNREADABLE",
      layer: "USAGE_INPUT",
      message: "a prior observation is not a normalizer-issued record",
      ok: false,
      upstream: [],
    });
    const seen = refused(projected);
    expect(seen.code).toBe("PROVIDER_RUN_MEASUREMENT_REFUSED");
    expect(seen.layer).toBe("PROVIDER_RUN_COMPOSITION");
  });

  it("invents no envelope for a USAGE_INPUT refusal the record already explains", async () => {
    const projected = projectUsage(handoffOf(await refusedLaunch()), {
      code: "PROVIDER_USAGE_RECEIPT_UNKNOWN",
      layer: "USAGE_INPUT",
      message: "the run reports no readable stdout receipt digest",
      ok: false,
      upstream: [],
    });
    if (!projected.ok) throw new Error(`expected a projection, got ${projected.code}`);
    expect(projected.usage).toEqual([]);
    expect(projected.usageRefusals).toEqual([]);
  });
});

/**
 * A port whose commit throws the store's own error. The refusal it produces is
 * unreachable through a healthy store, and the case exists to prove the arm
 * leaves nothing durable rather than a fragment.
 */
function throwingCommit(store: SqliteEventStore, error: DurableStoreError): ProviderRunStore {
  return {
    commitExpectedVersionDecision: () => {
      throw error;
    },
    getCommandDecision: (key) => store.getCommandDecision(key),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
  };
}

describe("commitActivationProviderRun — replay and atomicity", () => {
  it("replays the same activation and still holds exactly one durable event", async () => {
    const store = openStore();
    try {
      const first = accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      const second = accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));

      expect(first.disposition).toBe("COMMITTED");
      expect(second.disposition).toBe("REPLAYED");
      expect(second.digest).toBe(first.digest);
      expect(store.readEvents(AGGREGATE)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  /**
   * THE ECHO KILLER. The store's replay identity hashes the key, commandKind,
   * target aggregate, expectedVersion and request bytes — NOT the events array —
   * so a second call under the same key carrying a MATERIALLY DIFFERENT record
   * replays cleanly at the store while describing a run nobody committed. A ledger
   * that answered from the caller's own record would return ok:true here and every
   * idempotence assertion in this file would be comparing the caller's bytes with
   * the caller's bytes.
   */
  it("answers a changed-byte resubmit from the DURABLE record, never the caller's", async () => {
    const store = openStore();
    try {
      accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      const drifted = commitActivationProviderRun(store, commitInput(await notAttemptedLaunch()));

      const seen = refused(drifted);
      expect(seen.code).toBe("PROVIDER_RUN_REPLAY_DIVERGED");
      // This ledger refusing, not the store: the store replayed correctly.
      expect(seen.layer).toBe("PROVIDER_RUN_LEDGER");
      expect((seen as unknown as { storeCode: unknown }).storeCode).toBeNull();

      // The durable aggregate still holds the FIRST record, untouched.
      const durable = durableRecord(store, AGGREGATE);
      expect(durable.terminal).toBe("REFUSED");
      expect(durable.infrastructure).toBe("LAUNCH_REFUSED");
      expect(durable.upstreamRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
    } finally {
      store.close();
    }
  });

  it("refuses a distinct command on an already-committed run and writes nothing more", async () => {
    const store = openStore();
    try {
      accepted(commitActivationProviderRun(store, commitInput(await refusedLaunch())));
      const conflicting = commitActivationProviderRun(store, commitInput(
        await notAttemptedLaunch(),
        { key: { ...KEY, commandId: "command-2" }, requestBytes: new TextEncoder().encode("other") },
      ));

      const seen = refused(conflicting);
      expect(seen.code).toBe("PROVIDER_RUN_EXPECTED_VERSION_CONFLICT");
      expect(seen.layer).toBe("PROVIDER_RUN_LEDGER");
      expect(store.readEvents(AGGREGATE)).toHaveLength(1);
      expect(durableRecord(store, AGGREGATE).terminal).toBe("REFUSED");
    } finally {
      store.close();
    }
  });

  /**
   * The clock readings are the one part of this record the CALLER supplies, so
   * they are the one reachable route to a codec refusal. The composition
   * deliberately does not pre-validate them: a daemon-side check would be
   * validating one record while the codec digests another.
   */
  it("leaves no durable event when the codec refuses caller-supplied clock facts", async () => {
    const store = openStore();
    try {
      const result = commitActivationProviderRun(store, commitInput(await refusedLaunch(), {
        clock: {
          observedStart: { serverWallSeconds: -1, bootId: "", monotonicObservation: 1.5 },
          observedEnd: null,
        },
      }));

      const seen = refused(result);
      expect(seen.code).toBe("PROVIDER_RUN_FIELD_INVALID");
      expect(seen.layer).toBe("PROVIDER_RUN_CODEC");
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
      expect(store.getCommandDecision(KEY)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("leaves no durable event when the store refuses, preserving the store's own code", async () => {
    const store = openStore();
    try {
      const port = throwingCommit(store, new DurableStoreError("STORE_INPUT_INVALID", "refused"));
      const result = commitActivationProviderRun(port, commitInput(await refusedLaunch()));

      const seen = refused(result);
      // An input fault is OURS and retrying never succeeds, so it is FIELD_INVALID
      // rather than "unavailable" — and the store's own code survives verbatim.
      expect(seen.code).toBe("PROVIDER_RUN_FIELD_INVALID");
      expect(seen.layer).toBe("PROVIDER_RUN_LEDGER");
      expect((seen as unknown as { storeCode: unknown }).storeCode).toBe("STORE_INPUT_INVALID");
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
