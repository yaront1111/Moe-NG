import { describe, expect, it } from "vitest";

import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  buildProviderRuntimeObservation,
  observationDigestInput,
  runtimePinningIsAuthoritative,
  type ObservationClock,
  type PlatformIdentity,
  type RuntimeClosureEntry,
} from "./claude-observation.js";
import {
  CLAUDE_CAPABILITIES,
  CLAUDE_CAPABILITY_PROFILE_VERSION,
  probeClaudeRuntime,
  type ClaudeCapability,
  type ClaudeCapabilityRecord,
  type ClaudeProbePort,
  type ClaudeProbeReport,
} from "./claude-probe.js";
import { canonicalDigest } from "../../canonical.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const OBSERVED_AT = "2026-08-07T20:00:00.000Z";

const PLATFORM: PlatformIdentity = Object.freeze({
  os: "win32",
  arch: "x64",
  osVersion: "10.0.26200",
});

const CLOSURE: readonly RuntimeClosureEntry[] = Object.freeze([
  Object.freeze({ kind: "EXECUTABLE" as const, path: "C:/tools/claude/claude.exe", sha256: DIGEST_A }),
  Object.freeze({ kind: "PACKAGE" as const, path: "C:/tools/claude/package.json", sha256: DIGEST_B }),
]);

function fixedClock(observedAt: string = OBSERVED_AT): ObservationClock {
  return { observedAt: () => observedAt };
}

/** Everything a probe can legitimately prove, all at once. */
function provenReport(): ClaudeProbeReport {
  return {
    resolvedRuntimeClosure: CLOSURE,
    reportedVersion: "2.1.0",
    schemaVersion: "claude-stream-json/1",
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    structuredSample: { jsonLines: ['{"type":"assistant","seq":1}'] },
    rawSampleBase64: "eyJ0eXBlIjoiYXNzaXN0YW50In0=",
    cancelObservation: { requestedAtSequence: 4, terminatedAtSequence: 5 },
    processTreeObservation: { childrenBefore: 3, childrenAfter: 0 },
    runEnumeration: { enumeratedRunIds: ["run-a", "run-b"], provenAbsentRunId: "run-c" },
    tokenizer: { tokenizerId: "claude-tok/1", sampleText: "hello", sampleTokenCount: 1 },
    declaredContextLimit: { kind: "EXACT_TOKENS", tokens: 200_000 },
    helpText: null,
    resumeClaim: null,
  };
}

/** A probe that learned nothing. Every field is an explicit absence. */
function emptyReport(): ClaudeProbeReport {
  return {
    resolvedRuntimeClosure: [],
    reportedVersion: null,
    schemaVersion: null,
    pinningMethod: "UNSUPPORTED",
    structuredSample: null,
    rawSampleBase64: null,
    cancelObservation: null,
    processTreeObservation: null,
    runEnumeration: null,
    tokenizer: null,
    declaredContextLimit: null,
    helpText: null,
    resumeClaim: null,
  };
}

function portOf(report: ClaudeProbeReport): ClaudeProbePort {
  return { report: () => report };
}

function statusOf(records: readonly ClaudeCapabilityRecord[], capability: ClaudeCapability): string {
  return records.find((record) => record.capability === capability)?.status ?? "MISSING";
}

function probeOrThrow(port: ClaudeProbePort, clock: ObservationClock = fixedClock()) {
  const result = probeClaudeRuntime({ port, clock, platformIdentity: PLATFORM });
  if (!result.ok) {
    throw new Error(`probe failed: ${result.code} ${result.message}`);
  }
  return result;
}

describe("provider runtime observation", () => {
  it("records the full design-221 shape and a digest that excludes itself", () => {
    const result = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: CLOSURE,
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = result.observation;
    expect(observation.observationVersion).toBe(CLAUDE_RUNTIME_OBSERVATION_VERSION);
    expect(observation.providerId).toBe("claude");
    expect(observation.freshness.observedAt).toBe(OBSERVED_AT);
    expect(observation.truthClass).toBe("PROVEN");
    expect(observation.observationDigest).toBe(canonicalDigest(observationDigestInput(observation)));
    expect(JSON.stringify(observationDigestInput(observation))).not.toContain(
      observation.observationDigest,
    );
  });

  it("is deep frozen and order independent", () => {
    const forward = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: CLOSURE,
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    const reversed = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: [...CLOSURE].reverse(),
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.observation.observationDigest).toBe(forward.observation.observationDigest);
    expect(Object.isFrozen(forward.observation)).toBe(true);
    expect(Object.isFrozen(forward.observation.resolvedRuntimeClosure)).toBe(true);
    expect(Object.isFrozen(forward.observation.resolvedRuntimeClosure[0])).toBe(true);
  });

  it("stays UNKNOWN without a closure or a reported version, and refuses malformed facts", () => {
    const unproven = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: [],
      reportedVersion: null,
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "UNSUPPORTED",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    expect(unproven.ok).toBe(true);
    if (!unproven.ok) return;
    expect(unproven.observation.truthClass).toBe("UNKNOWN");
    expect(runtimePinningIsAuthoritative(unproven.observation)).toBe(false);

    const badDigest = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "claude.exe", sha256: "nope" }],
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    expect(badDigest.ok).toBe(false);
    if (badDigest.ok) return;
    expect(badDigest.code).toBe("CLAUDE_OBSERVATION_CLOSURE_INVALID");

    const badClock = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: CLOSURE,
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock("today"),
    });
    expect(badClock.ok).toBe(false);
    if (badClock.ok) return;
    expect(badClock.code).toBe("CLAUDE_OBSERVATION_CLOCK_INVALID");
  });

  it("refuses a duplicated closure path so one runtime cannot be counted twice", () => {
    const duplicated = buildProviderRuntimeObservation({
      resolvedRuntimeClosure: [
        { kind: "EXECUTABLE", path: "C:/tools/claude/claude.exe", sha256: DIGEST_A },
        { kind: "EXECUTABLE", path: "C:/tools/claude/claude.exe", sha256: DIGEST_B },
      ],
      reportedVersion: "2.1.0",
      adapterCapabilitySchemaDigest: DIGEST_A,
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      platformIdentity: PLATFORM,
      clock: fixedClock(),
    });
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.code).toBe("CLAUDE_OBSERVATION_CLOSURE_DUPLICATE");
  });
});

describe("claude capability probe", () => {
  it("emits one record per closed-vocabulary capability, in a stable order", () => {
    const { profile } = probeOrThrow(portOf(provenReport()));
    expect(profile.profileVersion).toBe(CLAUDE_CAPABILITY_PROFILE_VERSION);
    expect(profile.capabilities.map((record) => record.capability)).toEqual([
      ...CLAUDE_CAPABILITIES,
    ]);
    expect(new Set(CLAUDE_CAPABILITIES).size).toBe(CLAUDE_CAPABILITIES.length);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.capabilities[0])).toBe(true);
  });

  it("marks proven capabilities SUPPORTED with the method that proved them", () => {
    const { profile } = probeOrThrow(portOf(provenReport()));
    const proven: readonly ClaudeCapability[] = [
      "CANCEL_ON_READING",
      "CONTEXT_LIMIT_DECLARATION",
      "PIN_METHOD",
      "PROCESS_TREE_TERMINATION",
      "RAW_STREAM",
      "RUN_ENUMERATION_NEGATIVE_PROOF",
      "SCHEMA_VERSION_REPORT",
      "STRUCTURED_STREAM",
      "TOKENIZER_AVAILABILITY",
      "VERSION_REPORT",
    ];
    for (const capability of proven) {
      expect(`${capability}:${statusOf(profile.capabilities, capability)}`).toBe(
        `${capability}:SUPPORTED`,
      );
    }
    for (const record of profile.capabilities) {
      const proofRequired = record.status === "SUPPORTED";
      expect(proofRequired ? record.proofMethod !== "NONE" : record.proofMethod === "NONE").toBe(
        true,
      );
    }
    expect(profile.contextLimit).toEqual({ kind: "EXACT_TOKENS", tokens: 200_000 });
    expect(profile.contextPolicy).toBe("ADMISSIBLE");
  });

  it("keeps RESUME UNSUPPORTED in v1 even when the runtime advertises it", () => {
    const report = provenReport();
    const { profile } = probeOrThrow(
      portOf({ ...report, resumeClaim: "--resume <session-id>", helpText: "--resume  Resume" }),
    );
    expect(statusOf(profile.capabilities, "RESUME")).toBe("UNSUPPORTED");
    const resume = profile.capabilities.find((record) => record.capability === "RESUME");
    expect(resume?.proofMethod).toBe("NONE");
  });

  it("never accepts help text as capability proof", () => {
    const helpOnly: ClaudeProbeReport = {
      ...emptyReport(),
      helpText:
        "--output-format stream-json  --max-tokens  --resume  --kill-tree  --list-sessions",
    };
    const { profile, observation } = probeOrThrow(portOf(helpOnly));
    for (const record of profile.capabilities) {
      expect(`${record.capability}:${record.status}`).toBe(`${record.capability}:UNSUPPORTED`);
    }
    expect(profile.contextPolicy).toBe("HOLD_UNKNOWN");
    expect(observation.truthClass).toBe("UNKNOWN");
  });

  it("refuses observations that contradict the claim they are offered as proof of", () => {
    const report = provenReport();
    const survivingChildren = probeOrThrow(
      portOf({ ...report, processTreeObservation: { childrenBefore: 3, childrenAfter: 1 } }),
    );
    expect(statusOf(survivingChildren.profile.capabilities, "PROCESS_TREE_TERMINATION")).toBe(
      "UNSUPPORTED",
    );

    const cancelAfterEnd = probeOrThrow(
      portOf({ ...report, cancelObservation: { requestedAtSequence: 9, terminatedAtSequence: 4 } }),
    );
    expect(statusOf(cancelAfterEnd.profile.capabilities, "CANCEL_ON_READING")).toBe("UNSUPPORTED");

    const runIdPresent = probeOrThrow(
      portOf({
        ...report,
        runEnumeration: { enumeratedRunIds: ["run-a"], provenAbsentRunId: "run-a" },
      }),
    );
    expect(statusOf(runIdPresent.profile.capabilities, "RUN_ENUMERATION_NEGATIVE_PROOF")).toBe(
      "UNSUPPORTED",
    );

    const unparseableStructured = probeOrThrow(
      portOf({ ...report, structuredSample: { jsonLines: ["not json"] } }),
    );
    expect(statusOf(unparseableStructured.profile.capabilities, "STRUCTURED_STREAM")).toBe(
      "UNSUPPORTED",
    );

    const zeroTokens = probeOrThrow(
      portOf({
        ...report,
        tokenizer: { tokenizerId: "claude-tok/1", sampleText: "hello", sampleTokenCount: 0 },
      }),
    );
    expect(statusOf(zeroTokens.profile.capabilities, "TOKENIZER_AVAILABILITY")).toBe("UNSUPPORTED");
  });

  it("holds UNKNOWN when no trustworthy context limit is declared", () => {
    const report = provenReport();
    for (const declared of [
      null,
      { kind: "UNKNOWN" } as const,
      { kind: "EXACT_TOKENS", tokens: 0 } as const,
      { kind: "CONSERVATIVE_INPUT_BYTES", bytes: -1 } as const,
    ]) {
      const { profile } = probeOrThrow(portOf({ ...report, declaredContextLimit: declared }));
      expect(profile.contextLimit).toEqual({ kind: "UNKNOWN" });
      expect(profile.contextPolicy).toBe("HOLD_UNKNOWN");
      expect(statusOf(profile.capabilities, "CONTEXT_LIMIT_DECLARATION")).toBe("UNSUPPORTED");
    }
    const bytes = probeOrThrow(
      portOf({
        ...report,
        declaredContextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 1_048_576 },
      }),
    );
    expect(bytes.profile.contextPolicy).toBe("ADMISSIBLE");
  });

  it("degrades to a fully unproven profile when the probe port fails", () => {
    const throwing: ClaudeProbePort = {
      report: () => {
        throw new Error("ENOENT: claude not installed");
      },
    };
    const { profile, observation } = probeOrThrow(throwing);
    for (const record of profile.capabilities) {
      expect(`${record.capability}:${record.status}`).toBe(`${record.capability}:UNSUPPORTED`);
    }
    expect(profile.contextPolicy).toBe("HOLD_UNKNOWN");
    expect(observation.resolvedRuntimeClosure).toEqual([]);
    expect(observation.reportedVersion).toBeNull();
    expect(observation.pinningMethod).toBe("UNSUPPORTED");
    expect(observation.truthClass).toBe("UNKNOWN");
    expect(runtimePinningIsAuthoritative(observation)).toBe(false);
  });

  it("binds the capability schema digest into the observation and stays deterministic", () => {
    const first = probeOrThrow(portOf(provenReport()));
    const second = probeOrThrow(portOf(provenReport()));
    expect(first.profile.capabilitySchemaDigest).toBe(second.profile.capabilitySchemaDigest);
    expect(first.observation.observationDigest).toBe(second.observation.observationDigest);
    expect(first.observation.adapterCapabilitySchemaDigest).toBe(
      first.profile.capabilitySchemaDigest,
    );

    const degraded = probeOrThrow(portOf({ ...provenReport(), tokenizer: null }));
    expect(degraded.profile.capabilitySchemaDigest).not.toBe(first.profile.capabilitySchemaDigest);
    expect(degraded.observation.observationDigest).not.toBe(first.observation.observationDigest);
  });

  it("fails closed when the platform identity cannot be trusted", () => {
    const result = probeClaudeRuntime({
      port: portOf(provenReport()),
      clock: fixedClock(),
      platformIdentity: { os: "", arch: "x64", osVersion: "10.0.26200" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_OBSERVATION_PLATFORM_INVALID");
  });
});
