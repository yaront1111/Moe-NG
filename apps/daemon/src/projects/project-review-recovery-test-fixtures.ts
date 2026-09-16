import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";

const delay = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });
export async function privateListenerOpen(port: number): Promise<boolean> {
  return await new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
    socket.setTimeout(1_000, () => { socket.destroy(); done(false); });
  });
}

/** Run physical packaged modules in the same default Node runtime as moe.ps1, outside Vitest's resolver. */
export async function runPackagedReviewRecoveryCli(runtimeRoot: string, projectRoot: string,
  expected: { readonly owner: unknown; readonly storeId: string; readonly projectId: string;
    readonly baselineId: string; readonly revision: number }) {
  const script = `import assert from 'node:assert/strict';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const input=await new Promise(resolve=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>resolve(JSON.parse(text)));});
const {runtimeRoot,projectRoot,expected}=input;
const load=relative=>import(pathToFileURL(join(runtimeRoot,relative)).href);
const {runMoeCli}=await load('apps/daemon/src/cli/moe-cli-main.js');
const events=[],logs=[];let recoveryResult,diagnostic;
const code=await runMoeCli({artifactRoot:runtimeRoot,argv:['recover-review',projectRoot,'--operator-stdin'],cwd:projectRoot,
env:{},log:line=>logs.push(line),nodeVersion:process.version,packageVersion:'private-test',randomHex:()=> 'ab'.repeat(32),
startManager:async()=>{throw new Error('MANAGER_MUST_NOT_START');},
recoverReview:async request=>{events.push('recover');try {const {runProjectReviewRecovery}=await load('apps/daemon/src/cli/moe-cli-review-recovery.js');
recoveryResult=await runProjectReviewRecovery(request);return recoveryResult;}catch(error){diagnostic=String(error.stack);throw error;}},
startStack:async request=>{assert.deepEqual(recoveryResult,{ok:true});assert.equal(request.projectRoot,projectRoot);assert.equal(request.operatorStdin,true);
const {createRepositoryExecutionPort}=await load('apps/daemon/src/repository/repository-execution-port.js');
const owned=createRepositoryExecutionPort().readOwned(projectRoot,expected.storeId,expected.projectId);
assert.equal(owned.ok,true);assert.deepEqual(owned.handle.owner,expected.owner);
assert.equal(owned.handle.reservation.phase,'RESERVED');assert.equal(owned.handle.reservation.baselineId,expected.baselineId);
assert.equal(owned.handle.reservation.revision,expected.revision);assert.equal(owned.handle.reservation.sessionId,null);assert.equal(owned.handle.reservation.pid,null);
events.push('restart');return 17;}});
process.stdout.write(JSON.stringify({code,events,logs,recoveryResult,diagnostic})+'\\n');process.exitCode=code;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = ""; let errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const timer = setTimeout(() => { child.kill(); }, 40_000);
  const completed = new Promise<number | null>((done, reject) => {
    child.once("error", reject); child.once("close", (code) => { done(code); });
  });
  child.stdin.end(JSON.stringify({ runtimeRoot, projectRoot, expected }));
  try {
    const exitCode = await completed;
    if (output.length === 0) throw new Error(`PRIVATE_PACKAGED_RECOVERY_NO_RESULT (${exitCode}): ${errors}`);
    const result = JSON.parse(output.trim()) as { code: number; events: string[]; logs: string[];
      recoveryResult?: { ok: boolean; code?: string }; diagnostic?: string };
    if (result.code !== exitCode) throw new Error("PRIVATE_PACKAGED_RECOVERY_EXIT_MISMATCH");
    return result;
  } finally { clearTimeout(timer); }
}

/** Process scripts stay outside the application's Git workspace and contain no provider. */
export async function startPrivateReviewRuntime(projectRoot: string, runtimeRoot: string,
  cliCommand: "start" | "recover-review" | "recover-replan" = "start") {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "moe-review-recovery-processes-"));
  const cli = join(fixtureRoot, "apps", "daemon", "src", "cli", "moe-cli-main.ts");
  const entry = join(fixtureRoot, "project-stack-host-main.ts");
  const controller = join(fixtureRoot, "controller.mjs");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(controller, `import {spawn} from 'node:child_process';
const worker=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
let startedAt;worker.once('spawn',()=>{startedAt=new Date().toISOString();});
worker.once('exit',()=>process.stdout.write(JSON.stringify({controllerPid:process.pid,workerPid:worker.pid,startedAt})+'\\n'));
setInterval(()=>{},1000);\n`);
  writeFileSync(entry, `import {spawn} from 'node:child_process';import {createServer} from 'node:net';
const controller=spawn(process.execPath,[${JSON.stringify(controller)}],{stdio:['ignore','pipe','ignore']});
const ready=new Promise(resolve=>{let text='';controller.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes('\\n'))resolve(JSON.parse(text.trim()));});});
const server=createServer();server.listen(0,'127.0.0.1',async()=>{await ready;
process.stdout.write(JSON.stringify({...await ready,daemonPid:process.pid,brokerPid:process.ppid,port:server.address().port})+'\\n');});\n`);
  const boundary = pathToFileURL(join(runtimeRoot, "packages/runner/src/platform/windows/windows-project-stack-boundary.js")).href;
  writeFileSync(cli, `import {openWindowsProjectStackBoundary} from ${JSON.stringify(boundary)};
const boundary=openWindowsProjectStackBoundary(${JSON.stringify({ assetRoot: fixtureRoot, configPath: join(projectRoot, "moe.config.json"), cwd: projectRoot,
    entryPath: entry, environment: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" }, instanceId: randomUUID(),
    nodeExecutable: process.execPath, storePath: join(projectRoot, "store.sqlite") })});
if('truthClass' in boundary) throw new Error(boundary.code);
boundary.providerStdout.pipe(process.stdout);boundary.providerStderr.pipe(process.stderr);
const result=await boundary.completed;process.exit(result.truthClass==='PROVEN'?0:2);\n`);
  const child = spawn(process.execPath, [cli, cliCommand, projectRoot, "--operator-stdin"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; let error = ""; let closed = false;
  let runtime: { readonly controllerPid: number; readonly daemonPid: number; readonly brokerPid: number; readonly port: number } | null = null;
  const dead = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
  child.on("close", () => { closed = true; });
  const close = async () => {
    if (!closed) child.kill(); // Exact owned CLI only; its broker then loses its original handle.
    const until = Date.now() + 8_000;
    while (!closed && Date.now() < until) await delay(25);
    if (!closed) throw new Error("PRIVATE_REVIEW_CLI_NOT_CLOSED");
    // Its Job closes with the broker's last handle, which kills the rest asynchronously.
    if (runtime !== null) {
      const gone = Date.now() + 30_000;
      while (Date.now() < gone) {
        if ([runtime.controllerPid, runtime.daemonPid, runtime.brokerPid].every(dead)
          && !(await privateListenerOpen(runtime.port))) break;
        await delay(50);
      }
    }
    if (!resolve(fixtureRoot).startsWith(resolve(tmpdir(), "moe-review-recovery-processes-"))) throw new Error("PRIVATE_PROCESS_ROOT_INVALID");
    rmSync(fixtureRoot, { recursive: true, force: true });
  };
  try {
    const until = Date.now() + 15_000;
    while (!output.includes("\n") && !closed && Date.now() < until) await delay(25);
    if (!output.includes("\n")) throw new Error(`PRIVATE_REVIEW_RUNTIME_NOT_READY: ${error}`);
    const identity = JSON.parse(output.trim()) as { controllerPid: number; daemonPid: number; brokerPid: number; port: number; workerPid: number; startedAt: string };
    runtime = { brokerPid: identity.brokerPid, controllerPid: identity.controllerPid,
      daemonPid: identity.daemonPid, port: identity.port };
    return { ...identity, cliPid: child.pid!, close, closed: () => closed };
  } catch (cause) { await close(); throw cause; }
}
