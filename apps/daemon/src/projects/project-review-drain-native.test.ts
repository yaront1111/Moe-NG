import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProjectReviewDrainPort } from "./project-review-drain.js";
import { drainWithNativeFault } from "./project-review-drain-fault-test-fixtures.js";

describe.skipIf(process.platform !== "win32")("private real Windows project Job drain", () => {
  it.each(["drain", "operator-stdin", "manager", "different-workspace", "controller-too-new", "extra-argument",
    "access-denied", "query-only", "query-failed", "active-members"] as const)(
    "proves drain or refuses before stopping a private project: %s", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "moe-review-drain-"));
    const entry = join(root, "project-stack-host-main.ts");
    const controller = join(root, "controller.mjs");
    const cli = join(root, "apps", "daemon", "src", "cli", "moe-cli-main.ts");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(controller, "setInterval(() => {}, 1000);\n");
    writeFileSync(entry, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(controller)}],{stdio:'ignore'});
child.on('spawn',()=>process.stdout.write(JSON.stringify({controllerPid:child.pid,daemonPid:process.pid})+'\\n'));
setInterval(()=>{},1000);\n`);
    const artifactRoot = process.env["MOE_REVIEW_DRAIN_ARTIFACT_ROOT"];
    const runtimeRoot = artifactRoot === undefined ? resolve("../..") : resolve(artifactRoot);
    const boundary = pathToFileURL(join(runtimeRoot, "packages/runner/src/platform/windows/windows-project-stack-boundary.js")).href;
    const createDrain: typeof createProjectReviewDrainPort = artifactRoot === undefined ? createProjectReviewDrainPort
      : (await import(pathToFileURL(join(runtimeRoot, "apps/daemon/src/projects/project-review-drain.js")).href)).createProjectReviewDrainPort;
    writeFileSync(cli, `import {openWindowsProjectStackBoundary} from ${JSON.stringify(boundary)};
const boundary=openWindowsProjectStackBoundary(${JSON.stringify({ assetRoot: root, configPath: join(root, "moe.config.json"), cwd: root,
      entryPath: entry, environment: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" }, instanceId: randomUUID(),
      nodeExecutable: process.execPath, storePath: join(root, "store.sqlite") })});
if('truthClass' in boundary) throw new Error(boundary.code);
boundary.providerStdout.pipe(process.stdout);boundary.providerStderr.pipe(process.stderr);
const result=await boundary.completed;process.exit(result.truthClass==='PROVEN'?0:2);\n`);
    const args = [cli, scenario === "manager" ? "projects" : "start", root];
    if (scenario === "operator-stdin") args.push("--operator-stdin");
    if (scenario === "extra-argument") args.push("--unapproved");
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = ""; let closed = false;
    child.on("close", () => { closed = true; });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    let result: Awaited<ReturnType<ReturnType<typeof createProjectReviewDrainPort>["drain"]>> | undefined;
    try {
      const deadline = Date.now() + 15_000;
      while (!output.includes("\n") && !closed && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(output, errors).toContain("\n");
      const identity = JSON.parse(output.trim()) as { controllerPid: number; daemonPid: number };
      const input = { controllerPid: identity.controllerPid,
        notStartedAfter: scenario === "controller-too-new" ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
        workspace: scenario === "different-workspace" ? join(root, "different") : root };
      if (["access-denied", "query-only", "query-failed", "active-members"].includes(scenario)) {
        const failure = await drainWithNativeFault(input, scenario);
        expect(failure).toMatchObject({ ok: false, code: ["access-denied", "query-only"].includes(scenario)
          ? "RUNTIME_REVIEW_DRAIN_ACCESS_DENIED" : "RUNTIME_REVIEW_DRAIN_UNPROVEN" });
        if (["access-denied", "query-only"].includes(scenario)) {
          expect(closed).toBe(false);
          for (const pid of [child.pid!, identity.controllerPid, identity.daemonPid]) expect(() => process.kill(pid, 0)).not.toThrow();
        }
        return;
      }
      result = await createDrain().drain(input);
      if (!["drain", "operator-stdin"].includes(scenario)) {
        expect(result).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
        expect(closed).toBe(false);
        for (const pid of [child.pid!, identity.controllerPid, identity.daemonPid]) expect(() => process.kill(pid, 0)).not.toThrow();
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, evidence: { ...identity, cliPid: child.pid, jobEmpty: true } });
      if (result.ok) {
        expect(Date.parse(result.evidence.controllerStartedAt)).toBeLessThanOrEqual(Date.parse(result.evidence.observedAt));
        await result.close();
      }
      const deadline2 = Date.now() + 3_000;
      while (!closed && Date.now() < deadline2) await new Promise((done) => setTimeout(done, 25));
      expect(closed).toBe(true);
      for (const pid of [identity.controllerPid, identity.daemonPid]) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (result?.ok) await result.close();
      // Only this private CLI. Its owned broker observes control EOF and drains the job.
      if (!closed) child.kill();
      const until = Date.now() + 8_000;
      while (!closed && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
      if (!resolve(root).startsWith(resolve(tmpdir(), "moe-review-drain-"))) throw new Error("PRIVATE_WORKSPACE_IDENTITY_INVALID");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
