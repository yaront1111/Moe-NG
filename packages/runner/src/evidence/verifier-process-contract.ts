import type { ProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type {
  ActivationGrant,
  AttemptSlice,
  EffectIntent,
  SupervisorFailure,
} from "../supervisor/effect-kernel.js";
import type { WorkspaceInputManifest } from "../workspace/workspace-contract.js";
import type { EvidenceFailure, VerificationRecipe } from "./evidence-contract.js";
import type { ProcessLauncher } from "./verifier-process-launcher.js";
import type { ObservedOutput, ObservedVerifierExecution } from "./verifier-execution.js";

/**
 * Vocabulary for the verifier process wrapper. Holds no spawning.
 *
 * The evidence and supervisor packages already own closed code lists this module
 * is not allowed to widen, so the wrapper carries its own and passes their
 * failures through untouched.
 */
export const VERIFIER_PROCESS_ERROR_CODES = Object.freeze([
  "VERIFIER_PROCESS_RECIPE_SEAL_INVALID",
  "VERIFIER_PROCESS_INPUT_MANIFEST_STALE",
  "VERIFIER_PROCESS_RUNTIME_UNPROVEN",
  "VERIFIER_PROCESS_EXECUTABLE_UNSUPPORTED",
  "VERIFIER_PROCESS_WORKSPACE_INVALID",
  "VERIFIER_PROCESS_GRANT_RUN_DIVERGENT",
  "VERIFIER_PROCESS_SPAWN_FAILED",
  "VERIFIER_PROCESS_TIMED_OUT",
  "VERIFIER_PROCESS_CANCELLED",
  "VERIFIER_PROCESS_OUTPUT_OVERFLOW",
  "VERIFIER_PROCESS_EXIT_AMBIGUOUS",
  "VERIFIER_PROCESS_TREE_UNREAPED",
] as const);

export type VerifierProcessErrorCode = (typeof VERIFIER_PROCESS_ERROR_CODES)[number];

/**
 * Which stage refused, recorded on every failure because a launch that never
 * happened and a launch that happened and could not be reaped are different
 * facts about whether an external effect occurred.
 */
export const VERIFIER_PROCESS_LAYERS = Object.freeze([
  "LAUNCH_GATE",
  "SPAWN",
  "CAPTURE",
  "REAP",
  "REGISTRY",
] as const);

export type VerifierProcessLayer = (typeof VERIFIER_PROCESS_LAYERS)[number];

export interface VerifierProcessFailure {
  readonly ok: false;
  readonly code: VerifierProcessErrorCode;
  readonly layer: VerifierProcessLayer;
  readonly message: string;
}

export function verifierProcessFailure(
  code: VerifierProcessErrorCode,
  layer: VerifierProcessLayer,
  message: string,
): VerifierProcessFailure {
  return Object.freeze({ ok: false as const, code, layer, message });
}

/** One MiB per stream: a verifier that says more than this is reporting, not proving. */
export const MAX_VERIFIER_OUTPUT_BYTES = 1024 * 1024;
export const MAX_VERIFIER_RUN_MS = 15 * 60 * 1000;
/** How long a killed tree gets to actually close before the kill counts as unproven. */
export const VERIFIER_REAP_GRACE_MS = 10_000;

export interface VerifierStreamCapture {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface VerifierCapture {
  readonly stdout: VerifierStreamCapture;
  readonly stderr: VerifierStreamCapture;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/** Injected so nothing here reads a clock: `now` stamps evidence, `monotonicMs` measures it. */
export interface VerifierClock {
  readonly now: () => string;
  readonly monotonicMs: () => number;
}

/**
 * The refusal union, discriminated by WHICH AUTHORITY refused.
 *
 * A supervisor or evidence failure is carried verbatim rather than re-coded into
 * this module's vocabulary. Re-coding would erase the only signal that tells a
 * grant refusal apart from a launch-gate refusal that happens to agree with it,
 * and a test pinning the collapsed code would stay green while it no longer
 * exercised the layer it was written for.
 */
export type VerifierProcessRefusal =
  | { readonly ok: false; readonly source: "PROCESS"; readonly failure: VerifierProcessFailure }
  | { readonly ok: false; readonly source: "SUPERVISOR"; readonly failure: SupervisorFailure }
  | { readonly ok: false; readonly source: "EVIDENCE"; readonly failure: EvidenceFailure };

export function processRefusal(
  code: VerifierProcessErrorCode,
  layer: VerifierProcessLayer,
  message: string,
  capture: VerifierCapture | null = null,
): RunVerifierProcessRefused {
  return Object.freeze({
    ok: false as const,
    source: "PROCESS" as const,
    failure: verifierProcessFailure(code, layer, message),
    capture,
  });
}

export function supervisorRefusal(
  failure: SupervisorFailure,
  capture: VerifierCapture | null = null,
): RunVerifierProcessRefused {
  return Object.freeze({ ok: false as const, source: "SUPERVISOR" as const, failure, capture });
}

export function evidenceRefusal(
  failure: EvidenceFailure,
  capture: VerifierCapture | null = null,
): RunVerifierProcessRefused {
  return Object.freeze({ ok: false as const, source: "EVIDENCE" as const, failure, capture });
}

/** The three records `validateActivationCommit` machine-checks as one commit. */
export interface VerifierActivation {
  readonly intent: EffectIntent;
  readonly attempt: AttemptSlice;
  readonly grant: ActivationGrant;
}

export interface RunVerifierProcessInput {
  readonly recipe: VerificationRecipe;
  readonly inputManifest: WorkspaceInputManifest;
  readonly candidateBaseIdentity: string;
  readonly activation: VerifierActivation;
  readonly wrapperIdentity: string;
  readonly candidateRoot: string;
  /** Caller-supplied facts: this wrapper owns the process, never the observation. */
  readonly runtimeObservation: ProviderRuntimeObservation;
  readonly outputs: readonly ObservedOutput[];
  readonly launcher: ProcessLauncher;
  readonly clock: VerifierClock;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number | undefined;
  readonly reapGraceMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RunVerifierProcessOk {
  readonly ok: true;
  readonly execution: ObservedVerifierExecution;
  readonly capture: VerifierCapture;
}

/** A refusal may still carry what was observed; it never carries an execution. */
export type RunVerifierProcessRefused = VerifierProcessRefusal & {
  readonly capture: VerifierCapture | null;
};

export type RunVerifierProcessResult = RunVerifierProcessOk | RunVerifierProcessRefused;

const ENVIRONMENT_ALLOWLIST = Object.freeze([
  "SystemRoot",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
] as const);

/**
 * Allowlist, not denylist. A verifier child gets only what an executable needs to
 * start — stripping the environment to nothing makes most Windows binaries fail
 * in ways indistinguishable from a real verifier failure, while inheriting the
 * daemon's environment would hand a third-party verifier every credential the
 * daemon holds. `base` is a parameter so this module never reads an ambient
 * `process.env` and stays deterministic, matching `hermeticGitEnvironment`.
 * Lookup is case-insensitive because Windows environment keys are.
 */
export function hermeticVerifierEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Map<string, string>(
    ENVIRONMENT_ALLOWLIST.map((key) => [key.toUpperCase(), key]),
  );
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const canonical = allowed.get(key.toUpperCase());
    if (canonical !== undefined && value !== undefined) {
      environment[canonical] = value;
    }
  }
  environment.LC_ALL = "C";
  return environment;
}
