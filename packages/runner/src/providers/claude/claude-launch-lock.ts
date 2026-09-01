import { createHash } from "node:crypto";
import { readFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepFreeze } from "../../canonical.js";
import { type ClaudeLaunchLockLease,
  type ClaudeLaunchLockResult } from "./claude-launcher-contract.js";
/**
 * THE OS-EXCLUSIVE LAUNCH LOCK, and the rename-arbitrated reclaim of a lock a
 * crashed holder left behind.
 *
 * Split out of claude-launcher.ts VERBATIM (task-d8650fec) so the facade stays
 * inside the per-file line cap; nothing here changed. It is a separate concern
 * from the ordered launch facade in every sense that matters: it touches the
 * filesystem, it is the only part of the launcher a crashed PREDECESSOR can
 * still affect, and its two exported functions are the ones proven directly.
 */
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
