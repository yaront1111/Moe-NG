import { randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, backupFailure,
  nodeActivationReceiptPorts, pruneBackups,
} from "../bootstrap/activation-receipts-measure.js";
import type { ActivationReceiptFs } from "../bootstrap/activation-receipts-ports.js";
import { probeProcessAlive } from "../orchestrator/process-runner-lifecycle.js";
import { backupFileHash, nodeBackupPorts } from "./backup-ports.js";
import type { BackupPorts, BackupProof } from "./backup-ports.js";
import type { BackupRestoreProofStore } from "./backup-restore-proof.js";

export interface ScheduledBackupInput {
  readonly projectRoot: string;
  readonly storePath: string;
  readonly environments: readonly { readonly name: string; readonly databaseUrl: string | null }[];
  readonly now?: Date;
}
type Stage = "WRITE" | "RESTORE" | "PRUNE" | "CLEANUP";
export interface ScheduledBackupResult {
  readonly environment: string;
  readonly kind: "STORE" | "POSTGRES";
  readonly status: "VERIFIED" | "FAILED";
  readonly ref: string;
  readonly sha256: string | null;
  readonly proof: BackupProof | null;
  readonly failure: ReturnType<typeof backupFailure> | null;
  readonly stage: Stage;
}
export interface ScheduledBackupReceipt {
  readonly schemaVersion: "moe-scheduled-backup/1";
  readonly backups: readonly ScheduledBackupResult[];
  readonly skipped: readonly { readonly environment: string; readonly reason: "DATABASE_ABSENT" }[];
  readonly prunedRefs: readonly string[];
  readonly pruneFailedRefs: readonly string[];
}
interface Attempt {
  environment: string; kind: "STORE" | "POSTGRES"; stage: Stage;
  ref: string; sha256: string | null; proof: BackupProof | null;
  failure: ReturnType<typeof backupFailure> | null;
}
interface AttemptResult {
  readonly backup: ScheduledBackupResult;
  readonly ownsDestination: boolean;
  /** The restore check's own verdict, fixed the moment the check ran. `backup.status` is the
   * RUN's outcome and also turns FAILED when retention or the lock release fails AFTER the check
   * proved the artifact, so it cannot stand in for this. */
  readonly restoreCheck: ScheduledBackupResult["status"];
}
interface Retention { prunedRefs: string[]; pruneFailedRefs: string[] }
const safeName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(name);

/** Refuse symlinked subtrees instead of letting one environment escape into another's backups. */
function directoryFor(root: string, environment: string): string {
  if (!safeName(environment)) throw new Error("BACKUP_FAILED");
  let directory = realpathSync(root);
  for (const part of [BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, environment]) {
    directory = join(directory, part);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BACKUP_FAILED");
  }
  return directory;
}

async function writeAndRestore(state: Attempt, source: string, ports: BackupPorts): Promise<void> {
  if (state.kind === "STORE") await ports.store(source, state.ref);
  else await ports.database(source, state.ref);
  state.stage = "RESTORE";
  state.sha256 = await backupFileHash(state.ref);
  const proof = state.kind === "STORE"
    ? await ports.restoreStore(state.ref) : await ports.restoreDatabase(state.ref);
  if (proof.sha256 !== state.sha256 || proof.restoredSha256 !== state.sha256) throw new Error("BACKUP_FAILED");
  state.proof = Object.freeze({ ...proof });
}

function prune(state: Attempt, directory: string, fs: ActivationReceiptFs, retention: Retention): void {
  state.stage = "PRUNE";
  const result = pruneBackups({ fs }, directory, state.ref);
  retention.prunedRefs.push(...result.removedRefs);
  retention.pruneFailedRefs.push(...result.failedRefs);
  state.failure = result.failure;
}

/** A backwards clock must not bypass the retention bound by pinning an older new artifact. */
function assertForwardClock(directory: string, stamp: string): void {
  if (!/^\d{17}$/u.test(stamp) || readdirSync(directory).some(name =>
    /^\d{17}\.(?:sqlite|sql)$/u.test(name) && name.slice(0, 17) > stamp)) throw new Error("BACKUP_FAILED");
}

const LOCK_LEAF = ".backup.lock";
const LOCK_OWNER_LEAF = "owner";
/**
 * The run-length ceiling for EVERY lock. No run holds one this long (each docker call inside a
 * run is bounded at 120 s), so an older lock is a corpse whatever its owner file says: a live pid
 * vouches for a holder only inside this ceiling, because pids are recycled - after a crash and a
 * reboot the dead daemon's pid routinely names an unrelated long-lived process, and `kill(pid, 0)`
 * answers EPERM=alive for every system service. An ownerless lock (a crash between `mkdirSync`
 * and the owner write, or a build that predates the owner file) has only this rule. Wall clock,
 * deliberately: it is compared with the directory's mtime, not with the run's stamp clock, which
 * a caller may pin.
 */
export const BACKUP_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const PID = /^[1-9]\d{0,9}$/u;

function lockOwner(lock: string): number | null {
  try {
    const text = readFileSync(join(lock, LOCK_OWNER_LEAF), "utf8").trim();
    return PID.test(text) ? Number(text) : null;
  } catch { return null; }
}

/**
 * A corpse is a lock older than any run can be, or a younger one whose named owner no longer
 * exists. Everything else - a younger lock with a live or unnamed owner, an owner this process
 * may not probe, a file or a symlink standing at the lock's path - is a HOLDER and is never
 * evicted: evicting a live writer is the double write the lock exists to prevent, and a wedge is
 * the safer error. `probeProcessAlive` throws on an unknown probe failure, and the caller's catch
 * turns that into the same refusal, so unknown is never read as dead.
 */
function lockIsStale(lock: string): boolean {
  const stat = lstatSync(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (Date.now() - stat.mtimeMs > BACKUP_LOCK_STALE_AFTER_MS) return true;
  const owner = lockOwner(lock);
  return owner !== null && !probeProcessAlive(owner);
}

/**
 * A reaper that took a live holder's lock and could not put it back (see `acquireLock`) leaves
 * it stranded under its corpse name, still holding the owner file. The same judge clears it once
 * the holder is gone or the bound has passed. Best effort, under the lock: a strand that will not
 * go today waits for the next run and never costs a backup - nor may it throw here, where the
 * lock is held but not yet handed to the `finally` that releases it.
 */
function sweepStrandedLocks(directory: string): void {
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(`${LOCK_LEAF}.`)) continue;
    const stranded = join(directory, name);
    try { if (lockIsStale(stranded)) rmSync(stranded, { force: true, recursive: true }); }
    catch { /* Kept for the next run's sweep. */ }
  }
}

/**
 * `mkdirSync` is the atomic claim: of two contenders exactly one gets it and the other EEXIST. A
 * corpse is claimed the same way - RENAMED aside first, so two reapers cannot both remove it and
 * both create a lock behind it - then judged again under its new name and put back if what was
 * taken is not the corpse that was judged (a live holder re-created the lock in between). The
 * claim is retried once and never loops. An owner this process could not name is released at
 * once, so a failed write does not leave an ownerless lock for the age rule to find hours later.
 *
 * THAT IS SAFE AGAINST ONE OTHER CONTENDER, NOT MORE. Two reapers of one corpse can leave a fresh
 * lock nobody holds at the path - the second takes the first's lock inside its mkdir-to-owner
 * window and puts it back after the first gave up - which the age rule clears. A third contender
 * claiming inside that put-back window strands the live holder's lock under its corpse name and
 * lets two writers overlap; `sweepStrandedLocks` clears the strand once that holder is gone.
 * Both need runs of one environment overlapping inside a window that holds no await.
 */
function acquireLock(directory: string): string {
  const lock = join(directory, LOCK_LEAF);
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lockIsStale(lock)) throw error;
    const corpse = `${lock}.${randomUUID()}`;
    renameSync(lock, corpse);
    if (!lockIsStale(corpse)) { renameSync(corpse, lock); throw new Error("BACKUP_FAILED"); }
    rmSync(corpse, { force: true, recursive: true });
    mkdirSync(lock);
  }
  try { writeFileSync(join(lock, LOCK_OWNER_LEAF), String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) { try { rmdirSync(lock); } catch { /* Already gone; the refusal below stands. */ } throw error; }
  sweepStrandedLocks(directory);
  return lock;
}

/** The owner file first, then the directory: anything else inside it is a release failure. */
function releaseLock(lock: string): void {
  rmSync(join(lock, LOCK_OWNER_LEAF), { force: true });
  rmdirSync(lock);
}

/** An environment lock also keeps retention from deleting another run's unverified artifact. */
async function backupOne(
  input: ScheduledBackupInput, environment: string, kind: Attempt["kind"], source: string,
  ports: BackupPorts, fs: ActivationReceiptFs, retention: Retention,
): Promise<AttemptResult> {
  const state: Attempt = { environment: safeName(environment) ? environment : "INVALID_ENVIRONMENT",
    kind, stage: "WRITE", ref: "", sha256: null, proof: null, failure: null };
  let lock: string | null = null;
  let ownsDestination = false;
  let restoreCheck: AttemptResult["restoreCheck"] = "FAILED";
  try {
    if (kind === "POSTGRES" && environment === "store") throw new Error("BACKUP_FAILED");
    const directory = directoryFor(input.projectRoot, environment);
    const stamp = (input.now ?? new Date()).toISOString().replaceAll(/\D/gu, "");
    state.ref = join(directory, `${stamp}.${kind === "STORE" ? "sqlite" : "sql"}`);
    lock = acquireLock(directory);
    if (existsSync(state.ref)) throw new Error("BACKUP_FAILED");
    assertForwardClock(directory, stamp);
    ownsDestination = true;
    await writeAndRestore(state, source, ports);
    restoreCheck = "VERIFIED";
    prune(state, directory, fs, retention);
  } catch {
    state.failure = backupFailure();
    if (ownsDestination && state.stage !== "PRUNE") {
      state.proof = null;
      try { rmSync(state.ref, { force: true }); } catch { state.stage = "CLEANUP"; }
    }
  } finally {
    if (lock !== null) {
      try { releaseLock(lock); }
      catch { state.failure = backupFailure(); state.stage = "CLEANUP"; }
    }
  }
  return { backup: Object.freeze({ ...state, status: state.failure === null ? "VERIFIED" : "FAILED" }),
    ownsDestination, restoreCheck };
}

/** The write half of the durable restore-proof record. Narrowed to the one method this module
 * needs, so a caller cannot be handed a reader it has no business calling. */
export type ScheduledBackupProofWriter = Pick<BackupRestoreProofStore, "recordChecked">;

/**
 * ONE RESTORE-PROOF RECORD PER ATTEMPT THAT OWNED ITS DESTINATION.
 *
 * Deliberately AFTER every attempt has returned: `backupOne` releases its lock and removes its
 * own material in its `finally` before it hands a result back, so nothing here can leak a
 * directory, a lock or a temp artifact on any exit path - including the failure ones.
 *
 * THE RESTORE CHECK'S VERDICT IS RECORDED, NOT THE RUN'S OUTCOME. `backup.status` also turns
 * FAILED when retention or the lock release fails AFTER the check proved the artifact; forwarding
 * it stored restoreProof=FAILED beside the verified digest for a backup that is proven restorable,
 * and an operator mid-incident skipped the newest good backup for an older one - the collapse the
 * record module's header says the bridge exists to prevent. `restoreCheck` is fixed in `backupOne`
 * the moment the check passed, where nothing after it can touch it.
 *
 * NOTHING HERE RE-DERIVES THE STATE. That verdict travels into the record module's exhaustive
 * bridge untouched; a second mapping of one fact is how the two drift, and the drift would land
 * on PROVEN. Because the bridge's parameter is `"VERIFIED" | "FAILED"`, a future widening of
 * `ScheduledBackupResult.status` fails to compile HERE, at the call site, rather than silently
 * mapping a new outcome onto a proof.
 *
 * WHAT IS DELIBERATELY NOT RECORDED. A SKIPPED environment (`DATABASE_ABSENT`) never reaches
 * this loop. A lock, destination collision or clock refusal also owns no artifact: recording
 * that attempt would overwrite another run's restore proof or invent a backup never attempted.
 * Ownership is captured at admission to the write, so genuine write/restore failures still
 * record FAILED even when cleanup removed their incomplete artifact.
 *
 * A REFUSED RECORD NEVER FAILS THE RUN. The record admits a stricter environment name than the
 * filesystem guard above does (the served surface shares one environment vocabulary with the
 * deploy and health reads), so a write can refuse. Aborting a backup that already succeeded
 * because its proof row would not store is strictly worse than the missing row, and this
 * function's behaviour is a delivered contract that must not change.
 */
function persistRestoreProofs(
  attempts: readonly AttemptResult[], proofs: ScheduledBackupProofWriter, checkedAt: string,
): void {
  for (const { backup: result, ownsDestination, restoreCheck } of attempts) {
    if (!ownsDestination || result.ref === "") continue;
    proofs.recordChecked({
      checkedAt, environment: result.environment, kind: result.kind,
      ref: basename(result.ref), sha256: result.sha256, status: restoreCheck,
    });
  }
}

/** Callable by the daemon's scheduler; never arms a competing timer or returns a connection value.
 * `proofs` is ADDITIVE and optional: absent, the run behaves exactly as it did before this
 * parameter existed, which is what keeps the delivered receipt contract intact. */
export async function runScheduledBackup(
  input: ScheduledBackupInput, ports: BackupPorts = nodeBackupPorts(),
  fs: ActivationReceiptFs = nodeActivationReceiptPorts().fs,
  proofs?: ScheduledBackupProofWriter,
): Promise<ScheduledBackupReceipt> {
  const retention: Retention = { prunedRefs: [], pruneFailedRefs: [] };
  const run = { ...input, now: input.now ?? new Date() };
  const attempts = [await backupOne(run, "store", "STORE", input.storePath, ports, fs, retention)];
  const skipped: { environment: string; reason: "DATABASE_ABSENT" }[] = [];
  for (const environment of input.environments) {
    if (environment.databaseUrl === null && safeName(environment.name)) {
      skipped.push(Object.freeze({ environment: environment.name, reason: "DATABASE_ABSENT" }));
    } else {
      attempts.push(await backupOne(run, environment.name, "POSTGRES", environment.databaseUrl ?? "", ports, fs, retention));
    }
  }
  if (proofs !== undefined) persistRestoreProofs(attempts, proofs, run.now.toISOString());
  return Object.freeze({ schemaVersion: "moe-scheduled-backup/1",
    backups: Object.freeze(attempts.map(attempt => attempt.backup)),
    skipped: Object.freeze(skipped), prunedRefs: Object.freeze(retention.prunedRefs),
    pruneFailedRefs: Object.freeze(retention.pruneFailedRefs) });
}
