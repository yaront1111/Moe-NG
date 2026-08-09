/**
 * Behaviour contract for the provider / process / launch-lock inventory adapter.
 *
 * Every refusal is driven END TO END through the shipped `collectRecoveryInventory`,
 * because the enumerator mints no codes: the aggregate turns a reading into a
 * coverage proof. A test that checked a private mapping helper inside the module
 * would only prove the module agrees with itself.
 *
 * Probe doubles sit at the port boundary the probes already define
 * (`input.port.report()`), so the real `probeClaudeRuntime` / `probeCodexRuntime`
 * and the real `capabilityStatus` stay inside the path under test. No probe,
 * launch-lock or process-observation authority is reimplemented here.
 */
import { describe, expect, it } from "vitest";

import { collectRecoveryInventory, createRecoveryInventoryRegistry, isRecoveryInventoryFailure } from "@moe/runner";
import type {
  RecoveryInventoryCoverageProof,
  RecoveryInventoryReport,
  RecoveryInventoryResult,
  RecoveryInventoryUnknownReason,
} from "@moe/runner";

import type { ClaudeProbeReport } from "../providers/claude/claude-capabilities.js";
import type { CodexProbeReport } from "../providers/codex/codex-capabilities.js";
import {
  enumerateProviderLockInventory,
  providerLockInventoryRegistration,
  type ProviderLockInventoryInput,
  type ProviderProcessRecord,
} from "./provider-lock-inventory.js";

const CLASS = "PROVIDER_PROCESS_LAUNCH_LOCK";
const LAYER = "INVENTORY_ADAPTER";
const UNKNOWN_CODE = "RECOVERY_INVENTORY_COVERAGE_UNKNOWN";
const PROJECT = "moe-next";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** Counts coverage cases actually generated: a sweep producing nothing must fail. */
const GENERATED: string[] = [];

const PLATFORM = { os: "windows", arch: "x64", osVersion: "10.0.26200" };
const CLOCK = { observedAt: () => OBSERVED_AT };

const CLAIM = {
  claimId: "claim-1",
  intentId: "intent-1",
  wrapperIdentity: "wrapper-1",
  lockIdentity: "lock-1",
  claimedAt: "2026-08-05T11:00:00.000Z",
};

function claudeReport(overrides: Partial<ClaudeProbeReport> = {}): ClaudeProbeReport {
  return {
    resolvedRuntimeClosure: [],
    reportedVersion: "claude-1.2.3",
    schemaVersion: null,
    pinningMethod: "UNSUPPORTED",
    structuredSample: null,
    rawSampleBase64: null,
    cancelObservation: null,
    processTreeObservation: { childrenBefore: 2, childrenAfter: 0 },
    runEnumeration: { enumeratedRunIds: ["run-a"], provenAbsentRunId: "run-z" },
    tokenizer: null,
    declaredContextLimit: null,
    helpText: null,
    resumeClaim: null,
    ...overrides,
  };
}

function codexReport(overrides: Partial<CodexProbeReport> = {}): CodexProbeReport {
  return {
    resolvedRuntimeClosure: [],
    reportedVersion: "codex-4.5.6",
    schemaVersion: null,
    pinningMethod: "UNSUPPORTED",
    structuredSample: null,
    rawSampleBase64: null,
    cancelObservation: null,
    cwdObservation: null,
    processTreeObservation: { childrenBefore: 2, childrenAfter: 0 },
    runEnumeration: { enumeratedRunIds: ["run-b"], provenAbsentRunId: "run-y" },
    tokenizer: null,
    declaredContextLimit: null,
    helpText: null,
    resumeClaim: null,
    ...overrides,
  };
}

function lockRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lockIdentity: "lock-1",
    wrapperIdentity: "wrapper-1",
    processIdentity: "pid-1",
    bootstrapCredentialDigest: DIGEST_A,
    registeredAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

function processRecord(overrides: Partial<ProviderProcessRecord> = {}): ProviderProcessRecord {
  return {
    processIdentity: "pid-1",
    exit: { kind: "EXITED", code: 0 },
    reconciliation: null,
    ...overrides,
  };
}

interface InputOverrides {
  readonly claude?: Partial<ClaudeProbeReport>;
  readonly codex?: Partial<CodexProbeReport>;
  readonly locks?: readonly unknown[];
  readonly processes?: readonly ProviderProcessRecord[];
  readonly claim?: unknown;
  readonly throwOn?: "claim" | "locks" | "processes";
  readonly clock?: { readonly observedAt: () => string };
}

function input(overrides: InputOverrides = {}): ProviderLockInventoryInput {
  const boom = (which: string) => {
    if (overrides.throwOn === which) {
      throw new Error(`port ${which} is unreachable`);
    }
  };
  return {
    clock: CLOCK,
    claude: {
      port: { report: () => claudeReport(overrides.claude) },
      clock: overrides.clock ?? CLOCK,
      platformIdentity: PLATFORM,
    },
    codex: {
      port: { report: () => codexReport(overrides.codex) },
      clock: overrides.clock ?? CLOCK,
      platformIdentity: PLATFORM,
    },
    port: {
      governingClaim: () => {
        boom("claim");
        return "claim" in overrides ? overrides.claim : { ...CLAIM };
      },
      launchLockRecords: () => {
        boom("locks");
        return overrides.locks ?? [];
      },
      processRecords: () => {
        boom("processes");
        return overrides.processes ?? [];
      },
    },
  };
}

function request(): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A },
    incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B },
    window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
    configuredClasses: [CLASS],
  };
}

async function collect(overrides: InputOverrides = {}): Promise<RecoveryInventoryReport> {
  const registry = createRecoveryInventoryRegistry([providerLockInventoryRegistration(input(overrides))]);
  const result: RecoveryInventoryResult = await collectRecoveryInventory(request(), registry);
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofFor(report: RecoveryInventoryReport): RecoveryInventoryCoverageProof {
  const proof = report.proofs.find((candidate) => candidate.class === CLASS);
  if (proof === undefined) {
    throw new Error(`configured class ${CLASS} vanished from the report`);
  }
  GENERATED.push(CLASS);
  return proof;
}

/** Pins truth, code, reason and layer together so a swapped proof cannot pass. */
function expectUnknown(report: RecoveryInventoryReport, reason: RecoveryInventoryUnknownReason): void {
  const proof = proofFor(report);
  expect({ truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer }).toEqual({
    truth: "UNKNOWN",
    code: UNKNOWN_CODE,
    reason,
    layer: LAYER,
  });
  expect(report.coverage).toBe("UNKNOWN");
  expect(report.items).toHaveLength(0);
}

function factsOf(report: RecoveryInventoryReport, id: string): Record<string, unknown> {
  const found = report.items.find(
    (candidate) => candidate.identity.kind === "OPAQUE" && candidate.identity.id === id,
  );
  if (found === undefined) {
    throw new Error(`no inventory item for external identity ${id}`);
  }
  return { ...found.facts };
}

describe("provider, process and launch-lock enumeration", () => {
  it("binds every lock and process to the class, a stable identity and a source proof", async () => {
    const report = await collect({
      locks: [lockRecord()],
      processes: [processRecord()],
    });
    const proof = proofFor(report);
    expect({ truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer }).toEqual({
      truth: "COMPLETE",
      code: null,
      reason: null,
      layer: LAYER,
    });
    expect(report.coverage).toBe("COMPLETE");
    expect(report.items).toHaveLength(2);
    expect(proof.itemCount).toBe(2);
    for (const item of report.items) {
      expect(item.class).toBe(CLASS);
      expect(item.projectTag).toBe(PROJECT);
      expect(item.observedAt).toBe(OBSERVED_AT);
      expect(item.sourceProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(factsOf(report, "launch-lock:lock-1")).toEqual({
      source: "LAUNCH_LOCK",
      wrapperIdentity: "wrapper-1",
      processIdentity: "pid-1",
      registeredAt: "2026-08-05T10:00:00.000Z",
      bindsGoverningClaim: true,
    });
    expect(factsOf(report, "process:pid-1")).toEqual({
      source: "PROCESS_OBSERVATION",
      exitKind: "EXITED",
      dispositionProven: true,
      ended: true,
      reconciled: false,
    });
  });

  it("never leaks the one-time bootstrap credential digest into an item's facts", async () => {
    const report = await collect({ locks: [lockRecord()], processes: [processRecord()] });
    expect(JSON.stringify(report.items)).not.toContain(DIGEST_A);
    GENERATED.push(CLASS);
  });

  it("reports a lock that binds a different wrapper as unbound rather than dropping it", async () => {
    const report = await collect({
      locks: [lockRecord({ lockIdentity: "lock-2", wrapperIdentity: "wrapper-9" })],
      processes: [processRecord()],
    });
    expect(factsOf(report, "launch-lock:lock-2")["bindsGoverningClaim"]).toBe(false);
    expect(proofFor(report).truth).toBe("COMPLETE");
  });
});

describe("a quiet process is not an absent one", () => {
  it("keeps an unobserved process visible and never reports it as ended", () => {
    const context = {
      class: CLASS,
      projectTag: PROJECT,
      backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A },
      incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B },
      window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
    } as const;
    const reading = enumerateProviderLockInventory(
      input({ processes: [processRecord({ exit: { kind: "UNOBSERVED" } })] }),
      context,
    );
    if (reading.status !== "ENUMERATED") {
      throw new Error(`expected an enumeration, got ${reading.status}`);
    }
    expect(reading.items).toHaveLength(1);
    const [only] = reading.items as readonly { facts: Record<string, unknown> }[];
    expect(only?.facts).toEqual({
      source: "PROCESS_OBSERVATION",
      exitKind: "UNOBSERVED",
      dispositionProven: false,
      ended: false,
      reconciled: false,
    });
    expect(reading.complete).toBe(false);
  });

  it("drives the class to UNKNOWN rather than to COMPLETE", async () => {
    const report = await collect({ processes: [processRecord({ exit: { kind: "UNOBSERVED" } })] });
    expectUnknown(report, "RESULT_TRUNCATED");
  });

  it("treats a process record that does not parse as truncation, not as absence", async () => {
    const report = await collect({ processes: [processRecord({ exit: { kind: "EXITED" } })] });
    expectUnknown(report, "RESULT_TRUNCATED");
  });

  it("treats a launch-lock record that does not parse as truncation, not as absence", async () => {
    const report = await collect({ locks: [lockRecord({ registeredAt: "not-a-timestamp" })] });
    expectUnknown(report, "RESULT_TRUNCATED");
  });
});

describe("an empty population is never COMPLETE by itself", () => {
  it("refuses with NEGATIVE_PROOF_MISSING when no provider can prove absence", async () => {
    const report = await collect({
      claude: { runEnumeration: null },
      codex: { runEnumeration: null },
    });
    expectUnknown(report, "NEGATIVE_PROOF_MISSING");
  });

  it("still refuses when only one of the two providers can prove absence", async () => {
    const report = await collect({ codex: { runEnumeration: null } });
    expectUnknown(report, "NEGATIVE_PROOF_MISSING");
  });

  it("admits an empty population only against a verifiable negative proof", async () => {
    const report = await collect();
    const proof = proofFor(report);
    expect({ truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer }).toEqual({
      truth: "COMPLETE",
      code: null,
      reason: null,
      layer: LAYER,
    });
    expect(proof.itemCount).toBe(0);
    expect(proof.negativeProofDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("capability, availability and ceiling refusals", () => {
  it("reports CAPABILITY_UNSUPPORTED when the Claude runtime cannot observe a process tree", async () => {
    const report = await collect({ claude: { processTreeObservation: null }, locks: [lockRecord()] });
    expectUnknown(report, "CAPABILITY_UNSUPPORTED");
  });

  it("reports CAPABILITY_UNSUPPORTED when the Codex runtime cannot observe a process tree", async () => {
    const report = await collect({ codex: { processTreeObservation: null }, locks: [lockRecord()] });
    expectUnknown(report, "CAPABILITY_UNSUPPORTED");
  });

  it("reports CAPABILITY_UNSUPPORTED when surviving children disprove tree termination", async () => {
    const report = await collect({
      claude: { processTreeObservation: { childrenBefore: 2, childrenAfter: 1 } },
    });
    expectUnknown(report, "CAPABILITY_UNSUPPORTED");
  });

  it("reports ENUMERATOR_UNAVAILABLE when a source port throws", async () => {
    expectUnknown(await collect({ throwOn: "locks" }), "ENUMERATOR_UNAVAILABLE");
    expectUnknown(await collect({ throwOn: "processes" }), "ENUMERATOR_UNAVAILABLE");
  });

  it("reports ENUMERATOR_UNAVAILABLE when the runtime observation itself refuses", async () => {
    const report = await collect({ clock: { observedAt: () => "not-a-canonical-instant" } });
    expectUnknown(report, "ENUMERATOR_UNAVAILABLE");
  });

  it("reports ENUMERATOR_UNAVAILABLE when the governing claim does not parse", async () => {
    const report = await collect({ claim: { ...CLAIM, claimedAt: "yesterday" } });
    expectUnknown(report, "ENUMERATOR_UNAVAILABLE");
  });

  it("reports RESULT_OVER_LIMIT one item above the ceiling", async () => {
    const locks = Array.from({ length: 4097 }, (_ignored, index) =>
      lockRecord({ lockIdentity: `lock-${index}` }),
    );
    expect(locks).toHaveLength(4097);
    expectUnknown(await collect({ locks }), "RESULT_OVER_LIMIT");
  });

  it("refuses two locks claiming one external identity instead of merging them", async () => {
    const report = await collect({
      locks: [lockRecord(), lockRecord({ processIdentity: "pid-9" })],
    });
    const proof = proofFor(report);
    expect({ truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer }).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(report.items).toHaveLength(0);
  });

  it("answers ENUMERATOR_UNREGISTERED rather than dropping the class from the report", async () => {
    const result = await collectRecoveryInventory(request(), createRecoveryInventoryRegistry([]));
    if (isRecoveryInventoryFailure(result)) {
      throw new Error(`expected a report, got refusal ${result.code}`);
    }
    expectUnknown(result, "ENUMERATOR_UNREGISTERED");
  });
});

describe("coverage sweep", () => {
  it("generated a coverage case for the class on every arm above", () => {
    expect(GENERATED.filter((entry) => entry === CLASS)).toHaveLength(19);
    expect(GENERATED.length).toBeGreaterThan(0);
  });
});
