import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  RUNTIME_TELEMETRY_KINDS,
  buildNextAllowedCommands,
  lookupRuntimeError,
} from "@moe/contracts";
import { expect, it } from "vitest";

import {
  COMMAND_ENVELOPE_KEYS,
  GENERATED_COMMAND_BUILDERS,
  GENERATED_CONTRACT_PINS,
  GENERATED_ERROR_TABLE,
  GENERATED_QUERY_BUILDERS,
  GENERATED_TELEMETRY_KINDS,
  GENERATED_WIRE_PROTOCOL_VERSION,
  QUERY_ENVELOPE_KEYS,
} from "./generated/generated-client.js";
import type { CommandAffordance } from "./generated/generated-client.js";

/**
 * Golden fixtures. Every `@moe/contracts` registry change breaks these BY DESIGN:
 * regenerate (`pnpm --filter @moe/control-room-client generate`), review the diff,
 * then update both constants. That ritual is the whole point of committing output.
 */
const GENERATED_FILE_SHA256 = "957b18dfe2d3c677d6104b753182b981d2b991844a0773218c7125a741d29f03";
const CONTRACT_DIGEST = "9057aa947ce5cd23c1e2e667ddbf9315a7e329869a4fa0d473e037cd1d30077d";

const GENERATED_FILE = fileURLToPath(new URL("./generated/generated-client.ts", import.meta.url));

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

const GENERATED_COMMAND_KINDS = Object.freeze(sorted(Object.keys(GENERATED_COMMAND_BUILDERS)));
const LIVE_COMMAND_KINDS = Object.freeze(sorted(RUNTIME_COMMAND_KINDS));
const GENERATED_QUERY_KINDS = Object.freeze(sorted(Object.keys(GENERATED_QUERY_BUILDERS)));
const LIVE_QUERY_KINDS = Object.freeze(sorted(RUNTIME_QUERY_KINDS));

const REQUIRED_GENERATED_COMMAND_KINDS = Object.freeze([
  "planning.submit_decomposition",
  "product_contract.answer_clarification",
  "product_contract.ask_clarification",
  "product_contract.propose_revision",
] as const);

const REQUIRED_GENERATED_QUERY_KINDS = Object.freeze([
  "documents.source_read",
] as const);

const AFFORDANCE_INPUT = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  commandId: "cmd-0001",
  commandKind: "goal.create",
  expectedVersion: 7,
  graphRevisionHash: "a".repeat(64),
  inputSchemaVersion: "goal.create/1",
  policyRevisionHash: "b".repeat(64),
  targetAggregateId: "goal-0001",
});

/** Built through the real contracts parser so the fixture carries no hand-rolled shape. */
function goalCreateAffordance(): CommandAffordance<"goal.create"> {
  const built = buildNextAllowedCommands({ aggregate: "GOAL", state: "DRAFT" }, [AFFORDANCE_INPUT]);
  const first = built[0];
  if (first === undefined || first.commandKind !== "goal.create") {
    throw new Error("affordance fixture rejected by buildNextAllowedCommands");
  }
  return first as CommandAffordance<"goal.create">;
}

const CALLER = Object.freeze({
  correlationId: "corr-0001",
  payload: Object.freeze({ title: "ship it" }),
  requestDigest: "c".repeat(64),
  sessionCredential: "sess-0001",
});

it("generates exactly one command builder per runtime command kind", () => {
  expect(GENERATED_COMMAND_KINDS.length).toBeGreaterThan(0);
  expect(LIVE_COMMAND_KINDS.length).toBeGreaterThan(0);
  expect(GENERATED_COMMAND_KINDS).toEqual(LIVE_COMMAND_KINDS);
  expect(LIVE_COMMAND_KINDS).toEqual(GENERATED_COMMAND_KINDS);
  for (const kind of RUNTIME_COMMAND_KINDS) {
    expect(typeof GENERATED_COMMAND_BUILDERS[kind]).toBe("function");
  }
});

it("generates exactly one query builder per runtime query kind", () => {
  expect(GENERATED_QUERY_KINDS.length).toBeGreaterThan(0);
  expect(LIVE_QUERY_KINDS.length).toBeGreaterThan(0);
  expect(GENERATED_QUERY_KINDS).toEqual(LIVE_QUERY_KINDS);
  expect(LIVE_QUERY_KINDS).toEqual(GENERATED_QUERY_KINDS);
  for (const kind of RUNTIME_QUERY_KINDS) {
    expect(typeof GENERATED_QUERY_BUILDERS[kind]).toBe("function");
  }
});

it("includes every required PRD compiler command on both command surfaces", () => {
  expect(REQUIRED_GENERATED_COMMAND_KINDS).toHaveLength(4);
  for (const kind of REQUIRED_GENERATED_COMMAND_KINDS) {
    expect({
      generated: GENERATED_COMMAND_KINDS.includes(kind),
      kind,
      live: LIVE_COMMAND_KINDS.includes(kind),
    }).toEqual({ generated: true, kind, live: true });
  }
});

it("includes documents.source_read on both query surfaces", () => {
  expect(REQUIRED_GENERATED_QUERY_KINDS).toHaveLength(1);
  for (const kind of REQUIRED_GENERATED_QUERY_KINDS) {
    expect({
      generated: GENERATED_QUERY_KINDS.includes(kind),
      kind,
      live: LIVE_QUERY_KINDS.includes(kind),
    }).toEqual({ generated: true, kind, live: true });
  }
});

it("generates exactly one error row per runtime error code, projected from the registry", () => {
  expect(sorted(Object.keys(GENERATED_ERROR_TABLE))).toEqual(sorted(RUNTIME_ERROR_CODES));
  for (const code of RUNTIME_ERROR_CODES) {
    expect(GENERATED_ERROR_TABLE[code]).toEqual(lookupRuntimeError(code));
  }
});

it("re-exports the telemetry vocabulary verbatim", () => {
  expect(GENERATED_TELEMETRY_KINDS).toEqual(RUNTIME_TELEMETRY_KINDS);
});

it("pins the envelope and registry versions plus the contract digest", () => {
  expect(GENERATED_CONTRACT_PINS).toEqual({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    contractDigest: CONTRACT_DIGEST,
    errorRegistryVersion: "moe-runtime-error-registry/1",
    queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
  });
  expect(Object.isFrozen(GENERATED_CONTRACT_PINS)).toBe(true);
});

/**
 * The pin must be COMPOSED from the live registry constants, not written down. Asserting
 * it against a hard-coded string would pass even if the generator emitted a literal that
 * had drifted from the registry, which is the exact failure this pin exists to prevent.
 */
it("composes the wire protocol pin from the live registry constants", () => {
  expect(GENERATED_WIRE_PROTOCOL_VERSION).toBe(
    `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}`
    + `+${RUNTIME_ERROR_REGISTRY_VERSION}`,
  );
  expect(GENERATED_WIRE_PROTOCOL_VERSION.split("+")).toHaveLength(3);
});

it("matches the committed golden hash of the generated file", () => {
  const bytes = readFileSync(GENERATED_FILE);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(GENERATED_FILE_SHA256);
});

it("enumerates the envelope keys the generator was built against", () => {
  expect(sorted(COMMAND_ENVELOPE_KEYS)).toEqual([
    "commandId", "commandKind", "correlationId", "expectedVersion", "graphRevisionHash",
    "leaseAuthority", "payload", "policyRevisionHash", "requestDigest", "schemaVersion",
    "sessionCredential", "targetAggregateId",
  ]);
  expect(sorted(QUERY_ENVELOPE_KEYS)).toEqual([
    "correlationId", "cursor", "payload", "queryKind", "schemaVersion", "sessionCredential",
    "targetAggregateId",
  ]);
});

it("copies every command identity field from the daemon affordance", () => {
  const result = GENERATED_COMMAND_BUILDERS["goal.create"](goalCreateAffordance(), CALLER);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.envelope).toEqual({
    commandId: "cmd-0001",
    commandKind: "goal.create",
    correlationId: "corr-0001",
    expectedVersion: 7,
    graphRevisionHash: "a".repeat(64),
    payload: { title: "ship it" },
    policyRevisionHash: "b".repeat(64),
    requestDigest: "c".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "sess-0001",
    targetAggregateId: "goal-0001",
  });
  expect(Object.isFrozen(result.envelope)).toBe(true);
});

it("refuses an affordance whose kind does not match the builder", () => {
  const wrongKind = GENERATED_COMMAND_BUILDERS["goal.cancel"] as unknown as (
    affordance: CommandAffordance<"goal.create">,
    caller: typeof CALLER,
  ) => ReturnType<(typeof GENERATED_COMMAND_BUILDERS)["goal.create"]>;
  const result = wrongKind(goalCreateAffordance(), CALLER);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("INPUT_INVALID");
});

it("refuses a non-object affordance rather than minting an envelope", () => {
  const builder = GENERATED_COMMAND_BUILDERS["goal.create"] as unknown as (
    affordance: unknown,
    caller: typeof CALLER,
  ) => ReturnType<(typeof GENERATED_COMMAND_BUILDERS)["goal.create"]>;
  expect(builder(undefined, CALLER).ok).toBe(false);
  expect(builder("goal.create", CALLER).ok).toBe(false);
});

it("builds a query envelope without authority fields and omits absent optionals", () => {
  const envelope = GENERATED_QUERY_BUILDERS["goal.get"]({
    correlationId: "corr-0002",
    payload: { goalId: "goal-0001" },
    sessionCredential: "sess-0001",
  });
  expect(envelope).toEqual({
    correlationId: "corr-0002",
    payload: { goalId: "goal-0001" },
    queryKind: "goal.get",
    schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    sessionCredential: "sess-0001",
  });
  expect(Object.keys(envelope)).not.toContain("cursor");
  expect(Object.isFrozen(envelope)).toBe(true);
});

it("carries the optional query cursor and target when supplied", () => {
  const envelope = GENERATED_QUERY_BUILDERS["events.read"]({
    correlationId: "corr-0003",
    cursor: "cursor-9",
    payload: {},
    sessionCredential: "sess-0001",
    targetAggregateId: "goal-0001",
  });
  expect(envelope.cursor).toBe("cursor-9");
  expect(envelope.targetAggregateId).toBe("goal-0001");
});
