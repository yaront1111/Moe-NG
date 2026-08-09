import { describe, expect, it } from "vitest";

import {
  CODEX_CAPABILITIES,
  CODEX_CAPABILITY_STATUSES,
  UNPROVEN_PROBE_REPORT,
  assessCapabilities,
  resolveContextLimit,
  type CodexCapability,
  type CodexCapabilityRecord,
  type CodexProbeReport,
} from "./codex-capabilities.js";

const report = (overrides: Partial<CodexProbeReport> = {}): CodexProbeReport => ({
  ...UNPROVEN_PROBE_REPORT,
  ...overrides,
});

const statusOf = (
  records: readonly CodexCapabilityRecord[],
  capability: CodexCapability,
): CodexCapabilityRecord => {
  const found = records.find((entry) => entry.capability === capability);
  if (found === undefined) throw new Error(`missing capability ${capability}`);
  return found;
};

describe("Codex capability proof rules", () => {
  it("publishes one closed, non-empty capability and status vocabulary", () => {
    expect(CODEX_CAPABILITIES).toEqual([
      "CANCEL_ON_READING",
      "CONTEXT_LIMIT_DECLARATION",
      "CWD_OBSERVATION",
      "PIN_METHOD",
      "PROCESS_TREE_TERMINATION",
      "RAW_STREAM",
      "RESUME",
      "RUN_ENUMERATION_NEGATIVE_PROOF",
      "SCHEMA_VERSION_REPORT",
      "STRUCTURED_STREAM",
      "TOKENIZER_AVAILABILITY",
      "VERSION_REPORT",
    ]);
    expect(new Set(CODEX_CAPABILITIES).size).toBe(CODEX_CAPABILITIES.length);
    expect(CODEX_CAPABILITY_STATUSES).toEqual(["SUPPORTED", "UNSUPPORTED"]);
  });

  it("defaults every unproven capability to UNSUPPORTED with no proof", () => {
    const records = assessCapabilities(UNPROVEN_PROBE_REPORT, { kind: "UNKNOWN" });
    expect(records).toHaveLength(CODEX_CAPABILITIES.length);
    expect(records.map((entry) => entry.capability)).toEqual(CODEX_CAPABILITIES);
    expect(records.every((entry) => entry.status === "UNSUPPORTED")).toBe(true);
    expect(records.every((entry) => entry.proofMethod === "NONE")).toBe(true);
  });

  it("treats help and resume claims as diagnostic text, never proof", () => {
    const records = assessCapabilities(report({
      helpText: "resume supported --force",
      resumeClaim: "supported",
    }), { kind: "UNKNOWN" });
    expect(statusOf(records, "RESUME")).toEqual({
      capability: "RESUME",
      status: "UNSUPPORTED",
      proofMethod: "NONE",
    });
  });

  it("supports only capabilities backed by matching observations", () => {
    const limit = resolveContextLimit({ kind: "CONSERVATIVE_INPUT_BYTES", bytes: 4096 });
    const records = assessCapabilities(report({
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
      declaredContextLimit: limit,
    }), limit);

    for (const capability of CODEX_CAPABILITIES.filter((value) => value !== "RESUME")) {
      expect(statusOf(records, capability).status, capability).toBe("SUPPORTED");
    }
    expect(statusOf(records, "RESUME").status).toBe("UNSUPPORTED");
  });

  it("turns contradicting process and cwd observations into explicit UNSUPPORTED records", () => {
    const records = assessCapabilities(report({
      cwdObservation: { requestedCwd: "/expected", observedCwd: "/other" },
      processTreeObservation: { childrenBefore: 2, childrenAfter: 1 },
    }), { kind: "UNKNOWN" });
    expect(statusOf(records, "CWD_OBSERVATION")).toMatchObject({
      capability: "CWD_OBSERVATION",
      status: "UNSUPPORTED",
    });
    expect(statusOf(records, "PROCESS_TREE_TERMINATION")).toMatchObject({
      capability: "PROCESS_TREE_TERMINATION",
      status: "UNSUPPORTED",
    });
  });

  it("makes every evidence field present and explicitly nullable in the safe default", () => {
    expect(Object.keys(UNPROVEN_PROBE_REPORT).sort()).toEqual([
      "cancelObservation", "cwdObservation", "declaredContextLimit", "helpText",
      "pinningMethod", "processTreeObservation", "rawSampleBase64", "reportedVersion",
      "resolvedRuntimeClosure", "resumeClaim", "runEnumeration", "schemaVersion",
      "structuredSample", "tokenizer",
    ]);
  });
});
