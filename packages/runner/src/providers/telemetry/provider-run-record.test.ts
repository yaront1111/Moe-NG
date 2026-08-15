/**
 * Provider-run record tests. The record is PROVIDER-NEUTRAL — the handoff it is
 * built from is Claude-shaped, and the benchmark consumer must not have to know
 * that — so every case below drives the REAL `launchClaudeWithTelemetry` with
 * the launcher's own fixture ports and reads the record the production builder
 * returns. Two cases take a real handoff and remove exactly one fact, which is
 * labelled where it happens: those branches are structurally required but not
 * reachable through the launcher.
 *
 * THE THREE RULINGS THIS SUITE ENCODES, rather than leaving as prose:
 * 1. The two digest noun sets are DIFFERENT EVIDENCE, not two names for one
 *    thing. configuration/policy/orchestration are launch-DECISION inputs read
 *    from the declared selection; runtimeBinding/pinnedClosure/observation plus
 *    profileRevisionId are what the runtime actually WAS. The record carries
 *    both, and neither is derived from the other.
 * 2. `achieved` concurrency exists as a field and is UNKNOWN by construction:
 *    both halves are present, and the declared ceiling never fills the achieved
 *    half.
 * 3. `profileRevisionId` is a positive labelled field AND may never satisfy
 *    model or effort. Both readings are simultaneously true.
 */
import { describe, expect, it } from "vitest";

import { BUDGET_MEASUREMENT_SOURCES, type BudgetMeasurementSource } from "@moe/scheduler";

import {
  CLAIM, DIGEST, SELECTED_EFFORT, SELECTED_MODEL, SELECTION, boundaryHarness, dependencies,
  request, selectionWith,
} from "../claude/claude-launcher-test-fixtures.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import type { ClaudeLaunchRequest, ClaudeLauncherDependencies } from "../claude/claude-launcher.js";
import {
  launchClaudeWithTelemetry, type ClaudeTelemetryHandoff,
} from "./claude-telemetry-launch.js";
import {
  PROVIDER_INFRASTRUCTURE_OUTCOMES, PROVIDER_TELEMETRY_CODES, PROVIDER_TELEMETRY_LAYERS,
  PROVIDER_TERMINAL_OUTCOMES,
  type ProviderInfrastructureOutcome, type ProviderTerminalOutcome,
} from "./provider-telemetry-contracts.js";
import { PROVIDER_USAGE_METERS } from "./provider-usage-contracts.js";
import {
  PROVIDER_RUN_RECORD_VERSION, buildProviderRunRecord, type ProviderRunRecord,
} from "./provider-run-record.js";

const RUN_REF = {
  provider: "claude", runRef: "run:record:1", effectIntentId: "intent:1",
  attemptRef: "attempt:1", epoch: 3,
} as const;
const LIMITS = { stdoutBytes: 65_536, stderrBytes: 65_536, tailBytes: 4_096, timeoutMs: 1_000 };

const line = (record: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schemaVersion: "claude-stream-json/1", ...record })}\n`;
const resultLine = (subtype: string, seq = 2): string => line({ seq, type: "result", subtype,
  num_turns: 3, usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5 } });
const INIT = line({ seq: 1, type: "system", subtype: "init", model: "claude-opus-5-20260514" });
const STREAM = `${INIT}${resultLine("success")}`;
const DIVERGENT = `${line({ seq: 1, type: "system", subtype: "init",
  model: "claude-sonnet-5-20260101" })}${resultLine("success")}`;
const PARTIAL_STREAM = `${INIT}${line({ seq: 2, type: "result", subtype: "success", num_turns: 3,
  usage: { input_tokens: 4 } })}`;
const INIT_ONLY = INIT;
const DUPLICATED = `${line({ seq: 1, type: "result", subtype: "success" })}` +
  `${line({ seq: 1, type: "result", subtype: "success" })}`;
const FOREIGN_SCHEMA =
  `${JSON.stringify({ schemaVersion: "claude-stream-json/2", seq: 1, type: "result",
    subtype: "success" })}\n`;
const DUPLICATE_DELIVERY = {
  claim: CLAIM,
  registration: {
    lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
    processIdentity: "windows:4242:134309515541692727",
    bootstrapCredentialDigest: DIGEST, registeredAt: "2026-08-12T08:00:00.000Z",
  },
  lockState: "HELD", effectState: "ACTIVE",
};
const MISMATCHED = { launchSelection: selectionWith({ selectedModelId: "claude-haiku-4-5" }) };

interface ArmCase {
  readonly stdout?: string;
  readonly overrides?: Partial<ClaudeLaunchRequest>;
  readonly harness?: Parameters<typeof boundaryHarness>[0];
  readonly exit?: unknown;
}

async function handoffOf(arm: ArmCase = {}): Promise<ClaudeTelemetryHandoff> {
  const harness = boundaryHarness({
    stdout: Buffer.from(arm.stdout ?? STREAM, "utf8"), ...arm.harness,
  });
  const base = dependencies(harness, []);
  const deps: ClaudeLauncherDependencies = arm.exit === undefined ? base : {
    ...base,
    observeProcess: (_exit, reconciliation) => intakeProcessObservation(arm.exit, reconciliation),
  };
  const result = await launchClaudeWithTelemetry({
    providerRunRef: RUN_REF, request: request({ limits: LIMITS, ...arm.overrides }),
    options: { platform: "win32", deps },
  });
  if (!result.ok) throw new Error(`telemetry launch refused: ${result.code}/${result.layer}`);
  return result.handoff;
}
const recordOf = async (arm: ArmCase = {}): Promise<ProviderRunRecord> =>
  buildProviderRunRecord(await handoffOf(arm));

/** Every `{known:false}` fact in the record, gathered from the production output. */
function unknownFacts(value: unknown, found: { code: unknown; layer: unknown }[] = []):
readonly { code: unknown; layer: unknown }[] {
  if (typeof value !== "object" || value === null) return found;
  const entry = value as Record<string, unknown>;
  if (entry["known"] === false) found.push({ code: entry["code"], layer: entry["layer"] });
  for (const nested of Object.values(entry)) unknownFacts(nested, found);
  return found;
}
function frozenThroughout(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(frozenThroughout);
}

describe("buildProviderRunRecord — identity and evidence", () => {
  it("binds run identity and provider from the launch, never from a caller", async () => {
    const handoff = await handoffOf();
    const record = buildProviderRunRecord(handoff);
    expect(record.recordVersion).toBe(PROVIDER_RUN_RECORD_VERSION);
    expect(record.provider).toBe("claude");
    expect(record.identity.providerRunRef).toEqual(RUN_REF);
    expect(record.identity.effectDigest).toEqual({ known: true, value: handoff.launch.effectDigest });
    expect(record.identity.activationDigest)
      .toEqual({ known: true, value: handoff.launch.activationDigest });
    expect(record.startedAt).toEqual({ known: true, value: handoff.launch.startedAt });
    expect(record.completedAt).toEqual({ known: true, value: handoff.launch.completedAt });
  });

  it("carries BOTH digest families side by side, neither derived from the other", async () => {
    const handoff = await handoffOf();
    const record = buildProviderRunRecord(handoff);
    // Launch-DECISION inputs: read from the declared selection.
    expect(record.decisionDigests).toEqual({
      configurationDigest: { known: true, value: SELECTION.configurationDigest },
      policyDigest: { known: true, value: SELECTION.policyDigest },
      orchestrationDigest: { known: true, value: SELECTION.orchestrationDigest },
    });
    // What the runtime actually WAS: read from the launcher's own observation.
    expect(record.runtimeEvidence).toEqual({
      runtimeBindingDigest: { known: true, value: handoff.launch.runtimeBindingDigest },
      pinnedClosureDigest: { known: true, value: handoff.launch.pinnedClosureDigest },
      observationDigest: { known: true, value: handoff.launch.observationDigest },
      profileRevisionId: { known: true, value: SELECTION.profileRevisionId },
    });
    const decision = Object.values(record.decisionDigests).map((fact) => fact.known && fact.value);
    const runtime = [record.runtimeEvidence.runtimeBindingDigest,
      record.runtimeEvidence.pinnedClosureDigest, record.runtimeEvidence.observationDigest]
      .map((fact) => fact.known && fact.value);
    // Six DISTINCT values: no member of either family is a copy of the other's.
    expect(new Set([...decision, ...runtime]).size).toBe(6);
    for (const value of runtime) expect(decision).not.toContain(value);
  });

  it("takes model, snapshot evidence and effort ONLY from the declared selection", async () => {
    const record = await recordOf({ stdout: DIVERGENT });
    expect(record.model).toEqual({
      selectedModelId: { known: true, value: SELECTED_MODEL },
      snapshotKind: "DATED_SNAPSHOT",
      snapshotEvidence: { known: true, value: SELECTION.modelSnapshotEvidence },
      reasoningEffort: { known: true, value: SELECTED_EFFORT },
    });
    // The provider's own claim travels in its own labelled field, unreconciled.
    expect(record.observedModel.modelId).toEqual({ known: true, value: "claude-sonnet-5-20260101" });
    expect(record.observedModel.snapshotEvidence).toEqual({ known: true, value: "20260101" });
    expect(record.model.selectedModelId).not.toEqual(record.observedModel.modelId);
  });

  /**
   * RULING 3, and the mutation-drill anchor for the model/effort comparison. The
   * handoff below is a REAL production one with exactly one fact removed: the
   * declared selection. Every model-ISH value survives — the pinned closure
   * digest, the runtime binding digest, the observation digest and the
   * provider's own observed model id — so a builder that let any of them stand
   * in for the declared model or effort would report a known model here.
   */
  it("never lets runtime or observed evidence stand in for model or effort", async () => {
    const real = await handoffOf();
    const blinded: ClaudeTelemetryHandoff = {
      ...real,
      declared: { known: false, code: "TELEMETRY_DECLARED_SELECTION_UNREADABLE",
        layer: "TELEMETRY_INPUT" },
    };
    const record = buildProviderRunRecord(blinded);
    const unreadable =
      { known: false, code: "TELEMETRY_DECLARED_SELECTION_UNREADABLE", layer: "TELEMETRY_INPUT" };
    expect(record.model.selectedModelId).toEqual(unreadable);
    expect(record.model.reasoningEffort).toEqual(unreadable);
    expect(record.model.snapshotEvidence).toEqual(unreadable);
    expect(record.model.snapshotKind).toBe("UNKNOWN");
    expect(record.runtimeEvidence.profileRevisionId).toEqual(unreadable);
    // A known runtime fact sits beside the UNKNOWN model, so the UNKNOWN is not
    // merely "nothing was observed at all".
    expect(record.runtimeEvidence.pinnedClosureDigest.known).toBe(true);
    expect(record.observedModel.modelId).toEqual({ known: true, value: "claude-opus-5-20260514" });
    const substitutes = [real.launch.pinnedClosureDigest, real.launch.runtimeBindingDigest,
      real.launch.observationDigest, SELECTION.profileRevisionId, "claude-opus-5-20260514",
      SELECTED_EFFORT];
    for (const value of substitutes) {
      expect(JSON.stringify(record.model), `${String(value)} reached the model field`)
        .not.toContain(String(value));
    }
  });

  it("pairs a declared concurrency ceiling with an achieved half it cannot fill", async () => {
    const record = await recordOf();
    expect(record.concurrency.fact).toBe("DECLARED_CEILING_ONLY");
    expect(record.concurrency.declaredCeiling)
      .toEqual({ known: true, value: SELECTION.concurrencyCeiling });
    expect(record.concurrency.achieved).toEqual({ known: false,
      code: "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", layer: "TELEMETRY_SCHEMA" });
    expect(record.concurrency.achieved).not.toEqual(record.concurrency.declaredCeiling);
  });

  it("reports token and step measurements under provider-neutral names", async () => {
    const record = await recordOf();
    expect(record.tokens).toEqual({
      inputTokens: { known: true, value: 11 }, outputTokens: { known: true, value: 7 },
      cacheCreationInputTokens: { known: true, value: 0 },
      cacheReadInputTokens: { known: true, value: 5 }, coverage: "COMPLETE",
    });
    expect(record.steps).toEqual({ count: { known: true, value: 3 }, coverage: "COMPLETE" });
  });

  it("freezes the record throughout and detaches it from the handoff", async () => {
    const handoff = await handoffOf();
    const record = buildProviderRunRecord(handoff);
    expect(frozenThroughout(record)).toBe(true);
    expect(record.tokens).not.toBe(handoff.tokens);
    expect(record.concurrency).not.toBe(handoff.concurrency);
    expect(record.identity.providerRunRef).not.toBe(handoff.providerRunRef);
    expect(() => {
      (record as { provider: string }).provider = "codex";
    }).toThrow(TypeError);
  });
});

describe("buildProviderRunRecord — closed vocabularies and fail-closed facts", () => {
  const TERMINAL_CASES: readonly (readonly [ProviderTerminalOutcome, ArmCase])[] = [
    ["COMPLETED", { stdout: resultLine("success", 1) }],
    ["CANCELLED", { stdout: resultLine("cancelled", 1) }],
    ["MAX_TURNS_EXHAUSTED", { stdout: resultLine("error_max_turns", 1) }],
    ["ERROR_DURING_EXECUTION", { stdout: resultLine("error_during_execution", 1) }],
    ["REFUSED", { overrides: MISMATCHED }],
    ["UNKNOWN", { stdout: INIT_ONLY }],
  ];
  const INFRASTRUCTURE_CASES: readonly (readonly [ProviderInfrastructureOutcome, ArmCase])[] = [
    ["NONE", {}],
    ["PROCESS_SIGNALLED", { exit: { kind: "SIGNALLED", signal: "SIGKILL" } }],
    ["EXIT_UNOBSERVED", { exit: { kind: "UNOBSERVED" } }],
    ["CAPTURE_TRUNCATED", { overrides: { limits: { ...LIMITS, stdoutBytes: 16 } } }],
    ["CAPTURE_INCOMPLETE", { harness: { streamError: "stdout" } }],
    ["SCHEMA_UNSUPPORTED", { stdout: FOREIGN_SCHEMA }],
    ["STREAM_ANOMALOUS", { stdout: DUPLICATED }],
    ["LAUNCH_REFUSED", { overrides: MISMATCHED }],
    ["LAUNCH_NOT_ATTEMPTED", { overrides: { duplicateDelivery: DUPLICATE_DELIVERY } }],
    ["UNKNOWN", { harness: { streamError: "stderr" } }],
  ];
  /** The three sources this seam can DERIVE, and the three it must never emit. */
  const SOURCE_CASES: readonly (readonly [BudgetMeasurementSource, ArmCase])[] = [
    ["PROVIDER_REPORTED_COMPLETE", {}],
    ["PROVIDER_REPORTED_PARTIAL", { stdout: PARTIAL_STREAM }],
    ["UNKNOWN", { stdout: line({ seq: 2, type: "result", subtype: "success", num_turns: 3 }) }],
  ];
  const NEVER_EMITTED: readonly BudgetMeasurementSource[] =
    ["DERIVED_LIST_PRICE", "SUBSCRIPTION_QUOTA", "ACTUAL_BILLED"];

  it("generates a case for every member of each closed vocabulary, by name", () => {
    expect(TERMINAL_CASES.length).toBe(6);
    expect(TERMINAL_CASES.map(([outcome]) => outcome)).toEqual([...PROVIDER_TERMINAL_OUTCOMES]);
    expect(INFRASTRUCTURE_CASES.length).toBe(10);
    expect(INFRASTRUCTURE_CASES.map(([outcome]) => outcome))
      .toEqual([...PROVIDER_INFRASTRUCTURE_OUTCOMES]);
    expect(SOURCE_CASES.length).toBe(3);
    expect(NEVER_EMITTED.length).toBe(3);
    expect([...SOURCE_CASES.map(([source]) => source), ...NEVER_EMITTED].sort())
      .toEqual([...BUDGET_MEASUREMENT_SOURCES].sort());
  });

  it.each(TERMINAL_CASES)("classifies terminal %s", async (expected, arm) => {
    expect((await recordOf(arm)).terminal).toBe(expected);
  });

  it.each(INFRASTRUCTURE_CASES)("classifies infrastructure %s", async (expected, arm) => {
    expect((await recordOf(arm)).infrastructure).toBe(expected);
  });

  it.each(SOURCE_CASES)("derives measurement source %s", async (expected, arm) => {
    const record = await recordOf(arm);
    if (!record.usage.ok) throw new Error(`usage refused: ${record.usage.code}`);
    expect(record.usage.source).toBe(expected);
    expect(NEVER_EMITTED).not.toContain(record.usage.source);
    expect(record.usage.measurements.length).toBe(4);
    expect(record.usage.measurements.map((entry) => entry.measurement.meter))
      .toEqual(Object.values(PROVIDER_USAGE_METERS));
  });

  it("keeps a run the launcher refused fail-closed in every field", async () => {
    const record = await recordOf({ overrides: MISMATCHED });
    expect(record.terminal).toBe("REFUSED");
    expect(record.infrastructure).toBe("LAUNCH_REFUSED");
    const blind = { known: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH" };
    expect(record.identity.effectDigest).toEqual(blind);
    expect(record.runtimeEvidence.observationDigest).toEqual(blind);
    expect(record.startedAt).toEqual(blind);
    expect(record.tokens.inputTokens).toEqual(blind);
    expect(record.steps.count).toEqual(blind);
    // The usage seam refuses rather than measuring a run that never started.
    expect(record.usage.ok).toBe(false);
    if (record.usage.ok) throw new Error("an unlaunched run was measured");
    expect(record.usage.layer).toBe("USAGE_INPUT");
    expect(record.usage.code).toBe("PROVIDER_USAGE_INTERVAL_UNOBSERVED");
    expect(record.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
    expect(record.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
  });

  it("gives every UNKNOWN an exact code and layer, and never a zero or an empty string",
    async () => {
      const record = await recordOf({ overrides: MISMATCHED });
      const facts = unknownFacts(record);
      // Non-zero cardinality asserted before the members are judged: a walker
      // that found nothing would otherwise pass while checking nothing.
      expect(facts.length).toBeGreaterThan(10);
      for (const fact of facts) {
        expect(PROVIDER_TELEMETRY_CODES).toContain(fact.code);
        expect(PROVIDER_TELEMETRY_LAYERS).toContain(fact.layer);
        expect(fact.code).not.toBe("");
        expect(fact.code).not.toBe(0);
      }
      // No quantity survives anywhere on a run that measured nothing.
      expect(JSON.stringify({ tokens: record.tokens, steps: record.steps }))
        .not.toContain("\"value\"");
    });
});
