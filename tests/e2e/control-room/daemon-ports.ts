/**
 * The DAEMON-BACKED lane: a real daemon, the real demo seed, and the real
 * control-room dev server, started in that order and torn down on every exit path.
 *
 * HOW THIS DIFFERS FROM `harness.ts`/`static-ports.ts`. That pair builds the
 * bundle and serves COMMITTED FIXTURES with no daemon attached. This module
 * attaches one: `apps/daemon/src/daemon-main.ts` on an EPHEMERAL port,
 * `apps/daemon/src/orchestrator/demo-seed-main.ts` driving the J1 bootstrap chain
 * over that daemon's own HTTP surface, and the Vite dev server whose proxy carries
 * the five control-room routes to it. Nothing is reimplemented: the seed is the
 * shipped seed and the daemon is the shipped daemon, so what the browser reads is
 * the daemon's own answer and not a fixture standing in for one.
 *
 * THE SEED IS THE ONE OPTIONAL CHILD (`DaemonLaneOptions.seed`). A lane that
 * skips it opens the browser onto an EMPTY store, which is the only arrangement
 * in which the operator's own clicks are what drive the chain - a seeded lane
 * asserts over a chain the seed already completed server-side, and cannot see a
 * board-driven move break. Everything else is identical, spec directory included.
 *
 * REASON CODES ARE THIS MODULE'S OWN, mirroring `harness.ts`'s frozen tuple. A
 * child that never announces itself fails with a code naming WHICH child, because
 * "the journey timed out" is the one report an operator cannot act on. Process
 * mechanics live in `daemon-children.ts`; the pre-process scratch identities are
 * the first section of this file.
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteEventStore } from "@moe/store";

import { OPERATOR_CAPABILITIES } from "../../../apps/daemon/src/daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort, OPERATOR_SESSION_TTL_MS }
  from "../../../apps/daemon/src/identity/session-handshake.js";
import { freePort, killTree, spawnNode, survivingChildren } from "./daemon-children.js";
import type { FakeDockerMode } from "./fake-docker-dependencies.js";

/**
 * The operator principal id the lane's minted seat is bound to.
 *
 * Distinct from the daemon's own configured operator so a seat this lane mints can never be
 * mistaken for the one an actual operator paired into — two seats, two ids, one store.
 */
const LANE_OPERATOR_PRINCIPAL = "e2e-lane-operator";

export { survivingPids } from "./daemon-children.js";

/**
 * The inputs the daemon-backed lane needs BEFORE any process exists: a scratch
 * store, a per-run identity, the code-node spec the daemon publishes, and the
 * wire protocol version a direct cross-check request has to present.
 *
 * WHY THE IDENTITIES ARE PER-RUN. The journey proves the board rendered REAL
 * daemon data, and the only way an assertion can tell real data from a frozen
 * fixture is to name something no fixture could contain. Every identity below is
 * derived from the scratch directory's own random suffix, so the aggregate id the
 * board card carries is minted by THIS run and cannot be matched by the committed
 * fixture corpus. A fixed id would make the positive arm pass against fixtures.
 *
 * These moved here verbatim when the scratch-named module was retired: the
 * lane has ONE durable harness surface, and nothing in this section spawns,
 * kills or waits — that stays below, and in `daemon-children.ts`.
 */

/** Known to the test, known to the daemon, and never derived from a default. */
export const LANE_CREDENTIAL = "e2e-daemon-lane-credential";
export const LANE_CSRF_TOKEN = "e2e-daemon-lane-csrf";

const SCRATCH_PREFIX = "moe-e2e-daemon-";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const HOP_COUNTED_ROOT = resolve(HERE, "..", "..", "..");

/**
 * A hop-counted root breaks silently the day this file moves, and every child
 * would then be spawned against a directory that holds no daemon. Anchor it on
 * two files only the real root has and fail closed rather than spawn nothing.
 */
export function repoRoot(): string | null {
  const anchored = existsSync(join(HOP_COUNTED_ROOT, "package.json"))
    && existsSync(join(HOP_COUNTED_ROOT, "pnpm-workspace.yaml"));
  return anchored ? HOP_COUNTED_ROOT : null;
}

export interface LaneScratch {
  /**
   * The MANAGER CATALOG this lane may write, inside the scratch root.
   *
   * `resolveProjectCatalogPath` falls back to `~/.moe-next/projects.json` when
   * MOE_PROJECT_CATALOG is unset, so a lane driving `repository.bootstrap` would register
   * its throwaway product in the REAL host catalog and leave it there. Scoping it here keeps
   * the whole write inside the directory the lane already deletes on every exit path.
   */
  readonly catalogPath: string;
  /** Where the daemon reads its one code-node spec from. */
  readonly nodeSpecsDir: string;
  /**
   * A REAL git repository inside the scratch root, with one real commit.
   *
   * `repository.publish` measures its candidate by shelling out to git in this directory
   * (`publication-candidate.ts`), so the lane cannot satisfy it with a path that merely exists.
   * Handed to the daemon as MOE_NODE_WORKSPACE, which the production composition reads when
   * `config.repositoryWorkspace` is undefined - no production seam is added for the lane.
   */
  readonly workspace: string;
  /**
   * The sha of that commit, READ BACK FROM GIT rather than written as a literal.
   *
   * A literal is what makes `seedLandingReceipt`'s fixture unusable here: the publish candidate
   * check compares real objects, so a made-up sha names nothing this repository contains.
   */
  readonly workspaceSha: string;
  /** The aggregate id the seeded `node.deliver` step carries. Unique per run. */
  readonly nodeRef: string;
  readonly projectId: string;
  readonly root: string;
  readonly storePath: string;
  /** The random suffix every identity above is derived from. */
  readonly tag: string;
}

/**
 * Creates the scratch tree and writes the node spec.
 *
 * The spec's five string fields are all required by `readNodeSpec`; the first
 * `.json` by name is the one seeded, and this directory holds exactly one.
 */
export function createLaneScratch(landing = false): LaneScratch {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const tag = basename(root).slice(SCRATCH_PREFIX.length).toLowerCase();
  const nodeSpecsDir = join(root, "node-specs");
  mkdirSync(nodeSpecsDir);
  const workspace = createLaneWorkspace(root);
  const nodeRef = `node-e2e-${tag}`;
  writeFileSync(join(nodeSpecsDir, "node.json"), JSON.stringify({
    instructions: "The browser lane never runs this node; it only reads its step.",
    nodeRef,
    test: "node --eval \"process.exit(0)\"",
    title: "Daemon-backed browser lane node",
    // THE SCRATCH ROOT, EXCEPT ON THE LANDING LANE. `repository-delivery-runtime.ts:61` resolves
    // the brief's workspace with `resolveRepositoryExecutionIdentity` and drops any node whose
    // workspace is not a git repository, so the scratch root - deliberately not a repository -
    // can never be landed into. The deploy lane needs a REAL landing receipt written by the
    // real lander (`publication-goal-integration.ts:24` refuses PUBLISH_GOAL_NOT_INTEGRATED on
    // `receipts.length === 0`), so it points the node at the lane's own git workspace instead.
    // Gated for the same reason MOE_NODE_WORKSPACE is: every other spec keeps today's bytes.
    workspace: (landing ? workspace.path : root).replaceAll("\\", "/"),
  }), "utf8");
  return Object.freeze({
    catalogPath: join(root, "projects.json"), nodeRef, nodeSpecsDir,
    projectId: `e2e-proj-${tag}`, root, storePath: join(root, "store.sqlite"), tag,
    workspace: workspace.path, workspaceSha: workspace.sha,
  });
}

/**
 * The lander's identity flags, HAND-TRANSCRIBED from `apps/daemon/src/repository/git-landing-port.ts`
 * (`LANDER_IDENTITY`) for the reason `publish-remote.spec.ts` gives: this directory's tsconfig
 * cannot reach into apps/ (TS6059).
 *
 * They are stated rather than inherited so the lane does not depend on the host having a git
 * identity configured. A lane that fails on an unconfigured developer machine is a lane that
 * fails for the next person, not for a defect - and `commit.gpgsign=false` keeps a host that
 * signs by default from blocking on a key this commit has no use for.
 */
const LANE_LANDER_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];

/**
 * Builds a REAL one-commit git repository under the scratch root and reads its sha back.
 *
 * WHY A REAL REPOSITORY AND NOT A FIXTURE. `repository.publish` refuses
 * PUBLISH_WORKSPACE_UNCONFIGURED until a workspace is configured, and then MEASURES that
 * workspace with git: `publication-candidate.ts` runs `rev-parse --verify HEAD^{commit}` and
 * `symbolic-ref --quiet HEAD`, re-reads both, and refuses PUBLISH_CANDIDATE_CHANGED unless the
 * identity, sha and ref are stable across the two reads. Nothing short of an actual repository
 * with an actual commit on a named branch survives that.
 *
 * `-b main` is explicit because the check requires a ref under `refs/heads/`, and a host whose
 * `init.defaultBranch` is unset leaves HEAD on an unborn branch git will not resolve.
 *
 * GIT_* IS STRIPPED FROM THE CHILD ENV, mirroring `git-landing-port.ts`'s `landingEnvironment()`:
 * a GIT_DIR or GIT_WORK_TREE exported by a parent shell would silently redirect every command
 * below into the developer's own repository.
 *
 * TEARDOWN IS INHERITED: this lives under the scratch root the lane already removes on every
 * exit path, including the throwing one. A leaked git tree is the same class of failure as a
 * leaked container (epic rail 4), so it is deliberately not created anywhere else.
 */
function createLaneWorkspace(root: string): LaneWorkspace {
  const path = join(root, "workspace");
  mkdirSync(path);
  laneGit(path, ["init", "-b", "main", "--quiet"]);
  writeFileSync(join(path, "product.txt"), "The lane's own workspace, committed for real.\n", "utf8");
  laneGit(path, ["add", "--", "product.txt"]);
  laneGit(path, [...LANE_LANDER_IDENTITY, "commit", "--quiet", "--message", "Lane workspace baseline"]);
  return Object.freeze({ path, sha: laneGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]) });
}

/** The workspace path and its real head sha. Both are read, never assumed. */
export interface LaneWorkspace {
  readonly path: string;
  readonly sha: string;
}

/**
 * Re-reads an already-built lane workspace, for the scratch REDISCOVERY path in `wrapper-lane.ts`.
 *
 * Returns null rather than throwing when the directory is not a repository: rediscovery scans
 * every scratch in the temp directory, and one left by an older build that predates this
 * workspace is simply not this run's - the same reason the scan already skips a root with no
 * store or no node spec.
 */
export function laneWorkspaceIdentity(root: string): LaneWorkspace | null {
  const path = join(root, "workspace");
  if (!existsSync(join(path, ".git"))) return null;
  try { return Object.freeze({ path, sha: laneGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]) }); }
  catch { return null; }
}

/** An operator seat the lane can dispatch as: a HUMAN principal and its plaintext credential. */
export interface LaneOperatorSeat {
  readonly credential: string;
  readonly principalId: string;
}

/**
 * Mints a REAL operator seat against the lane's own store, through the production pairing seam.
 *
 * WHY THE LANE CREDENTIAL WILL NOT DO. `publish-services.ts:72` refuses PUBLISH_HUMAN_REQUIRED
 * unless `isDurableHumanPrincipal` finds a principal record whose `kind` is `"HUMAN"`
 * (`human-approver.ts:23-29`). The lane credential names no such principal, so every
 * prerequisite dispatch a spec makes with it is refused at AUTHORIZATION before any of the ten
 * checks behind it is reached — measured 21:03Z, and unchanged by pairing the browser.
 *
 * WHY PAIRING THE BROWSER IS NOT ENOUGH EITHER, which is the part that surprises. Pairing does
 * mint a HUMAN principal, but the plaintext credential is "returned ONCE, never stored here or
 * logged" (`session-handshake.ts`) — the ledger binds only its sha256. The browser keeps the
 * only copy, so a spec-side `fetch` cannot borrow it and the lane cannot read it back.
 *
 * NOTHING IS FABRICATED HERE. `createOperatorSessionHandshakePort` is the same seam the daemon
 * composes at `daemon-store-foundation-composition.ts:590`; it opens a real session through the
 * same `session.open` machinery every other session travels, and the HUMAN kind is a server fact
 * of that seam rather than a claim this lane makes. The alternative — asserting a principal
 * record into the store — is the fabricated authority this row's rails forbid.
 */
export function mintLaneOperatorSeat(lane: DaemonLane): LaneOperatorSeat {
  const store = SqliteEventStore.openForProject(join(dirname(lane.catalogPath), "store.sqlite"),
    lane.projectId);
  try {
    const minted = createOperatorSessionHandshakePort({
      capabilities: OPERATOR_CAPABILITIES,
      clock: () => Date.now(),
      operatorPrincipalId: LANE_OPERATOR_PRINCIPAL,
      projectId: lane.projectId,
      sessionTtlMs: OPERATOR_SESSION_TTL_MS,
      store,
    }).mint();
    if (!minted.ok) throw new Error(`LANE_OPERATOR_SEAT_REFUSED: ${minted.code}@${minted.layer}`);
    return Object.freeze({ credential: minted.credential, principalId: minted.principalId });
  } finally { store.close(); }
}

/**
 * Runs git in the lane's own workspace with GIT_* stripped from the child environment, mirroring
 * `git-landing-port.ts`'s `landingEnvironment()`: a GIT_DIR or GIT_WORK_TREE exported by a parent
 * shell would silently redirect every one of these commands into the developer's own repository.
 */
function laneGit(cwd: string, args: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  return execFileSync("git", [...args], {
    cwd, encoding: "utf8", env: environment,
    shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/u, "");
}

/**
 * Which approval path the daemon runs under. Stated by the lane, never inherited.
 *
 * SPEED is the daemon's ONE ungated path and needs both settings: the delay must
 * be exactly 0 or `approval.decide` answers APPROVAL_HUMAN_REVIEW_REQUIRED.
 *
 * HUMAN states NEITHER setting rather than spelling a mode of its own, because
 * `approval-policy-settings.ts` matches SPEED exactly and returns REQUIRE_HUMAN
 * for every other input including an absent one - a "HUMAN" literal would read
 * as a mode the daemon knows while taking the identical absent-setting branch.
 * A HUMAN lane still commits `approval.decide` from the board: the operator
 * credential is the human seat, and the daemon mints the human-review witness at
 * the authenticated seam (`daemon-command-registry.ts`).
 */
export type LaneApprovalMode = "HUMAN" | "SPEED";

/**
 * The daemon's environment. `MOE_APPROVAL_MODE`/`MOE_SPEED_MODE_DELAY_MS` are
 * daemon-side approval policy the seed cannot supply, and the daemon needs the
 * SAME spec directory as the seed or it publishes no `node.deliver`.
 *
 * The two approval keys are set to `undefined` rather than omitted under HUMAN:
 * `process.env` is spread above, so a host that already exports either one would
 * otherwise hand a HUMAN lane the speed path. `spawn` drops an undefined value
 * instead of writing the string "undefined", which is what makes the absent
 * setting actually absent in the child.
 */
export function daemonEnv(
  scratch: LaneScratch, approval: LaneApprovalMode = "SPEED",
): Readonly<Record<string, string | undefined>> {
  const speed = approval === "SPEED";
  return Object.freeze({
    ...process.env,
    MOE_APPROVAL_MODE: speed ? "SPEED" : undefined,
    MOE_DAEMON_CREDENTIAL: LANE_CREDENTIAL,
    MOE_NODE_SPECS_DIR: scratch.nodeSpecsDir,
    // Scratch-scoped, never the host default: see LaneScratch.catalogPath.
    MOE_PROJECT_CATALOG: scratch.catalogPath,
    MOE_PROJECT_ID: scratch.projectId,
    MOE_SPEED_MODE_DELAY_MS: speed ? "0" : undefined,
    MOE_STORE_PATH: scratch.storePath,
  });
}

/**
 * The seed reads four variables of its own and refuses each missing one by name.
 * It inherits the lane's approval mode so the two children cannot disagree about
 * a policy only one of them can observe.
 */
export function seedEnv(
  scratch: LaneScratch, daemonOrigin: string, approval: LaneApprovalMode = "SPEED",
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...daemonEnv(scratch, approval),
    MOE_CSRF_TOKEN: LANE_CSRF_TOKEN,
    MOE_DAEMON_ORIGIN: daemonOrigin,
  });
}

/** Whether the served bundle carries live credentials at all. */
export type LiveCredentialMode = "ABSENT" | "ATTACHED";

export function serverEnv(
  daemonOrigin: string, mode: LiveCredentialMode,
): Readonly<Record<string, string | undefined>> {
  const attached = mode === "ATTACHED";
  return Object.freeze({
    ...process.env,
    MOE_DAEMON_ORIGIN: daemonOrigin,
    VITE_MOE_LIVE_CREDENTIAL: attached ? LANE_CREDENTIAL : "",
    VITE_MOE_LIVE_CSRF: attached ? LANE_CSRF_TOKEN : "",
  });
}

/**
 * The `x-moe-protocol-version` value the daemon's compatibility stage demands.
 *
 * Loaded from the generated client's own committed bridge rather than written
 * down here: a hand-copied version would drift into a second compatibility rule,
 * and the daemon answers a stale one with DISTRIBUTION_MISMATCH at stage
 * COMPATIBILITY. Loaded by URL, because this directory's tsconfig cannot reach
 * into `packages/` (TS6059) — the same way `apps/control-room/vite.config.ts`
 * reads the pins it injects.
 */
export async function readWireProtocolVersion(root: string): Promise<string | null> {
  const href = new URL(
    `file:///${join(root, "packages", "control-room-client", "src", "generated", "generated-client.js")
      .replaceAll("\\", "/")}`,
  ).href;
  let loaded: { readonly GENERATED_WIRE_PROTOCOL_VERSION?: unknown };
  try {
    loaded = await import(href) as { readonly GENERATED_WIRE_PROTOCOL_VERSION?: unknown };
  } catch {
    return null;
  }
  const version = loaded.GENERATED_WIRE_PROTOCOL_VERSION;
  return typeof version === "string" && version !== "" ? version : null;
}

export const DAEMON_LANE_ERROR_CODES = Object.freeze([
  "E2E_REPO_ROOT_UNRESOLVED",
  "E2E_DAEMON_SPAWN_FAILED",
  "E2E_DAEMON_READY_TIMEOUT",
  "E2E_SEED_REFUSED",
  "E2E_SERVER_READY_TIMEOUT",
  "E2E_TEARDOWN_ORPHAN",
] as const);
export type DaemonLaneErrorCode = (typeof DAEMON_LANE_ERROR_CODES)[number];

/** Bounded, and separately per child, so a hang names the child that hung. */
export const DAEMON_READY_BUDGET_MS = 60_000;
export const SEED_BUDGET_MS = 90_000;
export const SERVER_READY_BUDGET_MS = 60_000;

export interface DaemonLane {
  /** The dev server's base URL — what the browser opens. */
  readonly baseUrl: string;
  /** The manager catalog this lane's daemon writes, inside the scratch root it deletes. */
  readonly catalogPath: string;
  readonly credential: string;
  readonly csrfToken: string;
  /**
   * Types one confirmation label on the daemon's private operator channel, exactly as a
   * keystroke would. NULL when the lane was opened without `operatorChannel`, so a caller
   * cannot mistake "this lane has no terminal" for "the label was refused".
   */
  readonly approvePairing: ((confirmationLabel: string) => void) | null;
  /** The daemon's OWN announced origin, parsed from its stdout. Never assumed. */
  readonly daemonOrigin: string;
  readonly daemonPid: number;
  /** The aggregate id the seeded `node.deliver` step carries. Unique per run. */
  readonly nodeRef: string;
  readonly projectId: string;
  readonly repoRoot: string;
  /**
   * The seed child's pid, for the run's evidence line ONLY. It has already exited
   * by the time `body` runs, so the number may name some other process by now and
   * is never probed; see `lanePids`.
   *
   * NULL when the lane ran with `seed: "NONE"`. There was no seed child at all,
   * and any number here would name a stranger - a lane that reports a pid it
   * never spawned is the one evidence line an operator cannot check.
   */
  readonly seedPid: number | null;
  readonly serverPid: number;
  /**
   * The lane's own git workspace and the sha it actually committed there.
   *
   * A spec that needs a sha the daemon can RESOLVE must use this one. A literal
   * `"a".repeat(40)` names no object in any repository, so every check that walks git —
   * `publication-candidate.ts`'s candidate read, `publication-goal-integration.ts`'s
   * `merge-base --is-ancestor` — refuses on it for a reason that has nothing to do with
   * what the spec meant to test.
   */
  readonly workspace: string;
  readonly workspaceSha: string;
}

export interface LaneRefused {
  readonly code: DaemonLaneErrorCode;
  /** The child's own words, verbatim: a MOE_SEED_* refusal is never restated. */
  readonly detail: string;
  readonly ok: false;
}

export type LaneOutcome<T> = LaneRefused | { readonly ok: true; readonly value: T };

const refuse = (code: DaemonLaneErrorCode, detail: string): LaneRefused =>
  Object.freeze({ code, detail, ok: false as const });

const DAEMON_ORIGIN_LINE = /^listening on (\S+)$/mu;
const SERVER_LOCAL_LINE = /Local:\s+(http:\/\/localhost:\d+)/mu;

interface StartedChild {
  /** What the child announced: the daemon's origin, the server's base URL. */
  readonly announced: string;
  /** Present only for a daemon started with `--operator-stdin`. */
  readonly operatorInput?: NodeJS.WritableStream;
  readonly pid: number;
}

async function startDaemon(
  root: string, scratch: LaneScratch, approval: LaneApprovalMode, tracked: ChildProcess[],
  operatorChannel: true | undefined, fixedDemoGoal: true | undefined,
  fakeDocker: FakeDockerMode | undefined,
): Promise<LaneRefused | StartedChild> {
  const dependencies = fakeDocker !== undefined
    ? `${root}/tests/e2e/control-room/fake-docker-dependencies.ts`
    : fixedDemoGoal === true
    ? `${root}/tests/e2e/control-room/fixed-demo-goal-dependencies.ts`
    : `${root}/apps/daemon/src/daemon-store-dependencies.ts`;
  const watched = spawnNode([
    "--experimental-transform-types",
    `${root}/apps/daemon/src/daemon-main.ts`,
    `--dependencies=${dependencies}`,
    // No fixed port: an ephemeral one is what stops this lane colliding with a
    // dev daemon, and the origin is read back rather than assumed.
    "--port=0",
    `--csrf-token=${LANE_CSRF_TOKEN}`,
    // daemon-main.ts:212-214 turns this flag into `operatorInput: process.stdin`, so the
    // label the lane writes below reaches the SAME approval path an operator's keystroke
    // would. Nothing here approves on the daemon's behalf.
    ...(operatorChannel === true ? ["--operator-stdin"] : []),
  ], root, {
    ...daemonEnv(scratch, approval),
    MOE_E2E_DEPLOY_MODE: fakeDocker,
    // The composition reads MOE_NODE_WORKSPACE at daemon-store-foundation-composition.ts:190 when
    // `config.repositoryWorkspace` is undefined, so the publish candidate reader measures the
    // lane's own repository instead of refusing PUBLISH_WORKSPACE_UNCONFIGURED.
    //
    // GATED ON THE DEPLOY LANE. Supplying it unconditionally would move a refusal CODE for every
    // other spec on this daemon - PUBLISH_WORKSPACE_UNCONFIGURED becomes PUBLISH_GOAL_NOT_INTEGRATED
    // once a workspace exists - and this row has not run those specs to show none of them read it.
    // Ungating is a one-line change once that measurement exists; guessing is not.
    MOE_NODE_WORKSPACE: fakeDocker === undefined ? undefined : scratch.workspace,
  });
  // Held on an object because a spawn error arrives on a later turn: a plain
  // `let` assigned only inside the listener reads as never-assigned here.
  const failure: { message: string | null } = { message: null };
  watched.child.once("error", (error: Error) => { failure.message = error.message; });
  // The HANDLE is tracked, not the pid: teardown must know whether this child is
  // still the process its number names before it kills anything by that number.
  tracked.push(watched.child);
  const pid = watched.child.pid;
  const announced = await watched.waitFor(DAEMON_ORIGIN_LINE, DAEMON_READY_BUDGET_MS);
  if (failure.message !== null) return refuse("E2E_DAEMON_SPAWN_FAILED", failure.message);
  if (pid === undefined) return refuse("E2E_DAEMON_SPAWN_FAILED", "the daemon reported no pid");
  if (announced === null) {
    return refuse("E2E_DAEMON_READY_TIMEOUT", watched.transcript().slice(-600));
  }
  return operatorChannel === true && watched.child.stdin !== null
    ? { announced, operatorInput: watched.child.stdin, pid }
    : { announced, pid };
}

async function runSeed(
  root: string, scratch: LaneScratch, origin: string,
  approval: LaneApprovalMode, tracked: ChildProcess[],
): Promise<LaneRefused | number> {
  const watched = spawnNode([
    "--experimental-transform-types",
    `${root}/apps/daemon/src/orchestrator/demo-seed-main.ts`,
  ], root, seedEnv(scratch, origin, approval));
  // Tracked even though it exits on its own: a seed that HANGS hits its budget
  // below and would otherwise outlive the lane, since teardown only kills what
  // it was told about. A seed that exited is left alone by the same teardown,
  // which reads the handle before it reads the number.
  tracked.push(watched.child);
  const pid = watched.child.pid ?? -1;
  const exit = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => { done(null); }, SEED_BUDGET_MS);
    watched.child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
  // The seed echoes the daemon's own code and layer, so its transcript IS the
  // diagnosis; restating it locally would lose the refusing layer.
  return exit === 0 ? pid : refuse("E2E_SEED_REFUSED", watched.transcript().slice(-800));
}

async function startServer(
  root: string, origin: string, mode: LiveCredentialMode, tracked: ChildProcess[],
): Promise<LaneRefused | StartedChild> {
  const port = await freePort();
  const watched = spawnNode([
    `${root}/apps/control-room/node_modules/vite/bin/vite.js`,
    "--port", String(port), "--strictPort",
  ], `${root}/apps/control-room`, serverEnv(origin, mode));
  tracked.push(watched.child);
  const pid = watched.child.pid;
  const announced = await watched.waitFor(SERVER_LOCAL_LINE, SERVER_READY_BUDGET_MS);
  if (announced === null) {
    return refuse("E2E_SERVER_READY_TIMEOUT", watched.transcript().slice(-600));
  }
  if (pid === undefined) {
    return refuse("E2E_SERVER_READY_TIMEOUT", "the dev server reported no pid");
  }
  // A server on a DIFFERENT port than the one requested is a second server, and
  // the journey would then drive something this lane does not own.
  if (announced !== `http://localhost:${String(port)}`) {
    return refuse("E2E_SERVER_READY_TIMEOUT", `expected port ${String(port)}, got ${announced}`);
  }
  return { announced, pid };
}

/**
 * Whether the shipped demo seed runs between the daemon and the dev server.
 *
 * SHIPPED is the seeded journey: `demo-seed-main.ts` drives the whole J1
 * bootstrap chain SERVER-SIDE, so the browser opens onto a board the seed
 * already finished. NONE leaves the store empty and hands the browser the
 * chain's FIRST move - the only lane in which a board click is what commits,
 * and therefore the only lane in which a daemon-side gate change can be caught
 * by clicking. The scratch node spec is written either way, so `node.deliver`
 * still appears once approval lands, however the approval got there.
 */
export type LaneSeedMode = "NONE" | "SHIPPED";

export interface DaemonLaneOptions {
  /**
   * The daemon's approval policy. Omitted is SPEED, which is what every seeded
   * caller has always run under; see `LaneApprovalMode` for why HUMAN states no
   * mode at all rather than a literal of its own.
   */
  readonly approval?: LaneApprovalMode;
  /** Pin the one shipped dev authority identity while retaining the production dependency root. */
  readonly fixedDemoGoal?: true;
  /** Replace only deploy spawns; omitted retains the production provider. */
  readonly fakeDocker?: FakeDockerMode;
  /** ABSENT serves the same bundle with no credentials, for the refusal arm. */
  readonly liveCredentials: LiveCredentialMode;
  /**
   * Give the daemon a private operator channel over its own stdin pipe.
   *
   * OMITTED IS TODAY'S BEHAVIOUR for every existing caller: no `--operator-stdin`, so
   * `pairingOperatorChannelAvailable` stays false and pairing can never be approved —
   * which is exactly what the J1 unusable-product arm needs to stay true. Present, the
   * lane exposes `approvePairing` and a browser can complete a real handshake.
   */
  readonly operatorChannel?: true;
  /** Omitted is SHIPPED: today's behaviour, unchanged for every existing caller. */
  readonly seed?: LaneSeedMode;
}

async function openLane<T>(
  root: string, options: DaemonLaneOptions, tracked: ChildProcess[], scratchRoots: string[],
  body: (lane: DaemonLane) => Promise<T>,
): Promise<LaneOutcome<T>> {
  const scratch = createLaneScratch(options.fakeDocker !== undefined);
  const approval = options.approval ?? "SPEED";
  scratchRoots.push(scratch.root);
  const daemon = await startDaemon(
    root, scratch, approval, tracked, options.operatorChannel, options.fixedDemoGoal, options.fakeDocker,
  );
  if ("ok" in daemon) return daemon;
  // NULL is "no seed child was ever spawned", which is a different fact from
  // "the seed ran": only a number reaching `seedPid` may be read as a pid.
  const seeded = (options.seed ?? "SHIPPED") === "NONE"
    ? null
    : await runSeed(root, scratch, daemon.announced, approval, tracked);
  if (seeded !== null && typeof seeded !== "number") return seeded;
  const served = await startServer(root, daemon.announced, options.liveCredentials, tracked);
  if ("ok" in served) return served;
  return Object.freeze({
    ok: true as const,
    value: await body(Object.freeze({
      approvePairing: daemon.operatorInput === undefined
        ? null
        : (confirmationLabel: string): void => {
          daemon.operatorInput?.write(`${confirmationLabel}
`);
        },
      baseUrl: served.announced,
      catalogPath: scratch.catalogPath,
      credential: LANE_CREDENTIAL,
      csrfToken: LANE_CSRF_TOKEN,
      daemonOrigin: daemon.announced,
      daemonPid: daemon.pid,
      nodeRef: scratch.nodeRef,
      projectId: scratch.projectId,
      workspace: scratch.workspace,
      workspaceSha: scratch.workspaceSha,
      repoRoot: root,
      seedPid: seeded,
      serverPid: served.pid,
    })),
  });
}

/**
 * Runs `body` against a real daemon-backed control room and tears the fleet down
 * in a `finally`.
 *
 * Precedence mirrors `harness.ts`: each child refuses before the next is started,
 * a body failure RE-THROWS (a failed assertion is the caller's failure and must
 * never be laundered into a harness reason code), and a surviving process only
 * overwrites a SUCCESSFUL outcome — the operator needs the reason the run failed
 * at all before the reason teardown was untidy.
 */
export async function withDaemonBackedControlRoom<T>(
  options: DaemonLaneOptions,
  body: (lane: DaemonLane) => Promise<T>,
): Promise<LaneOutcome<T>> {
  const root = repoRoot();
  if (root === null) return refuse("E2E_REPO_ROOT_UNRESOLVED", "package.json/pnpm-workspace.yaml");
  const tracked: ChildProcess[] = [];
  const scratchRoots: string[] = [];
  let primary: LaneOutcome<T>;
  try {
    primary = await openLane(root, options, tracked, scratchRoots, body);
  } finally {
    // Newest first: the dev server holds the proxy connection to the daemon.
    for (const child of [...tracked].reverse()) await killTree(child);
    // Best effort, and deliberately silent. The store file's handle may not be
    // released the instant its process dies, and a scratch directory that
    // survives is a few hundred kilobytes in TEMP — never a reason to fail a
    // journey that otherwise passed.
    for (const scratch of scratchRoots) {
      try {
        rmSync(scratch, { force: true, recursive: true });
      } catch {
        // Left behind on purpose rather than retried; see above.
      }
    }
  }
  const survivors = await survivingChildren(tracked);
  return survivors.length > 0 && primary.ok
    ? refuse("E2E_TEARDOWN_ORPHAN", survivors.join(","))
    : primary;
}

/**
 * The pids still alive when `body` ran, for the caller's own orphan assertion
 * after teardown. The seed is NOT among them: `body` only runs once the seed has
 * exited 0, so by the time any caller probes, its number is a reaped process's
 * number and can only ever name a stranger. A seed that hangs never reaches
 * `body` at all; it is refused as E2E_SEED_REFUSED and killed through its handle.
 * Under `seed: "NONE"` there is no third process to account for either way.
 */
export const lanePids = (lane: DaemonLane): readonly number[] =>
  Object.freeze([lane.daemonPid, lane.serverPid]);
