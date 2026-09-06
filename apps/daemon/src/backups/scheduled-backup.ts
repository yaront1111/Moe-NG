import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BACKUP_DIRECTORY, BACKUP_LEAF, SCHEDULED_BACKUP_LEAF, backupFailure,
  nodeActivationReceiptPorts, pruneBackups,
} from "../bootstrap/activation-receipts-measure.js";
import type { ActivationReceiptFs } from "../bootstrap/activation-receipts-ports.js";
import { backupFileHash, nodeBackupPorts } from "./backup-ports.js";
import type { BackupPorts, BackupProof } from "./backup-ports.js";

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

/** An environment lock also keeps retention from deleting another run's unverified artifact. */
async function backupOne(
  input: ScheduledBackupInput, environment: string, kind: Attempt["kind"], source: string,
  ports: BackupPorts, fs: ActivationReceiptFs, retention: Retention,
): Promise<ScheduledBackupResult> {
  const state: Attempt = { environment: safeName(environment) ? environment : "INVALID_ENVIRONMENT",
    kind, stage: "WRITE", ref: "", sha256: null, proof: null, failure: null };
  let lock: string | null = null;
  let ownsDestination = false;
  try {
    if (kind === "POSTGRES" && environment === "store") throw new Error("BACKUP_FAILED");
    const directory = directoryFor(input.projectRoot, environment);
    const stamp = (input.now ?? new Date()).toISOString().replaceAll(/\D/gu, "");
    state.ref = join(directory, `${stamp}.${kind === "STORE" ? "sqlite" : "sql"}`);
    const candidateLock = join(directory, ".backup.lock");
    mkdirSync(candidateLock); lock = candidateLock;
    if (existsSync(state.ref)) throw new Error("BACKUP_FAILED");
    assertForwardClock(directory, stamp);
    ownsDestination = true;
    await writeAndRestore(state, source, ports);
    prune(state, directory, fs, retention);
  } catch {
    state.failure = backupFailure();
    if (ownsDestination && state.stage !== "PRUNE") {
      state.proof = null;
      try { rmSync(state.ref, { force: true }); } catch { state.stage = "CLEANUP"; }
    }
  } finally {
    if (lock !== null) {
      try { rmdirSync(lock); }
      catch { state.failure = backupFailure(); state.stage = "CLEANUP"; }
    }
  }
  return Object.freeze({ ...state, status: state.failure === null ? "VERIFIED" : "FAILED" });
}

/** Callable by the daemon's scheduler; never arms a competing timer or returns a connection value. */
export async function runScheduledBackup(
  input: ScheduledBackupInput, ports: BackupPorts = nodeBackupPorts(),
  fs: ActivationReceiptFs = nodeActivationReceiptPorts().fs,
): Promise<ScheduledBackupReceipt> {
  const retention: Retention = { prunedRefs: [], pruneFailedRefs: [] };
  const run = { ...input, now: input.now ?? new Date() };
  const backups = [await backupOne(run, "store", "STORE", input.storePath, ports, fs, retention)];
  const skipped: { environment: string; reason: "DATABASE_ABSENT" }[] = [];
  for (const environment of input.environments) {
    if (environment.databaseUrl === null && safeName(environment.name)) {
      skipped.push(Object.freeze({ environment: environment.name, reason: "DATABASE_ABSENT" }));
    } else {
      backups.push(await backupOne(run, environment.name, "POSTGRES", environment.databaseUrl ?? "", ports, fs, retention));
    }
  }
  return Object.freeze({ schemaVersion: "moe-scheduled-backup/1", backups: Object.freeze(backups),
    skipped: Object.freeze(skipped), prunedRefs: Object.freeze(retention.prunedRefs),
    pruneFailedRefs: Object.freeze(retention.pruneFailedRefs) });
}
