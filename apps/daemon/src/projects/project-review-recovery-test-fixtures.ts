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

/** Process scripts stay outside the application's Git workspace and contain no provider. */
export async function startPrivateReviewRuntime(projectRoot: string, runtimeRoot: string) {
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
  const child = spawn(process.execPath, [cli, "start", projectRoot, "--operator-stdin"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; let error = ""; let closed = false;
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
  child.on("close", () => { closed = true; });
  const close = async () => {
    if (!closed) child.kill(); // Exact owned CLI only; its broker then loses its original handle.
    const until = Date.now() + 8_000;
    while (!closed && Date.now() < until) await delay(25);
    if (!closed) throw new Error("PRIVATE_REVIEW_CLI_NOT_CLOSED");
    if (!resolve(fixtureRoot).startsWith(resolve(tmpdir(), "moe-review-recovery-processes-"))) throw new Error("PRIVATE_PROCESS_ROOT_INVALID");
    rmSync(fixtureRoot, { recursive: true, force: true });
  };
  try {
    const until = Date.now() + 15_000;
    while (!output.includes("\n") && !closed && Date.now() < until) await delay(25);
    if (!output.includes("\n")) throw new Error(`PRIVATE_REVIEW_RUNTIME_NOT_READY: ${error}`);
    const identity = JSON.parse(output.trim()) as { controllerPid: number; daemonPid: number; brokerPid: number; port: number; workerPid: number; startedAt: string };
    return { ...identity, cliPid: child.pid!, close, closed: () => closed };
  } catch (cause) { await close(); throw cause; }
}
