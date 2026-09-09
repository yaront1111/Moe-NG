import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runDocker } = vi.hoisted(() => ({ runDocker: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: runDocker,
}));
import { liveContainers, liveNetworks } from "./platform-pipeline-harness.js";

const readers = [
  { name: "containers", read: liveContainers, argv: ["ps", "--format", "{{.Names}}"] },
  { name: "networks", read: liveNetworks, argv: ["network", "ls", "--format", "{{.Name}}"] },
] as const;

describe.each(readers)("Docker census observations: $name", ({ read, argv }) => {
  beforeEach(() => { runDocker.mockReset(); });

  it.each([
    { output: "", names: [] },
    { output: "first\r\nsecond\n", names: ["first", "second"] },
  ])("preserves a successful empty or populated observation: $output", ({ output, names }) => {
    runDocker.mockReturnValue({ status: 0, stdout: output, stderr: "" });
    expect(read()).toEqual(names);
    expect(runDocker).toHaveBeenCalledExactlyOnceWith("docker", argv, {
      encoding: "utf8", shell: false, timeout: 60_000,
    });
  });

  it.each([
    { name: "nonzero", result: { status: 1 } },
    { name: "null status", result: { status: null } },
    { name: "spawn error", result: { status: 0, error: new Error("private diagnostic") } },
    { name: "timeout", result: { status: null, error: Object.assign(new Error("private diagnostic"), { code: "ETIMEDOUT" }) } },
  ])("refuses $name even with misleading stdout", ({ result }) => {
    runDocker.mockReturnValue({ stdout: "not-a-proven-resource\n", stderr: "private diagnostic", ...result });
    expect(read).toThrowError(expect.objectContaining({
      message: "PLATFORM_CENSUS_UNAVAILABLE", code: "PLATFORM_CENSUS_UNAVAILABLE",
      layer: "PLATFORM_PIPELINE_HARNESS", truthClass: "UNKNOWN",
    }));
    expect(runDocker).toHaveBeenCalledTimes(1);
  });

  it("sanitizes a synchronous spawn throw", () => {
    runDocker.mockImplementation(() => { throw new Error("private diagnostic"); });
    expect(read).toThrowError(expect.objectContaining({
      message: "PLATFORM_CENSUS_UNAVAILABLE", code: "PLATFORM_CENSUS_UNAVAILABLE",
      layer: "PLATFORM_PIPELINE_HARNESS", truthClass: "UNKNOWN",
    }));
  });
});

/** The child uses worker THREADS: killing its bounded process cannot orphan a worker process. */
async function runCensusFile(mode: "flagless" | "unavailable") {
  const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), "moe-census-lane-"));
  const script = [
    'import { startVitest } from "vitest/node";',
    'const mode = process.env.MOE_CENSUS_TEST_MODE;',
    'const marker = "FLAGLESS_DOCKER_CALL";',
    'const trap = "const spawnSync = () => { process.stdout.write(" + JSON.stringify(marker + "\\n") + "); throw new Error(" + JSON.stringify(marker) + "); };";',
    'const unavailable = "const spawnSync = () => ({ status: 1, stdout: \\"\\", stderr: \\"private diagnostic\\" });";',
    'const ctx = await startVitest("test", ["tests/e2e/foundation/platform-teardown-failure-paths.e2e.test.ts"], {',
    '  root: process.cwd(), config: "vitest.config.ts", watch: false, run: true, pool: "threads", maxWorkers: 1,',
    '  ...(mode === "unavailable" ? { testNamePattern: "counts what is alive by asking docker" } : {}),',
    '}, { cacheDir: process.env.MOE_CENSUS_TEST_CACHE, plugins: [{ name: "bounded-census-docker-probe", enforce: "pre",',
    '  transform(code, id) {',
    '    const path = id.replaceAll("\\\\", "/");',
    '    if (!path.endsWith("/platform-pipeline-harness.ts") && !path.endsWith("/deployment-docker-probe.ts")) return;',
    '    const needle = \'import { spawnSync } from "node:child_process";\';',
    '    if (!code.includes(needle)) throw new Error("census probe import anchor absent");',
    '    return code.replace(needle, mode === "flagless" ? trap : unavailable);',
    '  },',
    '}] });',
    'try { if (ctx.state.getFiles().length !== 1) throw new Error("census probe selected the wrong files"); }',
    'finally { await ctx.close(); }',
  ].join("\n");
  try {
    return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 60_000, killSignal: "SIGKILL",
      env: { ...process.env, MOE_PLATFORM_PIPELINE: mode === "flagless" ? "" : "1",
        MOE_CENSUS_TEST_MODE: mode, MOE_CENSUS_TEST_CACHE: temporary },
      maxBuffer: 1024 * 1024,
    });
  } finally { rmSync(temporary, { force: true, recursive: true }); }
}

describe("the real teardown file's Docker opt-in", () => {
  it("runs its pure flagless arm without any Docker call", async () => {
    const result = await runCensusFile("flagless");
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).not.toContain("FLAGLESS_DOCKER_CALL");
    expect(output).toMatch(/Test Files\s+1 passed/u);
    expect(output).toMatch(/Tests\s+1 passed\s+\|\s+4 skipped/u);
  }, 70_000);

  it("fails explicitly, rather than skipping, when opted in without Docker", async () => {
    const result = await runCensusFile("unavailable");
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain("DEPLOY_DOCKER_UNAVAILABLE @ PLATFORM_PIPELINE_HARNESS");
    expect(output).not.toContain("private diagnostic");
    expect(output).toMatch(/Tests\s+1 failed/u);
  }, 70_000);
});

