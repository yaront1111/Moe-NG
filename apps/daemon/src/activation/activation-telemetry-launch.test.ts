/**
 * The daemon's activation-side provider-run emission seam, driven through the
 * REAL `launchClaudeWithTelemetry` and the launcher's REAL production ports —
 * no stub of the launcher and no injected `deps` anywhere below.
 *
 * WHAT EVERY CASE HERE IS GUARDING. `ok: true` does NOT mean the run succeeded.
 * The only route to the `ok: false` arm is a malformed run ref; a launcher that
 * REFUSED before any provider bytes existed and a delivery that launched no
 * process at all BOTH come back `ok: true` carrying a BLIND handoff whose facts
 * are UNKNOWN and whose `telemetryRefusal` is populated. A consumer that
 * branched on `ok` alone would report both as healthy observations and every
 * assertion that merely checked `ok` would stay green. So each case below pins
 * the exact stable code AND the layer that answered, and pins the FACTS rather
 * than the outcome flag.
 *
 * WHY THERE IS NO OBSERVED CASE, measured rather than assumed. Reaching the
 * OBSERVED arm needs all ten `ClaudeLauncherDependencies` ports, because `deps`
 * is all-or-nothing (`entry.deps ?? CLAUDE_LAUNCHER_DEFAULTS`, no merge) and the
 * default set is deliberately off the published seam. Four of those ten have no
 * published implementation: a bare-specifier probe reports TS2305 "no exported
 * member" for `prepareClaudeRuntimePin`, `registerLaunchLock`,
 * `resolveDuplicateDelivery` and `intakeProcessObservation`. Hand-building the
 * records those ports return would be reimplementing withheld runner authority
 * inside a daemon test, and running the default set instead would spawn a real
 * provider process. The NOT_ATTEMPTED case below is the one arm that reaches a
 * real production port — duplicate resolution runs ahead of everything else —
 * so it drives `resolveDuplicateDelivery` for real rather than around it.
 */
import {
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_RESULT_TELEMETRY_VERSION,
  CLAUDE_TELEMETRY_HANDOFF_VERSION,
  PROVIDER_TELEMETRY_LAYERS,
  type ClaudeLaunchSelection,
  type ClaudeTelemetryHandoff,
  type ClaudeTelemetryLaunchResult,
} from "@moe/runner";
import { describe, expect, it } from "vitest";

import { launchActivationProviderRun } from "./activation-telemetry-launch.js";

/** The five run-identity facts, exactly as the ledger's aggregate id keys them. */
const PROVIDER_RUN = Object.freeze({
  provider: "claude" as const,
  runRef: "run:activation:1",
  effectIntentId: "intent:1",
  attemptRef: "attempt:1",
  epoch: 3,
});

const SELECTED_MODEL = "claude-opus-5-20260514";
const SELECTED_EFFORT = "high";
const SELECTION: ClaudeLaunchSelection = Object.freeze({
  provider: "claude",
  selectedModelId: SELECTED_MODEL,
  modelSnapshotKind: "DATED_SNAPSHOT",
  modelSnapshotEvidence: "claude-opus-5-20260514/build-2026-05-14",
  reasoningEffort: SELECTED_EFFORT,
  profileRevisionId: "profile-revision-19",
  configurationDigest: "1c".repeat(32),
  policyDigest: "2d".repeat(32),
  orchestrationDigest: "3e".repeat(32),
  concurrencyCeiling: 4,
});

/**
 * A claim that parses as an `EffectClaim`: five plain fields, four bounded refs
 * and a canonical UTC timestamp. Nothing here is digest-derived, so this record
 * is legal at the layer the duplicate resolver actually reads it at.
 */
const CLAIM = Object.freeze({
  claimId: "claim-1",
  intentId: "intent-1",
  wrapperIdentity: "wrapper-1",
  lockIdentity: "lock-1",
  claimedAt: "2026-08-16T00:00:00.000Z",
});

/** A string that appears nowhere a real observation could come from. */
const CALLER_SENTINEL = "caller-invented-observation";

const runtime = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  quotedObservation: { observationDigest: "4f".repeat(32) },
  installedRoot: "C:\\Claude",
  pinRoot: "C:\\Claude\\pins",
  fs: null,
  facts: null,
  clock: null,
  ...overrides,
});

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    runtime: runtime(),
    duplicateDelivery: null,
    effect: null,
    attempt: null,
    grant: null,
    claim: CLAIM,
    wrapperIdentity: "wrapper-1",
    bootstrapCredentialDigest: "ab".repeat(32),
    priorRegistration: null,
    // Names a DIFFERENT model than the selection, so the pre-open selection gate
    // refuses: the REFUSED arm is reached by a real production refusal rather
    // than by a request too malformed to survive the snapshot.
    argv: [
      "--print", "hello",
      CLAUDE_LAUNCH_SELECTION_FLAGS.model, "claude-sonnet-5-20260514",
      CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT,
    ],
    cwd: "C:\\work",
    environment: { SYSTEMROOT: "C:\\Windows" },
    reconciliation: null,
    limits: { stdoutBytes: 4_096, stderrBytes: 4_096, tailBytes: 256, timeoutMs: 1_000 },
    launchSelection: SELECTION,
    ...overrides,
  };
}

/**
 * `registration: null` with a RELEASED lock and a declared effect state is the
 * resolver's EXIT_BEFORE_LAUNCH arm: nothing was adopted and nothing was
 * launched.
 */
const DUPLICATE_DELIVERY = Object.freeze({
  claim: CLAIM,
  registration: null,
  lockState: "RELEASED",
  effectState: "ACTIVE",
});

/** win32 is pinned so the platform gate answers the same on every runner. */
const OPTIONS = Object.freeze({ platform: "win32" });

function handoffOf(result: ClaudeTelemetryLaunchResult): ClaudeTelemetryHandoff {
  if (!result.ok) throw new Error(`expected the handoff arm, received ${result.code}/${result.layer}`);
  return result.handoff;
}

const blind = (code: string): Readonly<Record<string, unknown>> =>
  ({ known: false, code, layer: "TELEMETRY_LAUNCH" });

describe("launchActivationProviderRun", () => {
  it("refuses a malformed run ref at TELEMETRY_INPUT and launches nothing", async () => {
    const result = await launchActivationProviderRun({
      // A space is outside the bounded-ref alphabet /^[!-~]{1,200}$/u.
      providerRun: { ...PROVIDER_RUN, runRef: "run ref with a space" },
      request: request(),
      options: OPTIONS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a malformed run ref must not produce a handoff");
    expect(result.code).toBe("TELEMETRY_RUN_REF_MALFORMED");
    expect(result.layer).toBe("TELEMETRY_INPUT");
    expect(PROVIDER_TELEMETRY_LAYERS).toContain(result.layer);
  });

  it("reports a REFUSED launch as a blind handoff, never as an observation", async () => {
    const handoff = handoffOf(await launchActivationProviderRun({
      providerRun: PROVIDER_RUN, request: request(), options: OPTIONS,
    }));
    // The trap this case exists for: the arm is ok:true.
    expect(handoff.telemetryRefusal).toEqual({
      ok: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH",
      message: "the launcher refused before any provider bytes existed",
    });
    expect(handoff.terminal).toBe("REFUSED");
    expect(handoff.infrastructure).toBe("LAUNCH_REFUSED");
    expect(handoff.launch.kind).toBe("REFUSED");
    // The launcher's OWN code and layer, forwarded verbatim and unwrapped.
    expect(handoff.launch.reasonCode).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
    expect(handoff.launch.reasonLayer).toBe("TELEMETRY_CONFIGURATION");
    expect(handoff.launch.exit).toBeNull();
    expect(handoff.launch.observationDigest).toBeNull();
  });

  it("reports a delivery that launched nothing as NOT_ATTEMPTED, distinct from REFUSED", async () => {
    const notAttempted = handoffOf(await launchActivationProviderRun({
      providerRun: PROVIDER_RUN,
      request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      options: OPTIONS,
    }));
    const refused = handoffOf(await launchActivationProviderRun({
      providerRun: PROVIDER_RUN, request: request(), options: OPTIONS,
    }));
    expect(notAttempted.telemetryRefusal).toEqual({
      ok: false, code: "TELEMETRY_LAUNCH_NOT_ATTEMPTED", layer: "TELEMETRY_LAUNCH",
      message: "this delivery launched no process of its own",
    });
    expect(notAttempted.terminal).toBe("UNKNOWN");
    expect(notAttempted.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
    expect(notAttempted.launch.kind).toBe("EXIT_BEFORE_LAUNCH");
    // Both arms are ok:true blind handoffs. Collapsing them would lose WHICH
    // happened, so every field that separates them is pinned as different.
    expect(notAttempted.telemetryRefusal?.code).not.toBe(refused.telemetryRefusal?.code);
    expect(notAttempted.terminal).not.toBe(refused.terminal);
    expect(notAttempted.infrastructure).not.toBe(refused.infrastructure);
    expect(notAttempted.launch.kind).not.toBe(refused.launch.kind);
    // A PROVEN launch truth class here means "proven that no process started",
    // NOT a proven run. The facts below are what say the run is unobserved, and
    // reading this flag as run authority is the misread the pairing guards.
    expect(notAttempted.launch.truthClass).toBe("PROVEN");
    expect(notAttempted.telemetryRefusal).not.toBeNull();
  });

  it("returns the runner's own handoff, not a daemon-composed lookalike", async () => {
    const handoff = handoffOf(await launchActivationProviderRun({
      providerRun: PROVIDER_RUN,
      request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      options: OPTIONS,
    }));
    expect(handoff.handoffVersion).toBe(CLAUDE_TELEMETRY_HANDOFF_VERSION);
    expect(handoff.parserVersion).toBe(CLAUDE_RESULT_TELEMETRY_VERSION);
    // The five identity facts arrive as the runner's own frozen snapshot of
    // them — not the object this test passed in, and carrying nothing else.
    expect(handoff.providerRunRef).toEqual(PROVIDER_RUN);
    expect(handoff.providerRunRef).not.toBe(PROVIDER_RUN);
    expect(Object.keys(handoff.providerRunRef).sort()).toEqual(
      ["attemptRef", "effectIntentId", "epoch", "provider", "runRef"]);
    // Deep-frozen by the producer. A lookalike assembled from object spreads in
    // the daemon would satisfy the field names and fail these.
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.tokens)).toBe(true);
    expect(Object.isFrozen(handoff.launch)).toBe(true);
  });

  it("renders every unmeasured fact as UNKNOWN carrying its code, never as zero", async () => {
    const cases = [
      { code: "TELEMETRY_LAUNCH_REFUSED", request: request() },
      {
        code: "TELEMETRY_LAUNCH_NOT_ATTEMPTED",
        request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      },
    ] as const;
    expect(cases.length).toBe(2);
    for (const scenario of cases) {
      const handoff = handoffOf(await launchActivationProviderRun({
        providerRun: PROVIDER_RUN, request: scenario.request, options: OPTIONS,
      }));
      const fact = blind(scenario.code);
      expect(handoff.tokens).toEqual({
        inputTokens: fact, outputTokens: fact, cacheCreationInputTokens: fact,
        cacheReadInputTokens: fact, coverage: "UNKNOWN",
      });
      expect(handoff.steps).toEqual({ turns: fact, coverage: "UNKNOWN" });
      expect(handoff.sequence).toEqual(fact);
      expect(handoff.stdoutReceiptDigest).toEqual(fact);
      expect(handoff.stderrReceiptDigest).toEqual(fact);
      expect(handoff.observedModel.modelId).toEqual(fact);
      expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
      // The distinction the whole quantity union exists for: an unmeasured count
      // must never arrive as a measured zero.
      expect(handoff.tokens.inputTokens).not.toHaveProperty("value");
      expect(handoff.steps.turns).not.toHaveProperty("value");
    }
  });

  it("never echoes a caller-supplied timing pair, model snapshot or effort as an observation",
    async () => {
      // The planted values sit in fields the caller LEGITIMATELY supplies —
      // `effect`, `attempt` and the quoted observation are the caller's own
      // records, carried as plain data. That keeps the fixture valid at the
      // request snapshot and at the duplicate resolver, so this case is answered
      // by the observation discipline rather than by an earlier structural
      // guard. Planting the same names at the TOP level is covered separately
      // below, where the exact-record read refuses the whole request instead.
      const handoff = handoffOf(await launchActivationProviderRun({
        providerRun: PROVIDER_RUN,
        request: request({
          duplicateDelivery: DUPLICATE_DELIVERY,
          effect: {
            startedAt: "1999-01-01T00:00:00.000Z",
            completedAt: "1999-01-01T00:00:09.000Z",
            observedModel: CALLER_SENTINEL,
            tokens: { inputTokens: 999, outputTokens: 999 },
            terminal: "COMPLETED",
            infrastructure: "NONE",
          },
          attempt: { modelSnapshotEvidence: CALLER_SENTINEL, reasoningEffort: SELECTED_EFFORT },
          runtime: runtime({
            quotedObservation: { observationDigest: "4f".repeat(32), model: CALLER_SENTINEL },
          }),
        }),
        options: OPTIONS,
      }));
      const unmeasured = blind("TELEMETRY_LAUNCH_NOT_ATTEMPTED");
      expect(handoff.launch.startedAt).toBeNull();
      expect(handoff.launch.completedAt).toBeNull();
      expect(handoff.observedModel.modelId).toEqual(unmeasured);
      expect(handoff.observedModel.snapshotEvidence).toEqual(unmeasured);
      expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
      expect(handoff.tokens.inputTokens).toEqual(unmeasured);
      expect(handoff.terminal).toBe("UNKNOWN");
      expect(handoff.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
      // Nothing the caller planted reaches ANY field of the handoff, not just
      // the fields this case thought to name.
      expect(JSON.stringify(handoff)).not.toContain(CALLER_SENTINEL);
      expect(JSON.stringify(handoff)).not.toContain("1999-01-01");
      // The reasoning effort the caller DID have standing to declare stays on
      // the DECLARED side and never crosses into the observed model.
      expect(handoff.declared).toEqual({ known: true, selection: SELECTION });
      expect(JSON.stringify(handoff.observedModel)).not.toContain(SELECTED_EFFORT);
      expect(JSON.stringify(handoff.observedModel)).not.toContain(SELECTED_MODEL);
    });

  it("refuses a request that carries handoff-shaped observation fields at the top level",
    async () => {
      const handoff = handoffOf(await launchActivationProviderRun({
        providerRun: PROVIDER_RUN,
        request: request({
          duplicateDelivery: DUPLICATE_DELIVERY,
          startedAt: "1999-01-01T00:00:00.000Z",
          completedAt: "1999-01-01T00:00:09.000Z",
          observedModel: CALLER_SENTINEL,
          terminal: "COMPLETED",
        }),
        options: OPTIONS,
      }));
      // The request is read as an EXACT record, so smuggled observation fields
      // do not travel and are not silently dropped either: the whole request is
      // refused, ahead of the duplicate resolution this same fixture would
      // otherwise have reached.
      expect(handoff.launch.kind).toBe("REFUSED");
      expect(handoff.launch.reasonCode).toBe("CLAUDE_LAUNCH_REQUEST_MALFORMED");
      expect(handoff.launch.reasonLayer).toBe("LAUNCHER");
      expect(handoff.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
      expect(handoff.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      expect(handoff.launch.startedAt).toBeNull();
      expect(JSON.stringify(handoff)).not.toContain(CALLER_SENTINEL);
    });
});
