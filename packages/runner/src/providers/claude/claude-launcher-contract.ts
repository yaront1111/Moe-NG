import { WINDOWS_PROCESS_CODES,
  WINDOWS_PROCESS_LAYERS } from "../../platform/windows/windows-process-contract.js";
import { SUPERVISOR_ERROR_CODES, SUPERVISOR_LAYERS,
  type ActivationGrant } from "../../supervisor/effect-kernel.js";
import { type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { CLAUDE_RUNTIME_PIN_ERROR_CODES,
  CLAUDE_RUNTIME_PIN_LAYER } from "./claude-runtime-pin-closure.js";
import { type ClaudeRuntimePinRequest } from "./claude-runtime-pin.js";

export const CLAUDE_LAUNCHER_VERSION = "moe-claude-launcher/1" as const;
const LOCAL_CODES = [
  "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "CLAUDE_LAUNCH_REQUEST_MALFORMED",
  "CLAUDE_LAUNCH_RUNTIME_THROWN", "CLAUDE_LAUNCH_DEPENDENCY_THROWN",
  "CLAUDE_LAUNCH_BOUNDARY_THROWN",
  "CLAUDE_LAUNCH_LOCK_UNKNOWN",
  "CLAUDE_LAUNCH_OUTPUT_TRUNCATED", "CLAUDE_LAUNCH_STREAM_ERROR",
  "CLAUDE_LAUNCH_TIMEOUT", "CLAUDE_LAUNCH_CANCELLED", "CLAUDE_LAUNCH_CLEANUP_UNKNOWN",
  "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE",
] as const;
export const CLAUDE_LAUNCH_ERROR_CODES = Object.freeze([
  ...CLAUDE_RUNTIME_PIN_ERROR_CODES, ...SUPERVISOR_ERROR_CODES, ...WINDOWS_PROCESS_CODES, ...LOCAL_CODES,
] as const);
export const CLAUDE_LAUNCH_LAYERS = Object.freeze([
  ...SUPERVISOR_LAYERS, CLAUDE_RUNTIME_PIN_LAYER, ...WINDOWS_PROCESS_LAYERS, "LAUNCHER", "OUTPUT",
] as const);
export const CLAUDE_LAUNCH_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN", "UNSUPPORTED"] as const);
export type ClaudeLaunchErrorCode = (typeof CLAUDE_LAUNCH_ERROR_CODES)[number];
export type ClaudeLaunchLayer = (typeof CLAUDE_LAUNCH_LAYERS)[number];
export type ClaudeLaunchTruthClass = (typeof CLAUDE_LAUNCH_TRUTH_CLASSES)[number];

export interface ClaudeLaunchLockLease {
  release(): Promise<void>;
}
export type ClaudeLaunchLockResult =
  | { readonly ok: true; readonly lease: ClaudeLaunchLockLease }
  | { readonly ok: false; readonly code: ClaudeLaunchErrorCode;
      readonly layer: ClaudeLaunchLayer; readonly message: string };

export interface ClaudeLaunchLimits {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly tailBytes: number;
  readonly timeoutMs: number;
}
export interface ClaudeLaunchRequest {
  readonly runtime: ClaudeRuntimePinRequest;
  readonly duplicateDelivery: unknown | null;
  readonly effect: unknown;
  readonly attempt: unknown;
  readonly grant: unknown;
  readonly claim: unknown;
  readonly wrapperIdentity: string;
  readonly bootstrapCredentialDigest: string;
  readonly priorRegistration: unknown | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly reconciliation: unknown | null;
  readonly limits: ClaudeLaunchLimits;
}
export interface ClaudeStreamEvidence {
  readonly capturedBase64: string;
  readonly tailBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly complete: boolean;
}
export type ClaudeLaunchExit =
  | { readonly kind: "EXITED"; readonly code: number }
  | { readonly kind: "SIGNALLED"; readonly signal: string }
  | { readonly kind: "UNOBSERVED" };
export interface ClaudeLaunchObservation {
  readonly launcherVersion: typeof CLAUDE_LAUNCHER_VERSION;
  readonly effectDigest: string;
  readonly activationDigest: string;
  readonly grantId: string;
  readonly consumedGrantDigest: string;
  readonly runtimeBindingDigest: string;
  readonly quotedRuntimeDigest: string;
  readonly freshRuntimeDigest: string;
  readonly pinnedClosureDigest: string;
  readonly lockIdentity: string;
  readonly wrapperIdentity: string;
  readonly processIdentity: string | null;
  readonly registrationDigest: string | null;
  readonly stdout: ClaudeStreamEvidence;
  readonly stderr: ClaudeStreamEvidence;
  readonly exit: ClaudeLaunchExit;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly truthClass: "PROVEN" | "UNKNOWN";
  readonly reasonCode: ClaudeLaunchErrorCode | null;
  readonly reasonLayer: ClaudeLaunchLayer | null;
  readonly observationDigest: string;
}
export interface ClaudeLaunchFailure {
  readonly kind: "REFUSED";
  readonly ok: false;
  readonly truthClass: "UNKNOWN" | "UNSUPPORTED";
  readonly code: ClaudeLaunchErrorCode;
  readonly layer: ClaudeLaunchLayer;
  readonly message: string;
}
export interface ClaudeLaunchDuplicate {
  readonly kind: "ADOPTED" | "EXIT_BEFORE_LAUNCH";
  readonly ok: true;
  readonly truthClass: "PROVEN";
  readonly code: null;
  readonly layer: null;
  readonly launched: false;
  readonly processIdentity: string | null;
}
export interface ClaudeLaunchObserved {
  readonly kind: "OBSERVED";
  readonly ok: true;
  readonly truthClass: "PROVEN" | "UNKNOWN";
  readonly code: ClaudeLaunchErrorCode | null;
  readonly layer: ClaudeLaunchLayer | null;
  readonly consumedGrant: ActivationGrant;
  readonly registration: LaunchLockRegistration;
  readonly observation: ClaudeLaunchObservation;
}
export type ClaudeLaunchResult = ClaudeLaunchFailure | ClaudeLaunchDuplicate | ClaudeLaunchObserved;
/**
 * EVERY port answers `unknown`. These are injected capabilities that may cross a
 * process, a package or a test boundary, so a declared return type is a claim
 * about someone else's code rather than a fact. Typing them honestly forces the
 * launcher to decode before it branches — see `claude-launcher-port-results.ts`.
 */
export interface ClaudeLauncherDependencies {
  prepareRuntime(request: ClaudeRuntimePinRequest): unknown;
  resolveDuplicate(value: unknown): unknown;
  validateCommit(effect: unknown, attempt: unknown, grant: unknown): unknown;
  consumeGrant(grant: unknown, wrapperIdentity: unknown): unknown;
  acquireLock(lockIdentity: string): unknown;
  openBoundary(request: unknown, options?: { readonly timeoutMs?: number }): unknown;
  registerLock(registration: unknown, claim: unknown, prior: unknown): unknown;
  observeProcess(exit: unknown, reconciliation: unknown): unknown;
  now(): unknown;
  delay(milliseconds: number, signal?: AbortSignal): unknown;
}
export interface ClaudeLaunchOptions {
  readonly platform?: string;
  readonly signal?: AbortSignal;
  readonly deps?: ClaudeLauncherDependencies;
}
/**
 * The two moments the launcher registers a process identity, and the ONE place
 * those identity strings are built.
 *
 * PREFLIGHT names an intention: no process exists yet, so the identity is the
 * wrapper's, marked pending. STARTED names an observed fact. A durable consumer
 * may reserve at PREFLIGHT but must only treat STARTED as process authority —
 * a persisted pending record, fed back as `priorRegistration`, would make
 * `registerLaunchLock` refuse a legitimate restart instead of adopting it.
 *
 * The builders exist because the launcher compares a registration's
 * `processIdentity` against a freshly rebuilt string to detect boundary drift.
 * Two literals would let a format change pass that comparison silently, so both
 * call sites and the phase classifier read from here.
 */
export const CLAUDE_LAUNCH_REGISTRATION_PHASES = Object.freeze(["PREFLIGHT", "STARTED"] as const);
export type ClaudeLaunchRegistrationPhase = (typeof CLAUDE_LAUNCH_REGISTRATION_PHASES)[number];
export const CLAUDE_PENDING_IDENTITY_PREFIX = "pending:";
export const CLAUDE_STARTED_IDENTITY_PREFIX = "windows:";
export function pendingProcessIdentity(wrapperIdentity: string): string {
  return `${CLAUDE_PENDING_IDENTITY_PREFIX}${wrapperIdentity}`;
}
export function startedProcessIdentity(pid: number, creationTime: bigint): string {
  return `${CLAUDE_STARTED_IDENTITY_PREFIX}${pid}:${creationTime}`;
}
/**
 * What the launcher hands a durable registration port. `claim` and `prior` stay
 * `unknown`: they are the caller's own records travelling back out unchanged, and
 * the launcher has already used the validated `registration` for every decision
 * it makes itself.
 */
export interface ClaudeRegistrationCommit {
  readonly phase: ClaudeLaunchRegistrationPhase;
  readonly registration: LaunchLockRegistration;
  readonly claim: unknown;
  readonly prior: unknown;
}
/**
 * The two authority ports a daemon supplies to make a launch durable. Both
 * return `unknown` for the same reason `ClaudeLauncherDependencies` does: these
 * cross a process boundary, so a declared return type would be a claim about
 * someone else's code. The launcher decodes both before branching.
 */
export interface ClaudeLauncherAuthority {
  consumeGrantDurably(grant: unknown, wrapperIdentity: unknown): unknown;
  commitProcessRegistration(commit: ClaudeRegistrationCommit): unknown;
}
