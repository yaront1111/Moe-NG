import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const CASES = [
  { launcher: "manager", ending: "signal", exitCode: 0 },
  { launcher: "manager", ending: "shutdown-error", exitCode: 1 },
  { launcher: "single", ending: "signal", exitCode: 0 },
  { launcher: "single", ending: "completed", exitCode: 7 },
  { launcher: "single", ending: "shutdown-error", exitCode: 1 },
  { launcher: "single", ending: "wait-error", exitCode: 1 },
] as const;

/** The parent deliberately keeps stdin open, like an operator's terminal. A
 * resolved main promise alone cannot prove that the executable actually exits. */
describe.runIf(process.platform === "win32")("project launcher operator shutdown", () => {
  it.each(CASES)("$launcher releases stdin after $ending", async ({ launcher, ending, exitCode }) => {
    const parent = resolve(tmpdir());
    const scratch = await mkdtemp(join(parent, "moe-operator-shutdown-test-"));
    const source = new URL(launcher === "manager" ? "./project-manager-main.ts" : "./project-single-main.ts",
      import.meta.url).href;
    const project = { root: scratch, projectId: "operator-probe",
      configPath: join(scratch, "moe.config.json"), storePath: join(scratch, "store.sqlite") };
    const script = [
      `import { ${launcher === "manager" ? "runProjectManagerMain" : "runSingleProjectMain"} as run } from ${JSON.stringify(source)};`,
      "const accepted = {ok:true,code:'PROBE_ACCEPTED',layer:'PROBE'};",
      "const runtime = {list:()=>[],approvePairing:async()=>accepted,",
      `shutdown:async()=>{${ending === "shutdown-error" ? "throw new Error('controlled shutdown failure');" : "return accepted;"}},`,
      "start:async()=>accepted,stop:async()=>accepted,open:async()=>({...accepted,origin:'http://127.0.0.1:43123'}),",
      `wait:()=>${ending === "completed" ? "Promise.resolve({ok:true,exitCode:7})" : ending === "wait-error"
        ? "Promise.reject(new Error('controlled wait failure'))" : "new Promise(()=>{})"}};`,
      "try { const result = await run({",
      `env:{LOCALAPPDATA:${JSON.stringify(scratch)}},root:${JSON.stringify(scratch)},projectRoot:${JSON.stringify(scratch)},`,
      "platform:'win32',operatorInput:process.stdin,log:()=>{},",
      `onSignal:stop=>{${ending === "completed" || ending === "wait-error" ? "" : "setTimeout(stop,30);"}},`,
      `dependencies:{createRuntime:()=>runtime,resolveAssetRoot:()=>${JSON.stringify(scratch)},`,
      `createFiles:()=>({register:async()=>({ok:true,project:${JSON.stringify(project)}})}),`,
      "startHttp:async()=>({ok:true,origin:'http://127.0.0.2:39122',port:39122,approvePairing:()=>({ok:true,state:'APPROVED'}),close:async()=>{}})}});",
      "process.exitCode=result; process.stdout.write('SETTLED:'+result+'\\n');",
      "} catch { process.exitCode=1; process.stdout.write('SETTLED:1\\n'); }",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "--eval", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((settle) => {
        let timer = setTimeout(() => { child.kill(); settle({ code: null, timedOut: true }); }, 10_000);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (!output.includes("SETTLED:")) return;
          clearTimeout(timer);
          timer = setTimeout(() => { child.kill(); settle({ code: null, timedOut: true }); }, 1_000);
        });
        child.once("exit", (code) => { clearTimeout(timer); settle({ code, timedOut: false }); });
      });
      expect(output).toContain(`SETTLED:${exitCode}`);
      expect(outcome, stderr).toEqual({ code: exitCode, timedOut: false });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((settle) => { child.once("exit", () => settle()); });
        child.kill();
        await exited;
      }
      child.stdin.destroy();
      const target = resolve(scratch);
      if (!target.startsWith(parent + sep) || !target.includes("moe-operator-shutdown-test-")) {
        throw new Error("operator test cleanup escaped its owned temp directory");
      }
      await rm(target, { recursive: true, force: true });
    }
  });
});
