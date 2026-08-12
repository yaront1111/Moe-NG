import { createHash } from "node:crypto";
import { type Readable } from "node:stream";
import { canonicalDigest, deepFreeze } from "../../canonical.js";
import { openWindowsProcessBoundary, type WindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { type WindowsProcessOutcome,
  type WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import { resolveDuplicateDelivery, type DuplicateDeliveryOutcome } from "../../supervisor/duplicate-delivery.js";
import { consumeActivationGrant, validateActivationCommit } from "../../supervisor/effect-grant.js";
import { type ActivationGrant,
  type SupervisorFailure } from "../../supervisor/effect-kernel.js";
import { registerLaunchLock, type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin,
  type ClaudeRuntimePinResult, type PreparedClaudeRuntime } from "./claude-runtime-pin.js";
import { CLAUDE_LAUNCHER_VERSION, type ClaudeLaunchDuplicate, type ClaudeLaunchErrorCode,
  type ClaudeLaunchExit, type ClaudeLaunchFailure, type ClaudeLaunchLayer,
  type ClaudeLaunchObservation, type ClaudeLaunchOptions, type ClaudeLaunchResult,
  type ClaudeLauncherDependencies, type ClaudeStreamEvidence } from "./claude-launcher-contract.js";
import { snapshotClaudeLaunchRequest,
  type ClaudeLaunchSnapshot } from "./claude-launcher-input.js";
export * from "./claude-launcher-contract.js";
const defaults: ClaudeLauncherDependencies = Object.freeze({
  prepareRuntime: prepareClaudeRuntimePin,
  resolveDuplicate: resolveDuplicateDelivery,
  validateCommit: validateActivationCommit,
  consumeGrant: consumeActivationGrant,
  openBoundary: openWindowsProcessBoundary,
  registerLock: registerLaunchLock,
  observeProcess: intakeProcessObservation,
  now: () => new Date().toISOString(),
  delay: async (milliseconds: number, signal?: AbortSignal) => await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds); timer.unref();
    const cancel = (): void => { clearTimeout(timer); resolve(); };
    if (signal?.aborted === true) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  }),
});
const malformed = (message: string, truthClass: "UNKNOWN" | "UNSUPPORTED" = "UNKNOWN"): ClaudeLaunchFailure =>
  deepFreeze({ kind: "REFUSED", ok: false, truthClass,
    code: truthClass === "UNSUPPORTED" ? "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED" : "CLAUDE_LAUNCH_REQUEST_MALFORMED",
    layer: "LAUNCHER", message });
function delegated(failure: SupervisorFailure): ClaudeLaunchFailure {
  return deepFreeze({ kind: "REFUSED", ok: false, truthClass: "UNKNOWN",
    code: failure.code, layer: failure.layer, message: failure.message });
}
function duplicate(outcome: Exclude<DuplicateDeliveryOutcome, { readonly kind: "SUSPECT" }>): ClaudeLaunchDuplicate {
  return deepFreeze({ kind: outcome.kind, ok: true, truthClass: "PROVEN", code: null, layer: null,
    launched: false, processIdentity: outcome.kind === "ADOPTED" ? outcome.processIdentity : null });
}
function directFailure(code: ClaudeLaunchErrorCode, layer: ClaudeLaunchLayer, message: string): ClaudeLaunchFailure {
  return deepFreeze({ kind: "REFUSED", ok: false, truthClass: "UNKNOWN", code, layer, message });
}
interface OpenedLaunch {
  readonly request: ClaudeLaunchSnapshot;
  readonly runtime: PreparedClaudeRuntime;
  readonly activationDigest: string;
  readonly consumedGrant: ActivationGrant;
  readonly boundary: WindowsProcessBoundary;
  readonly deps: ClaudeLauncherDependencies;
  readonly signal: AbortSignal | undefined;
}
interface CapturedStream {
  readonly evidence: ClaudeStreamEvidence;
  readonly failed: boolean;
}
async function captureStream(stream: Readable, limit: number, tailLimit: number): Promise<CapturedStream> {
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  let capturedLength = 0;
  let tail = Buffer.alloc(0);
  let byteLength = 0;
  try {
    for await (const value of stream) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      hash.update(bytes);
      byteLength += bytes.length;
      if (capturedLength < limit) {
        const part = bytes.subarray(0, limit - capturedLength);
        captured.push(Buffer.from(part)); capturedLength += part.length;
      }
      tail = bytes.length >= tailLimit ? Buffer.from(bytes.subarray(-tailLimit)) : Buffer.concat([tail, bytes]).subarray(-tailLimit);
    }
    return finishCapture(false);
  } catch { return finishCapture(true); }
  function finishCapture(failed: boolean): CapturedStream {
    return deepFreeze({ failed, evidence: { capturedBase64: Buffer.concat(captured).toString("base64"),
      tailBase64: tail.toString("base64"), byteLength, sha256: hash.digest("hex"),
      truncated: byteLength > limit, complete: !failed } });
  }
}
type Terminal =
  | { readonly kind: "COMPLETED"; readonly outcome: WindowsProcessOutcome }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "CANCELLED" }
  | { readonly kind: "STREAM_ERROR" };
function cancellation(signal: AbortSignal | undefined): { promise: Promise<Terminal>; dispose(): void } {
  if (signal === undefined) return { promise: new Promise(() => undefined), dispose: () => undefined };
  let resolve!: (value: Terminal) => void;
  const promise = new Promise<Terminal>((done) => { resolve = done; });
  const abort = (): void => resolve({ kind: "CANCELLED" });
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", abort) };
}

function terminalReason(terminal: Terminal): readonly [ClaudeLaunchErrorCode, ClaudeLaunchLayer] | null {
  if (terminal.kind === "TIMEOUT") return ["CLAUDE_LAUNCH_TIMEOUT", "LAUNCHER"];
  if (terminal.kind === "CANCELLED") return ["CLAUDE_LAUNCH_CANCELLED", "LAUNCHER"];
  if (terminal.kind === "STREAM_ERROR") return ["CLAUDE_LAUNCH_STREAM_ERROR", "OUTPUT"];
  if (terminal.outcome.truthClass === "UNKNOWN") return [terminal.outcome.code, terminal.outcome.layer];
  return null;
}
const isProven = (value: WindowsProcessOutcome | null): value is Extract<WindowsProcessOutcome,
  { readonly truthClass: "PROVEN" }> => value?.truthClass === "PROVEN";

async function waitForTerminal(
  opened: OpenedLaunch, stdout: Promise<CapturedStream>, stderr: Promise<CapturedStream>,
): Promise<Terminal> {
  const cancelled = cancellation(opened.signal);
  const streamFault = (capture: Promise<CapturedStream>): Promise<Terminal> => capture.then((result) =>
    result.failed ? Promise.resolve({ kind: "STREAM_ERROR" }) : new Promise(() => undefined));
  const timer = new AbortController();
  try {
    const terminal = await Promise.race([
      opened.boundary.completed.then((outcome) => ({ kind: "COMPLETED", outcome }) as const),
      opened.deps.delay(opened.request.limits.timeoutMs, timer.signal).then(() => ({ kind: "TIMEOUT" }) as const),
      cancelled.promise, Promise.race([streamFault(stdout), streamFault(stderr)]),
    ]);
    if (terminal.kind !== "COMPLETED") opened.boundary.cancel();
    return terminal;
  } finally { timer.abort(); cancelled.dispose(); }
}

function buildLaunchObservation(
  opened: OpenedLaunch, registration: LaunchLockRegistration,
  streams: readonly [CapturedStream, CapturedStream], exit: ClaudeLaunchExit,
  truthClass: "PROVEN" | "UNKNOWN",
  uncertainty: readonly [ClaudeLaunchErrorCode, ClaudeLaunchLayer] | null, startedAt: string,
): ClaudeLaunchObservation {
  const body = { launcherVersion: CLAUDE_LAUNCHER_VERSION,
    effectDigest: canonicalDigest(opened.request.effect), activationDigest: opened.activationDigest,
    grantId: opened.consumedGrant.grantId, consumedGrantDigest: canonicalDigest(opened.consumedGrant),
    runtimeBindingDigest: opened.runtime.bindingDigest,
    quotedRuntimeDigest: opened.runtime.quotedObservationDigest,
    freshRuntimeDigest: opened.runtime.freshObservationDigest,
    pinnedClosureDigest: opened.runtime.pinnedClosureDigest,
    lockIdentity: registration.lockIdentity, wrapperIdentity: registration.wrapperIdentity,
    processIdentity: registration.processIdentity, registrationDigest: canonicalDigest(registration),
    stdout: streams[0].evidence, stderr: streams[1].evidence, exit,
    startedAt, completedAt: opened.deps.now(), truthClass,
    reasonCode: uncertainty?.[0] ?? null, reasonLayer: uncertainty?.[1] ?? null } as const;
  return deepFreeze({ ...body, observationDigest: canonicalDigest(body) });
}

interface RegisteredLaunch { readonly registration: LaunchLockRegistration; readonly startedAt: string }
async function startAndRegister(opened: OpenedLaunch): Promise<RegisteredLaunch | ClaudeLaunchFailure> {
  try {
    const started = await opened.boundary.started;
    if ("truthClass" in started) return directFailure(started.code, started.layer, started.message);
    const startedAt = opened.deps.now();
    const processIdentity = `windows:${started.pid}:${started.creationTime}`;
    const registered = opened.deps.registerLock({
      lockIdentity: (opened.request.claim as { lockIdentity?: unknown }).lockIdentity,
      wrapperIdentity: opened.request.wrapperIdentity, processIdentity,
      bootstrapCredentialDigest: opened.request.bootstrapCredentialDigest, registeredAt: startedAt,
    }, opened.request.claim, opened.request.priorRegistration);
    return registered.kind === "REFUSED" ? delegated(registered.failure) :
      { registration: registered.registration, startedAt };
  } catch {
    opened.boundary.cancel();
    return directFailure("CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER", "process lifecycle threw");
  }
}

async function settleClaudeLaunch(opened: OpenedLaunch): Promise<ClaudeLaunchResult> {
  const { request, boundary, deps } = opened;
  const stdoutPromise = captureStream(boundary.providerStdout, request.limits.stdoutBytes, request.limits.tailBytes);
  const stderrPromise = captureStream(boundary.providerStderr, request.limits.stderrBytes, request.limits.tailBytes);
  let terminal: Terminal | null = null;
  const started = await startAndRegister(opened);
  const registration = "registration" in started ? started.registration : null;
  const startedAt = "registration" in started ? started.startedAt : "";
  let primaryFailure = "registration" in started ? null : started;
  if (primaryFailure === null) terminal = await waitForTerminal(opened, stdoutPromise, stderrPromise);

  let closed: WindowsProcessOutcome | null = null;
  try { closed = await boundary.close(); }
  catch { primaryFailure = directFailure("CLAUDE_LAUNCH_CLEANUP_UNKNOWN", "LAUNCHER", "process cleanup threw"); }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (closed?.truthClass === "UNKNOWN" &&
      !(terminal?.kind === "COMPLETED" && terminal.outcome.truthClass === "UNKNOWN" &&
        terminal.outcome.code === closed.code && terminal.outcome.layer === closed.layer)) {
    primaryFailure = directFailure("CLAUDE_LAUNCH_CLEANUP_UNKNOWN", "LAUNCHER", "process cleanup is unproven");
  }
  if (registration === null) return primaryFailure ?? directFailure(
    "CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER", "process registration was not observed");

  const reason = primaryFailure === null && terminal !== null ? terminalReason(terminal) : null;
  const terminalOutcome = terminal?.kind === "COMPLETED" ? terminal.outcome : null;
  const proofs = [closed, terminalOutcome].filter(isProven);
  const completion = proofs[0] ?? null;
  const identityConflict = completion !== null && proofs.some((proof) =>
    `windows:${proof.identity.pid}:${proof.identity.creationTime}` !== registration.processIdentity ||
    proof.exitCode !== completion.exitCode);
  const observed = deps.observeProcess(completion === null ? { kind: "UNOBSERVED" } :
    { kind: "EXITED", code: completion.exitCode }, request.reconciliation);
  if (observed.kind === "REFUSED") return delegated(observed.failure);
  let uncertainty = primaryFailure === null ? reason : [primaryFailure.code, primaryFailure.layer] as const;
  if (identityConflict) uncertainty = ["PROCESS_BOUNDARY_IDENTITY_UNPROVEN", "WINDOWS_PROCESS_TRANSPORT"];
  if (uncertainty === null && (stdout.failed || stderr.failed)) uncertainty = ["CLAUDE_LAUNCH_STREAM_ERROR", "OUTPUT"];
  if (uncertainty === null && (stdout.evidence.truncated || stderr.evidence.truncated)) {
    uncertainty = ["CLAUDE_LAUNCH_OUTPUT_TRUNCATED", "OUTPUT"];
  }
  const truthClass = uncertainty === null && observed.observation.proven ? "PROVEN" : "UNKNOWN";
  const observation = buildLaunchObservation(opened, registration, [stdout, stderr],
    observed.observation.processExit, truthClass, uncertainty, startedAt);
  return deepFreeze({ kind: "OBSERVED", ok: true, truthClass,
    code: uncertainty?.[0] ?? null, layer: uncertainty?.[1] ?? null,
    consumedGrant: opened.consumedGrant, registration, observation });
}

export async function launchClaude(value: unknown, options: ClaudeLaunchOptions = {}): Promise<ClaudeLaunchResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return malformed("Claude launch is supported only on win32", "UNSUPPORTED");
  }
  const signal = options.signal;
  const request = snapshotClaudeLaunchRequest(value);
  if (request === null) return malformed("launch request is not bounded plain data");
  const deps = options.deps ?? defaults;
  if (request.duplicateDelivery !== null) {
    const decided = deps.resolveDuplicate(request.duplicateDelivery);
    if (decided.kind === "SUSPECT") return delegated(decided.failure);
    return duplicate(decided);
  }
  let runtime: ClaudeRuntimePinResult;
  try { runtime = await deps.prepareRuntime(request.runtime); }
  catch { return directFailure("CLAUDE_LAUNCH_RUNTIME_THROWN", "RUNTIME", "runtime preparation threw"); }
  if (!runtime.ok) return directFailure(runtime.code, runtime.layer, runtime.message);
  const commit = deps.validateCommit(request.effect, request.attempt, request.grant);
  if (commit.kind === "REFUSED") return delegated(commit.failure);
  const grant = deps.consumeGrant(request.grant, request.wrapperIdentity);
  if (grant.kind === "REFUSED") return delegated(grant.failure);
  let opened: WindowsProcessBoundary | WindowsProcessUnknown;
  try {
    opened = deps.openBoundary({ executable: runtime.executablePath, argv: request.argv,
      cwd: request.cwd, environment: request.environment }, { timeoutMs: request.limits.timeoutMs });
  } catch { return directFailure("CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER", "process boundary threw before opening"); }
  if ("truthClass" in opened) return directFailure(opened.code, opened.layer, opened.message);
  return await settleClaudeLaunch({ request, runtime, activationDigest: commit.activationDigest,
    consumedGrant: grant.grant, boundary: opened, deps, signal });
}
