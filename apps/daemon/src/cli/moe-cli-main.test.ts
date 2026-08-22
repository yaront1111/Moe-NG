import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MOE_CLI_UNKNOWN_COMMAND } from "./moe-cli-argv.js";
import { MOE_CLI_CONFIG_ABSENT, runMoeCli } from "./moe-cli-main.js";
import type { CliIo, StartRequest } from "./moe-cli-main.js";
import {
  MOE_CLI_NODE_UNSUPPORTED, MOE_CONFIG_FILENAME, MOE_CONFIG_UNREADABLE,
  MOE_INIT_CONFIG_PRESENT,
} from "./moe-init.js";

const CREDENTIAL = "5c".repeat(32);
const scratch: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-cli-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
});

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly starts: readonly StartRequest[];
}

async function run(root: string, argv: readonly string[], io: Partial<CliIo> = {}): Promise<Run> {
  const lines: string[] = [];
  const starts: StartRequest[] = [];
  const code = await runMoeCli({
    argv,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    log: (line) => lines.push(line),
    nodeVersion: "v24.16.0",
    packageVersion: "0.1.0",
    randomHex: () => CREDENTIAL,
    root,
    startStack: async (request) => {
      starts.push(request);
      return Promise.resolve(0);
    },
    ...io,
  });
  return { code, lines: Object.freeze(lines), starts: Object.freeze(starts) };
}

describe("moe init", () => {
  it("writes the config into the target and reports success", async () => {
    const root = temp();
    const result = await run(root, ["init", "demo"]);
    expect(result.code).toBe(0);
    const raw = readFileSync(join(root, "demo", MOE_CONFIG_FILENAME), "utf8");
    expect(JSON.parse(raw)).toEqual({
      credential: CREDENTIAL,
      projectId: "demo",
      schemaVersion: "moe-cli-config/1",
      storePath: join(root, "demo", "store.sqlite"),
    });
  });

  it("never echoes the minted credential onto the console", async () => {
    const root = temp();
    const result = await run(root, ["init", "demo"]);
    expect(result.lines.join("\n")).not.toContain(CREDENTIAL);
    expect(result.lines.join("\n")).toContain("MOE_DAEMON_CREDENTIAL=<minted, hidden>");
  });

  it("refuses a second init into the same directory instead of overwriting", async () => {
    const root = temp();
    await run(root, ["init", "demo"]);
    const second = await run(root, ["init", "demo"]);
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain(MOE_INIT_CONFIG_PRESENT);
    // The first credential must still be the one on disk.
    const raw = readFileSync(join(root, "demo", MOE_CONFIG_FILENAME), "utf8");
    expect(JSON.parse(raw).credential).toBe(CREDENTIAL);
  });

  it("initializes a target whose path contains spaces", async () => {
    const root = temp();
    const result = await run(root, ["init", "Moe Demo"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "Moe Demo", MOE_CONFIG_FILENAME), "utf8")).projectId)
      .toBe("moe-demo");
  });

  it("refuses an unsupported Node by name rather than dying on stripped types", async () => {
    const root = temp();
    const result = await run(root, ["init", "demo"], { nodeVersion: "v22.14.0" });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(`${MOE_CLI_NODE_UNSUPPORTED}: v22.14.0`);
  });
});

describe("moe start", () => {
  it("refuses by name when the target was never initialized", async () => {
    const root = temp();
    const result = await run(root, ["start", "demo"]);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(MOE_CLI_CONFIG_ABSENT);
    expect(result.starts).toEqual([]);
  });

  it("hands the config identities to the launcher and returns its exit code", async () => {
    const root = temp();
    await run(root, ["init", "demo"]);
    const result = await run(root, ["start", "demo"]);
    expect(result.code).toBe(0);
    expect(result.starts).toHaveLength(1);
    const request = result.starts[0];
    if (request === undefined) throw new Error("unreachable: one start was recorded");
    expect(request.root).toBe(root);
    expect(request.env["MOE_STORE_PATH"]).toBe(join(root, "demo", "store.sqlite"));
    expect(request.env["MOE_PROJECT_ID"]).toBe("demo");
    expect(request.env["MOE_DAEMON_CREDENTIAL"]).toBe(CREDENTIAL);
  });

  it("returns the launcher's own nonzero code rather than inventing one", async () => {
    const root = temp();
    await run(root, ["init", "demo"]);
    const result = await run(root, ["start", "demo"], { startStack: async () => Promise.resolve(3) });
    expect(result.code).toBe(3);
  });

  it("refuses a corrupted config by name and never launches", async () => {
    const root = temp();
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(join(root, "demo", MOE_CONFIG_FILENAME), "{not json");
    const result = await run(root, ["start", "demo"]);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(MOE_CONFIG_UNREADABLE);
    expect(result.starts).toEqual([]);
  });

  it("refuses an unsupported Node before it launches anything", async () => {
    const root = temp();
    await run(root, ["init", "demo"]);
    const result = await run(root, ["start", "demo"], { nodeVersion: "v25.0.0" });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(`${MOE_CLI_NODE_UNSUPPORTED}: v25.0.0`);
    expect(result.starts).toEqual([]);
  });
});

describe("moe version, help, and the unknown command", () => {
  it("prints the version it was built with", async () => {
    const result = await run(temp(), ["--version"], { packageVersion: "0.1.0" });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["0.1.0"]);
  });

  it("answers version even on an unsupported Node, so the operator can read it", async () => {
    const result = await run(temp(), ["--version"], { nodeVersion: "v22.14.0" });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["0.1.0"]);
  });

  it("lists the wired commands in help", async () => {
    const result = await run(temp(), ["help"]);
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    for (const command of ["moe init", "moe start", "moe --version"]) {
      expect(text).toContain(command);
    }
  });

  it("refuses an unknown command by name and exits nonzero", async () => {
    const result = await run(temp(), ["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(`${MOE_CLI_UNKNOWN_COMMAND}: frobnicate`);
  });
});
