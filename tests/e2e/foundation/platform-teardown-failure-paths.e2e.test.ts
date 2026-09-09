import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { dockerUnavailableLine, probeDocker } from "../../../apps/daemon/src/repository/deployment/deployment-docker-probe.js";
import { candidateContainerName, createDeployService } from "../../../apps/daemon/src/deployment/deploy-service.js";
import { productionDeployPorts } from "../../../apps/daemon/src/deployment/deploy-command.js";
import type { DeployMigrationResult } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import { resolveDeployMigrationContext } from "../../../apps/daemon/src/deployment/deploy-migration-context.js";
import { migrateWithBackup } from "../../../apps/daemon/src/repository/migrations/migration-service.js";
import { setEnvironmentVariable } from "../../../apps/daemon/src/environment/environment-store.js";
import {
  PUBLIC_PORT, awaitAnswer, composeDown, composeUp, dockerQuietly, excludeLocally, installWorkspace,
  legDetail,
  liveContainers, liveNetworks, materialize, portIsFree, removeWorkspace, reservePublicPort,
} from "./platform-pipeline-harness.js";

/**
 * DoD 4 FOR THE EPIC-FINAL ROW: NOTHING LEAKS ON A FAILURE PATH.
 *
 * The happy-path teardown belongs to each band and is already proven in
 * `platform-pipeline.e2e.test.ts`. THE LEAKS LIVE HERE, on the three paths nobody rehearses: a
 * deploy that fails, a migration that fails, and a verifier that is KILLED rather than asked to
 * stop. Each arm enumerates what is alive BEFORE and AFTER by real query — `docker ps`,
 * `docker network ls`, and an OS port probe — and asserts the delta is empty. A cleanup function
 * that returned is not evidence (rail 2), which is why nothing here reads a return value as proof.
 *
 * WHY THIS FILE OPTS IN THE SAME WAY its sibling does (`MOE_PLATFORM_PIPELINE=1`): it is matched
 * by the root `vitest.config.ts` include, so unconditionally it would put a docker build inside
 * the gate every row on this board runs. WITH the flag and no docker daemon it fails LOUDLY on a
 * `DEPLOY_DOCKER_UNAVAILABLE:` line rather than skipping.
 *
 * THIS FILE MUST NOT LEAK WHILE PROVING OTHERS DO NOT. Everything it starts is registered by name
 * before it is started, torn down in `afterAll`, and then re-counted.
 *
 * THESE LIVE FILES CANNOT RUN IN PARALLEL WITH EACH OTHER. Each stands up the generated topology
 * VERBATIM, which publishes the product's real host ports (3000 for the proxy, 5432 for the
 * database), so two of them at once lose the bind — measured: `docker compose up --wait` exits
 * non-zero for whichever loses. Run them with `--no-file-parallelism` (or one file at a time) when
 * `MOE_PLATFORM_PIPELINE=1` is set. Flagless, they neither bind nor conflict, which is why the
 * root gate is unaffected.
 */

const RUN_PIPELINE = process.env.MOE_PLATFORM_PIPELINE === "1";
const ENVIRONMENT = "preview";
const PROJECT_ID = "project-platform-teardown";
const CANARY = `canary-not-a-secret-${randomBytes(6).toString("hex")}`;

interface Census {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly publicPortFree: boolean;
}

/** What is alive right now, as docker and the OS report it — never as a cleanup function claims. */
async function census(): Promise<Census> {
  return {
    containers: liveContainers(),
    networks: liveNetworks(),
    publicPortFree: await portIsFree(PUBLIC_PORT),
  };
}

function added(before: readonly string[], after: readonly string[]): readonly string[] {
  return after.filter((name) => !before.includes(name));
}

function git(directory: string, args: readonly string[]): void {
  const outcome = spawnSync("git", [...args], { cwd: directory, encoding: "utf8", shell: false, timeout: 120_000 });
  if (outcome.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr ?? ""}`);
}

function commitAll(directory: string, message: string): string {
  git(directory, ["add", "--all"]);
  git(directory, ["-c", "user.name=platform", "-c", "user.email=platform@moe.invalid", "commit", "--message", message]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", shell: false });
  const sha = (head.stdout ?? "").trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("git rev-parse produced no sha");
  return sha;
}

interface World {
  readonly credential: string;
  readonly directory: string;
  readonly network: string;
  readonly project: string;
  readonly sha: string;
  readonly store: SqliteEventStore;
}

let world: World | null = null;
let baseline: Census | null = null;

async function ensureWorld(): Promise<World> {
  if (world !== null) return world;
  const availability = probeDocker();
  if (!availability.available) throw new Error(dockerUnavailableLine(availability.detail));
  await reservePublicPort();
  baseline = baseline ?? await census();

  const project = `moeteardown${randomBytes(4).toString("hex")}`;
  const workspace = materialize("teardown-product", `build-${randomBytes(3).toString("hex")}`, CANARY);
  const install = installWorkspace(workspace.directory, 1_800_000);
  expect(install.status, legDetail(install)).toBe(0);
  git(workspace.directory, ["init", "--initial-branch=main"]);
  // The scratch pnpm store lives inside the workspace so it dies with it; keep it out of the
  // product's history and out of the deploy's archive context.
  excludeLocally(workspace.directory, [".pnpm-store/", "node_modules/"]);
  const sha = commitAll(workspace.directory, "the scaffolded product");
  const up = composeUp(project, workspace.directory, 1_800_000);
  expect(up.status, legDetail(up)).toBe(0);
  await awaitAnswer("/health", 300_000);

  const credential = randomBytes(32).toString("hex");
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  const now = (): string => new Date().toISOString();
  const set = setEnvironmentVariable({ credential: () => credential, now, projectId: PROJECT_ID, store },
    { environment: ENVIRONMENT, name: "DATABASE_URL", value: `postgres://app:${CANARY}@127.0.0.1:5432/app` });
  expect(set.ok).toBe(true);

  world = { credential, directory: workspace.directory, network: `${project}_default`, project, sha, store };
  return world;
}

afterAll(async () => {
  if (world === null) return;
  composeDown(world.project, world.directory);
  dockerQuietly(["network", "rm", world.network], 60_000);
  world.store.close();
  removeWorkspace(world.directory);
  // The file's own promise, checked rather than asserted: a leak here is reported on stderr
  // because a throwing afterAll can mask the arm result that matters.
  const after = await census();
  const orphans = added(baseline?.containers ?? [], after.containers);
  if (orphans.length > 0) process.stderr.write(`TEARDOWN FILE LEAKED CONTAINERS: ${orphans.join(",")}\n`);
}, 600_000);

function deployService(current: World, healthBudgetMs: number, databaseUrl: string) {
  const now = (): string => new Date().toISOString();
  const migrate = async (
    environment: string, sha: string, decisionId: string,
  ): Promise<DeployMigrationResult> => {
    const resolved = resolveDeployMigrationContext({
      credential: () => current.credential, now, projectId: PROJECT_ID,
      projectRoot: current.directory, store: current.store, workspace: current.directory,
    }, { environment, requestId: decisionId, sha });
    if (!resolved.ok) return { code: resolved.code, detail: "", layer: resolved.layer, ok: false };
    const receipt = await migrateWithBackup(current.store, { ...resolved.input, databaseUrl });
    if (receipt.outcome === "APPLIED") return { applied: receipt.applied, ok: true };
    return {
      code: receipt.refusal?.code ?? "MIGRATION_FAILED",
      detail: receipt.refusal?.detail ?? "",
      layer: receipt.refusal?.layer ?? "DAEMON_INGRESS",
      ok: false,
    };
  };
  return createDeployService({
    healthBudgetMs,
    pollMs: 1_000,
    ports: {
      ...productionDeployPorts(current.store, PROJECT_ID),
      migrate,
      target: () => ({ network: current.network, sshTarget: null, url: `http://127.0.0.1:${String(PUBLIC_PORT)}` }),
    },
    projectId: PROJECT_ID,
    store: current.store,
  });
}

describe("the platform's failure paths", () => {
  it("computes the names added since a prior census without Docker", () => {
    expect(added(["a", "b"], ["b", "c"])).toEqual(["c"]);
    expect(added(["a"], [])).toEqual([]);
  });

  it.runIf(RUN_PIPELINE)("counts what is alive by asking docker, not by trusting a cleanup that returned", async () => {
    const availability = probeDocker();
    if (!availability.available) throw Object.assign(
      new Error("DEPLOY_DOCKER_UNAVAILABLE @ PLATFORM_PIPELINE_HARNESS"),
      { code: availability.code, layer: "PLATFORM_PIPELINE_HARNESS", truthClass: "UNKNOWN" },
    );
    const seen = await census();
    // The census is a real query in both directions: `docker ps` answers with names, and the port
    // probe answers by binding. Neither reads a return value from the code under test.
    expect(Array.isArray(seen.containers)).toBe(true);
    expect(Array.isArray(seen.networks)).toBe(true);
    expect(typeof seen.publicPortFree).toBe("boolean");
    // 20s availability probe + two bounded 60s queries, with 20s for host scheduling.
  }, 160_000);

  it.runIf(RUN_PIPELINE)("removes the candidate when the DEPLOY fails", async () => {
    const current = await ensureWorld();
    const before = await census();

    // A candidate that starts and never becomes healthy: the generated healthcheck is replaced
    // with one that always exits 1, so docker itself never reports `healthy` and the engine
    // refuses on DEPLOY_HEALTH_TIMEOUT after starting a real container.
    const healthcheck = join(current.directory, "docker", "healthcheck.mjs");
    const original = readFileSync(healthcheck, "utf8");
    writeFileSync(healthcheck, "process.exit(1);\n", "utf8");
    const brokenSha = commitAll(current.directory, "a build whose healthcheck never passes");
    const name = candidateContainerName(ENVIRONMENT, brokenSha, "decision-unhealthy");
    try {
      const report = await deployService(current, 20_000, `postgres://app:${CANARY}@127.0.0.1:5432/app`)
        .deploy({ context: current.directory, decisionId: "decision-unhealthy", environment: ENVIRONMENT, sha: brokenSha });
      expect(report.outcome).toBe("REFUSED");

      const after = await census();
      expect(added(before.containers, after.containers), "the failed deploy left a container").toEqual([]);
      expect(added(before.networks, after.networks)).toEqual([]);
      expect(after.publicPortFree).toBe(before.publicPortFree);
      expect(liveContainers()).not.toContain(name);
    } finally {
      // Belt and braces: if the engine had NOT cleaned up, this file still must not leak.
      dockerQuietly(["rm", "--force", name], 120_000);
      writeFileSync(healthcheck, original, "utf8");
      commitAll(current.directory, "restore the generated healthcheck");
    }
  }, 1_800_000);

  it.runIf(RUN_PIPELINE)("leaves nothing behind when the MIGRATION fails", async () => {
    const current = await ensureWorld();
    const before = await census();

    // An unreachable database: the migration's own backup step spawns a REAL postgres container to
    // run `pg_dump`, so a failed migration is exactly where that container can be orphaned.
    const report = await deployService(current, 20_000, "postgres://app:unreachable@127.0.0.1:1/app")
      .deploy({ context: current.directory, decisionId: "decision-migration", environment: ENVIRONMENT, sha: current.sha });
    expect(report.outcome).toBe("REFUSED");

    const after = await census();
    expect(added(before.containers, after.containers), "the failed migration left a container").toEqual([]);
    expect(added(before.networks, after.networks)).toEqual([]);
    expect(after.publicPortFree).toBe(before.publicPortFree);
    // Nothing was started, so nothing was flipped: the environment still serves.
    expect((await awaitAnswer("/health", 60_000)).status).toBe(200);
  }, 1_800_000);

  it.runIf(RUN_PIPELINE)("reaps the container an INTERRUPTED process started", async () => {
    const before = await census();
    const name = `moe-teardown-interrupted-${randomBytes(4).toString("hex")}`;
    const marker = join(tmpdir(), `${name}.started`);

    // INTERRUPT MEANS INTERRUPT. The child records the container name BEFORE starting it and then
    // sleeps forever inside a `try`; SIGKILL means its `finally` never runs. A child that returned
    // an error would have unwound its own cleanup, which is precisely what this arm must not do.
    const script = [
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)});`,
      `spawnSync('docker', ['run', '--detach', '--name', ${JSON.stringify(name)}, `
        + "'--publish', '127.0.0.1:0:80', 'alpine:3.20', 'sleep', '600'], { shell: false });",
      "try { await new Promise(() => {}); } finally { spawnSync('docker', ['rm', '--force', "
        + `${JSON.stringify(name)}], { shell: false }); }`,
    ].join("\n");

    const child = spawn(process.execPath, ["--input-type=module", "--eval", script],
      { shell: false, stdio: "ignore", windowsHide: true });
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !liveContainers().includes(name)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(liveContainers(), "the child never started the container this arm reaps").toContain(name);

      child.kill("SIGKILL");
      // POLLED, NOT AWAITED ON AN EVENT. A listener attached after `exit` has already fired never
      // resolves, and a promise that never settles cannot be unwound by a test timeout — measured
      // on this arm: the run hung for the full 600 s and its `finally` NEVER RAN, leaking the very
      // container it exists to reap. A bounded poll on the child's own exit state cannot hang.
      const exitBy = Date.now() + 60_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < exitBy) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(child.exitCode !== null || child.signalCode !== null, "the killed child never exited").toBe(true);
      // The killed process did NOT clean up: the orphan is still there, which is the premise.
      expect(liveContainers(), "the child's finally ran, so this arm proved nothing").toContain(name);

      // The reap is by NAME, recorded before the start — the only bookkeeping that survives a kill.
      const recorded = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      expect(recorded).toBe(name);
      dockerQuietly(["rm", "--force", recorded], 120_000);

      const after = await census();
      expect(added(before.containers, after.containers), "the interrupted run left a container").toEqual([]);
      expect(after.publicPortFree).toBe(before.publicPortFree);
    } finally {
      child.kill("SIGKILL");
      dockerQuietly(["rm", "--force", name], 120_000);
      rmSync(marker, { force: true });
    }
  }, 600_000);
});
