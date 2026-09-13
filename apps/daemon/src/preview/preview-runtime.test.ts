import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { runPreview } from "./preview-runner.js";
import { LISTENING_SERVER, cleanupFixtureWorkspaces, commitFixtureWorkspace, fixtureWorkspace } from "./preview-test-fixtures.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); closeStores(); cleanupFixtureWorkspaces(); });
function config() {
  const store = openStore(); driveThrough(store, "goal.close");
  const graph = activeCompiledGraphs(store, PROJECT_ID).find(item => item.goalRef === GOAL_ID)!;
  const ref = compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, ref); seedLandingReceipt(store, ref, "COMMITTED");
  return { projectId: PROJECT_ID, store, process: { startTimeoutMs: 15_000 } };
}
function product(manager: "npm" | "pnpm", build = 'import {writeFileSync} from "node:fs";writeFileSync("dist.txt"," built");',
  extraFiles: Readonly<Record<string, string>> = {}) {
  const lock = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  const files = {
    "package.json": JSON.stringify({ name: "preview-runtime", version: "1.0.0", private: true, type: "module",
      scripts: { preview: "node server.mjs", build: "node build.mjs",
        postinstall: "node -e \"require('node:fs').writeFileSync('install-hook.txt','ran')\"" },
      dependencies: { "preview-dep": "file:./vendor" } }),
    "vendor/package.json": JSON.stringify({ name: "preview-dep", version: "1.0.0", type: "module", exports: "./index.js" }),
    "vendor/index.js": 'export default "committed dependency";\n',
    "build.mjs": build,
    "server.mjs": 'import {createServer} from "node:http";import {readFileSync} from "node:fs";import body from "preview-dep";'
      + 'const suffix=readFileSync("dist.txt","utf8");const server=createServer((q,r)=>r.end(body+suffix));'
      + 'server.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+server.address().port));',
    [lock]: "",
    ...extraFiles,
  };
  const workspace = fixtureWorkspace({ scripts: {}, files });
  const command = manager === "npm"
    ? "npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund"
    : "pnpm install --lockfile-only --offline --ignore-scripts --store-dir .fixture-store";
  const setup = spawnSync(command, { cwd: workspace, shell: true, windowsHide: true, encoding: "utf8" });
  expect(setup.status, setup.stderr + setup.stdout).toBe(0);
  return { workspace, files, lock };
}

describe("preview runtime preparation", () => {
  for (const carrier of ["manifest", "npm lock", "pnpm lock"] as const) {
    it(`refuses external local dependencies in the ${carrier} before installer effects`, async () => {
      const external = fixtureWorkspace({ scripts: {}, files: { "index.js": "mutable external dependency" } });
      const path = external.replaceAll("\\", "/");
      const workspace = fixtureWorkspace({ scripts: {}, files: {
        "package.json": JSON.stringify({ dependencies: { external: carrier === "manifest" ? `file:${path}` : "1.0.0" },
          scripts: { preview: "node server.mjs" } }),
        ...(carrier === "pnpm lock" ? { "pnpm-lock.yaml": `lockfileVersion: '9.0'\nexternal: file:${path}\n` }
          : { "package-lock.json": JSON.stringify(carrier === "npm lock" ? { packages: {
            "node_modules/external": { link: true, resolved: path },
          } } : {}) }),
      } });
      let spawns = 0;
      const result = await runPreview({ ...config(), process: { spawn: (file, args, options) => {
        spawns += 1; return spawn(file, [...args], options);
      } }, capture: async () => [] }, { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
      expect(result.ok).toBe(false);
      if (result.ok) { stops.push(result.started.handle.stop); throw new Error("external dependency admitted"); }
      expect(result.refusal).toMatchObject({ code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" });
      expect(spawns).toBe(0);
    });
  }

  for (const mutation of ["startup", "capture"] as const) {
    it(`refuses tracked source drift during ${mutation} without a STARTED receipt`, async () => {
      const workspace = fixtureWorkspace({ scripts: { preview: "node server.mjs",
        ...(mutation === "startup" ? { prepreview: "node change.mjs" } : {}) }, files: {
        "server.mjs": LISTENING_SERVER, "product.txt": "committed source",
        "change.mjs": 'import {writeFileSync} from "node:fs";writeFileSync("product.txt","changed source");',
      } });
      let captures = 0;
      const result = await runPreview({ ...config(), capture: async input => {
        captures += 1; writeFileSync(join(input.workspace, "product.txt"), "changed source"); return [];
      } }, { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
      if (result.ok) stops.push(result.started.handle.stop);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("mutated source accepted");
      expect(result.refusal).toMatchObject({ code: "PREVIEW_START_TIMEOUT", layer: "RUNNER" });
      expect(result.receipt).toMatchObject({ outcome: "REFUSED", pid: null, screenshots: [] });
      expect(captures).toBe(mutation === "startup" ? 0 : 1);
    }, 40_000);
  }

  for (const manager of ["npm", "pnpm"] as const) {
    it(`installs locked ${manager} dependencies and builds an ordinary preview script inside the selected snapshot`, async () => {
      const { workspace, files } = product(manager); const sha = commitFixtureWorkspace(workspace);
      writeFileSync(join(workspace, "vendor/index.js"), 'export default "dirty dependency";\n');
      let source = ""; let body = "";
      const result = await runPreview({ ...config(), capture: async input => {
        source = input.workspace; body = await (await fetch(input.origin)).text(); return [];
      } }, { goalId: GOAL_ID, sha, workspace });
      if (result.ok) stops.push(result.started.handle.stop);
      expect(result.ok).toBe(true); expect(body).toBe("committed dependency built");
      expect(source).not.toBe(workspace);
      expect(realpathSync(join(source, "node_modules/preview-dep")).startsWith(source)).toBe(true);
      expect(readFileSync(join(source, "server.mjs"), "utf8")).toBe(files["server.mjs"]);
      expect(readFileSync(join(workspace, "vendor/index.js"), "utf8")).toContain("dirty dependency");
      expect(existsSync(join(workspace, "dist.txt"))).toBe(false);
      expect(existsSync(join(source, "install-hook.txt"))).toBe(false);
    }, 60_000);
  }

  for (const failure of ["install", "build", "source mutation"] as const) {
    it(`cuts off the product process and capture after ${failure} preparation failure`, async () => {
      const build = failure === "build" ? "process.exit(7);" : failure === "source mutation"
        ? 'import {writeFileSync} from "node:fs";writeFileSync("server.mjs","throw new Error();");'
        : undefined;
      const { workspace, lock } = product("npm", build);
      if (failure === "install") writeFileSync(join(workspace, lock), "{}");
      const sha = commitFixtureWorkspace(workspace); let launched = 0; let captured = 0;
      const result = await runPreview({ ...config(), process: { startTimeoutMs: 15_000,
        spawn: (file, args, options) => {
          if (file === "npm run preview") launched += 1;
          return spawn(file, [...args], options);
        } }, capture: async () => { captured += 1; return []; } }, { goalId: GOAL_ID, sha, workspace });
      if (result.ok) stops.push(result.started.handle.stop);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("preparation failure launched");
      expect(result.refusal).toMatchObject({ code: "PREVIEW_START_TIMEOUT", layer: "RUNNER" });
      expect({ launched, captured }).toEqual({ launched: 0, captured: 0 });
    }, 60_000);
  }

  it("disables pnpm config hooks and contains configured dependency output directories", async () => {
    const external = fixtureWorkspace({ scripts: {} });
    const { workspace } = product("pnpm", undefined, { ".pnpmfile.cjs": "module.exports={};",
      "pnpm-workspace.yaml": "packages: [\".\"]\nmodulesDir: " + JSON.stringify(join(external, "modules"))
        + "\nvirtualStoreDir: " + JSON.stringify(join(external, "store")) + "\n" });
    writeFileSync(join(workspace, ".pnpmfile.cjs"), 'require("node:fs").writeFileSync('
      + JSON.stringify(join(external, "hook-ran")) + ',"ran");module.exports={};');
    let body = "";
    const result = await runPreview({ ...config(),
      capture: async input => { body = await (await fetch(input.origin)).text(); return []; } },
    { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
    if (result.ok) stops.push(result.started.handle.stop);
    expect(existsSync(join(external, "hook-ran"))).toBe(false);
    expect(existsSync(join(external, "modules"))).toBe(false);
    expect(existsSync(join(external, "store"))).toBe(false);
    expect(result.ok).toBe(true); expect(body).toBe("committed dependency built");
  }, 60_000);

  for (const script of ["dev", "start"] as const) {
    it(`serves ${script} without invoking a build script`, async () => {
      const workspace = fixtureWorkspace({ scripts: { [script]: "node server.mjs", build: "node failing-build.mjs" },
        files: { "server.mjs": LISTENING_SERVER, "failing-build.mjs": "process.exit(8);" } });
      const result = await runPreview({ ...config(), capture: async () => [] },
        { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
      if (result.ok) stops.push(result.started.handle.stop);
      expect(result.ok).toBe(true);
    }, 40_000);
  }

  it("preserves explicit commands without automatic dependency or build preparation", async () => {
    const workspace = fixtureWorkspace({ scripts: {}, files: { "server.mjs": LISTENING_SERVER,
      "package.json": JSON.stringify({ dependencies: { absent: "1.0.0" }, scripts: { build: "missing-build" } }) } });
    const result = await runPreview({ ...config(), capture: async () => [], contractFacts: () => ({
      deploymentStatements: ["preview command: node server.mjs"], journeys: [],
    }) }, { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
    if (result.ok) stops.push(result.started.handle.stop);
    expect(result.ok).toBe(true);
  }, 40_000);

  for (const kind of ["no lock", "conflicting locks", "manager mismatch", "null manifest", "peer dependencies", "npm workspaces"] as const) {
    it(`refuses ${kind} before any preparation or product process`, async () => {
      const manifest = kind === "null manifest" ? null : { scripts: { preview: "node server.mjs" },
        ...(kind === "peer dependencies" ? { peerDependencies: { absent: "1.0.0" } }
          : kind === "npm workspaces" ? { workspaces: ["packages/*"] } : { dependencies: { absent: "1.0.0" } }),
        ...(kind === "manager mismatch" ? { packageManager: "yarn@1.0.0" } : {}) };
      const workspace = fixtureWorkspace({ scripts: {}, files: { "package.json": JSON.stringify(manifest),
        ...(["conflicting locks", "manager mismatch"].includes(kind) ? { "package-lock.json": "{}" } : {}),
        ...(kind === "conflicting locks" ? { "pnpm-lock.yaml": "" } : {}) } });
      let spawns = 0;
      const result = await runPreview({ ...config(), readScripts: () => ({ preview: "node server.mjs" }),
        process: { spawn: (file, args, options) => { spawns += 1; return spawn(file, [...args], options); } },
        capture: async () => { throw new Error("capture reached"); },
      }, { goalId: GOAL_ID, sha: commitFixtureWorkspace(workspace), workspace });
      expect(result.ok).toBe(false);
      if (result.ok) { stops.push(result.started.handle.stop); throw new Error("unsafe preparation launched"); }
      expect(result.refusal).toMatchObject({ code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" });
      expect(spawns).toBe(0);
    });
  }
});
