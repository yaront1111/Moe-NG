/**
 * `runMcp` under direct test, which is also what earns this module its `.js`
 * bridge: `runtime-entrypoint.test.ts` seeds the runtime tier from the package
 * entry plus every module carrying its OWN `<name>.test.ts` sibling, and this
 * module is reached only through a DYNAMIC import that the census's static
 * `from "…"` scan cannot follow. Without this file the bridge reads as
 * scaffolding — and the bridge is load-bearing: plain Node resolves
 * `./moe-cli-mcp.js` for real, where vitest would have silently fallen back to
 * the `.ts`.
 *
 * Every arm asserts the STDOUT sink is empty. On this verb stdout is the
 * JSON-RPC wire, and a single stray line there is a protocol error no exit code
 * can show.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MOE_CLI_CONFIG_ABSENT } from "./moe-cli-project.js";
import { MOE_CLI_MCP_UNAVAILABLE, runMcp } from "./moe-cli-mcp.js";
import type { CliIo } from "./moe-cli-main.js";
import { MOE_CONFIG_FILENAME, MOE_CONFIG_SCHEMA_VERSION, MOE_CONFIG_UNREADABLE } from "./moe-init.js";

const entry = vi.hoisted(() => ({ calls: 0, fail: null as string | null }));
vi.mock("../mcp-main.js", () => ({
  runMcpMain: async (): Promise<void> => {
    entry.calls += 1;
    if (entry.fail !== null) throw new Error(entry.fail);
    return Promise.resolve();
  },
}));

const CREDENTIAL = "7a".repeat(32);
const ENV_KEYS = Object.freeze([
  "MOE_STORE_PATH", "MOE_PROJECT_ID", "MOE_DAEMON_CREDENTIAL", "MOE_SESSION_CREDENTIAL",
]);
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
  for (const key of ENV_KEYS) delete process.env[key];
  entry.calls = 0;
  entry.fail = null;
});

function project(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "moe-mcp-unit-"));
  scratch.push(root);
  mkdirSync(join(root, "demo"), { recursive: true });
  if (config !== null) writeFileSync(join(root, "demo", MOE_CONFIG_FILENAME), config);
  return root;
}

const validConfig = (storePath: string): string => JSON.stringify({
  credential: CREDENTIAL,
  projectId: "demo-project",
  schemaVersion: MOE_CONFIG_SCHEMA_VERSION,
  storePath,
});

interface Sinks {
  readonly code: number;
  readonly diagnostics: readonly string[];
  readonly stdout: readonly string[];
}

async function drive(cwd: string, targetDir: string): Promise<Sinks> {
  const diagnostics: string[] = [];
  const stdout: string[] = [];
  const io = {
    artifactRoot: cwd,
    argv: ["mcp", targetDir],
    cwd,
    diagnostic: (line: string) => diagnostics.push(line),
    env: {},
    log: (line: string) => stdout.push(line),
    nodeVersion: "v24.16.0",
    packageVersion: "0.1.0",
    randomHex: () => CREDENTIAL,
    startManager: async () => 0,
    startStack: async () => 0,
  } satisfies CliIo;
  const code = await runMcp({ command: "mcp", ok: true, targetDir }, io);
  return { code, diagnostics: Object.freeze(diagnostics), stdout: Object.freeze(stdout) };
}

describe("runMcp", () => {
  it("refuses an uninitialized target by code, on stderr, without launching", async () => {
    const result = await drive(project(null), "demo");
    expect(result.code).toBe(1);
    expect(result.diagnostics.join("\n")).toContain(MOE_CLI_CONFIG_ABSENT);
    expect(result.stdout).toEqual([]);
    expect(entry.calls).toBe(0);
  });

  it("refuses a config that is not JSON by its own code, not the absent one", async () => {
    const result = await drive(project("{not json"), "demo");
    expect(result.code).toBe(1);
    // The two input classes have DIFFERENT codes and the arms pin both, so a
    // refusal that collapsed them into one could not pass.
    expect(result.diagnostics.join("\n")).toContain(MOE_CONFIG_UNREADABLE);
    expect(result.diagnostics.join("\n")).not.toContain(MOE_CLI_CONFIG_ABSENT);
    expect(result.stdout).toEqual([]);
    expect(entry.calls).toBe(0);
  });

  it("discloses a failed launch with a code instead of a bare stack", async () => {
    const root = project(validConfig("store.sqlite"));
    entry.fail = "STORE_INPUT_INVALID: database path parent must exist";
    const result = await drive(root, "demo");
    expect(result.code).toBe(1);
    expect(result.diagnostics.join("\n")).toContain(MOE_CLI_MCP_UNAVAILABLE);
    expect(result.diagnostics.join("\n")).toContain("STORE_INPUT_INVALID");
    expect(result.stdout).toEqual([]);
  });

  it("resolves a RELATIVE storePath against the project, never the cwd", async () => {
    const root = project(validConfig("store.sqlite"));
    const result = await drive(root, "demo");
    expect(result.code).toBe(0);
    expect(process.env["MOE_STORE_PATH"]).toBe(join(root, "demo", "store.sqlite"));
    expect(process.env["MOE_PROJECT_ID"]).toBe("demo-project");
    expect(result.stdout).toEqual([]);
  });

  it("passes an ABSOLUTE storePath through untouched", async () => {
    const absolute = join(tmpdir(), "elsewhere", "store.sqlite");
    const root = project(validConfig(absolute));
    expect((await drive(root, "demo")).code).toBe(0);
    expect(process.env["MOE_STORE_PATH"]).toBe(absolute);
  });

  it("hands the operator secret to BOTH credential variables and logs neither", async () => {
    const root = project(validConfig("store.sqlite"));
    const result = await drive(root, "demo");
    expect(process.env["MOE_DAEMON_CREDENTIAL"]).toBe(CREDENTIAL);
    expect(process.env["MOE_SESSION_CREDENTIAL"]).toBe(CREDENTIAL);
    expect(result.diagnostics.join("\n")).not.toContain(CREDENTIAL);
    expect(result.stdout).toEqual([]);
  });
});
