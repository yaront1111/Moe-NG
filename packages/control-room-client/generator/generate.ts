import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_AGGREGATES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_LIFECYCLES,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  RUNTIME_SAFE_DETAIL_KEYS,
  RUNTIME_TELEMETRY_KINDS,
  lookupRuntimeError,
} from "@moe/contracts";
import type { RuntimeAggregate, RuntimeErrorCode } from "@moe/contracts";

const OUTPUT_FILE = "generated-client.ts";
const LF = "\n";

const lit = (value: string): string => JSON.stringify(value);
const sortedCopy = <T extends string>(values: readonly T[]): readonly T[] => [...values].sort();

/**
 * Canonical serialization of the RUNTIME-ENUMERABLE contract surface. Key order is
 * fixed by construction and every list is sorted, so the digest is a pure function of
 * the registry. It deliberately does NOT cover envelope key arrays: those are
 * module-private in `@moe/contracts`, so envelope-shape drift is invisible here and is
 * caught instead by the emitted type-level exhaustive-key assertions.
 */
function canonicalSurface(): string {
  const lifecycles: Record<string, readonly string[]> = {};
  for (const aggregate of sortedCopy(Object.keys(RUNTIME_LIFECYCLES) as RuntimeAggregate[])) {
    lifecycles[aggregate] = RUNTIME_LIFECYCLES[aggregate];
  }
  return JSON.stringify({
    aggregates: sortedCopy(RUNTIME_AGGREGATES),
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandKinds: sortedCopy(RUNTIME_COMMAND_KINDS),
    errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
    errors: sortedCopy(RUNTIME_ERROR_CODES).map((code) => lookupRuntimeError(code)),
    lifecycles,
    limits: {
      maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
      maxJsonDepth: MAX_JSON_DEPTH,
      maxJsonStringUtf8Bytes: MAX_JSON_STRING_UTF8_BYTES,
    },
    queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    queryKinds: sortedCopy(RUNTIME_QUERY_KINDS),
    safeDetailKeys: sortedCopy(RUNTIME_SAFE_DETAIL_KEYS),
    telemetryKinds: sortedCopy(RUNTIME_TELEMETRY_KINDS),
  });
}

const HEADER = `// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: the @moe/contracts runtime registry (packages/contracts/src/runtime).
// Regenerate with: pnpm --filter @moe/control-room-client generate
//
// Honesty boundaries, stated so no reader credits this file with more authority than
// it has:
//  1. Command builders are AFFORDANCE-ANCHORED. Every identity field (commandId,
//     expectedVersion, targetAggregateId, leaseAuthority, graphRevisionHash,
//     policyRevisionHash) is COPIED from a daemon-supplied NextAllowedCommand. No
//     builder synthesizes one, no raw-field builder exists on this surface, and the
//     surface itself is reachable only through a matching compatibility gate (design
//     section 90; control-room spec CR-CMD-001). Residual, stated plainly rather than
//     claimed away: NextAllowedCommand is a structural type, so TypeScript cannot
//     prove a given affordance came from buildNextAllowedCommands. A caller that
//     hand-authors one gets an envelope the daemon refuses on its own checks. This
//     layer removes the mint path; it is not the authority.
//  2. Payloads stay JsonObject. No per-kind payload schema exists in the contract, and
//     NextAllowedCommand.inputSchemaVersion is an opaque daemon-supplied string, so
//     generating per-kind payload types would invent a contract that does not exist.
//  3. Caller-supplied fields (correlationId, sessionCredential, requestDigest) are
//     passed through unvalidated. The daemon's envelope decoder is the single
//     authority on field validity; re-validating here would be a competing validator.
//  4. contractDigest covers only the RUNTIME-ENUMERABLE surface. The envelope
//     required/optional key arrays are module-private in @moe/contracts, so the digest
//     CANNOT see envelope-shape drift. The exhaustive-key assertions below are the
//     compensating tripwire: they break typecheck loudly if an envelope interface
//     changes.
//  5. No event-stream frame vocabulary is generated. Cursor/resume semantics are TBD
//     (control-room spec section 13-D3) and no domain-event type exists in the
//     contract; inventing a frame shape would create a second competing vocabulary.

import type {
  JsonObject,
  NextAllowedCommand,
  RuntimeCommandEnvelope,
  RuntimeCommandKind,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeErrorDescriptor,
  RuntimeQueryEnvelope,
  RuntimeQueryKind,
} from "@moe/contracts";
import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_TELEMETRY_KINDS,
  createRuntimeError,
} from "@moe/contracts";

/** One daemon-issued mutation affordance, narrowed to a single command kind. */
export type CommandAffordance<K extends RuntimeCommandKind> = NextAllowedCommand & {
  readonly commandKind: K;
};

/** The only fields a caller may contribute to a command. Identity is never among them. */
export interface CommandCallerInput {
  readonly correlationId: string;
  readonly payload: JsonObject;
  readonly requestDigest: string;
  readonly sessionCredential: string;
}

export type CommandBuildResult =
  | { readonly envelope: RuntimeCommandEnvelope; readonly ok: true }
  | { readonly error: RuntimeError; readonly ok: false };

export type CommandBuilder<K extends RuntimeCommandKind> = (
  affordance: CommandAffordance<K>,
  caller: CommandCallerInput,
) => CommandBuildResult;

/** Queries carry no authority, so they need no affordance and cannot fail closed. */
export interface QueryCallerInput {
  readonly correlationId: string;
  readonly cursor?: string;
  readonly payload: JsonObject;
  readonly sessionCredential: string;
  readonly targetAggregateId?: string;
}

export type QueryEnvelopeFor<K extends RuntimeQueryKind> = RuntimeQueryEnvelope & {
  readonly queryKind: K;
};

export type QueryBuilder<K extends RuntimeQueryKind> = (
  caller: QueryCallerInput,
) => QueryEnvelopeFor<K>;

export const COMMAND_ENVELOPE_KEYS = Object.freeze([
  "commandId", "commandKind", "correlationId", "expectedVersion", "graphRevisionHash",
  "leaseAuthority", "payload", "policyRevisionHash", "requestDigest", "schemaVersion",
  "sessionCredential", "targetAggregateId",
] as const) satisfies readonly (keyof RuntimeCommandEnvelope)[];

export const QUERY_ENVELOPE_KEYS = Object.freeze([
  "correlationId", "cursor", "payload", "queryKind", "schemaVersion", "sessionCredential",
  "targetAggregateId",
] as const) satisfies readonly (keyof RuntimeQueryEnvelope)[];

type AssertNever<T extends never> = T;
type CommandKeyDrift = Exclude<
  keyof RuntimeCommandEnvelope,
  (typeof COMMAND_ENVELOPE_KEYS)[number]
>;
type QueryKeyDrift = Exclude<keyof RuntimeQueryEnvelope, (typeof QUERY_ENVELOPE_KEYS)[number]>;

/** Compile-time tripwires for boundary 4. A new envelope key breaks these first. */
export type CommandEnvelopeKeyCoverage = AssertNever<CommandKeyDrift>;
export type QueryEnvelopeKeyCoverage = AssertNever<QueryKeyDrift>;

const AFFORDANCE_REQUIRED_ERROR: RuntimeError = createRuntimeError({ code: "INPUT_INVALID" });

function isAffordanceFor(kind: RuntimeCommandKind, value: unknown): value is NextAllowedCommand {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)["commandKind"] === kind;
}

function commandBuilderFor<K extends RuntimeCommandKind>(kind: K): CommandBuilder<K> {
  return (affordance, caller) => {
    if (!isAffordanceFor(kind, affordance)) {
      return Object.freeze({ error: AFFORDANCE_REQUIRED_ERROR, ok: false as const });
    }
    const draft: Record<string, unknown> = {
      commandId: affordance.commandId,
      commandKind: affordance.commandKind,
      correlationId: caller.correlationId,
      expectedVersion: affordance.expectedVersion,
      payload: caller.payload,
      requestDigest: caller.requestDigest,
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: caller.sessionCredential,
      targetAggregateId: affordance.targetAggregateId,
    };
    if (affordance.graphRevisionHash !== undefined) {
      draft["graphRevisionHash"] = affordance.graphRevisionHash;
    }
    if (affordance.leaseAuthority !== undefined) {
      draft["leaseAuthority"] = affordance.leaseAuthority;
    }
    if (affordance.policyRevisionHash !== undefined) {
      draft["policyRevisionHash"] = affordance.policyRevisionHash;
    }
    return Object.freeze({
      envelope: Object.freeze(draft) as unknown as RuntimeCommandEnvelope,
      ok: true as const,
    });
  };
}

function queryBuilderFor<K extends RuntimeQueryKind>(kind: K): QueryBuilder<K> {
  return (caller) => {
    const draft: Record<string, unknown> = {
      correlationId: caller.correlationId,
      payload: caller.payload,
      queryKind: kind,
      schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      sessionCredential: caller.sessionCredential,
    };
    if (caller.cursor !== undefined) draft["cursor"] = caller.cursor;
    if (caller.targetAggregateId !== undefined) {
      draft["targetAggregateId"] = caller.targetAggregateId;
    }
    return Object.freeze(draft) as unknown as QueryEnvelopeFor<K>;
  };
}

function frozenRow(row: RuntimeErrorDescriptor): RuntimeErrorDescriptor {
  Object.freeze(row.recoveryCommands);
  Object.freeze(row.requiredDetailKeys);
  Object.freeze(row.transport);
  Object.freeze(row.validSources);
  return Object.freeze(row);
}
`;

function commandSection(kinds: readonly string[]): readonly string[] {
  const lines = ["export interface GeneratedCommandBuilders {"];
  for (const kind of kinds) lines.push(`  readonly [${lit(kind)}]: CommandBuilder<${lit(kind)}>;`);
  lines.push("}", "", "export const GENERATED_COMMAND_BUILDERS: GeneratedCommandBuilders =");
  lines.push("  Object.freeze({");
  for (const kind of kinds) lines.push(`    [${lit(kind)}]: commandBuilderFor(${lit(kind)}),`);
  lines.push("  });", "");
  return lines;
}

function querySection(kinds: readonly string[]): readonly string[] {
  const lines = ["export interface GeneratedQueryBuilders {"];
  for (const kind of kinds) lines.push(`  readonly [${lit(kind)}]: QueryBuilder<${lit(kind)}>;`);
  lines.push("}", "", "export const GENERATED_QUERY_BUILDERS: GeneratedQueryBuilders = Object.freeze({");
  for (const kind of kinds) lines.push(`  [${lit(kind)}]: queryBuilderFor(${lit(kind)}),`);
  lines.push("});", "");
  return lines;
}

function stringList(values: readonly string[]): string {
  return values.length === 0 ? "[]" : `[${values.map(lit).join(", ")}]`;
}

function errorRow(code: RuntimeErrorCode): readonly string[] {
  const row = lookupRuntimeError(code);
  return [
    `  ${lit(code)}: frozenRow({`,
    `    code: ${lit(row.code)},`,
    `    recoveryCategory: ${lit(row.recoveryCategory)},`,
    `    recoveryCommands: ${stringList(row.recoveryCommands)},`,
    `    requiredDetailKeys: ${stringList(row.requiredDetailKeys)},`,
    `    retryability: ${lit(row.retryability)},`,
    `    transport: { category: ${lit(row.transport.category)},`,
    `      httpStatus: ${String(row.transport.httpStatus)},`,
    `      mcpCode: ${String(row.transport.mcpCode)} },`,
    `    truthClass: ${lit(row.truthClass)},`,
    `    validSources: ${stringList(row.validSources)},`,
    "  }),",
  ];
}

function errorSection(codes: readonly RuntimeErrorCode[]): readonly string[] {
  const lines = [
    "/** Every stable error code, projected from the registry at generation time. */",
    "export type GeneratedErrorTable = Readonly<Record<RuntimeErrorCode, RuntimeErrorDescriptor>>;",
    "",
    "export const GENERATED_ERROR_TABLE: GeneratedErrorTable = Object.freeze({",
  ];
  for (const code of codes) lines.push(...errorRow(code));
  lines.push("});", "");
  return lines;
}

function pinSection(digest: string): readonly string[] {
  return [
    "/**",
    " * Telemetry vocabulary, re-exported verbatim (boundary 5: no stream frame types).",
    " */",
    "export const GENERATED_TELEMETRY_KINDS = RUNTIME_TELEMETRY_KINDS;",
    "",
    "export interface GeneratedContractPins {",
    "  readonly commandEnvelopeVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;",
    "  readonly contractDigest: string;",
    "  readonly errorRegistryVersion: typeof RUNTIME_ERROR_REGISTRY_VERSION;",
    "  readonly queryEnvelopeVersion: typeof RUNTIME_QUERY_ENVELOPE_VERSION;",
    "}",
    "",
    `export const GENERATED_CONTRACT_DIGEST = ${lit(digest)};`,
    "",
    "export const GENERATED_CONTRACT_PINS: GeneratedContractPins = Object.freeze({",
    "  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,",
    "  contractDigest: GENERATED_CONTRACT_DIGEST,",
    "  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,",
    "  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,",
    "});",
  ];
}

/** Pure function of the registry: sorted iteration, no clock, no randomness, LF only. */
export function renderGeneratedClient(): string {
  const digest = createHash("sha256").update(canonicalSurface(), "utf8").digest("hex");
  const body = [
    ...commandSection(sortedCopy(RUNTIME_COMMAND_KINDS)),
    ...querySection(sortedCopy(RUNTIME_QUERY_KINDS)),
    ...errorSection([...sortedCopy(RUNTIME_ERROR_CODES)]),
    ...pinSection(digest),
  ];
  return `${HEADER}${LF}${body.join(LF)}${LF}`;
}

export function emitGeneratedClient(outDir: string): readonly string[] {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, OUTPUT_FILE), renderGeneratedClient(), "utf8");
  return Object.freeze([OUTPUT_FILE]);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL("../src/generated/", import.meta.url));
  for (const name of emitGeneratedClient(target)) process.stdout.write(`${join(target, name)}${LF}`);
}
