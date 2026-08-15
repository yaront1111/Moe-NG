/**
 * Wrapper tests, driven through the REAL `launchClaude` with the launcher's own
 * production fixture ports — never a stub of the launcher itself. Every case
 * below therefore exercises the same selection gate, runtime pin, grant
 * consumption, lock and boundary the daemon will.
 */
import { describe, expect, it } from "vitest";

import {
  CLAIM, DIGEST, SELECTED_EFFORT, SELECTED_MODEL, SELECTION, boundaryHarness, dependencies,
  request, selectionWith,
} from "../claude/claude-launcher-test-fixtures.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import {
  launchClaude, type ClaudeLaunchRequest, type ClaudeLauncherDependencies,
} from "../claude/claude-launcher.js";
import {
  CLAUDE_TELEMETRY_HANDOFF_VERSION, launchClaudeWithTelemetry,
  type ClaudeTelemetryHandoff,
} from "./claude-telemetry-launch.js";
import {
  PROVIDER_COUNT_COVERAGE_CLASSES, PROVIDER_INFRASTRUCTURE_OUTCOMES, PROVIDER_TELEMETRY_CODES,
  PROVIDER_TELEMETRY_LAYERS, PROVIDER_TERMINAL_OUTCOMES,
  type ProviderCountCoverage, type ProviderInfrastructureOutcome, type ProviderTerminalOutcome,
} from "./provider-telemetry-contracts.js";

const RUN_REF = {
  provider: "claude", runRef: "run:telemetry:1", effectIntentId: "intent:1",
  attemptRef: "attempt:1", epoch: 3,
} as const;

/** Wide enough that a fixture capture is NOT truncated unless a case says so. */
const LIMITS = { stdoutBytes: 65_536, stderrBytes: 65_536, tailBytes: 4_096, timeoutMs: 1_000 };

const line = (record: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schemaVersion: "claude-stream-json/1", ...record })}\n`;

export const STREAM =
  `${line({ seq: 1, type: "system", subtype: "init", model: "claude-opus-5-20260514" })}` +
  `${line({ seq: 2, type: "result", subtype: "success", num_turns: 3,
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5 } })}`;

interface Launched {
  readonly log: readonly string[];
  readonly handoff: ClaudeTelemetryHandoff;
}

export async function withTelemetry(options: {
  readonly stdout?: string;
  readonly overrides?: Partial<ClaudeLaunchRequest>;
  readonly providerRunRef?: unknown;
} = {}): Promise<Launched> {
  const log: string[] = [];
  const harness = boundaryHarness({ stdout: Buffer.from(options.stdout ?? STREAM, "utf8") });
  const result = await launchClaudeWithTelemetry({
    providerRunRef: options.providerRunRef ?? RUN_REF,
    request: request({ limits: LIMITS, ...options.overrides }),
    options: { platform: "win32", deps: dependencies(harness, log) },
  });
  if (!result.ok) throw new Error(`telemetry launch refused: ${result.code}/${result.layer}`);
  return { log, handoff: result.handoff };
}

describe("launchClaudeWithTelemetry", () => {
  it("binds the launcher's own observation rather than recomputing any of it", async () => {
    const { handoff } = await withTelemetry();
    // The control runs the SAME production launcher with fresh ports; the fixture
    // clock restarts per `dependencies()` call, so an identical launch yields an
    // identical observation. Comparing field by field is what proves the wrapper
    // BOUND the launcher's facts instead of deriving a second copy.
    const control = await launchClaude(
      request({ limits: LIMITS }),
      { platform: "win32", deps: dependencies(boundaryHarness({
        stdout: Buffer.from(STREAM, "utf8") }), []) },
    );
    if (control.kind !== "OBSERVED") throw new Error(`control launch was ${control.kind}`);
    const observed = control.observation;
    expect(handoff.handoffVersion).toBe(CLAUDE_TELEMETRY_HANDOFF_VERSION);
    expect(handoff.providerRunRef).toEqual(RUN_REF);
    expect(handoff.launch).toEqual({
      kind: "OBSERVED", truthClass: observed.truthClass, reasonCode: observed.reasonCode,
      reasonLayer: observed.reasonLayer, effectDigest: observed.effectDigest,
      activationDigest: observed.activationDigest,
      runtimeBindingDigest: observed.runtimeBindingDigest,
      quotedRuntimeDigest: observed.quotedRuntimeDigest,
      freshRuntimeDigest: observed.freshRuntimeDigest,
      pinnedClosureDigest: observed.pinnedClosureDigest,
      observationDigest: observed.observationDigest, startedAt: observed.startedAt,
      completedAt: observed.completedAt, exit: observed.exit,
    });
    expect(handoff.stdoutReceiptDigest).toEqual({ known: true, value: observed.stdout.sha256 });
    expect(handoff.stderrReceiptDigest).toEqual({ known: true, value: observed.stderr.sha256 });
    expect(handoff.launch.effectDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reports the parsed provider facts and freezes the handoff", async () => {
    const { handoff } = await withTelemetry();
    expect(handoff.terminal).toBe("COMPLETED");
    expect(handoff.infrastructure).toBe("NONE");
    expect(handoff.tokens.coverage).toBe("COMPLETE");
    expect(handoff.tokens.inputTokens).toEqual({ known: true, value: 11 });
    expect(handoff.steps).toEqual({ turns: { known: true, value: 3 }, coverage: "COMPLETE" });
    expect(handoff.sequence).toEqual({ known: true, value: 2 });
    expect(handoff.telemetryRefusal).toBeNull();
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.tokens)).toBe(true);
  });

  it("keeps the declared selection and the observed model in separate fields", async () => {
    const { handoff } = await withTelemetry();
    expect(handoff.declared).toEqual({ known: true, selection: SELECTION });
    expect(handoff.observedModel.modelId).toEqual({ known: true, value: "claude-opus-5-20260514" });
    expect(handoff.concurrency).toEqual({
      fact: "DECLARED_CEILING_ONLY",
      declaredCeiling: { known: true, value: SELECTION.concurrencyCeiling },
      achieved: { known: false, code: "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED",
        layer: "TELEMETRY_SCHEMA" },
    });
  });

  it("forwards the launcher's own code and layer on the REFUSED arm, with no zeros", async () => {
    const { handoff } = await withTelemetry({
      overrides: { launchSelection: selectionWith({ selectedModelId: "claude-sonnet-5-20260514" }) },
    });
    expect(handoff.launch.kind).toBe("REFUSED");
    expect(handoff.launch.reasonCode).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
    expect(handoff.launch.reasonLayer).toBe("TELEMETRY_CONFIGURATION");
    expect(handoff.launch.observationDigest).toBeNull();
    expect(handoff.launch.exit).toBeNull();
    expect(handoff.terminal).toBe("REFUSED");
    expect(handoff.infrastructure).toBe("LAUNCH_REFUSED");
    const blind = { known: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH" };
    expect(handoff.tokens).toEqual({
      inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
      cacheReadInputTokens: blind, coverage: "UNKNOWN",
    });
    expect(handoff.steps).toEqual({ turns: blind, coverage: "UNKNOWN" });
    expect(handoff.observedModel).toEqual({
      modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind,
    });
    expect(handoff.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
    expect(handoff.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
  });

  it("marks an adopted duplicate delivery as never having launched", async () => {
    const { handoff, log } = await withTelemetry({
      overrides: {
        duplicateDelivery: {
          claim: CLAIM,
          registration: {
            lockIdentity: CLAIM.lockIdentity, wrapperIdentity: CLAIM.wrapperIdentity,
            processIdentity: "windows:4242:134309515541692727",
            bootstrapCredentialDigest: DIGEST, registeredAt: "2026-08-12T08:00:00.000Z",
          },
          lockState: "HELD", effectState: "ACTIVE",
        },
      },
    });
    expect(log).toEqual(["duplicate"]);
    expect(handoff.launch.kind).toBe("ADOPTED");
    // The duplicate arm carries NO code or layer of its own, and the wrapper
    // forwards that absence rather than inventing one.
    expect(handoff.launch.reasonCode).toBeNull();
    expect(handoff.launch.reasonLayer).toBeNull();
    expect(handoff.launch.truthClass).toBe("PROVEN");
    expect(handoff.terminal).toBe("UNKNOWN");
    expect(handoff.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
    expect(handoff.tokens.inputTokens)
      .toEqual({ known: false, code: "TELEMETRY_LAUNCH_NOT_ATTEMPTED", layer: "TELEMETRY_LAUNCH" });
  });

  it("refuses a malformed run reference BEFORE any process is launched", async () => {
    const log: string[] = [];
    const result = await launchClaudeWithTelemetry({
      providerRunRef: { ...RUN_REF, epoch: -1 },
      request: request({ limits: LIMITS }),
      options: { platform: "win32", deps: dependencies(boundaryHarness(), log) },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.code : "launched").toBe("TELEMETRY_RUN_REF_MALFORMED");
    expect(result.ok === false ? result.layer : "launched").toBe("TELEMETRY_INPUT");
    // Empty port log: the launcher was never reached, so no runtime was pinned,
    // no grant consumed and no boundary opened for a run nothing could attribute.
    expect(log).toEqual([]);
  });
});

/**
 * The DoD-4 sweeps. Every table asserts its own EXACT hand-written length before
 * it is iterated — a generator that silently produced zero cases would otherwise
 * pass while testing nothing — and then asserts, BY NAME, that it visits every
 * member of the frozen vocabulary it claims to cover. A member added later
 * without a case fails the membership assertion rather than being skipped.
 *
 * Every arm below is produced END TO END through the real `launchClaude`. Where
 * a case needs a different process observation, it scripts the production
 * `observeProcess` PORT with the production `intakeProcessObservation` — the
 * launcher, its selection gate, its runtime pin and its lock all still run.
 */
const foreign = (seq: number): string =>
  `${JSON.stringify({ schemaVersion: "claude-stream-json/2", seq, type: "result",
    subtype: "success" })}\n`;

const resultOnly = (subtype: string, seq = 1): string =>
  `${line({ seq, type: "result", subtype, num_turns: 2,
    usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0 } })}`;

const INIT_ONLY = line({ seq: 1, type: "system", subtype: "init", model: "claude-opus-5" });

const DUPLICATED = `${line({ seq: 1, type: "result", subtype: "success" })}` +
  `${line({ seq: 1, type: "result", subtype: "success" })}`;

interface ArmCase {
  readonly stdout?: string;
  readonly overrides?: Partial<ClaudeLaunchRequest>;
  readonly harness?: Parameters<typeof boundaryHarness>[0];
  readonly exit?: unknown;
}

async function armHandoff(arm: ArmCase): Promise<ClaudeTelemetryHandoff> {
  const log: string[] = [];
  const harness = boundaryHarness({
    stdout: Buffer.from(arm.stdout ?? STREAM, "utf8"), ...arm.harness,
  });
  const base = dependencies(harness, log);
  const deps: ClaudeLauncherDependencies = arm.exit === undefined ? base : {
    ...base,
    observeProcess: (_exit, reconciliation) => intakeProcessObservation(arm.exit, reconciliation),
  };
  const result = await launchClaudeWithTelemetry({
    providerRunRef: RUN_REF,
    request: request({ limits: LIMITS, ...arm.overrides }),
    options: { platform: "win32", deps },
  });
  if (!result.ok) throw new Error(`sweep arm refused: ${result.code}/${result.layer}`);
  return result.handoff;
}

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

const TERMINAL_CASES: readonly (readonly [ProviderTerminalOutcome, ArmCase])[] = [
  ["COMPLETED", { stdout: resultOnly("success") }],
  ["CANCELLED", { stdout: resultOnly("cancelled") }],
  ["MAX_TURNS_EXHAUSTED", { stdout: resultOnly("error_max_turns") }],
  ["ERROR_DURING_EXECUTION", { stdout: resultOnly("error_during_execution") }],
  ["REFUSED", { overrides: MISMATCHED }],
  ["UNKNOWN", { stdout: INIT_ONLY }],
];

const INFRASTRUCTURE_CASES:
  readonly (readonly [ProviderInfrastructureOutcome, ArmCase])[] = [
    ["NONE", {}],
    ["PROCESS_SIGNALLED", { exit: { kind: "SIGNALLED", signal: "SIGKILL" } }],
    ["EXIT_UNOBSERVED", { exit: { kind: "UNOBSERVED" } }],
    ["CAPTURE_TRUNCATED", { overrides: { limits: { ...LIMITS, stdoutBytes: 16 } } }],
    ["CAPTURE_INCOMPLETE", { harness: { streamError: "stdout" } }],
    ["SCHEMA_UNSUPPORTED", { stdout: foreign(1) }],
    ["STREAM_ANOMALOUS", { stdout: DUPLICATED }],
    ["LAUNCH_REFUSED", { overrides: MISMATCHED }],
    ["LAUNCH_NOT_ATTEMPTED", { overrides: { duplicateDelivery: DUPLICATE_DELIVERY } }],
    // stdout parses perfectly; the LAUNCHER could not prove the run because its
    // stderr capture failed, so `NONE` must not be claimed.
    ["UNKNOWN", { harness: { streamError: "stderr" } }],
  ];

const COVERAGE_CASES: readonly (readonly [ProviderCountCoverage, ArmCase])[] = [
  ["COMPLETE", {}],
  ["PARTIAL", { stdout: line({ seq: 1, type: "result", subtype: "success", num_turns: 2,
    usage: { input_tokens: 4, cache_creation_input_tokens: 0 } }) }],
  ["UNKNOWN", { overrides: { limits: { ...LIMITS, stdoutBytes: 16 } } }],
];

describe("declared-arm sweeps", () => {
  it("covers every terminal outcome exactly once, by name", () => {
    expect(TERMINAL_CASES.length).toBe(6);
    expect(TERMINAL_CASES.map(([outcome]) => outcome))
      .toEqual([...PROVIDER_TERMINAL_OUTCOMES]);
  });

  it.each(TERMINAL_CASES)("reports terminal %s", async (expected, arm) => {
    expect((await armHandoff(arm)).terminal).toBe(expected);
  });

  it("covers every infrastructure outcome exactly once, by name", () => {
    expect(INFRASTRUCTURE_CASES.length).toBe(10);
    expect(INFRASTRUCTURE_CASES.map(([outcome]) => outcome))
      .toEqual([...PROVIDER_INFRASTRUCTURE_OUTCOMES]);
  });

  it.each(INFRASTRUCTURE_CASES)("reports infrastructure %s", async (expected, arm) => {
    expect((await armHandoff(arm)).infrastructure).toBe(expected);
  });

  it("covers every count-coverage class exactly once, by name", () => {
    expect(COVERAGE_CASES.length).toBe(3);
    expect(COVERAGE_CASES.map(([coverage]) => coverage))
      .toEqual([...PROVIDER_COUNT_COVERAGE_CLASSES]);
  });

  it.each(COVERAGE_CASES)("reports token coverage %s", async (expected, arm) => {
    expect((await armHandoff(arm)).tokens.coverage).toBe(expected);
  });
});

/**
 * Refusal cases pin the exact code AND the refusing LAYER. Three layers can
 * answer here — the launcher's selection gate, the capture check and stream
 * admission — so an assertion that only checked "not ok" would stay green the
 * moment a different one started answering first.
 */
const REFUSAL_CASES: readonly (readonly [string, ArmCase, string, string])[] = [
  ["capture cut by the launcher's own bound", { overrides: { limits: { ...LIMITS,
    stdoutBytes: 16 } } }, "TELEMETRY_CAPTURE_TRUNCATED", "TELEMETRY_CAPTURE"],
  ["capture that never finished", { harness: { streamError: "stdout" } },
    "TELEMETRY_CAPTURE_INCOMPLETE", "TELEMETRY_CAPTURE"],
  ["a record schema this parser version does not accept", { stdout: foreign(1) },
    "TELEMETRY_SCHEMA_UNSUPPORTED", "TELEMETRY_SCHEMA"],
  ["a duplicated event", { stdout: DUPLICATED }, "TELEMETRY_STREAM_ANOMALOUS", "TELEMETRY_SCHEMA"],
  ["a launch the selection gate refused", { overrides: MISMATCHED },
    "TELEMETRY_LAUNCH_REFUSED", "TELEMETRY_LAUNCH"],
  ["a delivery that launched nothing", { overrides: { duplicateDelivery: DUPLICATE_DELIVERY } },
    "TELEMETRY_LAUNCH_NOT_ATTEMPTED", "TELEMETRY_LAUNCH"],
];

describe("refusal identity", () => {
  it("pins a non-empty refusal table spanning all three refusing layers", () => {
    expect(REFUSAL_CASES.length).toBe(6);
    expect([...new Set(REFUSAL_CASES.map(([, , , layer]) => layer))].sort())
      .toEqual(["TELEMETRY_CAPTURE", "TELEMETRY_LAUNCH", "TELEMETRY_SCHEMA"]);
  });

  it.each(REFUSAL_CASES)("refuses %s with an exact code and layer",
    async (_label, arm, code, layer) => {
      const handoff = await armHandoff(arm);
      expect(handoff.telemetryRefusal?.code).toBe(code);
      expect(handoff.telemetryRefusal?.layer).toBe(layer);
      expect(PROVIDER_TELEMETRY_CODES).toContain(code);
      expect(PROVIDER_TELEMETRY_LAYERS).toContain(layer);
      // Every count carries the SAME refusal, so no fact outlives its reason.
      expect(handoff.tokens.inputTokens).toEqual({ known: false, code, layer });
      expect(handoff.steps.turns).toEqual({ known: false, code, layer });
    });
});

/**
 * The two zero-invention rules, pinned explicitly because they are the ones a
 * plausible implementation gets wrong while every other test stays green.
 */
const NO_USAGE = line({ seq: 1, type: "result", subtype: "success", num_turns: 2 });

const NEVER_ZERO_CASES: readonly (readonly [string, ArmCase, string, string])[] = [
  ["a capture cut at the launcher's bound", { overrides: { limits: { ...LIMITS,
    stdoutBytes: 16 } } }, "TELEMETRY_CAPTURE_TRUNCATED", "TELEMETRY_CAPTURE"],
  ["a capture that never finished", { harness: { streamError: "stdout" } },
    "TELEMETRY_CAPTURE_INCOMPLETE", "TELEMETRY_CAPTURE"],
  ["an unknown schema version", { stdout: foreign(1) },
    "TELEMETRY_SCHEMA_UNSUPPORTED", "TELEMETRY_SCHEMA"],
  ["a capture holding no terminal result record", { stdout: INIT_ONLY },
    "TELEMETRY_RESULT_ABSENT", "TELEMETRY_RESULT"],
];

describe("never-zero", () => {
  it("pins a non-empty case table for the never-zero rule", () => {
    expect(NEVER_ZERO_CASES.length).toBe(4);
  });

  it.each(NEVER_ZERO_CASES)("leaves every count UNMEASURED for %s",
    async (_label, arm, code, layer) => {
      const { tokens, steps } = await armHandoff(arm);
      const blind = { known: false, code, layer };
      expect(tokens).toEqual({ inputTokens: blind, outputTokens: blind,
        cacheCreationInputTokens: blind, cacheReadInputTokens: blind, coverage: "UNKNOWN" });
      expect(steps).toEqual({ turns: blind, coverage: "UNKNOWN" });
      // Asserted against the NUMBER directly, and against the shape: a `?? 0`
      // anywhere upstream fails here rather than inside a later consumer.
      for (const fact of [tokens.inputTokens, tokens.outputTokens,
        tokens.cacheCreationInputTokens, tokens.cacheReadInputTokens, steps.turns]) {
        expect(fact).not.toBe(0);
        expect(fact).not.toEqual({ known: true, value: 0 });
        expect(fact.known).toBe(false);
      }
      // No quantity carries a value at all, so nothing was partially summed.
      expect(JSON.stringify({ tokens, steps })).not.toContain("\"value\"");
    });

  it("refuses to sum a partial capture instead of reporting it unmeasured", async () => {
    // The capture really is a PREFIX of a stream whose visible bytes would sum
    // to something plausible; the coverage class is what makes that inadmissible.
    const { tokens, telemetryRefusal } = await armHandoff(
      { overrides: { limits: { ...LIMITS, stdoutBytes: 90 } } });
    expect(telemetryRefusal?.code).toBe("TELEMETRY_CAPTURE_TRUNCATED");
    expect(tokens.coverage).toBe("UNKNOWN");
    expect(JSON.stringify(tokens)).not.toContain("11");
  });

  it("refuses a truncation that lands EXACTLY on a record boundary", async () => {
    // The dangerous shape, and the one a tail-length check cannot see: the
    // capture is cut at a newline, so every record it holds is complete, no
    // framing anomaly is raised, and the visible usage sums to a number that is
    // indistinguishable from a real total. Only `truncated` knows it is a prefix.
    const first = line({ seq: 1, type: "result", subtype: "success", num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0 } });
    const stdout = `${first}${line({ seq: 2, type: "result", subtype: "success", num_turns: 9,
      usage: { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0 } })}`;
    const boundary = Buffer.byteLength(first, "utf8");
    expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(boundary);
    const { tokens, steps, telemetryRefusal, infrastructure } = await armHandoff(
      { stdout, overrides: { limits: { ...LIMITS, stdoutBytes: boundary } } });
    expect(telemetryRefusal?.code).toBe("TELEMETRY_CAPTURE_TRUNCATED");
    expect(infrastructure).toBe("CAPTURE_TRUNCATED");
    expect(tokens.coverage).toBe("UNKNOWN");
    expect(steps.coverage).toBe("UNKNOWN");
    // Not merely a different number: the prefix's own plausible total is absent.
    expect(tokens.inputTokens).not.toEqual({ known: true, value: 4 });
    expect(JSON.stringify({ tokens, steps })).not.toContain('"value"');
  });

  it("keeps a missing usage block unmeasured while the step count stays observed", async () => {
    const { tokens, steps } = await armHandoff({ stdout: NO_USAGE });
    const absent = { known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT" };
    expect(tokens.inputTokens).toEqual(absent);
    expect(tokens.coverage).toBe("UNKNOWN");
    // The two axes are independent: a missing usage block must not erase a step
    // count the record really did report, nor invent one it did not.
    expect(steps).toEqual({ turns: { known: true, value: 2 }, coverage: "COMPLETE" });
  });

  it("never borrows a placeholder assistant count as the run total", async () => {
    const stdout = `${INIT_ONLY}` +
      `${line({ seq: 2, type: "assistant",
        message: { model: "claude-opus-5-20260514",
          usage: { input_tokens: 999, output_tokens: 999 } } })}` +
      `${line({ seq: 3, type: "result", subtype: "success", num_turns: 2 })}`;
    const { tokens } = await armHandoff({ stdout });
    expect(tokens.coverage).toBe("UNKNOWN");
    expect(JSON.stringify(tokens)).not.toContain("999");
  });
});

describe("declared is not observed", () => {
  const DIVERGENT = `${line({ seq: 1, type: "system", subtype: "init",
    model: "claude-sonnet-5-20260101" })}${resultOnly("success", 2)}`;

  it("reports a divergent declared and observed model side by side", async () => {
    const handoff = await armHandoff({ stdout: DIVERGENT });
    expect(handoff.declared).toEqual({ known: true, selection: SELECTION });
    expect(SELECTION.selectedModelId).toBe(SELECTED_MODEL);
    expect(handoff.observedModel.modelId).toEqual(
      { known: true, value: "claude-sonnet-5-20260101" });
    // Neither side was reconciled into the other, and the SNAPSHOT evidence came
    // from the observed id rather than the declared one.
    expect(handoff.observedModel.snapshotEvidence).toEqual({ known: true, value: "20260101" });
    expect(handoff.declared.known && handoff.declared.selection.modelSnapshotEvidence)
      .toBe(SELECTION.modelSnapshotEvidence);
  });

  it("leaves the observed model UNKNOWN when the stream names none", async () => {
    const handoff = await armHandoff({ stdout: resultOnly("success") });
    expect(handoff.observedModel.modelId)
      .toEqual({ known: false, code: "TELEMETRY_MODEL_ABSENT", layer: "TELEMETRY_RESULT" });
    // The exact failure this guards: echoing the DECLARED model back as if the
    // provider had observed it.
    expect(handoff.observedModel.modelId).not.toEqual({ known: true, value: SELECTED_MODEL });
    expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
    expect(handoff.declared).toEqual({ known: true, selection: SELECTION });
  });

  it("never lets an alias become dated-snapshot evidence", async () => {
    const handoff = await armHandoff({ stdout:
      `${line({ seq: 1, type: "system", subtype: "init", model: "claude-opus-latest" })}` +
      `${resultOnly("success", 2)}` });
    expect(handoff.observedModel.modelId).toEqual({ known: true, value: "claude-opus-latest" });
    expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
    expect(handoff.observedModel.snapshotEvidence)
      .toEqual({ known: false, code: "TELEMETRY_MODEL_ABSENT", layer: "TELEMETRY_RESULT" });
    // The DECLARED side still says DATED_SNAPSHOT, and was not weakened by the
    // observation any more than it strengthened it.
    expect(handoff.declared.known && handoff.declared.selection.modelSnapshotKind)
      .toBe("DATED_SNAPSHOT");
  });

  it("pairs a declared ceiling with an achieved figure that can never be filled", async () => {
    const handoff = await armHandoff({});
    expect(handoff.concurrency.declaredCeiling)
      .toEqual({ known: true, value: SELECTION.concurrencyCeiling });
    expect(handoff.concurrency.achieved).toEqual({ known: false,
      code: "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", layer: "TELEMETRY_SCHEMA" });
    expect(handoff.concurrency.achieved)
      .not.toEqual({ known: true, value: SELECTION.concurrencyCeiling });
    expect(handoff.concurrency.achieved.known).toBe(false);
  });

  it("keeps every declared field out of the provider-observed side of the handoff", async () => {
    const handoff = await armHandoff({ stdout: DIVERGENT });
    // The observed model record carries EXACTLY these three facts. An effort, a
    // profile revision or a ceiling appearing here would be a settings default
    // that had crossed into provider-observed evidence.
    expect(Object.keys(handoff.observedModel).sort())
      .toEqual(["modelId", "snapshotEvidence", "snapshotKind"]);
    const observedSide = JSON.stringify({
      observedModel: handoff.observedModel, tokens: handoff.tokens, steps: handoff.steps,
      terminal: handoff.terminal, achieved: handoff.concurrency.achieved,
    });
    expect(SELECTED_EFFORT).toBe("high");
    for (const declaredValue of [SELECTED_MODEL, SELECTED_EFFORT, SELECTION.profileRevisionId,
      SELECTION.modelSnapshotEvidence, SELECTION.configurationDigest]) {
      expect(observedSide, `declared ${declaredValue} reached the observed side`)
        .not.toContain(declaredValue);
    }
  });
});
