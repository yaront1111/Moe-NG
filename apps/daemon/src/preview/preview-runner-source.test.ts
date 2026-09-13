import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { nodeGitRunner } from "../repository/git-landing-port.js";
import { runPreview } from "./preview-runner.js";
import type { PreviewRunnerConfig } from "./preview-runner.js";
import { cleanupFixtureWorkspaces, fixtureWorkspace } from "./preview-test-fixtures.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
  closeStores();
  cleanupFixtureWorkspaces();
});

async function committedProduct(): Promise<{ workspace: string; sha: string }> {
  const workspace = fixtureWorkspace({ scripts: { preview: "node server.mjs" }, files: {
    "server.mjs": 'import { createServer } from "node:http";\n'
      + 'const server = createServer((_, response) => response.end("committed product"));\n'
      + 'server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));\n',
  } });
  for (const args of [
    ["init", "--template=", "."], ["add", "--", "package.json", "server.mjs"],
    ["-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "preview source"],
  ]) expect((await nodeGitRunner(workspace, args)).code).toBe(0);
  const head = await nodeGitRunner(workspace, ["rev-parse", "HEAD"]);
  expect(head.code).toBe(0);
  return { workspace, sha: head.stdout.trim() };
}

function landedConfig(): PreviewRunnerConfig {
  const store = openStore();
  driveThrough(store, "goal.close");
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((item) => item.goalRef === GOAL_ID)!;
  const nodeRef = compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  return { store, projectId: PROJECT_ID, capture: async () => [], process: { startTimeoutMs: 15_000 } };
}

describe("preview source selection", () => {
  it.skipIf(process.platform !== "win32")("retries a stop that completed before the product exited", async () => {
    const { workspace, sha } = await committedProduct();
    let kills = 0;
    let source = "";
    const result = await runPreview({ ...landedConfig(), process: { startTimeoutMs: 15_000, killGraceMs: 1,
      spawn: (file, args, options) => {
        if (file.toLowerCase().endsWith("taskkill.exe") && ++kills === 1) {
          const acknowledged = new ChildProcess();
          queueMicrotask(() => acknowledged.emit("close", 0));
          return acknowledged;
        }
        return spawn(file, [...args], options);
      },
    }, capture: async input => { source = input.workspace; return []; } }, { goalId: GOAL_ID, sha, workspace });
    if (!result.ok) throw new Error(result.refusal.code);
    const handle = result.started.handle;
    try {
      await handle.stop();
      expect(handle.alive()).toBe(true);
      expect(existsSync(source)).toBe(true);
      await handle.stop();
      expect(kills).toBe(2);
      await expect.poll(() => handle.alive(), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => existsSync(source), { timeout: 10_000 }).toBe(false);
    } finally {
      // The RED run must also stop its deliberately retained fixture process.
      if (handle.alive()) await new Promise<void>(resolve => {
        const cleanup = spawn("taskkill.exe", ["/pid", String(handle.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true });
        cleanup.once("close", () => resolve()); cleanup.once("error", () => resolve());
      });
    }
  }, 40_000);

  it("executes and captures the requested commit while preserving dirty source bytes", async () => {
    const { workspace, sha } = await committedProduct();
    const source = join(workspace, "server.mjs");
    const dirty = readFileSync(source, "utf8").replace("committed product", "uncommitted product");
    writeFileSync(source, dirty);
    writeFileSync(join(workspace, "untracked.txt"), "preserve me");
    let capturedSource = "";
    let captureDirectory = "";
    let observedBody = "";
    const result = await runPreview({ ...landedConfig(), capture: async input => {
      capturedSource = input.workspace;
      captureDirectory = input.directory;
      observedBody = await (await fetch(input.origin)).text();
      return [];
    } }, { goalId: GOAL_ID, sha, workspace });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal.code);
    stops.push(result.started.handle.stop);
    expect(observedBody).toBe("committed product");
    expect(capturedSource).not.toBe(workspace);
    expect(captureDirectory).toBe(workspace);
    expect(existsSync(capturedSource)).toBe(true);
    expect(readFileSync(source, "utf8")).toBe(dirty);
    expect(readFileSync(join(workspace, "untracked.txt"), "utf8")).toBe("preserve me");
    await result.started.handle.stop();
    expect(existsSync(capturedSource)).toBe(false);
  }, 40_000);

  it("refuses an absent commit before starting a product process", async () => {
    const { workspace } = await committedProduct();
    let spawns = 0;
    const result = await runPreview({ ...landedConfig(), process: {
      startTimeoutMs: 15_000, spawn: (file, args, options) => {
        spawns += 1;
        return spawn(file, [...args], options);
      },
    } }, { goalId: GOAL_ID, sha: "a".repeat(40), workspace });
    if (result.ok) stops.push(result.started.handle.stop);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an absent commit started a preview");
    expect(result.refusal).toMatchObject({ code: "PREVIEW_GOAL_NOT_LANDED", layer: "GOAL_AUTHORITY" });
    expect(spawns).toBe(0);
    expect(result.receipt?.outcome).toBe("REFUSED");
  }, 40_000);

  it("retains the requested source when HEAD and the working tree change during admission", async () => {
    const { workspace, sha } = await committedProduct();
    writeFileSync(join(workspace, "server.mjs"), readFileSync(join(workspace, "server.mjs"), "utf8")
      .replace("committed product", "newer committed product"));
    expect((await nodeGitRunner(workspace, ["add", "--", "server.mjs"])).code).toBe(0);
    expect((await nodeGitRunner(workspace, ["-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "newer source"])).code).toBe(0);
    let body = "";
    const result = await runPreview({ ...landedConfig(), readScripts: candidate => {
      writeFileSync(join(workspace, "server.mjs"), "throw new Error('mutable source must not run');");
      return (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as {
        scripts: Readonly<Record<string, string>>;
      }).scripts;
    }, capture: async input => {
      body = await (await fetch(input.origin)).text();
      return [];
    } }, { goalId: GOAL_ID, sha, workspace });
    if (result.ok) stops.push(result.started.handle.stop);
    expect(result.ok).toBe(true);
    expect(body).toBe("committed product");
  }, 40_000);

  it("removes the extracted source when command admission refuses", async () => {
    const { workspace, sha } = await committedProduct();
    let candidate = "";
    const result = await runPreview({ ...landedConfig(), readScripts: source => {
      candidate = source;
      return { build: "node --version" };
    } }, { goalId: GOAL_ID, sha, workspace });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a command refusal");
    expect(result.refusal).toMatchObject({ code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" });
    expect(candidate).not.toBe(workspace);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(workspace)).toBe(true);
  }, 40_000);

  it("stops the product and removes its source when capture throws", async () => {
    const { workspace, sha } = await committedProduct();
    let candidate = "";
    const result = await runPreview({ ...landedConfig(), capture: async input => {
      candidate = input.workspace;
      throw new Error("capture failure");
    } }, { goalId: GOAL_ID, sha, workspace });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected capture refusal");
    expect(result.refusal).toMatchObject({ code: "PREVIEW_START_TIMEOUT", layer: "RUNNER" });
    expect(candidate).not.toBe(workspace);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(workspace)).toBe(true);
  }, 40_000);

  for (const mode of ["120000", "160000"]) {
    it(`refuses an unbound source entry of mode ${mode} before process and capture`, async () => {
      const product = await committedProduct();
      const target = mode === "160000" ? product.sha : (await nodeGitRunner(product.workspace,
        ["hash-object", "-w", "--stdin"], join(product.workspace, "server.mjs"))).stdout.trim();
      expect((await nodeGitRunner(product.workspace,
        ["update-index", "--add", "--cacheinfo", `${mode},${target},external`])).code).toBe(0);
      expect((await nodeGitRunner(product.workspace, ["-c", "user.name=Preview Test",
        "-c", "user.email=preview@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "external entry"])).code).toBe(0);
      const sha = (await nodeGitRunner(product.workspace, ["rev-parse", "HEAD"])).stdout.trim();
      let spawns = 0;
      let captures = 0;
      const result = await runPreview({ ...landedConfig(), capture: async () => { captures += 1; return []; },
        process: { startTimeoutMs: 15_000, spawn: (file, args, options) => {
          spawns += 1;
          return spawn(file, [...args], options);
        } },
      }, { goalId: GOAL_ID, sha, workspace: product.workspace });
      if (result.ok) stops.push(result.started.handle.stop);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unbound source started");
      expect(result.refusal).toMatchObject({ code: "PREVIEW_GOAL_NOT_LANDED", layer: "GOAL_AUTHORITY" });
      expect(spawns).toBe(0);
      expect(captures).toBe(0);
    }, 40_000);
  }

  it("stops the process when writing its receipt throws", async () => {
    const product = await committedProduct();
    // A bounded fixture lifetime also cleans up the intentional RED run's leaked process.
    const path = join(product.workspace, "server.mjs");
    writeFileSync(path, readFileSync(path, "utf8") + '\nsetTimeout(() => server.close(), 5000);\n');
    await nodeGitRunner(product.workspace, ["add", "--", "server.mjs"]);
    await nodeGitRunner(product.workspace, ["-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", "bounded server"]);
    const sha = (await nodeGitRunner(product.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    const config = landedConfig();
    let origin = "";
    let source = "";
    let failWrites = false;
    const failingStore = new Proxy({} as typeof config.store, { get: (_target, property) => {
      if (property === "commitExpectedVersionDecision" && failWrites) {
        return (): never => { throw new Error("receipt write failed"); };
      }
      const value: unknown = Reflect.get(config.store, property, config.store);
      return typeof value === "function" ? value.bind(config.store) : value;
    } });
    const run = runPreview({ ...config, store: failingStore, capture: async input => {
      origin = input.origin;
      source = input.workspace;
      failWrites = true;
      return [];
    } }, { goalId: GOAL_ID, sha, workspace: product.workspace });
    await expect(run).rejects.toThrow("receipt write failed");
    await expect.poll(() => existsSync(source), { timeout: 15_000 }).toBe(false);
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 40_000);
});
