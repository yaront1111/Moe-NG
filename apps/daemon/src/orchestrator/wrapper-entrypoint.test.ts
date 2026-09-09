import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROBE_TIMEOUT_MS = 20_000;

// This runs in native Node, outside Vitest's .js-to-.ts resolver. Imports must
// remain passive: forbid child process effects before loading either entrypoint.
const PROBE = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
let spawnCalls = 0;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => {
    spawnCalls += 1;
    throw new Error("NATIVE_ENTRYPOINT_SPAWN_FORBIDDEN");
  };
}
syncBuiltinESMExports();
const entry = pathToFileURL(process.argv[1]).href;
const exportName = process.argv[2];
let result;
try {
  const namespace = await import(entry);
  result = { outcome: "IMPORTED", exportedFunction: typeof namespace[exportName] };
} catch (error) {
  result = { outcome: "FAILED", code: error.code ?? "NO_CODE" };
}
process.stdout.write(JSON.stringify({ ...result, exportName, spawnCalls }));
`;

async function probe(moduleName: string, exportName: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-transform-types", "--input-type=module", "-e", PROBE,
    resolve(PACKAGE_ROOT, "src/orchestrator", moduleName), exportName,
  ], {
    cwd: PACKAGE_ROOT, env: { ...process.env, NODE_OPTIONS: "" },
    killSignal: "SIGKILL", maxBuffer: 65_536, timeout: PROBE_TIMEOUT_MS,
  });
  return JSON.parse(stdout) as unknown;
}

describe("native public orchestrator entrypoints", () => {
  it.each([
    ["agent-wrapper-main.ts", "runAgentWrapperMain"],
    ["moe-up-main.ts", "runMoeUp"],
  ])("loads %s with the documented transform flag without launching a provider", async (module, name) => {
    expect(await probe(module, name)).toEqual({
      outcome: "IMPORTED", exportedFunction: "function", exportName: name, spawnCalls: 0,
    });
  }, PROBE_TIMEOUT_MS + 5_000);

  it("reports native resolution failure for an absent entrypoint", async () => {
    expect(await probe("review-native-entrypoint-does-not-exist.ts", "runAgentWrapperMain")).toEqual({
      outcome: "FAILED", code: "ERR_MODULE_NOT_FOUND", exportName: "runAgentWrapperMain", spawnCalls: 0,
    });
  }, PROBE_TIMEOUT_MS + 5_000);

  it("reports a missing export instead of treating any successful import as proof", async () => {
    expect(await probe("agent-wrapper-main.ts", "reviewExportDoesNotExist")).toEqual({
      outcome: "IMPORTED", exportedFunction: "undefined", exportName: "reviewExportDoesNotExist", spawnCalls: 0,
    });
  }, PROBE_TIMEOUT_MS + 5_000);
});
