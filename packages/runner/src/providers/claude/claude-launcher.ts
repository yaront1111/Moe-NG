import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepFreeze } from "../../canonical.js";
import { openWindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { resolveDuplicateDelivery } from "../../supervisor/duplicate-delivery.js";
import { consumeActivationGrant, validateActivationCommit, validateRuntimeBinding,
  type RuntimeBindingCheck } from "../../supervisor/effect-grant.js";
import { registerLaunchLock } from "../../supervisor/launch-lock.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import { directFailure, settleClaudeLaunch } from "./claude-launcher-lifecycle.js";
import { decodeCommit, decodeDuplicate, decodeGrant, decodeLease, decodeRegistration,
  decodeRuntime, isSafeNativePromise, snapshotLaunchEntry, snapshotLauncherPorts,
  type DecodedDuplicate, type PortDecision } from "./claude-launcher-port-results.js";
import { pendingProcessIdentity, type ClaudeLaunchDuplicate, type ClaudeLaunchFailure,
  type ClaudeLaunchLockLease, type ClaudeLaunchLockResult, type ClaudeLaunchOptions,
  type ClaudeLaunchResult, type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";
import { snapshotClaudeLaunchRequest } from "./claude-launcher-input.js";
export * from "./claude-launcher-contract.js";
/**
 * The ordered launch facade.
 *
 * Every gate runs before a provider process can exist: runtime re-observation,
 * activation commit, the one-use grant, durable launch-lock preflight, then the
 * OS-exclusive lock. Each port is invoked and DECODED inside the same
 * containment, because a fulfilled hostile record that is inspected after the
 * `catch` rejects the public promise just as effectively as a throw. Once the
 * lock is held, `settleClaudeLaunch` owns the single exit.
 */
/**
 * The shipped production port set. Exported for the durable-authority overlay in
 * this package to compose; it is deliberately NOT on the published seam, because
 * a consumer that could take these one at a time could replace the Windows
 * physical boundary alone and keep every other guarantee's appearance.
 */
export const CLAUDE_LAUNCHER_DEFAULTS: ClaudeLauncherDependencies = Object.freeze({
  prepareRuntime: prepareClaudeRuntimePin,
  resolveDuplicate: resolveDuplicateDelivery,
  validateCommit: validateActivationCommit,
  consumeGrant: consumeActivationGrant,
  acquireLock: acquireWindowsLaunchLock,
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
const REQUEST_MALFORMED = "launch request is not bounded plain data";
const PHASE = Object.freeze({
  duplicate: "the duplicate-delivery authority did not answer usably",
  runtime: "runtime preparation did not answer usably",
  activation: "the activation-commit authority did not answer usably",
  binding: "the prepared runtime is not the runtime this activation committed",
  grant: "the activation-grant authority did not answer usably",
  preflight: "durable launch-lock preflight did not answer usably",
  lock: "the OS-exclusive launch lock did not answer usably",
});
const MALFORMED: PortDecision<never> = Object.freeze({ kind: "MALFORMED" as const });
const malformed = (message: string, truthClass: "UNKNOWN" | "UNSUPPORTED" = "UNKNOWN"): ClaudeLaunchFailure =>
  deepFreeze({ kind: "REFUSED", ok: false, truthClass,
    code: truthClass === "UNSUPPORTED" ? "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED" : "CLAUDE_LAUNCH_REQUEST_MALFORMED",
    layer: "LAUNCHER", message });
function duplicateResult(decoded: DecodedDuplicate): ClaudeLaunchDuplicate {
  return deepFreeze({ kind: decoded.kind, ok: true, truthClass: "PROVEN", code: null, layer: null,
    launched: false, processIdentity: decoded.processIdentity });
}
/** Invocation AND interpretation share one containment; neither may escape. */
function contained<T>(call: () => unknown, decode: (value: unknown) => PortDecision<T>): PortDecision<T> {
  try { return decode(call()); } catch { return MALFORMED; }
}
async function containedAsync<T>(
  call: () => unknown, decode: (value: unknown) => PortDecision<T>,
): Promise<PortDecision<T>> {
  try {
    const pending = call();
    return isSafeNativePromise(pending) ? decode(await pending) : MALFORMED;
  } catch { return MALFORMED; }
}
const LOCK_ROOT = join(tmpdir(), "moe-claude-launch-locks");
export async function acquireWindowsLaunchLock(lockIdentity: string): Promise<ClaudeLaunchLockResult> {
  const path = join(LOCK_ROOT, `${createHash("sha256").update(lockIdentity).digest("hex")}.lock`);
  let handle;
  try {
    await mkdir(LOCK_ROOT, { recursive: true });
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    const conflict = (error as NodeJS.ErrnoException).code === "EEXIST";
    return deepFreeze({ ok: false, code: conflict ? "LAUNCH_LOCK_IDENTITY_CONFLICT" :
      "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
      message: conflict ? "the OS-exclusive launch lock is already held" :
        "the OS-exclusive launch lock could not be acquired" });
  }
  let released = false;
  const lease: ClaudeLaunchLockLease = Object.freeze({ release: async (): Promise<void> => {
    if (released) return;
    released = true;
    let failed = false;
    try { await handle.close(); } catch { failed = true; }
    try { await unlink(path); } catch { failed = true; }
    if (failed) throw new Error("OS-exclusive launch lock release is unproven");
  } });
  return Object.freeze({ ok: true, lease });
}
export async function launchClaude(
  value: unknown, options: ClaudeLaunchOptions = {},
): Promise<ClaudeLaunchResult> {
  const entry = snapshotLaunchEntry(options, process.platform);
  if (entry === null) return malformed("launch options are not bounded plain data");
  if (entry.platform !== "win32") {
    return malformed("Claude launch is supported only on win32", "UNSUPPORTED");
  }
  let snapshot;
  try { snapshot = snapshotClaudeLaunchRequest(value); } catch { return malformed(REQUEST_MALFORMED); }
  if (snapshot === null) return malformed(REQUEST_MALFORMED);
  const request = snapshot;
  const ports = snapshotLauncherPorts(entry.deps ?? CLAUDE_LAUNCHER_DEFAULTS);
  if (ports === null) return malformed("the launcher dependency capabilities are unusable");
  if (request.duplicateDelivery !== null) {
    const decided = contained(() => ports.resolveDuplicate(request.duplicateDelivery), decodeDuplicate);
    if (decided.kind === "REFUSED") return directFailure(decided.code, decided.layer, PHASE.duplicate);
    if (decided.kind === "MALFORMED") {
      return directFailure("CLAUDE_LAUNCH_DEPENDENCY_THROWN", "LAUNCH_LOCK", PHASE.duplicate);
    }
    return duplicateResult(decided.value);
  }
  const runtime = await containedAsync(() => ports.prepareRuntime(request.runtime), decodeRuntime);
  if (runtime.kind === "REFUSED") return directFailure(runtime.code, runtime.layer, PHASE.runtime);
  if (runtime.kind === "MALFORMED") {
    return directFailure("CLAUDE_LAUNCH_RUNTIME_THROWN", "RUNTIME", PHASE.runtime);
  }
  const commit = contained(
    () => ports.validateCommit(request.effect, request.attempt, request.grant), decodeCommit);
  if (commit.kind === "REFUSED") return directFailure(commit.code, commit.layer, PHASE.activation);
  if (commit.kind === "MALFORMED") {
    return directFailure("CLAUDE_LAUNCH_DEPENDENCY_THROWN", "ACTIVATION", PHASE.activation);
  }
  // A coherent activation for runtime A must not launch pinned runtime B. This
  // is the supervisor's own comparison, not a launcher-local copy, so the code
  // and layer pass through untranslated. The quoted digest is the operand: the
  // fresh one covers the pinned closure and can never equal the quote. Direct
  // import, so the throw containment every port already has is added here.
  let bound: RuntimeBindingCheck;
  try {
    bound = validateRuntimeBinding(request.effect, runtime.value.quotedObservationDigest);
  } catch {
    return directFailure("CLAUDE_LAUNCH_DEPENDENCY_THROWN", "ACTIVATION", PHASE.binding);
  }
  if (bound.kind === "REFUSED") {
    return directFailure(bound.failure.code, bound.failure.layer, PHASE.binding);
  }
  const grant = contained(
    () => ports.consumeGrant(request.grant, request.wrapperIdentity), decodeGrant);
  if (grant.kind === "REFUSED") return directFailure(grant.code, grant.layer, PHASE.grant);
  if (grant.kind === "MALFORMED") {
    return directFailure("CLAUDE_LAUNCH_DEPENDENCY_THROWN", "GRANT", PHASE.grant);
  }
  const preflight = contained(() => ports.registerLock({
    lockIdentity: (request.claim as { lockIdentity?: unknown }).lockIdentity,
    wrapperIdentity: request.wrapperIdentity,
    processIdentity: pendingProcessIdentity(request.wrapperIdentity),
    bootstrapCredentialDigest: request.bootstrapCredentialDigest, registeredAt: ports.now(),
  }, request.claim, request.priorRegistration), decodeRegistration);
  if (preflight.kind === "REFUSED") {
    return directFailure(preflight.code, preflight.layer, PHASE.preflight);
  }
  if (preflight.kind === "MALFORMED") {
    return directFailure("CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK", PHASE.preflight);
  }
  const lease = await containedAsync(
    () => ports.acquireLock(preflight.value.lockIdentity), decodeLease);
  if (lease.kind === "REFUSED") return directFailure(lease.code, lease.layer, PHASE.lock);
  if (lease.kind === "MALFORMED") {
    return directFailure("CLAUDE_LAUNCH_LOCK_UNKNOWN", "LAUNCH_LOCK", PHASE.lock);
  }
  let opened: unknown = null;
  let openThrew = false;
  try {
    opened = ports.openBoundary({ executable: runtime.value.executablePath, argv: request.argv,
      cwd: request.cwd, environment: request.environment }, { timeoutMs: request.limits.timeoutMs });
  } catch { openThrew = true; }
  return await settleClaudeLaunch({ request, runtime: runtime.value, opened, openThrew,
    activationDigest: commit.value, consumedGrant: grant.value, release: lease.value.release,
    ports, signal: entry.signal });
}
