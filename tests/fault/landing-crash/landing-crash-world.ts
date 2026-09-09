/**
 * FIXTURES AND MEASUREMENTS for the mid-write landing crash. FIXTURES ONLY.
 *
 * Nothing here grades anything. It builds a real Git repository and a real store file,
 * starts the child process that runs one production landing pass, and reads back two
 * durable records: the SQLite decision ledger (by SQL) and the Git branch (by git). Every
 * verdict the .fault.ts file asserts is computed from those readings or from a production
 * function; a helper that judged its own fixtures would let this lane agree with itself
 * while the shipped surface drifted away.
 *
 * WHY THE LEDGER IS READ WITH SQL RATHER THAN THROUGH THE STORE. DoD 2 asks for a store
 * query quoted with its result, and the property under test is a ROW COUNT: exactly one
 * outcome for the landing, never duplicated, never lost. A reader that returns the latest
 * decision cannot see a second one, so counting through a reader would be structurally
 * unable to fail. The SQL below counts rows in command_decisions, which is where
 * writeRecoveryFact puts them.
 *
 * The database is opened READ-WRITE for the query on purpose: a SIGKILLed writer leaves a
 * live WAL, and SQLite needs write access to recover it. Only SELECTs are issued.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { resolveRepositoryExecutionIdentity } from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { repositoryRecoveryOwnerDigest } from "../../../apps/daemon/src/repository/repository-landing-intent.js";
import { LANDING_PASS_RESULT_PREFIX, LANDING_PASS_WORLD_ENV } from "./landing-crash-child.js";
import type { LandingPassResult, LandingPassWorld } from "./landing-crash-child.js";

const CHILD = fileURLToPath(new URL("./landing-crash-child.ts", import.meta.url));
/** The one file the landing delivers. prepareDeliveredTree requires the set to match exactly. */
export const DELIVERED_PATH = "owned.txt";
export const LANDING_MESSAGE = "land\n";
const roots: string[] = [];

export interface LandingCrashWorld {
  readonly root: string;
  readonly world: LandingPassWorld;
  readonly ownerDigest: string;
}

/** A repository whose ONLY difference from HEAD is the delivered file. */
function initRepository(root: string, hooks: string): void {
  const git = (...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=" + hooks, ...args],
    { cwd: root, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  git("init", "--quiet", "-b", "trunk");
  git("config", "user.name", "landing crash fixture");
  git("config", "user.email", "landing-crash@moe-next.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "base.txt"), "base\n");
  git("add", "--", "base.txt");
  git("commit", "--quiet", "-m", "base");
  writeFileSync(join(root, DELIVERED_PATH), "delivered by the node under test\n");
}

/**
 * Builds the world ONCE, here, and hands it to the child whole.
 *
 * The handle is the address of the landing intent - intentId is derived from the owner, the
 * baseline and the session - so the crashed pass and the restarted pass MUST carry the
 * identical handle, or the restart would inspect an aggregate the crash never touched and
 * report a clean world.
 *
 * The workspace root comes from the production identity resolver rather than from mkdtemp,
 * because the journal compares the intent's root against the reservation's identity and the
 * two spellings of a temporary directory differ on this host.
 *
 * THE STORE LIVES OUTSIDE THE REPOSITORY. The verified-workspace port re-captures the
 * workspace inside commit and refuses VERIFIED_WORKSPACE_DRIFT if anything moved since the
 * binding was taken - and a store inside the tree moves, because journaling the landing
 * intent writes its WAL between the capture and the commit. Measured, not assumed: with the
 * store at the repository root every pass here refused DRIFT and never reached git.
 */
export function createLandingCrashWorld(label: string): LandingCrashWorld {
  const base = mkdtempSync(join(tmpdir(), "moe-landing-crash-" + label + "-"));
  roots.push(base);
  const root = join(base, "repository");
  const hooks = join(base, "empty-hooks");
  mkdirSync(root);
  mkdirSync(hooks);
  initRepository(root, hooks);
  const identity = resolveRepositoryExecutionIdentity(root);
  if (!identity.ok) throw new Error("git identity refused: " + identity.code);
  const storePath = join(base, "landing-crash-store.sqlite");
  const projectId = "project-landing-crash";
  const nodeRef = "node-landing-crash";
  const owner = { nodeRef, ownershipToken: "b".repeat(64), projectId, storeId: storePath };
  return {
    ownerDigest: repositoryRecoveryOwnerDigest(owner),
    root,
    world: {
      handle: {
        owner,
        reservation: {
          baselineId: "baseline-landing-crash", controllerId: "controller-landing-crash", controllerPid: 23,
          identity: identity.identity, nodeRef, phase: "LANDING", pid: 31, projectId, revision: 7,
          sessionId: "session-landing-crash", storeId: storePath,
        },
      },
      message: LANDING_MESSAGE,
      paths: [DELIVERED_PATH],
      projectId,
      storePath,
      verifierReceiptId: "c".repeat(64),
      workspace: identity.identity.root,
    },
  };
}

export interface LandingPassRun {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: LandingPassResult | null;
}

/**
 * Runs ONE landing pass in its own process.
 *
 * arming is the entire difference between the crash pass and the control pass. result is
 * null when the child never printed its terminal line, which is what a process SIGKILLed
 * mid-write looks like from out here - the absence of the line is the observation, not an
 * error to be smoothed over.
 */
export function runLandingPassProcess(
  world: LandingPassWorld, arming: Readonly<Record<string, string>> = {},
): LandingPassRun {
  const spawned = spawnSync(process.execPath, [CHILD], {
    encoding: "utf8",
    env: { ...process.env, ...arming, [LANDING_PASS_WORLD_ENV]: JSON.stringify(world) },
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  const stdout = spawned.stdout ?? "";
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(LANDING_PASS_RESULT_PREFIX));
  return {
    result: line === undefined ? null : (JSON.parse(line.slice(LANDING_PASS_RESULT_PREFIX.length)) as LandingPassResult),
    signal: spawned.signal ?? null,
    status: spawned.status,
    stderr: spawned.stderr ?? "",
    stdout,
  };
}

export interface LedgerRow {
  readonly aggregate: string;
  readonly kind: string;
  readonly disposition: string;
  readonly decisions: number;
}

export interface LedgerReading {
  readonly sql: string;
  readonly parameters: readonly string[];
  readonly rows: readonly LedgerRow[];
}

/**
 * THE STORE QUERY. Scoped by the two aggregates a landing writes, and grouped so the kinds
 * appear in the RESULT rather than in the filter - a query that named the kinds in its
 * WHERE clause could not notice a kind the write stopped emitting.
 */
export const LANDING_LEDGER_SQL = [
  "SELECT target_aggregate_id AS aggregate, command_kind AS kind,",
  "       effect_disposition AS disposition, COUNT(*) AS decisions",
  "  FROM command_decisions",
  " WHERE target_aggregate_id = ? OR target_aggregate_id LIKE ?",
  " GROUP BY aggregate, kind, disposition",
  " ORDER BY aggregate, kind",
].join("\n");

export function readLandingLedger(storePath: string, ownerDigest: string): LedgerReading {
  const landing = "repository-landing:" + ownerDigest;
  const attempts = "repository-landing-attempt:%";
  const database = new DatabaseSync(storePath);
  try {
    const rows = database.prepare(LANDING_LEDGER_SQL).all(landing, attempts);
    return {
      parameters: [landing, attempts],
      rows: rows.map((row) => ({
        aggregate: String(row["aggregate"]), decisions: Number(row["decisions"]),
        disposition: String(row["disposition"]), kind: String(row["kind"]),
      })),
      sql: LANDING_LEDGER_SQL,
    };
  } finally {
    database.close();
  }
}

/** Decisions of one kind, counted from the reading. The suffix is the ledger's own naming. */
export function decisionsOfKind(reading: LedgerReading, suffix: string): number {
  return reading.rows.filter((row) => row.kind.endsWith(suffix)).reduce((total, row) => total + row.decisions, 0);
}

export interface GitReading {
  readonly headSha: string;
  readonly subjects: readonly string[];
  readonly filesAtHead: readonly string[];
}

/** What Git actually holds, read with git rather than inferred from the child's report. */
export function readGit(root: string): GitReading {
  const git = (...args: string[]): string => execFileSync("git", args,
    { cwd: root, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return {
    filesAtHead: git("show", "--name-only", "--format=", "HEAD").split(/\r?\n/u).filter(Boolean),
    headSha: git("rev-parse", "HEAD").trim(),
    subjects: git("log", "--format=%s").split(/\r?\n/u).filter(Boolean),
  };
}

/** Every root, removed. A leaked SQLite handle wedges a lane that runs one file at a time. */
export function cleanupLandingCrashRoots(): void {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}
