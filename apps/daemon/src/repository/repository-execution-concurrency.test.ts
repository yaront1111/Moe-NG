import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const moduleUrl = new URL("./repository-execution-port.js", import.meta.url).href;
const owner = { projectId: "project-a", nodeRef: "graph-a:node-a", ownershipToken: "a".repeat(64), storeId: "store-a" };
const controller = { controllerId: "controller-a", controllerPid: process.pid };
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-execution-race-")); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, shell: false, windowsHide: true });
  return root;
}

function processFor(source: string, args: readonly string[]) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], { shell: false, windowsHide: true });
  let output = ""; let errors = "";
  let markReady!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve; child.once("error", reject); child.once("exit", () => { if (!output.includes("READY\n")) reject(new Error(errors)); });
  });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("READY\n")) markReady(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const done = once(child, "close").then(([code]) => ({ code, output, errors }));
  return { child, ready, done };
}

describe("repository reservation across native processes", () => {
  it("admits exactly one of four simultaneous project stores", async () => {
    const root = repository();
    const children = Array.from({ length: 4 }, (_, index) => processFor(String.raw`
      const { createRepositoryExecutionPort } = await import(process.argv[1]);
      process.stdout.write('READY\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      const result = createRepositoryExecutionPort().acquire(process.argv[2], JSON.parse(process.argv[3]), { controllerId: 'controller-' + process.pid, controllerPid: process.pid });
      process.stdout.write(JSON.stringify(result) + '\n');
      process.stdin.destroy();
    `, [moduleUrl, root, JSON.stringify({ ...owner, projectId: 'project-' + index, storeId: 'store-' + index })]));
    try {
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) child.child.stdin.end("GO\n");
      const completed = await Promise.all(children.map((child) => child.done));
      for (const result of completed) expect(result.code, result.errors).toBe(0);
      const results = completed.map((result) => JSON.parse(result.output.split("\n")[1] ?? "null"));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok).map((result) => result.code))
        .toEqual(["REPOSITORY_EXECUTION_BUSY", "REPOSITORY_EXECUTION_BUSY", "REPOSITORY_EXECUTION_BUSY"]);
      const observation = createRepositoryExecutionPort().inspect(root);
      expect(observation).toMatchObject({ ok: true, reservation: { projectId: results.find((result) => result.ok).handle.owner.projectId } });
    } finally { for (const child of children) child.child.kill(); await Promise.all(children.map((child) => child.done)); }
  }, 60_000);

  it("rolls back an interrupted transaction while retaining the logical owner for recovery", async () => {
    const root = repository(); const port = createRepositoryExecutionPort();
    const acquired = port.acquire(root, owner, controller); expect(acquired.ok).toBe(true); if (!acquired.ok) throw new Error(acquired.code);
    const changed = port.transition(root, owner, 1, { ...controller, phase: "EXECUTING", baselineId: "original-baseline", sessionId: "original-session", pid: 987654 });
    expect(changed.ok).toBe(true); if (!changed.ok) throw new Error(changed.code);
    const child = processFor(String.raw`
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
      database.prepare('UPDATE reservation SET state_json = ?').run('x'.repeat(500000));
      process.stdout.write('READY\n');
      setInterval(() => {}, 1000);
    `, [join(root, ".git", "moe-repository-execution.sqlite")]);
    try { await child.ready; child.child.kill(); await child.done; }
    finally { child.child.kill(); await child.done; }
    const restarted = createRepositoryExecutionPort();
    expect(restarted.readOwned(root, owner.storeId, owner.projectId)).toEqual({ ok: true, handle: changed.handle });
    expect(restarted.acquire(root, { ...owner, projectId: "new-project", storeId: "new-store" }, controller))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
  }, 60_000);
});
