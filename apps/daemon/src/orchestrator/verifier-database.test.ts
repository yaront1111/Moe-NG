import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createVerifierDatabaseRunner } from "./verifier-database.js";
import { createNodeVerifier, type VerifierRunCapture } from "./node-verifier.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { SqliteEventStore } from "@moe/store";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-contracts.js";
import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import type { VerifierAuthorityFacts } from "../review/verifier-receipt-ledger.js";
import { generateControlledProfile, CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";

const directories: string[] = [];
function workspace(database = true) {
  const dir = mkdtempSync(join(tmpdir(), "moe-verifier-db-"));
  directories.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: database ? { "db:migrate": "node-pg-migrate up" } : {} }));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations/1700000000001-broken.js"), "export const up = () => {};\n");
  return { instructions: "verify", test: "node recipe.mjs", title: "db verification", workspace: dir };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class DockerHost {
  readonly containers = new Map<string, number>();
  readonly events: string[] = [];
  readonly recipeEnvironments: NodeJS.ProcessEnv[] = [];
  readonly children = new Map<number, EventEmitter>();
  readonly dockerCalls: string[][] = [];
  available = true;
  startFails = false;
  portInvalid = false;
  hangMigration = false;
  ready = true;
  failRemove = false;
  migrationFails = false;
  migrationOutput = "### MIGRATION 1700000000001-broken (UP) ###\nError!";
  reflectPasswordAsFilename = false;
  recipeCode = 0;
  hangRecipe = false;
  migrated = false;
  nextPid = 100;
  nextPort = 40000;
  recipeStarted: () => void = () => undefined;

  spawn = (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const pid = this.nextPid++;
    const child = Object.assign(new EventEmitter(), {
      pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
      kill: () => { child.emit("close", null); return true; }, unref: () => undefined,
    });
    this.children.set(pid, child);
    queueMicrotask(() => {
      if (file === "docker") {
        expect(options.shell).toBe(false);
        expect(args.join(" ").includes(options.env?.POSTGRES_PASSWORD ?? "<unset>")).toBe(false);
        const result = this.docker(args);
        child.stdout.write(result.output);
        child.emit("close", result.code);
      } else if (file === "pnpm db:migrate") {
        this.events.push("migration");
        this.migrated = !this.migrationFails;
        if (this.reflectPasswordAsFilename) {
          const name = `${new URL(options.env!.DATABASE_URL!).password}.js`;
          writeFileSync(join(String(options.cwd), "migrations", name), "// untrusted recipe\n");
          this.migrationOutput = `Error\n at up (file:///workspace/migrations/${name}:1:1)`;
        }
        child.stdout.write(this.migrationFails ? this.migrationOutput : "migration done");
        if (!this.hangMigration) child.emit("close", this.migrationFails ? 1 : 0);
      } else {
        this.events.push(this.migrated ? "recipe-after-migration" : "recipe-before-migration");
        this.recipeEnvironments.push(options.env ?? {});
        this.recipeStarted();
        if (this.hangRecipe) return;
        child.stdout.write(`${options.env?.DATABASE_URL ?? "no database"}\n`);
        child.emit("close", this.recipeCode);
      }
    });
    return child as unknown as ChildProcess;
  };

  killGroup = (pid: number): void => { this.children.get(-pid)?.emit("close", null); };

  docker(args: readonly string[]): { code: number; output: string } {
    this.dockerCalls.push([...args]);
    if (args[0] === "version") return { code: this.available ? 0 : 1, output: this.available ? "29.6.2" : "daemon unavailable" };
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      if (this.containers.has(name)) return { code: 1, output: "name collision" };
      expect(args).toContain("127.0.0.1:0:5432");
      if (this.startFails) return { code: 1, output: "image pull failed" };
      this.containers.set(name, this.nextPort++);
      return { code: 0, output: "container id" };
    }
    if (args[0] === "port") return { code: 0, output: this.portInvalid ? "0.0.0.0:5432" : `127.0.0.1:${this.containers.get(args[1]!)}` };
    if (args[0] === "exec") return { code: this.ready ? 0 : 1, output: "" };
    if (args[0] === "rm") {
      if (!this.failRemove) this.containers.delete(args.at(-1)!);
      return { code: this.failRemove ? 1 : 0, output: "" };
    }
    if (args[0] === "ps") {
      const filter = args.at(-1)!;
      return { code: 0, output: [...this.containers.keys()].filter((name) => filter === `name=^/${name}$`).join("\n") };
    }
    throw new Error(`unexpected docker operation ${args[0]}`);
  }

  runner(timeoutMs = 1000) {
    return createVerifierDatabaseRunner({
      spawn: this.spawn, platform: "linux", killProcessGroup: this.killGroup,
      environment: { PATH: "/runtime", LANG: "C", DATABASE_URL: "ambient-must-not-win" },
      readyTimeoutMs: 10, pollMs: 1, timeoutMs, killGraceMs: 50,
    });
  }

  assertGone() {
    const names = this.dockerCalls.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--name") + 1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(this.docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]).output).toBe("");
  }
}

describe("verifier disposable database", () => {
  it("loads its production bridge in native Node without a transpiling test loader", () => {
    const url = new URL("./verifier-database.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const module = await import(${JSON.stringify(url)}); console.log(typeof module.createVerifierDatabaseRunner);`],
    { shell: false, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });
  it("composes the database owner at the production runner seam without losing shutdown", () => {
    const source = readFileSync(new URL("./agent-wrapper-main.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./verifier-database.js"');
    expect(source).toContain("verifierRunner = createVerifierDatabaseRunner(");
    expect(source).toContain("runTest: verifierRunner");
    expect(source).toContain("closeVerifierRunner: verifierRunner?.close");
  });
  it.each([0, 1])("removes the database after recipe exit %s and delivers the URL through the real runner", async (exitCode) => {
    const host = new DockerHost();
    host.recipeCode = exitCode;
    const runner = host.runner();
    try {
      const capture = await runner(workspace());
      expect(capture.exitCode).toBe(exitCode);
      expect(host.events).toEqual(["migration", "recipe-after-migration"]);
      expect(host.recipeEnvironments).toHaveLength(1);
      expect(new URL(host.recipeEnvironments[0]!.DATABASE_URL!).hostname).toBe("127.0.0.1");
      expect(capture.output.includes(host.recipeEnvironments[0]!.DATABASE_URL!)).toBe(false);
      host.assertGone();
    } finally { await runner.close(); }
  });

  it("removes the database after forced recipe kill and closes idempotently", async () => {
    const host = new DockerHost();
    host.hangRecipe = true;
    const started = new Promise<void>((resolve) => { host.recipeStarted = resolve; });
    const runner = host.runner();
    const done = runner(workspace());
    const rejected = expect(done).rejects.toMatchObject({ code: "VERIFIER_PROCESS_CANCELLED" });
    await started;
    await Promise.all([runner.close(), runner.close()]);
    await rejected;
    host.assertGone();
    expect(runner.activeCount()).toBe(0);
  });

  it("refuses missing Docker at the daemon layer instead of running an unverified recipe", async () => {
    const host = new DockerHost();
    host.available = false;
    const runner = host.runner();
    const result = await runner(workspace());
    expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_DB_UNAVAILABLE", refusedBy: "DAEMON_INGRESS", reason: "DOCKER_UNAVAILABLE" });
    expect(result.exitCode).toBe(1);
    expect(host.events).toEqual([]);
    await runner.close();
  });

  it.each(["sql", "javascript"])("names the actual failed migration without exposing raw %s output", async (kind) => {
    const host = new DockerHost();
    host.migrationFails = true;
    if (kind === "javascript") host.migrationOutput = "### MIGRATION 1700000000000-previous (UP) ###\nError\n    at up (file:///workspace/migrations/1700000000001-broken.js:1:32)";
    const runner = host.runner();
    const result = await runner(workspace());
    expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_FAILED", refusedBy: "DAEMON_INGRESS", file: "1700000000001-broken.js" });
    expect(result.exitCode).toBe(1);
    expect(host.events).toEqual(["migration"]);
    host.assertGone();
    await runner.close();
  });

  it("runs two verifications concurrently with distinct Docker-bound ports and names", async () => {
    const host = new DockerHost();
    const runner = host.runner();
    try {
      const results = await Promise.all([runner(workspace()), runner(workspace())]);
      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      const ports = host.recipeEnvironments.map((env) => new URL(env.DATABASE_URL!).port);
      expect(ports).toHaveLength(2);
      expect(new Set(ports).size).toBe(2);
      expect(new Set(host.recipeEnvironments.map((env) => new URL(env.DATABASE_URL!).password)).size).toBe(2);
      const names = host.dockerCalls.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--name") + 1]);
      expect(new Set(names).size).toBe(2);
      host.assertGone();
    } finally { await runner.close(); }
  });

  it("leaves a no-database recipe and its filtered environment unchanged", async () => {
    const host = new DockerHost();
    const runner = host.runner();
    const result = await runner(workspace(false));
    expect(result.output).toBe("no database\n");
    expect(host.recipeEnvironments).toEqual([{ PATH: "/runtime", LANG: "C" }]);
    expect(host.dockerCalls).toEqual([]);
    await runner.close();
  });

  it.each([true, false])("records the production database decision in the real ledger (Docker available=%s)", async (available) => {
    const host = new DockerHost();
    host.available = available;
    const brief = workspace();
    const runner = host.runner();
    try {
      const { reports, ledger } = await recordVerification(brief, () => runner(brief));
      if (available) {
        expect(reports[0]?.outcome).toBe("ACCEPTED");
        expect(ledger.accepted).toBeDefined();
        host.assertGone();
      } else {
        // This assertion MUST red if unavailable Docker is changed to a successful skip.
        expect(ledger.accepted).toBeUndefined();
        expect(reports[0]?.outcome).toBe("FAILED_ROUND_RECORDED");
        expect(ledger.version).toBe(2);
        const failure = ledger.lineage.records.find((record) => record.finding.ruleId === VERIFIER_FAILURE_RULE);
        expect(failure?.finding.detail).toContain('"code":"MIGRATION_DB_UNAVAILABLE"');
        expect(failure?.finding.detail).toContain('"refusedBy":"DAEMON_INGRESS"');
        expect(failure?.finding.detail).toContain('"reason":"DOCKER_UNAVAILABLE"');
        expect(host.events).toEqual([]);
      }
    } finally { await runner.close(); }
  });

  it.each(["ready", "remove"])("refuses %s failure with its reason and never runs an unready recipe", async (stage) => {
    const host = new DockerHost();
    host.ready = stage !== "ready";
    host.failRemove = stage === "remove";
    const runner = host.runner();
    try {
      const result = await runner(workspace());
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_DB_UNAVAILABLE", refusedBy: "DAEMON_INGRESS",
        reason: stage === "ready" ? "POSTGRES_NOT_READY" : "CONTAINER_CLEANUP_FAILED" });
      if (stage === "ready") { expect(host.events).toEqual([]); host.assertGone(); }
      else expect(host.containers.size).toBe(1); // The external double truth is a LEAK, not an invented clean flag.
    } finally {
      host.containers.clear();
      if (stage === "remove") await expect(runner.close()).rejects.toMatchObject({ message:
        '{"code":"MIGRATION_DB_UNAVAILABLE","refusedBy":"DAEMON_INGRESS","reason":"CONTAINER_CLEANUP_FAILED"}' });
      else await runner.close();
    }
  });

  it.each(["start", "port"])("refuses %s failures and removes any possibly created container", async (stage) => {
    const host = new DockerHost();
    host.startFails = stage === "start";
    host.portInvalid = stage === "port";
    const runner = host.runner();
    try {
      const result = await runner(workspace());
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_DB_UNAVAILABLE", refusedBy: "DAEMON_INGRESS",
        reason: stage === "start" ? "IMAGE_PULL_OR_START_FAILED" : "PORT_UNAVAILABLE" });
      expect(host.events).toEqual([]);
      host.assertGone();
    } finally { await runner.close(); }
  });

  it("tears down after a migration timeout before starting the recipe", async () => {
    const host = new DockerHost();
    host.hangMigration = true;
    host.migrationFails = true; // Writes a file banner, then hangs instead of exiting.
    const runner = host.runner(20);
    try {
      const result = await runner(workspace());
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_FAILED", refusedBy: "DAEMON_INGRESS", file: "1700000000001-broken.js" });
      expect(host.events).toEqual(["migration"]);
      host.assertGone();
    } finally { await runner.close(); }
  });

  it("does not persist a credential reflected through a real migration filename", async () => {
    const host = new DockerHost();
    host.migrationFails = true;
    host.reflectPasswordAsFilename = true;
    const runner = host.runner();
    try {
      const result = await runner(workspace());
      const failure = JSON.parse(result.output) as { code: string; refusedBy: string; file: string | null };
      expect(failure.code).toBe("MIGRATION_FAILED");
      expect(failure.refusedBy).toBe("DAEMON_INGRESS");
      // Boolean-only assertion: even a red control must never print the generated credential.
      expect(failure.file === null).toBe(true);
      host.assertGone();
    } finally { await runner.close(); }
  });

  it.each(["{", '{"scripts":{"db:migrate":""}}'])("fails closed on an unreadable/invalid declared manifest %s", async (manifest) => {
    const host = new DockerHost();
    const brief = workspace();
    writeFileSync(join(brief.workspace, "package.json"), manifest);
    const runner = host.runner();
    try {
      const result = await runner(brief);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({ code: "MIGRATION_DB_UNAVAILABLE", refusedBy: "DAEMON_INGRESS",
        reason: manifest === "{" ? "MANIFEST_UNREADABLE" : "MIGRATION_SCRIPT_INVALID" });
      expect(host.events).toEqual([]);
      expect(host.dockerCalls).toEqual([]);
    } finally { await runner.close(); }
  });
});

// Real ledger consequence, same host-authority fixture pattern as node-verifier.test.ts.
// No refusal/acceptance authority is implemented here: production adapters earn both verdicts.
async function recordVerification(brief: ReturnType<typeof workspace>, runTest: () => Promise<VerifierRunCapture>) {
  const projectId = "proj-verifier-db";
  const nodeRef = "node-verifier-db";
  const credential = randomUUID();
  const storePath = join(brief.workspace, `ledger-${randomUUID()}.db`);
  const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
  const store = SqliteEventStore.openForProject(storePath, projectId);
  installTestRecoveryBinding(store);
  try {
    const authority = testAuthority();
    const seed = runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
      commandId: randomUUID(), correlationId: "seed", decidedAt: "2026-08-11T09:00:00.000Z",
      expectedVersion: 0, kind: "review.submit", payload: { findings: [], round: 1, subjectRef: nodeRef,
        packageItems: [...authority.packageItems, { digest: "d".repeat(64), kind: "DAEMON_RECEIPT", locator: "receipt-1" }] },
      principalId: "sess-agent-x", projectId, schemaVersion: "moe-review-command/1",
    })));
    expect(seed.ok, seed.ok ? "" : seed.code).toBe(true);
    const verifier = createNodeVerifier({
      deps: provider.provide(), mintId: randomUUID, nodeMission: () => brief, nodes: () => [{ nodeRef }],
      operatorCredential: credential, projectId, runTest, store, verificationAuthority: () => authority,
      verifiedWorkspace: { capture: async () => ({ ok: true, binding: {
        branchRef: "refs/heads/main", dirtySha256: "d".repeat(64), headSha: "1".repeat(40), root: brief.workspace,
        treeSha: "2".repeat(40), version: "moe-verified-workspace/1",
      } }) },
    });
    const reports = await verifier.verifyOnce();
    return { reports, ledger: readReviewLedger(store, projectId, nodeRef) };
  } finally { store.close(); provider.close(); }
}

function testAuthority(): VerifierAuthorityFacts {
  const kinds = ["CRITERION", "GRAPH_HASH", "INTEGRATED_TREE", "PLAN_HASH", "RUBRIC", "SUBMITTED_BYTES"] as const;
  return {
    calibration: { corpusRevision: "corpus-1", sentinelPassed: true, staleness: "CURRENT" },
    packageItems: kinds.map((kind, i) => ({ digest: String(i + 1).repeat(64), kind, locator: `item-${i}` })),
    policy: {
      action: "integration.accept_output", actor: NODE_VERIFIER_PRINCIPAL_ID, callerRiskHint: "R1",
      decisionDigest: "d".repeat(64), evaluatedAtEpochMs: 1_760_000_000_000, evaluatorVersion: "daemon-verifier-1",
      facts: [{ factId: "fact-review-risk", tier: "R1", truthClass: "DAEMON_VERIFIED" }],
      graphNodeRevisionRefs: [], policyRevisionRef: "a".repeat(64), requiredFactIds: [], scope: [], waivers: [],
      sliceChain: [{ autoApprovalOptIns: [{ action: "integration.accept_output", tier: "R1" }], rules: [], sliceRef: "a".repeat(64) }],
    },
  };
}

function generatedWorkspace() {
  const brief = workspace();
  const generated = generateControlledProfile({ productName: "verifier-probe", profileVersion: CONTROLLED_PROFILE_VERSION });
  if (!generated.ok) throw new Error(`${generated.code}@${generated.refusedBy}`);
  // Replace the offline-only migration; the live arm consumes EXACT scaffold bytes.
  rmSync(join(brief.workspace, "migrations"), { recursive: true });
  for (const [path, body] of generated.files) {
    mkdirSync(dirname(join(brief.workspace, path)), { recursive: true });
    writeFileSync(join(brief.workspace, path), body);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete env[key];
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: brief.workspace, env, shell: false, encoding: "utf8", timeout: 600_000,
  });
  expect(install.error).toBeUndefined();
  expect(install.status, "GENERATED PRODUCT frozen install").toBe(0);
  process.stdout.write("GENERATED PRODUCT frozen install EXIT0\n");
  writeFileSync(join(brief.workspace, "verifier-probe.mjs"), `
import pg from 'pg';
import { existsSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const result = await client.query("SELECT to_regclass('public.app_metadata') IS NOT NULL AS present");
  writeFileSync(mode + '.ready', JSON.stringify({ present: result.rows[0].present,
    databaseUrlPresent: Boolean(process.env.DATABASE_URL), port: new URL(process.env.DATABASE_URL).port }));
  await client.end();
  if (mode === 'kill' || mode.startsWith('parallel')) {
    while (!existsSync(mode + '.release')) await new Promise(resolve => setTimeout(resolve, 50));
  }
  process.exitCode = mode === 'reject' ? 7 : 0;
} catch { process.exitCode = 73; }
`);
  return brief;
}

async function readyMarker(dir: string, mode: string) {
  const path = join(dir, `${mode}.ready`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(existsSync(path), `RECIPE_MARKER_MISSING:${mode}`).toBe(true);
  const marker = JSON.parse(readFileSync(path, "utf8")) as { present: boolean; databaseUrlPresent: boolean; port: string };
  expect(marker).toMatchObject({ present: true, databaseUrlPresent: true });
  expect(Number(marker.port)).toBeGreaterThan(0);
  return marker;
}

function realContainerExists(name: string): boolean {
  const result = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", `name=^/${name}$`], {
    shell: false, encoding: "utf8", timeout: 30_000,
  });
  expect(result.status, "DOCKER_EXISTENCE_QUERY_FAILED").toBe(0);
  return result.stdout.trim() !== "";
}

it.runIf(process.env.MOE_VERIFIER_DATABASE === "1")("real PostgreSQL: ACCEPT, REJECT, forced kill, concurrent ports and failing-file proof", async () => {
  const brief = generatedWorkspace();
  const names: string[] = [];
  const runners: ReturnType<typeof createVerifierDatabaseRunner>[] = [];
  const makeRunner = () => {
    const runner = createVerifierDatabaseRunner({ timeoutMs: 180_000, spawn: (file, args, options) => {
      if (file === "docker" && args[0] === "run") names.push(args[args.indexOf("--name") + 1]!);
      return spawn(file, [...args], options);
    } });
    runners.push(runner);
    return runner;
  };
  const mission = (mode: string) => ({ ...brief, test: `node verifier-probe.mjs ${mode}` });
  try {
    for (const mode of ["accept", "reject"]) {
      // Own ledger per mode; a successful earlier acceptance must not skip the reject run.
      const runner = makeRunner();
      const { reports, ledger } = await recordVerification(mission(mode), () => runner(mission(mode)));
      expect(reports[0]?.outcome).toBe(mode === "accept" ? "ACCEPTED" : "FAILED_ROUND_RECORDED");
      if (mode === "accept") expect(ledger.accepted).toBeDefined();
      else {
        expect(ledger.accepted).toBeUndefined();
        expect(ledger.lineage.records.find((record) => record.finding.ruleId === VERIFIER_FAILURE_RULE)?.finding.detail)
          .toContain("verifier run exited 7");
      }
      await readyMarker(brief.workspace, mode);
      expect(realContainerExists(names.at(-1)!)).toBe(false);
      process.stdout.write(`REAL VERIFIER ${mode.toUpperCase()}: recipe saw migrated table and DATABASE_URL; Docker says ABSENT\n`);
      await runner.close();
    }
    const killed = makeRunner();
    const pendingKill = killed(mission("kill"));
    const rejection = expect(pendingKill).rejects.toMatchObject({ code: "VERIFIER_PROCESS_CANCELLED" });
    await readyMarker(brief.workspace, "kill");
    await killed.close();
    await rejection;
    expect(realContainerExists(names.at(-1)!)).toBe(false);
    process.stdout.write("REAL VERIFIER FORCED RECIPE KILL: Docker says ABSENT\n");

    const parallel = makeRunner();
    const modes = ["parallel-a", "parallel-b"];
    const running = modes.map((mode) => parallel(mission(mode)));
    const markers = await Promise.all(modes.map((mode) => readyMarker(brief.workspace, mode)));
    expect(new Set(markers.map((marker) => marker.port)).size).toBe(2);
    expect(new Set(names.slice(-2)).size).toBe(2);
    expect(names.slice(-2).map(realContainerExists)).toEqual([true, true]);
    for (const mode of modes) writeFileSync(join(brief.workspace, `${mode}.release`), "release");
    expect((await Promise.all(running)).map((capture) => capture.exitCode)).toEqual([0, 0]);
    expect(names.slice(-2).map(realContainerExists)).toEqual([false, false]);
    process.stdout.write("REAL VERIFIER CONCURRENT: two live databases, distinct ports/names, both removed\n");

    writeFileSync(join(brief.workspace, "migrations/1700000000000-initial.js"),
      "export const up = () => { throw new Error('MIGRATION_PROBE_FAILURE'); }; export const down = () => {};\n");
    const failed = await makeRunner()(mission("fail"));
    expect(JSON.parse(failed.output)).toEqual({ code: "MIGRATION_FAILED", refusedBy: "DAEMON_INGRESS", file: "1700000000000-initial.js" });
    expect(failed.exitCode).toBe(1);
    expect(realContainerExists(names.at(-1)!)).toBe(false);
    expect(names).toHaveLength(6);
    process.stdout.write("REAL VERIFIER MIGRATION_FAILED@DAEMON_INGRESS: 1700000000000-initial.js; Docker says ABSENT\n");
  } finally {
    await Promise.allSettled(runners.map((runner) => runner.close()));
    // Safety net, AFTER the assertions: even a regressed owner cannot leak this test's containers.
    for (const name of names) spawnSync("docker", ["rm", "--force", "--volumes", name], { shell: false, timeout: 30_000 });
  }
}, 900_000);
