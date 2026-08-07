import { expect, it } from "vitest";

import { createCompatGate } from "./client-compat.js";
import type { DistributionCompatibilityReport } from "./client-compat.js";
import {
  GENERATED_COMMAND_BUILDERS,
  GENERATED_CONTRACT_PINS,
  GENERATED_ERROR_TABLE,
  GENERATED_QUERY_BUILDERS,
  GENERATED_TELEMETRY_KINDS,
} from "./generated/generated-client.js";
import * as packageRoot from "./index.js";

const MATCHING_REPORT: DistributionCompatibilityReport = Object.freeze({
  apiCompatibilityRange: Object.freeze({
    commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
    errorRegistryVersion: GENERATED_CONTRACT_PINS.errorRegistryVersion,
    queryEnvelopeVersion: GENERATED_CONTRACT_PINS.queryEnvelopeVersion,
  }),
  buildToolVersions: Object.freeze({ node: "24.16.0", typescript: "7.0.2" }),
  contractSchemaHash: GENERATED_CONTRACT_PINS.contractDigest,
});

const refuse = (report: unknown): { readonly ok: boolean } => createCompatGate(report);

it("exposes the generated surface when the distribution report pins match exactly", () => {
  const gate = createCompatGate(MATCHING_REPORT);
  expect(gate.ok).toBe(true);
  if (!gate.ok) return;
  expect(Object.keys(gate.client).sort()).toEqual([
    "commands", "errors", "pins", "queries", "telemetryKinds",
  ]);
  expect(gate.client.commands).toBe(GENERATED_COMMAND_BUILDERS);
  expect(gate.client.queries).toBe(GENERATED_QUERY_BUILDERS);
  expect(gate.client.errors).toBe(GENERATED_ERROR_TABLE);
  expect(gate.client.pins).toBe(GENERATED_CONTRACT_PINS);
  expect(gate.client.telemetryKinds).toBe(GENERATED_TELEMETRY_KINDS);
  expect(Object.isFrozen(gate)).toBe(true);
  expect(Object.isFrozen(gate.client)).toBe(true);
});

it("accepts the optional source and asset identity fields", () => {
  const gate = createCompatGate({
    ...MATCHING_REPORT,
    assetDigest: "d".repeat(64),
    sourceSha: "e".repeat(40),
  });
  expect(gate.ok).toBe(true);
});

it("refuses a missing distribution report", () => {
  const gate = createCompatGate(undefined);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.error.code).toBe("DISTRIBUTION_MISMATCH");
});

it("refuses a contract schema hash that does not match the generated digest", () => {
  const gate = createCompatGate({ ...MATCHING_REPORT, contractSchemaHash: "0".repeat(64) });
  expect(gate.ok).toBe(false);
});

it("refuses any single version pin drifting from the generated pins", () => {
  const pins = ["commandEnvelopeVersion", "errorRegistryVersion", "queryEnvelopeVersion"] as const;
  for (const pin of pins) {
    const gate = createCompatGate({
      ...MATCHING_REPORT,
      apiCompatibilityRange: { ...MATCHING_REPORT.apiCompatibilityRange, [pin]: "moe-drift/9" },
    });
    expect(gate.ok).toBe(false);
  }
});

it("refuses malformed reports rather than guessing intent", () => {
  const range = MATCHING_REPORT.apiCompatibilityRange;
  const { buildToolVersions: _dropped, ...missingKey } = MATCHING_REPORT;
  expect(refuse(null).ok).toBe(false);
  expect(refuse("moe").ok).toBe(false);
  expect(refuse([MATCHING_REPORT]).ok).toBe(false);
  expect(refuse({}).ok).toBe(false);
  expect(refuse(missingKey).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, unexpected: "extra" }).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, apiCompatibilityRange: "moe-runtime-command/1" }).ok)
    .toBe(false);
  expect(refuse({ ...MATCHING_REPORT, apiCompatibilityRange: { ...range, extra: "x" } }).ok)
    .toBe(false);
  expect(refuse({ ...MATCHING_REPORT, buildToolVersions: { node: 24 } }).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, buildToolVersions: ["node"] }).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, contractSchemaHash: 1 }).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, sourceSha: "" }).ok).toBe(false);
  expect(refuse({ ...MATCHING_REPORT, assetDigest: 7 }).ok).toBe(false);
});

it("exposes no builder on the refusal, by property or by prototype", () => {
  const gate = createCompatGate(undefined);
  expect(Object.keys(gate).sort()).toEqual(["error", "ok"]);
  expect(Object.getPrototypeOf(gate)).toBe(Object.prototype);
  for (const name of ["client", "commands", "queries", "errors", "pins"]) {
    expect(name in gate).toBe(false);
  }
  expect(Object.isFrozen(gate)).toBe(true);
  if (gate.ok) return;
  expect(Object.isFrozen(gate.error)).toBe(true);
});

it("carries the registry transport binding on the refusal so a UI can render it", () => {
  const gate = createCompatGate(undefined);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.error.transport).toEqual({
    category: "UNPROCESSABLE", httpStatus: 422, mcpCode: -32007,
  });
  expect(gate.error.retryability).toBe("NEVER");
  expect(gate.error.recoveryCategory).toBe("HUMAN_DECISION");
  expect(gate.error.truthClass).toBe("OBSERVED");
});

it("reuses one shared refusal identity across every refusal path", () => {
  expect(createCompatGate(undefined)).toBe(createCompatGate({}));
});

it("exports only the compatibility gate from the package root", () => {
  expect(Object.keys(packageRoot)).toEqual(["createCompatGate"]);
});
