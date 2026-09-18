import { win32 } from "node:path";

import { snapshotExactRecord } from "../platform-contract.js";
import { CANCEL_GRACE_MS } from "./windows-boundary.js";
import type { WindowsProcessBoundary } from "./windows-boundary-session.js";
import { driveBrokerBoundary } from "./windows-boundary-driver.js";
import { resolveBrokerBinary } from "./windows-broker-path.js";
import { spawnBroker, type BrokerSpawn } from "./windows-broker-process.js";
import { CHANNEL_PAYLOAD_CAPS, encodeFrame } from "./windows-frames.js";
import {
  ALLOWED_ENVIRONMENT_KEYS,
  encodeLaunchPayloadWithAllowedEnvironment,
} from "./windows-launch-request.js";
import { isBoundedText, isLocalAbsolutePath } from "./windows-path-guard.js";
import { unknownOutcome, type WindowsProcessUnknown } from "./windows-process-contract.js";

/**
 * Environment carried to the stack host, not to an agent process directly.
 * The ordinary provider boundary keeps its smaller roster unchanged. A stack
 * host needs Moe's own bindings and exactly the provider credentials accepted
 * by `moe start`; script-injection variables remain absent.
 *
 * CLAUDE_CONFIG_DIR is the claude sign-in's relocation directory, the analogue
 * of CODEX_HOME below. Provider-scoped on purpose: the launch snapshot strips it
 * and re-adds it only from the selected provider's overlay, so a codex launch
 * never carries a claude directory. Absent from this roster, a relocated
 * sign-in was refused MOE_UP_ENV_MISSING and a defaulted one never reached the
 * seats (measured 2026-09-13 through the real boundary opener).
 */
export const PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "OPENAI_API_KEY",
] as const);

export const PROJECT_STACK_ENVIRONMENT_KEYS = Object.freeze([
  ...ALLOWED_ENVIRONMENT_KEYS,
  ...PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS,
  "MOE_AGENT_COMMAND",
  "MOE_AGENT_TIMEOUT_MS",
  "MOE_DAEMON_CREDENTIAL",
  // R3-4: Foundation daemon inputs are admitted only to the project stack host.
  "MOE_FOUNDATION_WORKSPACE_CATALOG",
  // Whether the daemon may answer an exhausted review itself, and how many times per node
  // (owner decision 2026-09-16). Both are read by the wrapper at startup, so without them on
  // this roster the owner could state the policy and nothing would ever reach the process that
  // enforces it — the exact silent failure MOE_NODE_TREES hit before it was listed.
  "MOE_GOVERNANCE_MAX_DECISIONS",
  "MOE_GOVERNANCE_MODE",
  "MOE_NODE_SPECS_DIR",
  "MOE_NODE_TEST_COMMAND",
  // Each node in its own Git working tree (owner decision 2026-09-16); the wrapper reads it.
  "MOE_NODE_TREES",
  // Bound by the project launcher to the selected project's canonical root.
  "MOE_NODE_WORKSPACE",
  // The parent CLI's MEASURED fact of an attached operator console, "true" or "false";
  // server-owned at the launch edge, so a caller's environment cannot assert it.
  "MOE_OPERATOR_CHANNEL",
  "MOE_PRINCIPAL_ID",
  // The manager catalog the hosted daemon's repository bootstrap registers into. Server-owned at
  // the launch edge: off this roster the host fell back to ~/.moe-next/projects.json, a second
  // catalog on the same host that the manager (%LOCALAPPDATA%\Moe\projects.json) never reads.
  "MOE_PROJECT_CATALOG",
  "MOE_PROJECT_CONFIGURATION_DIGEST",
  "MOE_PROJECT_ID",
  "MOE_PROJECT_INSTANCE_ID",
  "MOE_RUNTIME_PIN_ROOT",
  "MOE_STORE_PATH",
  "MOE_VERIFICATION_CATALOG",
  // The verifier's disposable database: image, delivered URL variable names, TLS and the CA
  // variable (operator decision 2026-09-18). Read by the wrapper at startup via
  // verifier-database-provisioning.ts. Measured off this roster on UnAI: start.ps1 set all four,
  // the wrapper still provisioned plain postgres + DATABASE_URL, and every DB-backed node failed
  // MIGRATION_DID_NOT_START — the MOE_NODE_TREES silent failure again.
  "MOE_VERIFIER_DB_CA_VAR",
  "MOE_VERIFIER_DB_IMAGE",
  "MOE_VERIFIER_DB_TLS",
  "MOE_VERIFIER_DB_URL_VARS",
  "MOE_WRAPPER_INTERVAL_MS",
  "MOE_WRAPPER_MAX_AGENTS",
  "MOE_WRAPPER_MAX_ITEM_ATTEMPTS",
  "MOE_WRAPPER_ONCE",
] as const);

const REQUEST_KEYS = Object.freeze([
  "assetRoot", "configPath", "cwd", "entryPath", "environment", "instanceId", "nodeExecutable",
  "storePath",
] as const);
const STACK_ENTRY_BASENAME = "project-stack-host-main.ts";
const NODE_BASENAME = "node.exe";
const MAX_STORE_PATH_CHARS = 244;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface WindowsProjectStackRequest {
  readonly assetRoot: string;
  readonly configPath: string;
  readonly cwd: string;
  readonly entryPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly instanceId: string;
  readonly nodeExecutable: string;
  readonly storePath: string;
}

export interface WindowsProjectStackBoundaryDeps {
  readonly platform: string;
  readonly resolveBroker: () => string | WindowsProcessUnknown;
  readonly spawn: BrokerSpawn;
}

export interface WindowsProjectStackBoundaryOptions {
  readonly deps?: WindowsProjectStackBoundaryDeps;
}

const DEFAULT_DEPS: WindowsProjectStackBoundaryDeps = Object.freeze({
  platform: process.platform,
  resolveBroker: () => resolveBrokerBinary(),
  spawn: spawnBroker,
});
const PROJECT_STACK_LAUNCH_OPCODE = 3;

function refused(
  code: Parameters<typeof unknownOutcome>[0], message: string,
): WindowsProcessUnknown {
  return unknownOutcome(code, "WINDOWS_PROCESS_REQUEST", message);
}

function checkedPath(value: unknown): value is string {
  return isLocalAbsolutePath(value);
}

/**
 * Encodes the one reviewed Node entry and its fixed argv. There is no caller
 * supplied argv or shell flag, so publishing this function does not publish the
 * runner's arbitrary process boundary.
 */
export function encodeProjectStackLaunchPayload(
  request: unknown,
): Uint8Array | WindowsProcessUnknown {
  const snapshot = snapshotExactRecord(request, REQUEST_KEYS);
  if (snapshot === null) {
    return refused("PROCESS_BOUNDARY_REQUEST_MALFORMED", "the project stack request is not exact");
  }
  const nodeExecutable = snapshot["nodeExecutable"];
  // The request is Windows-shaped: its guard refuses "/" rather than normalising.
  // win32.basename splits "\\" on every host; native basename saw the whole path
  // on POSIX and refused every curated request in cross-host job 98675419028.
  if (!checkedPath(nodeExecutable)
    || win32.basename(nodeExecutable).toLowerCase() !== NODE_BASENAME) {
    return refused(
      "PROCESS_BOUNDARY_EXECUTABLE_REJECTED", "the project stack executable is not node.exe",
    );
  }
  const entryPath = snapshot["entryPath"];
  const configPath = snapshot["configPath"];
  const assetRoot = snapshot["assetRoot"];
  const storePath = snapshot["storePath"];
  if (!checkedPath(entryPath) || win32.basename(entryPath) !== STACK_ENTRY_BASENAME
    || !checkedPath(configPath) || !checkedPath(assetRoot) || !checkedPath(storePath)
    || !isBoundedText(storePath, MAX_STORE_PATH_CHARS)) {
    return refused("PROCESS_BOUNDARY_ARGV_REJECTED", "a project stack path is invalid");
  }
  const instanceId = snapshot["instanceId"];
  if (typeof instanceId !== "string" || !UUID_V4.test(instanceId)) {
    return refused("PROCESS_BOUNDARY_REQUEST_MALFORMED", "the project instance id is invalid");
  }
  const launch = encodeLaunchPayloadWithAllowedEnvironment({
    argv: [entryPath, `--config=${configPath}`, `--asset-root=${assetRoot}`],
    cwd: snapshot["cwd"],
    environment: snapshot["environment"],
    executable: nodeExecutable,
  }, PROJECT_STACK_ENVIRONMENT_KEYS, [
    ["MOE_PROJECT_INSTANCE_ID", instanceId],
    ["MOE_STORE_PATH", storePath],
  ]);
  if (!(launch instanceof Uint8Array)) return launch;
  return prefixStorePath(storePath, launch);
}

const UTF8 = new TextEncoder();

/** Project launch payload: store lock path, then the ordinary launch payload. */
function prefixStorePath(
  storePath: string,
  launch: Uint8Array,
): Uint8Array | WindowsProcessUnknown {
  const encodedPath = UTF8.encode(storePath);
  const total = 2 + encodedPath.length + launch.length;
  if (encodedPath.length > 0xffff || total > CHANNEL_PAYLOAD_CAPS.CONTROL) {
    return refused(
      "PROCESS_BOUNDARY_REQUEST_OVERSIZED",
      "the encoded project stack request is larger than the control channel's cap",
    );
  }
  const payload = new Uint8Array(total);
  payload[0] = encodedPath.length & 0xff;
  payload[1] = (encodedPath.length >>> 8) & 0xff;
  payload.set(encodedPath, 2);
  payload.set(launch, 2 + encodedPath.length);
  return payload;
}

/** Opens only the fixed project stack host inside the proven Windows Job. */
export function openWindowsProjectStackBoundary(
  request: unknown,
  options: WindowsProjectStackBoundaryOptions = {},
): WindowsProcessBoundary | WindowsProcessUnknown {
  const deps = options.deps ?? DEFAULT_DEPS;
  if (deps.platform !== "win32") {
    return refused(
      "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED", "the project stack boundary requires win32",
    );
  }
  const payload = encodeProjectStackLaunchPayload(request);
  if (!(payload instanceof Uint8Array)) return payload;
  const frame = encodeFrame("CONTROL", PROJECT_STACK_LAUNCH_OPCODE, payload);
  if (!(frame instanceof Uint8Array)) return frame;
  const binary = deps.resolveBroker();
  if (typeof binary !== "string") return binary;
  return driveBrokerBoundary(
    binary,
    frame,
    deps.spawn,
    null,
    CANCEL_GRACE_MS,
  );
}
