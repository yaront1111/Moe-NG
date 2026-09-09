import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deepFreeze } from "../../canonical.js";
import { type ClaudeLaunchLockLease,
  type ClaudeLaunchLockResult } from "./claude-launcher-contract.js";
/**
 * THE OS-EXCLUSIVE LAUNCH LOCK, held as a WIN32 NAMED PIPE.
 *
 * The disease this replaces was never that a FILE existed. It was that the
 * file was LOAD-BEARING FOR MUTUAL EXCLUSION: exclusion had to judge whether a
 * leftover record's holder was still alive, it judged by recorded PID, and
 * Windows recycles PIDs — so a long-lived process inheriting a dead holder's
 * number impersonated it and wedged the identity for as long as it lived. The
 * wedge was unbounded, and it was indistinguishable from real contention.
 *
 * `listen()` on `\\.\pipe\<prefix>-<sha256(identity)>` is the whole mechanism.
 * Exclusion is kernel-enforced: a second listen on a bound name answers
 * EADDRINUSE (measured — a busy name NEVER answers EBUSY or EACCES; EACCES is
 * the MANGLED-NAME signal, so it stays UNKNOWN and fails closed). Reclaim is
 * kernel-enforced too: the name frees the instant the holder is gone, however
 * it died, including TerminateProcess with no cleanup handler. Nothing records
 * a PID, nothing probes liveness, nothing consults a clock, and there is
 * nothing left behind for a recycled PID to impersonate.
 *
 * What that costs is DIAGNOSIS — a wedged pipe answers EADDRINUSE and nothing
 * else, where a stuck lock file could be read for a PID. The advisory sidecar
 * below buys that back WITHOUT making a file load-bearing again.
 */
const NAMESPACE_ENV = "MOE_CLAUDE_LAUNCH_LOCK_NAMESPACE";
const DEFAULT_NAMESPACE = "moe-claude-launch";
const DEFAULT_SIDECAR_ROOT = join(tmpdir(), "moe-claude-launch-locks");
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SIDECAR_SUFFIX = ".holder";
const BACKSLASH = String.fromCharCode(92);
const PIPE_PREFIX = `${BACKSLASH}${BACKSLASH}.${BACKSLASH}pipe${BACKSLASH}`;

export interface LaunchLockScope {
  readonly namespace: string;
  readonly pipeName: string;
  readonly sidecarRoot: string;
  readonly sidecarPath: string;
}

/**
 * ONE variable scopes BOTH the pipe-name prefix and the sidecar directory, so
 * a test lane and a live provider can never half-share the mutex. Absent, the
 * default sidecar root is byte-identical to the root this module used before,
 * so existing residue and existing lanes keep their shape.
 *
 * The validation is LOAD-BEARING, not hygiene. `\\.\pipe\` is a MACHINE-GLOBAL
 * namespace: a value carrying a backslash escapes it and simultaneously path-
 * traverses the sidecar root. Anything outside the pattern is refused, and the
 * refusal is a null scope the caller turns into CLAUDE_LAUNCH_LOCK_UNKNOWN.
 */
export function resolveLaunchLockScope(lockIdentity: string): LaunchLockScope | null {
  const configured = process.env[NAMESPACE_ENV];
  const namespace = configured === undefined ? DEFAULT_NAMESPACE : configured;
  if (!NAMESPACE_PATTERN.test(namespace)) return null;
  const digest = createHash("sha256").update(lockIdentity).digest("hex");
  const sidecarRoot = namespace === DEFAULT_NAMESPACE
    ? DEFAULT_SIDECAR_ROOT : join(tmpdir(), `moe-claude-launch-locks-${namespace}`);
  return Object.freeze({
    namespace,
    pipeName: `${PIPE_PREFIX}${namespace}-${digest}`,
    sidecarRoot,
    // Built ONCE, here, so no caller can compose a path this module's unlink
    // guard has not seen.
    sidecarPath: join(sidecarRoot, `${digest}${SIDECAR_SUFFIX}`),
  });
}

function lockRefusal(code: "LAUNCH_LOCK_IDENTITY_CONFLICT" | "CLAUDE_LAUNCH_LOCK_UNKNOWN",
  message: string): ClaudeLaunchLockResult {
  return deepFreeze({ ok: false, code, layer: "LAUNCH_LOCK", message });
}

/**
 * ADVISORY ONLY, and that is the entire point: exclusion never reads it, so
 * its residue is inert and a stale one can neither refuse nor admit anybody.
 * It is written immediately after a successful listen — BEFORE the holder can
 * stall — which is why it beats an identity banner served on connect. A banner
 * needs a PUMPING event loop and therefore cannot diagnose a stopped one, and
 * the wedge that motivated this module was exactly a stalled-holder shape.
 */
async function writeSidecar(scope: LaunchLockScope, lockIdentity: string): Promise<void> {
  try {
    await mkdir(scope.sidecarRoot, { recursive: true });
    await writeFile(scope.sidecarPath, JSON.stringify({
      pid: process.pid, identity: lockIdentity, acquiredAt: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
  } catch { /* advisory: a diagnostic that cannot be written is not a failed acquire */ }
}

async function removeSidecar(sidecarPath: string): Promise<void> {
  // The SUFFIX is the guard, not a convention. Pre-existing `.lock` residue
  // shares the default sidecar root and must be unreachable from this unlink
  // even if the digest were somehow chosen by whoever supplies the identity.
  if (!basename(sidecarPath).endsWith(SIDECAR_SUFFIX)) return;
  try { await unlink(sidecarPath); } catch { /* advisory: never makes a release unproven */ }
}

/**
 * Resolves to the listen error, or null once the name is BOUND to this server.
 *
 * The `error` handler registered here deliberately OUTLIVES a successful
 * listen. An error emitted on the server after that point is unhandled
 * otherwise, and an unhandled `error` event ends the process — mid-launch,
 * while this process is the holder.
 */
function listenExclusively(server: ReturnType<typeof createServer>,
  pipeName: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    let settled = false;
    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve(error as NodeJS.ErrnoException);
    });
    server.listen(pipeName, () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}

export async function acquireWindowsLaunchLock(lockIdentity: string): Promise<ClaudeLaunchLockResult> {
  if (process.platform !== "win32") {
    return lockRefusal("CLAUDE_LAUNCH_LOCK_UNKNOWN", "the named-pipe launch lock requires Windows");
  }
  const scope = resolveLaunchLockScope(lockIdentity);
  if (scope === null) {
    return lockRefusal("CLAUDE_LAUNCH_LOCK_UNKNOWN",
      "the OS-exclusive launch lock namespace is not a valid pipe-namespace segment");
  }
  // ACCEPT-AND-DROP, guarded, and it is mandatory in exactly this shape. A
  // server with NO connection handler still accepts and RETAINS a libuv pipe
  // handle per connect (71 after 200 connects, measured, versus 1 here), and a
  // handler that WRITES an identity banner is a remote-crash primitive: a rival
  // that times out and destroys its socket makes the holder's later write throw
  // an unhandled EPIPE and kills it mid-launch (measured cross-process).
  const server = createServer((socket) => {
    socket.on("error", () => { /* a rival that hangs up must never reach the holder */ });
    socket.destroy();
  });
  // NOT unref()'d: the holder's own liveness IS the lock.
  const failure = await listenExclusively(server, scope.pipeName);
  if (failure !== null) {
    // EADDRINUSE is the ONLY code a bound name answers on this platform
    // (measured, sequential and concurrent). Everything else — EACCES for a
    // mangled name included — is unknown and fails closed.
    const conflict = failure.code === "EADDRINUSE";
    return lockRefusal(conflict ? "LAUNCH_LOCK_IDENTITY_CONFLICT" : "CLAUDE_LAUNCH_LOCK_UNKNOWN",
      conflict ? "the OS-exclusive launch lock is already held"
        : "the OS-exclusive launch lock could not be acquired");
  }
  await writeSidecar(scope, lockIdentity);
  let released = false;
  const lease: ClaudeLaunchLockLease = Object.freeze({ release: async (): Promise<void> => {
    if (released) return;
    released = true;
    // A NATIVE promise, awaited. `isSafeNativePromise` gates the release at
    // claude-launcher-lifecycle.ts:287-293, so a thenable or a hand-rolled
    // wrapper reports CLAUDE_LAUNCH_LOCK_UNKNOWN on a release that succeeded.
    // A close that reports an error leaves the release UNPROVEN and throws,
    // exactly as the file lock did.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
    await removeSidecar(scope.sidecarPath);
  } });
  return Object.freeze({ ok: true, lease });
}
