/**
 * The generated subject-by-case matrix, as DATA. No spawning, no assertions.
 *
 * EVERY EXPECTED CODE, STAGE AND LAYER IS PINNED AGAINST ITS OWNING PACKAGE'S
 * FROZEN VOCABULARY at module load, through `pin`. A code spelled here that
 * production no longer publishes throws while this module is being imported, so
 * the whole suite reddens instead of quietly asserting a code nothing emits.
 *
 * `pin` is deliberately stronger than reading the name out of the vocabulary by
 * index. An index lookup is a tautology: rename the production code and both
 * operands move together, and the test stays green. Naming the code AND
 * requiring the owning package to still publish it catches the rename.
 *
 * The transport half is a genuine product — TRANSPORT_SUBJECTS x TRANSPORT_ARMS
 * — so `CASES.length` is a count of generated cases rather than a hand-written
 * list, and a generator that produced nothing would be visible rather than green.
 */

import {
  HTTP_BOUNDARY_ERROR_CODES,
  HTTP_REFUSAL_STAGES,
  PREREQUISITE_REFUSAL_CODES,
  SERVICE_REFUSED_BY,
} from "@moe/daemon";
import {
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_REFUSAL_REASONS,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  distributionRefusal,
} from "@moe/contracts";
import type { DistributionApiRange, DistributionRefusal } from "@moe/contracts";
import { STDIO_TOOL_INDEX, toolLabelForKind } from "@moe/mcp";
import { IdempotencyConflictError } from "@moe/store";

export type Subject = "HTTP" | "JETBRAINS" | "STDIO";
export type TransportSubject = Exclude<Subject, "JETBRAINS">;

export const SUBJECTS: readonly Subject[] = Object.freeze(["STDIO", "HTTP", "JETBRAINS"] as const);
export const TRANSPORT_SUBJECTS: readonly TransportSubject[] = Object.freeze([
  "STDIO",
  "HTTP",
] as const);

/**
 * Fails closed at import time when `name` is no longer published by `owner`.
 * `where` names the owning package so the throw says which vocabulary drifted.
 */
export function pin<T extends string>(name: T, owner: readonly string[], where: string): T {
  if (!owner.includes(name)) {
    throw new Error(`portability matrix: ${where} no longer publishes ${name}`);
  }
  return name;
}

/** Codes, stages and layers, each pinned against the package that owns it. */
export const CODES = Object.freeze({
  authenticationFailed: pin("AUTHENTICATION_FAILED", HTTP_BOUNDARY_ERROR_CODES, "@moe/daemon"),
  capabilityDenied: pin("CAPABILITY_DENIED", HTTP_BOUNDARY_ERROR_CODES, "@moe/daemon"),
  commandIdReused: pin("BOOTSTRAP_COMMAND_ID_REUSED", PREREQUISITE_REFUSAL_CODES, "@moe/daemon"),
  distributionMismatch: distributionRefusal(
    pin("API_RANGE_MISMATCH", DISTRIBUTION_REFUSAL_REASONS, "@moe/contracts"),
    "DISTRIBUTION_STARTUP",
  ).code,
  inputInvalid: pin("INPUT_INVALID", HTTP_BOUNDARY_ERROR_CODES, "@moe/daemon"),
  /**
   * The store's OWN conflict code, imported from the class that raises it. The
   * matrix asserts this is NOT what answers a reused command id: the daemon's
   * ledger short-circuits on the stored decision before the store's request-bytes
   * guard is ever consulted, so naming the wrong layer here would be a lie.
   */
  storeIdempotencyConflict: new IdempotencyConflictError({
    commandId: "pin",
    principalId: "pin",
    projectId: "pin",
  }).code,
});

export const STAGES = Object.freeze({
  authorize: pin("AUTHORIZE", HTTP_REFUSAL_STAGES, "@moe/daemon"),
  dispatch: pin("DISPATCH", HTTP_REFUSAL_STAGES, "@moe/daemon"),
});

export const LAYERS = Object.freeze({
  daemonPrerequisite: pin("DAEMON_PREREQUISITE", SERVICE_REFUSED_BY, "@moe/daemon"),
  durableStore: pin("DURABLE_STORE", SERVICE_REFUSED_BY, "@moe/store via @moe/daemon"),
});

/** MCP JSON-RPC transport codes. -32601 is the SDK's own "method not found". */
export const MCP_CODES = Object.freeze({
  forbidden: -32_002,
  invalidParams: -32_602,
  methodNotFound: -32_601,
  unauthenticated: -32_001,
});

/**
 * Which layer answered. This IS the assertion, not decoration.
 *
 * ADAPTER_DECODE  the MCP adapter's own bounded decode / tool-index lookup
 * ADAPTER_AUTH    the MCP adapter's authenticate call, after its decode
 * HTTP_SESSION_SCREEN  the HTTP bearer screen, which runs before a body is read
 * DAEMON_SEAM     handleCommandRequest, i.e. registry payload authority
 * MCP_SDK         the SDK's own JSON-RPC method table
 */
export type Answerer =
  | "ADAPTER_AUTH"
  | "ADAPTER_DECODE"
  | "DAEMON_SEAM"
  | "HTTP_SESSION_SCREEN"
  | "MCP_SDK";

export interface TransportArm {
  readonly armId: string;
  /** null when the transport answers with silence rather than a frame. */
  readonly expectedCode: string | null;
  /**
   * The refusal is expected here. stdio and HTTP legitimately DIFFER: the stdio
   * adapter decodes the envelope it built before it authenticates, while the HTTP
   * adapter screens the bearer before it reads the body at all. Both are measured.
   */
  readonly expectedAnswerer: Readonly<Record<TransportSubject, Answerer>>;
  readonly expectedCodeBySubject?: Readonly<Record<TransportSubject, string | null>>;
  /** Refusal and read-only arms must leave decision and event counts untouched. */
  readonly mutatesStore: boolean;
}

const ADAPTER_OR_SCREEN: Readonly<Record<TransportSubject, Answerer>> = Object.freeze({
  HTTP: "HTTP_SESSION_SCREEN",
  STDIO: "ADAPTER_DECODE",
});

const AUTH_OR_SCREEN: Readonly<Record<TransportSubject, Answerer>> = Object.freeze({
  HTTP: "HTTP_SESSION_SCREEN",
  STDIO: "ADAPTER_AUTH",
});

const BOTH_ADAPTER_DECODE: Readonly<Record<TransportSubject, Answerer>> = Object.freeze({
  HTTP: "ADAPTER_DECODE",
  STDIO: "ADAPTER_DECODE",
});

const BOTH_DAEMON_SEAM: Readonly<Record<TransportSubject, Answerer>> = Object.freeze({
  HTTP: "DAEMON_SEAM",
  STDIO: "DAEMON_SEAM",
});

const BOTH_SDK: Readonly<Record<TransportSubject, Answerer>> = Object.freeze({
  HTTP: "MCP_SDK",
  STDIO: "MCP_SDK",
});

/**
 * The refusal arms, one row per behaviour. `accepted-control` is first on
 * purpose: without a case that can succeed, a suite in which nothing can ever
 * succeed would still report every refusal below correctly.
 */
export const TRANSPORT_ARMS: readonly TransportArm[] = Object.freeze([
  {
    armId: "accepted-control",
    expectedAnswerer: BOTH_DAEMON_SEAM,
    expectedCode: "EFFECTS_COMMITTED",
    mutatesStore: true,
  },
  {
    armId: "malformed-envelope",
    expectedAnswerer: BOTH_ADAPTER_DECODE,
    expectedCode: CODES.inputInvalid,
    mutatesStore: false,
  },
  {
    armId: "unknown-tool-label",
    expectedAnswerer: BOTH_ADAPTER_DECODE,
    expectedCode: CODES.inputInvalid,
    mutatesStore: false,
  },
  {
    armId: "wrong-credential",
    expectedAnswerer: AUTH_OR_SCREEN,
    expectedCode: CODES.authenticationFailed,
    mutatesStore: false,
  },
  {
    // Invalid at TWO layers at once. The answer differs by transport and that
    // difference is the finding: stdio decodes before it authenticates, HTTP
    // screens the bearer before it reads a byte of body.
    armId: "wrong-credential-and-malformed",
    expectedAnswerer: ADAPTER_OR_SCREEN,
    expectedCode: null,
    expectedCodeBySubject: Object.freeze({
      HTTP: CODES.authenticationFailed,
      STDIO: CODES.inputInvalid,
    }),
    mutatesStore: false,
  },
  {
    armId: "capability-scope-denied",
    expectedAnswerer: BOTH_DAEMON_SEAM,
    expectedCode: CODES.capabilityDenied,
    mutatesStore: false,
  },
  {
    armId: "unsupported-method",
    expectedAnswerer: BOTH_SDK,
    expectedCode: null,
    mutatesStore: false,
  },
  {
    armId: "truncation-disconnect",
    expectedAnswerer: BOTH_ADAPTER_DECODE,
    expectedCode: null,
    mutatesStore: false,
  },
  {
    armId: "replay-conflict",
    expectedAnswerer: BOTH_DAEMON_SEAM,
    expectedCode: CODES.commandIdReused,
    mutatesStore: false,
  },
]);

export interface MatrixCase {
  readonly armId: string;
  readonly caseId: string;
  readonly subject: Subject;
}

/** The JetBrains arms map 1:1 onto the host's real four-port surface. */
export const JETBRAINS_ARMS: readonly string[] = Object.freeze([
  "distribution-discovery-match",
  "distribution-mismatch",
  "daemon-probe-not-listening",
  "daemon-start",
  "endpoint-open",
  "control-room-open",
  "reconnect",
  "uninstall",
  "post-uninstall-call",
  "no-command-method",
]);

function generateCases(): readonly MatrixCase[] {
  const generated: MatrixCase[] = [];
  for (const subject of TRANSPORT_SUBJECTS) {
    for (const arm of TRANSPORT_ARMS) {
      generated.push(Object.freeze({ armId: arm.armId, caseId: `${subject}:${arm.armId}`, subject }));
    }
  }
  for (const armId of JETBRAINS_ARMS) {
    generated.push(Object.freeze({ armId, caseId: `JETBRAINS:${armId}`, subject: "JETBRAINS" }));
  }
  return Object.freeze(generated);
}

export const CASES: readonly MatrixCase[] = generateCases();

/**
 * The exact IDE-layer outcome each JetBrains arm must produce. The names are
 * spelled here and pinned AT RUNTIME against `IDE_ADAPTER_REASON_CODES` /
 * `IDE_ADAPTER_LAYERS`, read out of `@moe/ide-adapter-contract` in a child
 * process — that package is not a root dependency, so this is the only way its
 * frozen vocabulary reaches the suite. Pinning still catches a production rename.
 */
export const JETBRAINS_EXPECTED = Object.freeze({
  "control-room-open": { code: "CONTROL_ROOM_BROWSER_FALLBACK", layer: null, outcome: "OK" },
  "control-room-assets-missing": {
    code: "CONTROL_ROOM_ASSETS_MISSING",
    layer: "CONTROL_ROOM_OPEN_PORT",
    outcome: "REFUSED",
  },
  "daemon-start": { code: "DAEMON_START_REFUSED", layer: "DAEMON_START_PORT", outcome: "REFUSED" },
  reconnect: { code: "CONTROL_ROOM_BROWSER_FALLBACK", layer: null, outcome: "OK" },
} as const);

/** The exact four keys `JetBrainsHost` publishes. There is no command method. */
export const JETBRAINS_HOST_KEYS: readonly string[] = Object.freeze([
  "endpoint",
  "reconnect",
  "start",
  "uninstall",
]);

/**
 * MCP command translation for JetBrains is UNKNOWN by construction, not by
 * omission: `JetBrainsHost` exposes no command method, so there is nothing to
 * translate. Task rail 2 forbids asserting command identity for JetBrains at all.
 */
export const JETBRAINS_MCP_TRANSLATION = "UNKNOWN" as const;

/** The command this matrix drives. Its label comes from the generator, never by hand. */
export const CONTROL_COMMAND_KIND = "project.register";
export const CONTROL_TOOL_LABEL = toolLabelForKind(CONTROL_COMMAND_KIND);
export const CONFLICT_TOOL_LABEL = toolLabelForKind("provider.probe");
export const SESSION_TOOL_LABEL = toolLabelForKind("session.open");

/** A label the generator did not produce, so `tools/list` cannot contain it. */
export const UNKNOWN_TOOL_LABEL = "not_a_generated_tool";

export function toolEntryExists(label: string): boolean {
  return STDIO_TOOL_INDEX.get(label) !== undefined;
}

export interface CommandArguments {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetAggregateId: string;
}

export function registerArguments(
  commandId: string,
  projectId: string,
  owner = "operator-local",
): CommandArguments {
  return Object.freeze({
    commandId,
    correlationId: `corr-${commandId}`,
    expectedVersion: 0,
    payload: Object.freeze({ owner }),
    targetAggregateId: projectId,
  });
}

/**
 * The api range a JetBrains distribution must match. Built from the contract's
 * own pinned versions so a bumped envelope version moves both the fixture and the
 * expectation together, which is what makes the MISMATCH arm a real mismatch.
 */
export const MATCHING_API_RANGE: DistributionApiRange = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
});

export const MISMATCHED_API_RANGE: DistributionApiRange = Object.freeze({
  ...MATCHING_API_RANGE,
  commandEnvelopeVersion: `${RUNTIME_COMMAND_ENVELOPE_VERSION}-not-this-build`,
});

/** A shape-complete manifest: every key the gate requires, and nothing invented. */
export function manifestFor(
  componentKind: string,
  apiCompatibilityRange: DistributionApiRange,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    aggregateDigest: "0".repeat(64),
    apiCompatibilityRange,
    assets: [],
    buildToolVersions: {},
    builtInSkills: [],
    componentId: `component-${componentKind.toLowerCase()}`,
    componentKind,
    contractSchemaHash: "0".repeat(64),
    instructionTemplates: [],
    manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
    signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
    signingKeyId: "portability-matrix-key",
    source: { objectFormat: "sha256", sourceSha: "0".repeat(64) },
  });
}

/** The two kinds a JetBrains session cannot run without, drawn from the frozen set. */
export const REQUIRED_DISTRIBUTION_KINDS: readonly string[] = Object.freeze(
  DISTRIBUTION_COMPONENT_KINDS.filter((kind) => kind === "CONTROL_ROOM" || kind === "DAEMON"),
);

/** The exact refusal the gate must produce, built by calling production itself. */
export function expectedDistributionRefusal(): DistributionRefusal {
  return distributionRefusal("API_RANGE_MISMATCH", "DISTRIBUTION_STARTUP");
}
