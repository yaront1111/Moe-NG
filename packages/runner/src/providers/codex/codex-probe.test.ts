import { describe, expect, it } from "vitest";

import {
  CODEX_CAPABILITIES,
  UNPROVEN_PROBE_REPORT,
  type CodexCapabilityProfile,
  type CodexProbeReport,
} from "./codex-capabilities.js";
import { capabilityStatus, probeCodexRuntime } from "./codex-probe.js";

const DIGEST = "a".repeat(64);
const clock = { observedAt: () => "2026-08-09T10:00:00.000Z" };
const platformIdentity = { os: "linux", arch: "x64", osVersion: "6.8" };

const provenReport = (): CodexProbeReport => ({
  ...UNPROVEN_PROBE_REPORT,
  resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "/usr/bin/codex", sha256: DIGEST }],
  reportedVersion: "codex 1.0",
  schemaVersion: "codex-stream-json/1",
  pinningMethod: "CONTENT_ADDRESSED_COPY",
  structuredSample: { jsonLines: ['{"seq":1}'] },
  rawSampleBase64: Buffer.from("event").toString("base64"),
  cancelObservation: { requestedAtSequence: 1, terminatedAtSequence: 2 },
  cwdObservation: { requestedCwd: "/workspace", observedCwd: "/workspace" },
  processTreeObservation: { childrenBefore: 1, childrenAfter: 0 },
  runEnumeration: { enumeratedRunIds: ["run-1"], provenAbsentRunId: "run-2" },
  tokenizer: { tokenizerId: "tok", sampleText: "a", sampleTokenCount: 1 },
  declaredContextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 4096 },
});

const probe = (report: () => CodexProbeReport) => probeCodexRuntime({
  port: { report },
  clock,
  platformIdentity,
});

describe("Codex runtime probe", () => {
  it("binds a deeply frozen capability profile to the observed runtime", () => {
    const result = probe(provenReport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.capabilities).toHaveLength(CODEX_CAPABILITIES.length);
    expect(result.observation.adapterCapabilitySchemaDigest).toBe(
      result.profile.capabilitySchemaDigest,
    );
    expect(result.observation.truthClass).toBe("PROVEN");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile.capabilities)).toBe(true);
    expect(Object.isFrozen(result.observation.resolvedRuntimeClosure)).toBe(true);
  });

  it("turns a throwing probe port into a complete unsupported profile", () => {
    const result = probe(() => { throw new Error("probe unavailable"); });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.truthClass).toBe("UNKNOWN");
    expect(result.profile.contextPolicy).toBe("HOLD_UNKNOWN");
    expect(result.profile.capabilities.every((entry) => entry.status === "UNSUPPORTED")).toBe(true);
  });

  it.each([
    ["partial report", {}],
    ["hostile nested sample", { ...provenReport(), structuredSample: {} }],
  ])("falls back to the unproven report for a %s", (_label, value) => {
    const result = probe(() => value as CodexProbeReport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.truthClass).toBe("UNKNOWN");
    expect(capabilityStatus(result.profile, "STRUCTURED_STREAM")).toBe("UNSUPPORTED");
  });

  it("returns the stable closure code instead of crashing on a lying closure", () => {
    const result = probe(() => ({
      ...provenReport(),
      resolvedRuntimeClosure: null,
    }) as unknown as CodexProbeReport);
    expect(result).toMatchObject({
      ok: false,
      code: "CODEX_OBSERVATION_CLOSURE_INVALID",
    });
  });

  it("defaults a missing capability lookup to UNSUPPORTED", () => {
    const result = probe(provenReport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const empty = { ...result.profile, capabilities: [] } satisfies CodexCapabilityProfile;
    expect(capabilityStatus(empty, "RAW_STREAM")).toBe("UNSUPPORTED");
  });
});
