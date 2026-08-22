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
import { DISTRIBUTION_REFUSAL_REASONS, distributionRefusal } from "@moe/contracts";
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

/**
 * Which layer answered. This IS the assertion, not decoration.
 *
 * ADAPTER_DECODE  the MCP adapter's own bounded decode / tool-index lookup
 * ADAPTER_AUTH    the MCP adapter's authenticate call, after its decode
 * HTTP_SESSION_SCREEN  the HTTP bearer screen, which runs before a body is read
 * DAEMON_SEAM     handleCommandRequest, i.e. registry payload authority
 * MCP_SDK         the SDK's own JSON-RPC method table
 * NO_ANSWER       the transport answered with silence and wrote nothing
 */
export type Answerer =
  | "ADAPTER_AUTH"
  | "ADAPTER_DECODE"
  | "DAEMON_SEAM"
  | "HTTP_SESSION_SCREEN"
  | "MCP_SDK"
  | "NO_ANSWER";

/** The only `stage` a truncated frame may record: silence AND an untouched store. */
export const TRUNCATED_NO_WRITE = "TRUNCATED_NO_WRITE" as const;

export interface TransportArm {
  readonly armId: string;
  /**
   * Where the refusal is expected. stdio and HTTP legitimately DIFFER: stdio
   * decodes the envelope it built before it authenticates, HTTP screens the
   * bearer before it reads a byte of body. Both measured, neither assumed.
   */
  readonly expectedAnswerer: Readonly<Record<TransportSubject, Answerer>>;
  /** null when the transport answers with silence rather than a coded frame. */
  readonly expectedCode: string | null;
  /** Set only where the two transports answer with different codes. */
  readonly expectedCodeBySubject?: Readonly<Record<TransportSubject, string | null>>;
}

const at = (
  stdio: Answerer,
  http: Answerer,
): Readonly<Record<TransportSubject, Answerer>> => Object.freeze({ HTTP: http, STDIO: stdio });

const arm = (
  armId: string,
  expectedAnswerer: Readonly<Record<TransportSubject, Answerer>>,
  expectedCode: string | null,
  expectedCodeBySubject?: Readonly<Record<TransportSubject, string | null>>,
): TransportArm =>
  Object.freeze({
    armId,
    expectedAnswerer,
    expectedCode,
    ...(expectedCodeBySubject === undefined ? {} : { expectedCodeBySubject }),
  });

/**
 * One row per behaviour. `accepted-control` is FIRST on purpose: without a case
 * that can succeed, a suite in which nothing can ever succeed would still report
 * every refusal below correctly.
 */
export const TRANSPORT_ARMS: readonly TransportArm[] = Object.freeze([
  arm("accepted-control", at("DAEMON_SEAM", "DAEMON_SEAM"), "EFFECTS_COMMITTED"),
  arm("malformed-envelope", at("ADAPTER_DECODE", "ADAPTER_DECODE"), CODES.inputInvalid),
  arm("unknown-tool-label", at("ADAPTER_DECODE", "ADAPTER_DECODE"), CODES.inputInvalid),
  arm("wrong-credential", at("ADAPTER_AUTH", "HTTP_SESSION_SCREEN"), CODES.authenticationFailed),
  // Invalid at TWO layers at once, and the per-transport difference IS the finding.
  arm("wrong-credential-and-malformed", at("ADAPTER_DECODE", "HTTP_SESSION_SCREEN"), null,
    Object.freeze({ HTTP: CODES.authenticationFailed, STDIO: CODES.inputInvalid })),
  arm("capability-scope-denied", at("DAEMON_SEAM", "DAEMON_SEAM"), CODES.capabilityDenied),
  arm("unsupported-method", at("MCP_SDK", "MCP_SDK"), null),
  arm("truncation-disconnect", at("NO_ANSWER", "NO_ANSWER"), null),
  arm("replay-conflict", at("DAEMON_SEAM", "DAEMON_SEAM"), CODES.commandIdReused),
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

/**
 * A session aggregate is independent of the project's bootstrap sequence, so this
 * commits at expectedVersion 0 for every fresh `sessionId`. That is what makes it
 * usable for the reversed-order identity pair, where `project.register` cannot be
 * replayed a second time: its aggregate has already moved past version 0.
 */
export function sessionArguments(
  commandId: string,
  sessionId: string,
  credentialSha256: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandId,
    correlationId: `corr-${commandId}`,
    expectedVersion: 0,
    payload: Object.freeze({
      capabilities: ["work.write"],
      credentialSha256,
      expiresAt: "2099-01-01T00:00:00.000Z",
      sessionId,
    }),
    targetAggregateId: sessionId,
  });
}

export function registerArguments(
  commandId: string,
  projectId: string,
  owner = "operator-local",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandId,
    correlationId: `corr-${commandId}`,
    expectedVersion: 0,
    payload: Object.freeze({ owner }),
    targetAggregateId: projectId,
  });
}

export function jetBrainsProbeSource(): string {
  return `
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJetBrainsHost } from "@moe/jetbrains-adapter/host";
import { DISTRIBUTION_MANIFEST_VERSION, DISTRIBUTION_SIGNATURE_ALGORITHM,
  RUNTIME_COMMAND_ENVELOPE_VERSION, RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION } from "@moe/contracts";

const range = { commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION };
const manifest = (kind) => ({ aggregateDigest: "0".repeat(64), apiCompatibilityRange: range,
  assets: [], buildToolVersions: {}, builtInSkills: [], componentId: "component-" + kind,
  componentKind: kind, contractSchemaHash: "0".repeat(64), instructionTemplates: [],
  manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
  signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM, signingKeyId: "portability-matrix-key",
  source: { objectFormat: "sha256", sourceSha: "0".repeat(64) } });

// The child owns its own listener and its own free-port probe, and closes both.
const listener = createServer((_r, response) => { response.statusCode = 401; response.end(); });
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const livePort = listener.address().port;
const scratch = createServer();
await new Promise((done) => scratch.listen(0, "127.0.0.1", done));
const deadPort = scratch.address().port;
await new Promise((done) => scratch.close(done));

const directory = mkdtempSync(join(tmpdir(), "jetbrains probe-"));
const installRoot = join(directory, "install");
mkdirSync(installRoot);
const assetPath = join(directory, "control room.html");
writeFileSync(assetPath, "<html></html>");
writeFileSync(join(installRoot, "CONTROL_ROOM.json"), JSON.stringify(manifest("CONTROL_ROOM")));
writeFileSync(join(installRoot, "DAEMON.json"), JSON.stringify(manifest("DAEMON")));

const openedTargets = [];
// A command that cannot launch ANYWHERE, so the dead-endpoint arm below
// refuses for the same stated reason on every host. Pointing this at the real
// bin shim made the arm platform-dependent: on Windows node refuses to spawn a
// .CMD without a shell, which is a launch REFUSAL, while on linux and macOS the
// shim launches fine, nothing ever confirms listening, and the arm degrades to
// LAUNCHED_UNCONFIRMED -> DAEMON_START_UNVERIFIED. It also left a detached
// daemon behind on those runners. Only this dead host ever launches: every
// other arm reconnects to the live listener or refuses at distribution.
const absentDaemon = join(directory, "absent-daemon");
const base = { apiCompatibilityRange: range, controlRoomAssetPath: assetPath,
  controlRoomOpenTimeoutMs: 4000, daemonArgs: [],
  daemonCommand: absentDaemon,
  endpoint: "http://127.0.0.1:" + livePort, installRoot,
  opener: async (target) => { openedTargets.push(target); },
  probeTimeoutMs: 3000, startConfirmIntervalMs: 100, startConfirmTimeoutMs: 1200 };

const report = {};
const live = createJetBrainsHost(base);
report.hostKeys = Object.keys(live).sort();
report.reconnect = await live.reconnect();
report.endpointLive = live.endpoint();
report.openedAfterReconnect = openedTargets.length;
live.uninstall();
report.endpointAfterUninstall = live.endpoint();
// A resurrected session would answer from its cached endpoint without firing the
// opener again, so the SECOND opener call is what proves the drop was real.
report.postUninstall = await live.start();
report.openedAfterPostUninstall = openedTargets.length;
report.postUninstallEndpoint = live.endpoint();

const dead = createJetBrainsHost({ ...base, endpoint: "http://127.0.0.1:" + deadPort });
report.startDead = await dead.start();
report.endpointAfterStartRefused = dead.endpoint();
const mismatched = createJetBrainsHost({ ...base,
  apiCompatibilityRange: { ...range, commandEnvelopeVersion: range.commandEnvelopeVersion + "-x" } });
report.mismatch = await mismatched.start();
const noAssets = createJetBrainsHost({ ...base, controlRoomAssetPath: join(directory, "gone.html") });
report.assetsMissing = await noAssets.reconnect();
const emptyRoot = createJetBrainsHost({ ...base, installRoot: join(directory, "absent") });
report.emptyRoot = await emptyRoot.reconnect();

await new Promise((done) => listener.close(done));
rmSync(directory, { force: true, recursive: true });
process.stdout.write(JSON.stringify(report));
`;
}
