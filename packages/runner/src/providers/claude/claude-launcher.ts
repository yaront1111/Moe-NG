import { createHash } from "node:crypto";
import { readFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepFreeze } from "../../canonical.js";
import { CANCEL_GRACE_MS, openWindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { resolveDuplicateDelivery } from "../../supervisor/duplicate-delivery.js";
import { consumeActivationGrant, validateActivationCommit, validateRuntimeBinding,
  type RuntimeBindingCheck } from "../../supervisor/effect-grant.js";
import { registerLaunchLock } from "../../supervisor/launch-lock.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import { CLAUDE_LAUNCH_SELECTION_LAYER,
  type ClaudeLaunchSelectionVerdict } from "./claude-launch-selection.js";
import { verifyLaunchSelection } from "./claude-launch-verify.js";
import { directFailure, settleClaudeLaunch } from "./claude-launcher-lifecycle.js";
import { decodeCommit, decodeDuplicate, decodeGrant, decodeLease, decodeRegistration,
  decodeRuntime, isSafeNativePromise, snapshotLaunchEntry, snapshotLauncherPorts,
  type DecodedDuplicate, type PortDecision } from "./claude-launcher-port-results.js";
import { pendingProcessIdentity, type ClaudeLaunchDuplicate, type ClaudeLaunchFailure,
  type ClaudeLaunchLockLease, type ClaudeLaunchLockResult, type ClaudeLaunchOptions,
  type ClaudeLaunchResult, type ClaudeLauncherDependencies } from "./claude-launcher-contract.js";
import { HOSTILE_LAUNCH_OPERAND, snapshotClaudeLaunchRequest } from "./claude-launcher-input.js";
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
/**
 * Padding for the physical boundary's INTERNAL launch timer. The lifecycle's
 * `ports.delay(limits.timeoutMs)` is the authoritative deadline — it is the
 * arm that names a late run CLAUDE_LAUNCH_TIMEOUT at LAUNCHER — while the
 * boundary's own timer exists only as the crash-safety backstop for a
 * lifecycle that never gets to act. Armed with the SAME duration the two race
 * and the boundary's always wins: it is armed at open, the delay only after
 * `started` and registration, so it fires first, tears the provider channels
 * down, and the fault arm misreports the deadline as
 * CLAUDE_LAUNCH_STREAM_ERROR at OUTPUT. Merely arming the delay earlier would
 * leave two same-duration timers racing microtasks apart; the backstop must
 * TRAIL the deadline by the grace the boundary itself grants a cancelled
 * broker to settle, so it can only fire once the deadline demonstrably never
 * did.
 */
export const BOUNDARY_TIMEOUT_SLACK_MS = CANCEL_GRACE_MS;
const PHASE = Object.freeze({
  duplicate: "the duplicate-delivery authority did not answer usably",
  // Its own message, never another phase's, and deliberately free of every
  // operand: naming the model, the effort or a flag here would echo the
  // caller's configuration back out of a failure path.
  selection: "the launch arguments do not prove the selection this launch declared",
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

/**
 * The recorded holder is dead only when the PID parses AND the signal-0 probe
 * says no such process. An unreadable or malformed lock file keeps the
 * conflict — fail closed; a live-but-unowned PID also keeps it (PID reuse can
 * make a dead holder look alive, which delays reclaim but never breaks mutual
 * exclusion — the unsafe direction would be reclaiming a live holder's lock).
 */
async function recordedHolderPid(path: string): Promise<number | null> {
  let recorded: string;
  try { recorded = await readFile(path, "utf8"); } catch { return null; }
  if (!/^\d{1,10}$/u.test(recorded.trim())) return null;
  const pid = Number(recorded.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function pidIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * The rename-arbitrated half of stale-lock reclaim, taking the dead PID the
 * caller already judged. Judging by content and then deleting by PATH is a
 * window two racers can both fall through: Windows opens with
 * FILE_SHARE_DELETE, so the loser's unlink lands on whatever the name means
 * by then — including the winner's freshly created live lock — and both
 * "hold" the same identity. The reap is therefore arbitrated by rename:
 * exactly one racer moves the file aside, and a racer whose rename fails has
 * lost the arbitration — that IS the conflict, never grounds to retry a
 * judgment made about a file that is no longer there. The judgment is then
 * re-run on the REAPED file, because the window between the caller's probe
 * and the rename can admit a fresh live lock; a record that no longer names
 * the same dead holder is renamed back and the conflict stands.
 *
 * Exported for direct proof only, never for composition: both verdicts of the
 * re-judgment live between two filesystem operations that no caller-visible
 * schedule can pin a racer inside.
 */
export async function reapStaleLaunchLock(
  path: string, deadPid: number,
): Promise<"REAPED" | "CONFLICT"> {
  const reapPath = `${path}.reap-${process.pid}`;
  try { await rename(path, reapPath); } catch { return "CONFLICT"; }
  const reaped = await recordedHolderPid(reapPath);
  if (reaped === deadPid && pidIsDead(reaped)) {
    try { await unlink(reapPath); } catch { /* the reap name is out of the lock's way */ }
    return "REAPED";
  }
  try { await rename(reapPath, path); } catch { /* the displaced holder's own binding guard answers */ }
  return "CONFLICT";
}

export async function acquireWindowsLaunchLock(lockIdentity: string): Promise<ClaudeLaunchLockResult> {
  const path = join(LOCK_ROOT, `${createHash("sha256").update(lockIdentity).digest("hex")}.lock`);
  let handle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(LOCK_ROOT, { recursive: true });
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      const conflict = (error as NodeJS.ErrnoException).code === "EEXIST";
      // ONE reclaim attempt: a crash between open and release leaves the file
      // behind forever, so a conflict whose recorded holder is provably dead
      // is reaped and retried exactly once. Every other failure stands.
      if (conflict && attempt === 0) {
        const holder = await recordedHolderPid(path);
        if (holder !== null && pidIsDead(holder)
          && await reapStaleLaunchLock(path, holder) === "REAPED") continue;
      }
      return deepFreeze({ ok: false, code: conflict ? "LAUNCH_LOCK_IDENTITY_CONFLICT" :
        "CLAUDE_LAUNCH_LOCK_UNKNOWN", layer: "LAUNCH_LOCK",
        message: conflict ? "the OS-exclusive launch lock is already held" :
          "the OS-exclusive launch lock could not be acquired" });
    }
  }
  // Record the holder so a LATER acquirer can judge liveness after a crash.
  try { await handle.write(String(process.pid), 0, "utf8"); } catch { /* advisory */ }
  // `open("wx")` proved the NAME was free, not that it stays bound to this
  // file: a reclaimer judging a stale record can rename this fresh lock aside
  // in the same instant. The lock is held only while the name still denotes
  // this holder's own file; on any disagreement — or an unanswerable probe —
  // the handle is surrendered as a conflict rather than held on faith.
  let bound = false;
  try {
    const held = await handle.stat({ bigint: true });
    const named = await stat(path, { bigint: true });
    bound = held.ino === named.ino && held.dev === named.dev;
  } catch { /* stays unbound */ }
  if (!bound) {
    try { await handle.close(); } catch { /* the refusal below already answers */ }
    return deepFreeze({ ok: false, code: "LAUNCH_LOCK_IDENTITY_CONFLICT", layer: "LAUNCH_LOCK",
      message: "the OS-exclusive launch lock did not stay bound to its holder" });
  }
  let released = false;
  const lease: ClaudeLaunchLockLease = Object.freeze({ release: async (): Promise<void> => {
    if (released) return;
    released = true;
    let failed = false;
    // Unlinking by NAME what was held by HANDLE deletes whatever the name
    // means NOW — after a crash-reclaim cycle that can be a successor's live
    // lock. The name is removed only while it still denotes this holder's
    // file; a name already rebound or gone is a successor's to manage, and an
    // unanswerable probe leaves the file and reports the release unproven.
    let owned: boolean | null = null;
    try {
      const held = await handle.stat({ bigint: true });
      const named = await stat(path, { bigint: true });
      owned = held.ino === named.ino && held.dev === named.dev;
    } catch (error) {
      owned = (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
    }
    try { await handle.close(); } catch { failed = true; }
    if (owned === true) { try { await unlink(path); } catch { failed = true; } }
    if (failed || owned === null) throw new Error("OS-exclusive launch lock release is unproven");
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
  // A hostile argv or environment is a SELECTION defect, and it is answered
  // here rather than at the gate below because the gate can only see operands
  // the snapshot already reflected over — which is precisely the reflection
  // that must not happen. The refusal is the gate's, the position is earlier.
  if (snapshot === HOSTILE_LAUNCH_OPERAND) {
    return directFailure("CLAUDE_LAUNCH_SELECTION_MALFORMED",
      CLAUDE_LAUNCH_SELECTION_LAYER, PHASE.selection);
  }
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
  // WHAT is being launched has to be proven before anything can exist to launch
  // it. This sits ahead of runtime preparation, grant consumption, lock
  // acquisition and the boundary open, so a selection argv does not corroborate
  // reaches none of them. Duplicate resolution is deliberately AHEAD of it:
  // adoption opens no process and consumes no grant, and the process it adopts
  // was gated by the launch that created it.
  //
  // The environment goes in with argv because the SAME environment is forwarded
  // to the boundary below, and the provider lets it override what argv asked
  // for. Checking argv alone would prove the request, not the launch.
  let selection: ClaudeLaunchSelectionVerdict;
  try {
    selection = verifyLaunchSelection(request.launchSelection, request.argv, request.environment);
  } catch {
    return directFailure("CLAUDE_LAUNCH_SELECTION_MALFORMED",
      CLAUDE_LAUNCH_SELECTION_LAYER, PHASE.selection);
  }
  if (!selection.ok) return directFailure(selection.code, selection.layer, PHASE.selection);
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
      cwd: request.cwd, environment: request.environment },
    { timeoutMs: request.limits.timeoutMs + BOUNDARY_TIMEOUT_SLACK_MS });
  } catch { openThrew = true; }
  return await settleClaudeLaunch({ request, runtime: runtime.value, opened, openThrew,
    activationDigest: commit.value, consumedGrant: grant.value, release: lease.value.release,
    ports, signal: entry.signal });
}
