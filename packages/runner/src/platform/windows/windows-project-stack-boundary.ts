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
 */
export const PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
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
  "MOE_NODE_SPECS_DIR",
  "MOE_PRINCIPAL_ID",
  "MOE_PROJECT_CONFIGURATION_DIGEST",
  "MOE_PROJECT_ID",
  "MOE_PROJECT_INSTANCE_ID",
  "MOE_RUNTIME_PIN_ROOT",
  "MOE_STORE_PATH",
  "MOE_VERIFICATION_CATALOG",
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
const TRANSFORM_TYPES = "--experimental-transform-types";
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
    argv: [TRANSFORM_TYPES, entryPath, `--config=${configPath}`, `--asset-root=${assetRoot}`],
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
