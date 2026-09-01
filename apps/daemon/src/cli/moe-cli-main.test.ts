import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MOE_CLI_UNKNOWN_COMMAND } from "./moe-cli-argv.js";
import { MOE_CLI_CONFIG_ABSENT, runMoeCli } from "./moe-cli-main.js";
import type { CliIo, StartRequest } from "./moe-cli-main.js";
import {
  MOE_CLI_NODE_UNSUPPORTED, MOE_CONFIG_FILENAME, MOE_CONFIG_UNREADABLE,
  MOE_INIT_CONFIG_PRESENT, planInit,
} from "./moe-init.js";

const CREDENTIAL = "5c".repeat(32);
const scratch: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-cli-"));
  scratch.push(dir);
  return dir;
}

function expectedProjectId(targetDir: string): string {
  const planned = planInit({
    force: false, probe: { entries: [], writable: true }, randomHex: () => CREDENTIAL, targetDir,
  });
  if (!planned.ok) throw new Error("expected a valid init plan");
  return planned.projectId;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
});

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly managerStarts: number;
  readonly starts: readonly StartRequest[];
}

async function run(artifactRoot: string, argv: readonly string[], io: Partial<CliIo> = {}): Promise<Run> {
  const lines: string[] = [];
  const starts: StartRequest[] = [];
  let managerStarts = 0;
  const code = await runMoeCli({
    artifactRoot,
    argv,
    cwd: artifactRoot,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    log: (line) => lines.push(line),
    nodeVersion: "v24.16.0",
    packageVersion: "0.1.0",
    randomHex: () => CREDENTIAL,
    startManager: async () => { managerStarts += 1; return 0; },
    startStack: async (request) => {
      starts.push(request);
      return Promise.resolve(0);
    },
    ...io,
  });
  return { code, lines: Object.freeze(lines), managerStarts, starts: Object.freeze(starts) };
}

describe("moe init", () => {
  it("resolves a relative project against the operator cwd, not the extracted artifact", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    const result = await run(artifactRoot, ["init", "demo"], {
      cwd: operatorCwd,
    });

    expect(result.code).toBe(0);
    const target = join(operatorCwd, "demo");
    expect(JSON.parse(readFileSync(join(target, MOE_CONFIG_FILENAME), "utf8")).projectId)
      .toBe(expectedProjectId(target));
    expect(() => readFileSync(join(artifactRoot, "demo", MOE_CONFIG_FILENAME), "utf8"))
      .toThrow();
  });

  it("defaults an omitted target to the caller cwd", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();

    const result = await run(artifactRoot, ["init"], { cwd: operatorCwd });

    expect(result.code).toBe(0);
    expect(existsSync(join(operatorCwd, MOE_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(join(artifactRoot, MOE_CONFIG_FILENAME))).toBe(false);
  });

  it("writes the config into the target and reports success", async () => {
    const root = temp();
    const result = await run(root, ["init", "demo"]);
    expect(result.code).toBe(0);
    const raw = readFileSync(join(root, "demo", MOE_CONFIG_FILENAME), "utf8");
    expect(JSON.parse(raw)).toEqual({
      credential: CREDENTIAL,
      projectId: expectedProjectId(join(root, "demo")),
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
      .toBe(expectedProjectId(join(root, "Moe Demo")));
  });

  it("refuses an unsupported Node by name rather than dying on stripped types", async () => {
    const root = temp();
    const result = await run(root, ["init", "demo"], { nodeVersion: "v22.14.0" });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(`${MOE_CLI_NODE_UNSUPPORTED}: v22.14.0`);
  });
});

describe("moe start", () => {
  it("resolves bare dot against the caller cwd while retaining the extracted artifact root", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    const caller = { cwd: operatorCwd };
    expect((await run(artifactRoot, ["init", "."], caller)).code).toBe(0);

    const result = await run(artifactRoot, ["start", "."], caller);

    expect(result.code).toBe(0);
    expect(result.starts).toEqual([{
      artifactRoot,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      projectRoot: operatorCwd,
    }]);
    expect(existsSync(join(artifactRoot, MOE_CONFIG_FILENAME))).toBe(false);
  });

  it("resolves a relative project against the caller cwd", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    const caller = { cwd: operatorCwd };
    expect((await run(artifactRoot, ["init", "demo"], caller)).code).toBe(0);

    const result = await run(artifactRoot, ["start", "demo"], caller);

    expect(result.code).toBe(0);
    expect(result.starts[0]?.projectRoot).toBe(join(operatorCwd, "demo"));
    expect(result.starts[0]?.artifactRoot).toBe(artifactRoot);
    expect(existsSync(join(artifactRoot, "demo", MOE_CONFIG_FILENAME))).toBe(false);
  });

  it("preserves an absolute project target", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    const absoluteTarget = temp();
    const caller = { cwd: operatorCwd };
    expect((await run(artifactRoot, ["init", absoluteTarget], caller)).code).toBe(0);

    const result = await run(artifactRoot, ["start", absoluteTarget], caller);

    expect(result.code).toBe(0);
    expect(result.starts[0]?.projectRoot).toBe(absoluteTarget);
    expect(existsSync(join(absoluteTarget, MOE_CONFIG_FILENAME))).toBe(true);
  });

  it("normalizes native relative segments, including the win32 separator shape", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    const relativeTarget = process.platform === "win32" ? "nested\\..\\demo" : "nested/../demo";
    const caller = { cwd: operatorCwd };
    expect((await run(artifactRoot, ["init", relativeTarget], caller)).code).toBe(0);

    const result = await run(artifactRoot, ["start", relativeTarget], caller);

    expect(result.code).toBe(0);
    expect(result.starts[0]?.projectRoot).toBe(join(operatorCwd, "demo"));
  });

  it("keeps packaged links under artifactRoot and project state under cwd", async () => {
    const artifactRoot = temp();
    const operatorCwd = temp();
    mkdirSync(join(artifactRoot, "packages", "runner"), { recursive: true });
    writeFileSync(join(artifactRoot, "moe-workspace-links.json"), JSON.stringify({
      links: { "@moe/runner": "packages/runner" },
      schemaVersion: "moe-workspace-links/1",
    }));
    const caller = { cwd: operatorCwd };
    expect((await run(artifactRoot, ["init"], caller)).code).toBe(0);

    const result = await run(artifactRoot, ["start"], caller);

    expect(result.code).toBe(0);
    expect(result.starts[0]?.projectRoot).toBe(operatorCwd);
    expect(existsSync(join(operatorCwd, MOE_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(join(artifactRoot, MOE_CONFIG_FILENAME))).toBe(false);
    expect(existsSync(join(artifactRoot, "node_modules", "@moe", "runner"))).toBe(true);
    expect(existsSync(join(operatorCwd, "node_modules", "@moe", "runner"))).toBe(false);
  });

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
    expect(request.artifactRoot).toBe(root);
    expect(request.projectRoot).toBe(join(root, "demo"));
    expect(request.env["MOE_STORE_PATH"]).toBeUndefined();
    expect(request.env["MOE_PROJECT_ID"]).toBeUndefined();
    expect(request.env["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
    expect(result.lines.join("\n")).toContain("project demo");
    expect(result.lines.join("\n")).toContain("goals, tasks, and board stay inside this project");
    expect(result.lines.join("\n")).not.toContain("cd apps/control-room");
  });

  it("passes the explicit operator stdin marker without placing a label in argv", async () => {
    const root = temp();
    await run(root, ["init", "demo"]);
    const result = await run(root, ["start", "demo", "--operator-stdin"]);
    expect(result.code).toBe(0);
    expect(result.starts).toEqual([{
      artifactRoot: root,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      operatorStdin: true,
      projectRoot: join(root, "demo"),
    }]);
    expect(JSON.stringify(result.starts)).not.toMatch(/[0-9a-f]{4}(?:-[0-9a-f]{4}){2}/u);
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

describe("moe projects", () => {
  it("starts the project manager without reading a project credential", async () => {
    const result = await run(temp(), ["projects"]);
    expect(result.code).toBe(0);
    expect(result.managerStarts).toBe(1);
    expect(result.starts).toEqual([]);
  });

  it("passes the explicit operator stdin marker to the manager host", async () => {
    let operatorStdin: true | undefined;
    const result = await run(temp(), ["projects", "--operator-stdin"], {
      startManager: async (request) => {
        operatorStdin = request.operatorStdin;
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(operatorStdin).toBe(true);
  });

  it("returns the manager's own nonzero exit code", async () => {
    const result = await run(temp(), ["projects"], { startManager: async () => 4 });
    expect(result.code).toBe(4);
  });

  it("materializes packaged workspace links before importing the manager", async () => {
    const root = temp();
    mkdirSync(join(root, "packages", "runner"), { recursive: true });
    writeFileSync(join(root, "moe-workspace-links.json"), JSON.stringify({
      links: { "@moe/runner": "packages/runner" },
      schemaVersion: "moe-workspace-links/1",
    }));
    let sawLink = false;
    const result = await run(root, ["projects"], {
      startManager: async () => {
        sawLink = existsSync(join(root, "node_modules", "@moe", "runner"));
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(sawLink).toBe(true);
    expect(result.lines).toContain("moe projects: linked 1 workspace packages");
  });

  it("refuses a malformed packaged link manifest before importing the manager", async () => {
    const root = temp();
    writeFileSync(join(root, "moe-workspace-links.json"), "not-json");
    const result = await run(root, ["projects"]);
    expect(result.code).toBe(1);
    expect(result.managerStarts).toBe(0);
    expect(result.lines.join("\n")).toContain("MOE_CLI_LINK_MANIFEST_INVALID");
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
    expect(text).toContain("open the plain origin");
    expect(text).toContain("--operator-stdin");
    expect(text).toContain("[dir] defaults to the current directory");
    for (const credential of [
      "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
    ]) {
      expect(text).toContain(credential);
    }
    expect(text).not.toContain("ANTHROPIC_API_KEY is required");
  });

  it("refuses an unknown command by name and exits nonzero", async () => {
    const result = await run(temp(), ["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(`${MOE_CLI_UNKNOWN_COMMAND}: frobnicate`);
  });
});
