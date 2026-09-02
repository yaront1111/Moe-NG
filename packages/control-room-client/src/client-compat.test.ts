import { expect, it } from "vitest";

import { admitByWireProtocol, createCompatGate } from "./client-compat.js";
import type { DistributionCompatibilityReport } from "./client-compat.js";
import {
  GENERATED_COMMAND_BUILDERS,
  GENERATED_CONTRACT_PINS,
  GENERATED_ERROR_TABLE,
  GENERATED_QUERY_BUILDERS,
  GENERATED_TELEMETRY_KINDS,
  GENERATED_WIRE_PROTOCOL_VERSION,
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
    "commands", "errors", "pins", "queries", "telemetryKinds", "wireProtocolVersion",
  ]);
  expect(gate.client.commands).toBe(GENERATED_COMMAND_BUILDERS);
  expect(gate.client.queries).toBe(GENERATED_QUERY_BUILDERS);
  expect(gate.client.errors).toBe(GENERATED_ERROR_TABLE);
  expect(gate.client.pins).toBe(GENERATED_CONTRACT_PINS);
  expect(gate.client.telemetryKinds).toBe(GENERATED_TELEMETRY_KINDS);
  expect(gate.client.wireProtocolVersion).toBe(GENERATED_WIRE_PROTOCOL_VERSION);
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

it("exports the gate and the transport from the package root, and nothing generated", () => {
  // The transport joined the root because a package whose send path is
  // unreachable from its entry point cannot be composed by apps/control-room.
  // The narrowness this case guards is unchanged: NONE of the generated surface
  // is published here. The digest is release/generator tooling exposed through
  // the Node-only `./contract-digest` subpath: publishing its `node:crypto`
  // dependency at this browser-facing root blanks Vite's dev graph before React
  // can mount. The transport instead takes `wireProtocolVersion` from its caller,
  // so a build whose pins drift still cannot learn the string it failed to match.
  // The session-key surface joins on the same terms the transport did: it is reached by
  // bare specifier from both apps/control-room and the e2e spec, and it holds ZERO `node:`
  // imports, so publishing it cannot blank the dev graph the way `./contract-digest` would.
  expect(Object.keys(packageRoot).sort()).toEqual([
    "COMMAND_AUTHORITY_PLANES",
    "CONTROL_ROOM_TRANSPORT_LAYER",
    "SESSION_KEY_LAYER",
    "SESSION_KEY_REFUSAL_CODES",
    "TRANSPORT_REFUSAL_CODES",
    "admitByWireProtocol",
    "buildGoalBriefCommand",
    "buildGoalWithSourceCommand",
    "createCompatGate",
    "createControlRoomTransport",
    "generateSessionKey",
    "isCommandAuthorityPlane",
    "openSessionRequestDigest",
    "signSessionChallenge",
  ]);
  for (const generated of ["GENERATED_COMMAND_BUILDERS", "GENERATED_WIRE_PROTOCOL_VERSION"]) {
    expect(Object.hasOwn(packageRoot, generated)).toBe(false);
  }
});

it("admits the exact generated wire protocol string and yields the full surface", () => {
  const gate = admitByWireProtocol(GENERATED_WIRE_PROTOCOL_VERSION);
  expect(gate.ok).toBe(true);
  if (!gate.ok) return;
  // The runtime pin yields the SAME frozen ADMITTED surface as the offline gate.
  expect(gate.client.commands).toBe(GENERATED_COMMAND_BUILDERS);
  expect(Object.hasOwn(gate.client.commands, "goal.create")).toBe(true);
  expect(gate.client.wireProtocolVersion).toBe(GENERATED_WIRE_PROTOCOL_VERSION);
  expect(Object.isFrozen(gate)).toBe(true);
  expect(Object.isFrozen(gate.client)).toBe(true);
});

it("refuses a wire protocol string that has drifted from the generated pin", () => {
  const gate = admitByWireProtocol(`${GENERATED_WIRE_PROTOCOL_VERSION}x`);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.error.code).toBe("DISTRIBUTION_MISMATCH");
});

it("refuses a non-string wire protocol value, whatever its runtime type", () => {
  for (const value of [undefined, null, 7, {}, [GENERATED_WIRE_PROTOCOL_VERSION]]) {
    const gate = admitByWireProtocol(value);
    expect(gate.ok).toBe(false);
    if (gate.ok) continue;
    expect(gate.error.code).toBe("DISTRIBUTION_MISMATCH");
  }
});

it("reuses the shared refusal identity for the runtime wire pin too", () => {
  expect(admitByWireProtocol(undefined)).toBe(createCompatGate(undefined));
});
