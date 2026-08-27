import { WINDOWS_PROCESS_CODES,
  WINDOWS_PROCESS_LAYERS } from "../../platform/windows/windows-process-contract.js";
import { SUPERVISOR_ERROR_CODES, SUPERVISOR_LAYERS,
  type ActivationGrant } from "../../supervisor/effect-kernel.js";
import { type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { CLAUDE_RUNTIME_PIN_ERROR_CODES,
  CLAUDE_RUNTIME_PIN_LAYER } from "./claude-runtime-pin-closure.js";
import { CLAUDE_LAUNCH_SELECTION_CODES, CLAUDE_LAUNCH_SELECTION_LAYER,
  type ClaudeLaunchSelection } from "./claude-launch-selection.js";
import { type ClaudeRuntimePinRequest } from "./claude-runtime-pin.js";

export const CLAUDE_LAUNCHER_VERSION = "moe-claude-launcher/1" as const;
export const MAX_CLAUDE_RENDERED_CONTEXT_BYTES = 64 * 1024;
const LOCAL_CODES = [
  "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "CLAUDE_LAUNCH_REQUEST_MALFORMED",
  "CLAUDE_LAUNCH_RUNTIME_THROWN", "CLAUDE_LAUNCH_DEPENDENCY_THROWN",
  "CLAUDE_LAUNCH_BOUNDARY_THROWN",
  "CLAUDE_LAUNCH_CONTEXT_DELIVERY_FAILED",
  "CLAUDE_LAUNCH_LOCK_UNKNOWN",
  "CLAUDE_LAUNCH_OUTPUT_TRUNCATED", "CLAUDE_LAUNCH_STREAM_ERROR",
  "CLAUDE_LAUNCH_TIMEOUT", "CLAUDE_LAUNCH_CANCELLED", "CLAUDE_LAUNCH_CLEANUP_UNKNOWN",
  "CLAUDE_LAUNCH_AUTHORITY_UNUSABLE",
] as const;
/**
 * The launch-selection vocabulary is SPREAD in from its own module rather than
 * copied here, the same way the runtime pin's is: the module that emits a code
 * is the module that should spell it, and the dependency runs one way only —
 * this file names the selection types, so the selection module must not name
 * this one back.
 *
 * The LAYER is spelled `TELEMETRY_CONFIGURATION` because the requirement names
 * that literal, while the CODES keep the `CLAUDE_LAUNCH_` prefix every other
 * launcher-local code carries. Model and effort each get their own three codes
 * so the two comparisons can be mutation-checked independently; one shared code
 * would make those two drills indistinguishable.
 */
export const CLAUDE_LAUNCH_ERROR_CODES = Object.freeze([
  ...CLAUDE_RUNTIME_PIN_ERROR_CODES, ...SUPERVISOR_ERROR_CODES, ...WINDOWS_PROCESS_CODES,
  ...LOCAL_CODES, ...CLAUDE_LAUNCH_SELECTION_CODES,
] as const);
export const CLAUDE_LAUNCH_LAYERS = Object.freeze([
  ...SUPERVISOR_LAYERS, CLAUDE_RUNTIME_PIN_LAYER, ...WINDOWS_PROCESS_LAYERS, "LAUNCHER", "OUTPUT",
  CLAUDE_LAUNCH_SELECTION_LAYER,
] as const);
export const CLAUDE_LAUNCH_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN", "UNSUPPORTED"] as const);
/**
 * `ClaudeLaunchRequest` names `ClaudeLaunchSelection`, so the selection's whole
 * type closure travels with it. A published interface carrying a field nobody
 * can name is a broken publication — a consumer able to declare the request but
 * not construct that field cannot use it at all.
 */
export {
  CLAUDE_LAUNCH_SELECTION_ENV,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_LAUNCH_SELECTION_LAYER,
  CLAUDE_MODEL_EVIDENCE_ABSENT,
  CLAUDE_MODEL_EVIDENCE_KINDS,
  CLAUDE_REASONING_EFFORTS,
  type ClaudeLaunchSelection,
  type ClaudeLaunchSelectionCode,
  type ClaudeLaunchSelectionLayer,
  type ClaudeModelEvidenceKind,
  type ClaudeReasoningEffort,
} from "./claude-launch-selection.js";
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
  /** Exact UTF-8 text sealed by the daemon and delivered without transformation. */
  readonly renderedContext: string;
  /** Daemon-authored binding carried verbatim; the runner does not recompute it. */
  readonly contextManifestDigest: string;
  /**
   * What this launch claims it is launching. Verified against `argv` before any
   * runtime preparation, so it cannot be supplied after the fact — and kept
   * distinct from `runtime`, whose reported version and pinned closure describe
   * the binary rather than the model it was asked for.
   */
  readonly launchSelection: ClaudeLaunchSelection;
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
  readonly deliveredByteLength: number;
  readonly contextManifestDigest: string;
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
