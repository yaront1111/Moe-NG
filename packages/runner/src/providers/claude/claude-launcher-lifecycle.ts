import { canonicalDigest, deepFreeze, isCanonicalUtcTimestamp } from "../../canonical.js";
import { type ActivationGrant } from "../../supervisor/effect-kernel.js";
import { type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { adaptBoundaryOpen, captureStream, normalizeObservation, normalizeOutcome,
  normalizeStart, type BoundaryAdaptation, type BoundaryCleanup, type CapturedStream,
  type NormalizedOutcome, type SafeBoundary } from "./claude-launcher-boundary-results.js";
import { decodeRegistration, isSafeNativePromise, type Capability,
  type DecodedRuntime } from "./claude-launcher-port-results.js";
import { CLAUDE_LAUNCHER_VERSION, startedProcessIdentity, type ClaudeLaunchErrorCode,
  type ClaudeLaunchExit, type ClaudeLaunchFailure, type ClaudeLaunchLayer, type ClaudeLaunchObservation,
  type ClaudeLaunchResult, type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";
import { type ClaudeLaunchSnapshot } from "./claude-launcher-input.js";
/**
 * The post-lock owner: NO_LOCK -> LOCK_OWNED -> BOUNDARY_CLEANUP_OWNED ->
 * STARTED_UNREGISTERED -> REGISTERED -> CLOSED -> RELEASED. There is ONE exit. An early `return` once the OS-exclusive lock is
 * held is how a launcher leaks a child and a lock at the same time, so every
 * refusal — including one raised by a hostile fulfilled value — falls through
 * the same finalizer: cancel unless the run is PROVEN over, await exactly one
 * close, settle both stream captures, then attempt exactly one release. Cleanup
 * uncertainty outranks the primary result, release uncertainty outranks cleanup.
 */
export interface LaunchLifecycleInput {
  readonly request: ClaudeLaunchSnapshot; readonly runtime: DecodedRuntime;
  readonly activationDigest: string; readonly consumedGrant: ActivationGrant;
  /** The raw `openBoundary` return, and whether that call threw instead. */
  readonly opened: unknown; readonly openThrew: boolean; readonly release: Capability;
  readonly ports: ClaudeLauncherDependencies; readonly signal: AbortSignal | undefined;
}
export type Reason = readonly [ClaudeLaunchErrorCode, ClaudeLaunchLayer];
type Proven = Extract<NormalizedOutcome, { readonly kind: "PROVEN" }>;
type Terminal =
  | { readonly kind: "COMPLETED"; readonly outcome: NormalizedOutcome }
  | { readonly kind: "TIMEOUT" } | { readonly kind: "CANCELLED" }
  | { readonly kind: "STREAM_ERROR" } | { readonly kind: "THROWN" };
interface Started {
  readonly registration: LaunchLockRegistration | null; readonly startedAt: string;
  readonly failure: ClaudeLaunchFailure | null;
}
interface Drive extends Started {
  readonly stdout: Promise<CapturedStream>; readonly stderr: Promise<CapturedStream>;
  readonly terminal: Terminal | null;
}
const BOUNDARY_UNUSABLE = "the opened process boundary is not usable";
export function directFailure(code: ClaudeLaunchErrorCode, layer: ClaudeLaunchLayer,
  message: string): ClaudeLaunchFailure {
  return deepFreeze({ kind: "REFUSED" as const, ok: false as const,
    truthClass: "UNKNOWN" as const, code, layer, message });
}
const boundaryThrown = (message: string): ClaudeLaunchFailure =>
  directFailure("CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER", message);
const cleanupUnknown = (): ClaudeLaunchFailure =>
  directFailure("CLAUDE_LAUNCH_CLEANUP_UNKNOWN", "LAUNCHER", "process cleanup is unproven");
function readInstant(ports: ClaudeLauncherDependencies): string | null {
  try { const now = ports.now(); return isCanonicalUtcTimestamp(now) ? now : null; } catch { return null; }
}
function cancellation(signal: AbortSignal | undefined): { promise: Promise<Terminal>; dispose(): void } {
  if (signal === undefined) return { promise: new Promise(() => undefined), dispose: () => undefined };
  let resolve!: (value: Terminal) => void;
  const promise = new Promise<Terminal>((done) => { resolve = done; });
  const abort = (): void => resolve({ kind: "CANCELLED" });
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", abort) };
}
function terminalReason(terminal: Terminal): Reason | null {
  if (terminal.kind === "TIMEOUT") return ["CLAUDE_LAUNCH_TIMEOUT", "LAUNCHER"];
  if (terminal.kind === "CANCELLED") return ["CLAUDE_LAUNCH_CANCELLED", "LAUNCHER"];
  if (terminal.kind === "STREAM_ERROR") return ["CLAUDE_LAUNCH_STREAM_ERROR", "OUTPUT"];
  if (terminal.kind === "THROWN") return ["CLAUDE_LAUNCH_BOUNDARY_THROWN", "LAUNCHER"];
  return terminal.outcome.kind === "UNKNOWN" ? [terminal.outcome.code, terminal.outcome.layer] : null;
}
async function waitForTerminal(input: LaunchLifecycleInput, boundary: SafeBoundary,
  stdout: Promise<CapturedStream>, stderr: Promise<CapturedStream>): Promise<Terminal> {
  let cancelled: ReturnType<typeof cancellation> | null = null;
  const timer = new AbortController();
  try {
    cancelled = cancellation(input.signal);
    const fault = (capture: Promise<CapturedStream>): Promise<Terminal> => capture.then((result) =>
      result.failed ? Promise.resolve<Terminal>({ kind: "STREAM_ERROR" }) : new Promise(() => undefined));
    const delayed = input.ports.delay(input.request.limits.timeoutMs, timer.signal);
    if (!isSafeNativePromise(delayed)) return { kind: "THROWN" };
    return await Promise.race<Terminal>([
      boundary.completed.then((value) => ({ kind: "COMPLETED", outcome: normalizeOutcome(value) })),
      delayed.then(() => ({ kind: "TIMEOUT" }) as const),
      cancelled.promise, Promise.race([fault(stdout), fault(stderr)]),
    ]);
  } catch { return { kind: "THROWN" }; } finally {
    timer.abort();
    try { cancelled?.dispose(); } catch { /* cancellation cleanup is best effort */ }
  }
}
async function startAndRegister(input: LaunchLifecycleInput, boundary: SafeBoundary): Promise<Started> {
  const no = (failure: ClaudeLaunchFailure): Started => ({ registration: null, startedAt: "", failure });
  const lockUnknown = (message: string): ClaudeLaunchFailure =>
    directFailure("CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK", message);
  let start;
  try { start = normalizeStart(await boundary.started); }
  catch { return no(boundaryThrown("the process lifecycle threw")); }
  if (start.kind === "MALFORMED") return no(boundaryThrown("the start observation is not usable"));
  if (start.kind === "UNKNOWN") return no(directFailure(start.code, start.layer, "start refused"));
  const startedAt = readInstant(input.ports);
  if (startedAt === null) return no(boundaryThrown("the launch clock is unusable"));
  const { request } = input;
  let decided;
  try {
    decided = decodeRegistration(input.ports.registerLock({
      lockIdentity: (request.claim as { lockIdentity?: unknown }).lockIdentity,
      wrapperIdentity: request.wrapperIdentity, bootstrapCredentialDigest:
        request.bootstrapCredentialDigest, registeredAt: startedAt,
      processIdentity: startedProcessIdentity(start.identity.pid, start.identity.creationTime),
    }, request.claim, request.priorRegistration));
  } catch { return no(lockUnknown("durable launch registration threw")); }
  if (decided.kind === "REFUSED") return no(directFailure(decided.code, decided.layer, "register refused"));
  if (decided.kind === "MALFORMED") return no(lockUnknown("durable launch registration is unproven"));
  return { registration: decided.value, startedAt, failure: null };
}
async function driveBoundary(input: LaunchLifecycleInput, boundary: SafeBoundary): Promise<Drive> {
  const { limits } = input.request;
  const stdout = captureStream(boundary.stdout, limits.stdoutBytes, limits.tailBytes);
  const stderr = captureStream(boundary.stderr, limits.stderrBytes, limits.tailBytes);
  const started = await startAndRegister(input, boundary);
  if (started.failure !== null) {
    return { stdout, stderr, registration: null, startedAt: "", terminal: null, failure: started.failure };
  }
  const terminal = await waitForTerminal(input, boundary, stdout, stderr);
  return { stdout, stderr, registration: started.registration, startedAt: started.startedAt, terminal,
    failure: terminal.kind === "COMPLETED" && terminal.outcome.kind === "MALFORMED"
      ? boundaryThrown("the completion outcome is not usable") : null };
}
/** Cancel unless the run is PROVEN over; an unobserved end is not an ended process. */
function provenComplete(drive: Drive | null): boolean {
  const terminal = drive?.terminal ?? null;
  return terminal !== null && terminal.kind === "COMPLETED" && terminal.outcome.kind === "PROVEN";
}
interface Closed { readonly outcome: NormalizedOutcome | null; readonly proven: boolean }
async function closeBoundary(cleanup: BoundaryCleanup, cancelFirst: boolean): Promise<Closed> {
  if (cancelFirst) { try { cleanup.cancel(); } catch { /* close stays authoritative */ } }
  try {
    const pending = cleanup.close();
    if (!isSafeNativePromise(pending)) return { outcome: null, proven: false };
    const normalized = normalizeOutcome(await pending);
    return normalized.kind === "MALFORMED"
      ? { outcome: null, proven: false } : { outcome: normalized, proven: true };
  } catch { return { outcome: null, proven: false }; }
}
/** A close reporting an UNKNOWN the run itself never observed is a drift. */
function cleanupDrifted(closed: NormalizedOutcome | null, drive: Drive | null): boolean {
  if (closed === null || closed.kind !== "UNKNOWN") return false;
  const terminal = drive?.terminal ?? null;
  if (terminal === null || terminal.kind !== "COMPLETED") return true;
  return !(terminal.outcome.kind === "UNKNOWN" && terminal.outcome.code === closed.code &&
    terminal.outcome.layer === closed.layer);
}
function buildObservation(input: LaunchLifecycleInput, registration: LaunchLockRegistration,
  streams: readonly [CapturedStream, CapturedStream], exit: ClaudeLaunchExit,
  truthClass: "PROVEN" | "UNKNOWN", uncertainty: Reason | null, startedAt: string,
  completedAt: string): ClaudeLaunchObservation {
  const body = { launcherVersion: CLAUDE_LAUNCHER_VERSION,
    effectDigest: canonicalDigest(input.request.effect), activationDigest: input.activationDigest,
    grantId: input.consumedGrant.grantId, consumedGrantDigest: canonicalDigest(input.consumedGrant),
    runtimeBindingDigest: input.runtime.bindingDigest,
    quotedRuntimeDigest: input.runtime.quotedObservationDigest,
    freshRuntimeDigest: input.runtime.freshObservationDigest,
    pinnedClosureDigest: input.runtime.pinnedClosureDigest,
    lockIdentity: registration.lockIdentity, wrapperIdentity: registration.wrapperIdentity,
    processIdentity: registration.processIdentity, registrationDigest: canonicalDigest(registration),
    stdout: streams[0].evidence, stderr: streams[1].evidence, exit, startedAt, completedAt, truthClass,
    reasonCode: uncertainty?.[0] ?? null, reasonLayer: uncertainty?.[1] ?? null } as const;
  return deepFreeze({ ...body, observationDigest: canonicalDigest(body) });
}
function uncertaintyOf(terminal: Terminal | null, conflict: boolean,
  streams: readonly [CapturedStream, CapturedStream]): Reason | null {
  if (conflict) return ["PROCESS_BOUNDARY_IDENTITY_UNPROVEN", "WINDOWS_PROCESS_TRANSPORT"];
  const reason = terminal === null ? null : terminalReason(terminal);
  if (reason !== null) return reason;
  if (streams[0].failed || streams[1].failed) return ["CLAUDE_LAUNCH_STREAM_ERROR", "OUTPUT"];
  return streams[0].evidence.truncated || streams[1].evidence.truncated
    ? ["CLAUDE_LAUNCH_OUTPUT_TRUNCATED", "OUTPUT"] : null;
}
function bindObservation(input: LaunchLifecycleInput, drive: Drive,
  closed: NormalizedOutcome | null,
  streams: readonly [CapturedStream, CapturedStream]): ClaudeLaunchResult {
  const { registration, terminal } = drive;
  if (registration === null) return boundaryThrown("process registration was not observed");
  const ended = terminal?.kind === "COMPLETED" ? terminal.outcome : null;
  const proofs = [closed, ended].filter((value): value is Proven => value?.kind === "PROVEN");
  const completion = proofs[0] ?? null;
  const conflict = completion !== null && proofs.some((proof) =>
    startedProcessIdentity(proof.identity.pid, proof.identity.creationTime) !== registration.processIdentity ||
    proof.exitCode !== completion.exitCode);
  let observed;
  try {
    observed = normalizeObservation(input.ports.observeProcess(completion === null
      ? { kind: "UNOBSERVED" } : { kind: "EXITED", code: completion.exitCode },
      input.request.reconciliation));
  } catch { return boundaryThrown("process observation threw"); }
  if (observed.kind === "REFUSED") {
    return directFailure(observed.code, observed.layer, "the process observation was refused");
  }
  if (observed.kind === "MALFORMED") return boundaryThrown("the process observation is not usable");
  const completedAt = readInstant(input.ports);
  if (completedAt === null) return boundaryThrown("the completion clock is unusable");
  const uncertainty = uncertaintyOf(terminal, conflict, streams);
  try {
    const truthClass = uncertainty === null && observed.proven ? "PROVEN" : "UNKNOWN";
    return deepFreeze({ kind: "OBSERVED" as const, ok: true as const, truthClass,
      code: uncertainty?.[0] ?? null, layer: uncertainty?.[1] ?? null,
      consumedGrant: input.consumedGrant, registration,
      observation: buildObservation(input, registration, streams, observed.processExit,
        truthClass, uncertainty, drive.startedAt, completedAt) });
  } catch { return boundaryThrown("observation binding threw"); }
}
async function releaseLease(release: Capability): Promise<boolean> {
  try {
    const pending = release();
    if (!isSafeNativePromise(pending)) return false;
    await pending; return true;
  } catch { return false; }
}
export async function settleClaudeLaunch(input: LaunchLifecycleInput): Promise<ClaudeLaunchResult> {
  let adaptation: BoundaryAdaptation = { kind: "UNOWNED" };
  let cleanup: BoundaryCleanup | null = null;
  let boundary: SafeBoundary | null = null;
  let primary: ClaudeLaunchResult | null =
    input.openThrew ? boundaryThrown("the process boundary threw before opening") : null;
  if (!input.openThrew) {
    try { adaptation = adaptBoundaryOpen(input.opened); } catch { /* stays UNOWNED */ }
    if (adaptation.kind === "REFUSAL") {
      primary = directFailure(adaptation.code, adaptation.layer, "the process boundary refused to open");
    } else if (adaptation.kind === "UNOWNED") primary = cleanupUnknown();
    else if (adaptation.kind === "BROKEN") {
      cleanup = adaptation.cleanup; primary = boundaryThrown(BOUNDARY_UNUSABLE);
    } else { boundary = adaptation.boundary; cleanup = adaptation.boundary; }
  }
  const drive = boundary === null ? null : await driveBoundary(input, boundary);
  if (drive?.failure != null) primary = drive.failure;
  if (cleanup !== null) {
    const closed = await closeBoundary(cleanup, !provenComplete(drive));
    const streams = drive === null ? null
      : await Promise.all([drive.stdout, drive.stderr]) as [CapturedStream, CapturedStream];
    if (!closed.proven || cleanupDrifted(closed.outcome, drive)) primary = cleanupUnknown();
    else if (primary === null && drive !== null && streams !== null) {
      primary = bindObservation(input, drive, closed.outcome, streams);
    }
  }
  const result = primary ?? boundaryThrown(BOUNDARY_UNUSABLE);
  return await releaseLease(input.release) ? result
    : directFailure("CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK",
      "OS-exclusive launch lock release is unproven");
}
