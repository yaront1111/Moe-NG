import { spawn } from "node:child_process";
import type { createRepositoryRecoveryService, RepositoryRecoveryCommand }
  from "../repository/repository-recovery-service.js";
import type { RepositoryReviewDrainEvidence } from "../repository/repository-review-drain-contracts.js";

/** Physical packaged modules run in ordinary Node, matching moe.ps1 rather than Vitest resolution. */
export async function runPackagedReplanRecovery(input: {
  readonly runtimeRoot: string; readonly workspace: string; readonly storeId: string; readonly projectId: string;
  readonly command: RepositoryRecoveryCommand; readonly scenario: "release" | "foreign-workspace";
  readonly expectedDrain: { readonly controllerPid: number; readonly notStartedAfter: string; readonly workspace: string };
}): Promise<{ readonly result: Awaited<ReturnType<ReturnType<typeof createRepositoryRecoveryService>["recover"]>>;
  readonly observed?: RepositoryReviewDrainEvidence; readonly closes: number }> {
  const script = `import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');
process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{try{resolve(JSON.parse(text));}catch(error){reject(error);}});});
const load=relative=>import(pathToFileURL(join(input.runtimeRoot,relative)).href);
const {SqliteEventStore}=await load('packages/store/src/index.ts');
const {createRepositoryRecoveryService}=await load('apps/daemon/src/repository/repository-recovery-service.js');
const {createProjectReviewDrainPort}=await load('apps/daemon/src/projects/project-review-drain.js');
const store=SqliteEventStore.openForProject(input.storeId,input.projectId);
let observed,closes=0;const native=createProjectReviewDrainPort();
try{const reviewDrain={drain:async bound=>{assert.deepEqual(bound,input.expectedDrain);
const result=await native.drain(input.scenario==='foreign-workspace'?{...bound,workspace:join(input.workspace,'other-project')}:bound);
if(!result.ok)return result;observed=result.evidence;
return {...result,close:async()=>{closes+=1;await result.close();}};}};
const service=createRepositoryRecoveryService({store,storeId:input.storeId,projectId:input.projectId,
workspaces:()=>[input.workspace],clock:()=>new Date().toISOString(),mintId:randomUUID,reviewDrain});
const result=await service.recover(input.command);
process.stdout.write(JSON.stringify({result,observed,closes})+'\\n');}finally{store.close();}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: input.workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.stdin.on("error", () => { /* The exit/output assertion reports a closed child. */ });
  const completed = new Promise<number | null>((done, reject) => {
    child.once("error", reject); child.once("close", done);
  });
  const timeout = setTimeout(() => { child.kill(); }, 45_000);
  child.stdin.end(JSON.stringify(input));
  try {
    const exit = await completed;
    if (exit !== 0 || output.trim() === "") throw new Error(`PRIVATE_PACKAGED_REPLAN_FAILED (${exit}): ${errors}`);
    return JSON.parse(output.trim()) as Awaited<ReturnType<typeof runPackagedReplanRecovery>>;
  } finally { clearTimeout(timeout); }
}
