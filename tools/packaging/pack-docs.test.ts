import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSingleProjectMain } from "../../apps/daemon/src/projects/project-single-main.js";
import type { ProjectSingleMainOptions } from "../../apps/daemon/src/projects/project-single-main.js";
import { MOE_CMD, MOE_PS1, installDoc } from "./pack-docs.js";

/**
 * The launcher this file emits is the FIRST thing an operator runs, and it runs before
 * any code this repository controls: the artifact bundles no runtime, so `moe.ps1` on a
 * machine without node is a real and expected shape.
 *
 * The rail is that the absence is REFUSED, by name and with a non-zero code. `& node`
 * against a missing runtime raises CommandNotFoundException, which never assigns
 * `$LASTEXITCODE`, so `exit $LASTEXITCODE` exits 0 and a wrapper supervising the launcher
 * records a missing runtime as a successful run.
 *
 * The script is spawned as BYTES for that reason: the constant is written to disk and
 * driven through a real `pwsh -File` with node scrubbed off PATH, because the defect is
 * in what PowerShell does with the text and no assertion over the string could see it.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const SEPARATOR = process.platform === "win32" ? ";" : ":";

const PATH_ENTRIES: readonly string[] = (process.env["PATH"] ?? "")
  .split(SEPARATOR)
  .filter((entry) => entry !== "");

/** Every name a PATH lookup would accept, so "scrubbed" is not just the bare suffix. */
const executableNames = (command: string): readonly string[] =>
  process.platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

/** Resolved against a NAMED entry list, so the same helper can witness a scrub. */
function locate(command: string, entries: readonly string[]): string | null {
  for (const entry of entries) {
    for (const name of executableNames(command)) {
      const full = join(entry, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const withoutNode = (): readonly string[] =>
  PATH_ENTRIES.filter((entry) => locate("node", [entry]) === null);

/**
 * One PATH key, whatever case the host spelled it: on Windows the environment is
 * case-insensitive, and handing the child both `Path` and `PATH` leaves which one it
 * reads to the platform.
 */
function envWithPath(entries: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toLowerCase() === "path") continue;
    env[key] = value;
  }
  env["PATH"] = entries.join(SEPARATOR);
  return env;
}

function emitLauncher(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-pack-docs-"));
  roots.push(root);
  const script = join(root, "moe.ps1");
  writeFileSync(script, MOE_PS1, "utf8");
  return script;
}

interface Run {
  readonly output: string;
  readonly status: number | null;
}

/** pwsh by ABSOLUTE path: the child's PATH is edited, and command lookup follows it. */
function runLauncher(entries: readonly string[]): Run {
  const pwsh = locate("pwsh", PATH_ENTRIES);
  if (pwsh === null) throw new Error("pwsh disappeared between the guard and the run");
  const result = spawnSync(
    pwsh,
    ["-NoProfile", "-NonInteractive", "-File", emitLauncher(), "--help"],
    { encoding: "utf8", env: envWithPath(entries), shell: false },
  );
  return { output: `${result.stderr}${result.stdout}`, status: result.status };
}

/**
 * INSTALL.md says every claim in it is MEASURED. The `moe start` lines it quotes are
 * measured HERE, against the composer the packaged launcher actually routes to: it used to
 * promise `moe up: daemon listening on ...` and a "two-process recipe" when the bundle is
 * absent, while the shipped `moe start` printed `moe start: <origin>` and refused with
 * `PROJECT_SINGLE_ASSET_ROOT_MISSING PROJECT_SINGLE_MAIN` (measured 2026-09-13 through the
 * real front door). An operator or wrapper waiting for the documented line waited forever.
 */
const DOC = installDoc({ closureCount: 3, nodeRange: ">=24.16 <25", version: "9.9.9-test" });
const PROJECT = Object.freeze({
  configPath: "C:\\work\\demo\\moe.config.json",
  projectId: "demo",
  root: "C:\\work\\demo",
  storePath: "C:\\work\\demo\\store.sqlite",
});
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

/** Every backticked literal in the doc, so a claim cannot hide from the check by wording. */
function quoted(doc: string): readonly string[] {
  return [...doc.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The client config the doc says to paste, parsed the way a client parses it. */
function recipe(doc: string): { readonly args: readonly string[]; readonly command: string } {
  const line = doc.split("\n").find((text) => text.trim().startsWith(`{"mcpServers"`)) ?? "{}";
  const config = JSON.parse(line) as {
    mcpServers?: Record<string, { args: string[]; command: string }>;
  };
  return config.mcpServers?.["moe-next"] ?? { args: [], command: "" };
}

/** The single-project composer with doubles for everything that spawns or touches disk. */
async function driveStart(
  overrides: Partial<ProjectSingleMainOptions> & { readonly assetRoot: string | null },
): Promise<{ readonly code: number; readonly logs: readonly string[] }> {
  const logs: string[] = [];
  const accepted = {
    code: "ACCEPTED", layer: "PROJECT_RUNTIME_SUPERVISOR" as const, ok: true as const,
  };
  const code = await runSingleProjectMain({
    dependencies: {
      createFiles: () => ({
        create: async () => ({ code: "UNUSED", layer: "PROJECT_MANAGER_FILES", ok: false }),
        discard: async () => undefined,
        register: async () => ({
          ok: true, project: PROJECT, written: { createdDirectories: [], paths: [], root: PROJECT.root },
        }),
      }),
      createRuntime: () => ({
        approvePairing: async () => accepted,
        list: () => [],
        open: async () => ({ ...accepted, code: "PROJECT_RUNTIME_OPENED", origin: "http://127.0.0.1:49152" }),
        shutdown: async () => accepted,
        start: async () => accepted,
        stop: async () => accepted,
        wait: async () => ({ ...accepted, code: "PROJECT_RUNTIME_COMPLETED" as const, exitCode: 0 }),
      }),
      mintUuid: () => INSTANCE_ID,
      resolveAssetRoot: () => overrides.assetRoot,
    },
    env: { ANTHROPIC_API_KEY: "key" },
    log: (line) => { logs.push(line); },
    onSignal: vi.fn(),
    platform: "win32",
    projectRoot: PROJECT.root,
    root: "D:\\artifact",
  });
  return { code, logs };
}

describe("INSTALL.md quotes the lines the packaged moe start prints", () => {
  it("names no `moe up` line and no two-process recipe: neither exists on the packaged path", () => {
    expect(DOC).not.toContain("moe up:");
    expect(DOC).not.toContain("two-process recipe");
  });

  it("quotes only `moe start:` lines the hosted composer prints, with <port> as the one placeholder", async () => {
    const hosted = await driveStart({ assetRoot: "D:\\artifact\\control-room" });
    expect(hosted.code).toBe(0);
    const promised = quoted(DOC).filter((literal) => literal.startsWith("moe start:"));
    expect(promised.length).toBeGreaterThan(0);
    for (const literal of promised) {
      const shape = new RegExp(`^${escapeRegExp(literal).replace("<port>", "\\d+")}$`, "u");
      expect(hosted.logs.some((line) => shape.test(line)), literal).toBe(true);
    }
  });

  it("names the absent-bundle refusal exactly as moe start prints it, and pins it as a refusal", async () => {
    const absent = await driveStart({ assetRoot: null });
    expect(absent.code).toBe(1);
    expect(absent.logs).toEqual(["PROJECT_SINGLE_ASSET_ROOT_MISSING PROJECT_SINGLE_MAIN"]);
    expect(quoted(DOC)).toContain("PROJECT_SINGLE_ASSET_ROOT_MISSING PROJECT_SINGLE_MAIN");
  });

  /**
   * The packaged doc is the only thing an operator reads after unzipping, so an
   * unpinned section disappears silently on the next edit. Pinned by CAPABILITY,
   * not by prose: the tool names and the refusal code are what a reader acts on.
   */
  it("documents the headless MCP path with the tools it actually serves", () => {
    expect(DOC).toContain("moe mcp");
    expect(quoted(DOC)).toContain("goal.create_with_source");
    // The connect recipe must be something a client can SPAWN. A client runs its
    // command literally: `moe` is a .cmd on no PATH after the install steps, and a
    // bare .cmd spawn is EINVAL besides. So it names node and the entry MOE_CMD runs,
    // derived from MOE_CMD so that moving the entry turns this red.
    const entry = /node "%~dp0([^"]+)"/u.exec(MOE_CMD)?.[1] ?? "MOE_CMD names no entry";
    const server = recipe(DOC);
    expect(server.command).toBe("node");
    expect(server.args).toHaveLength(3);
    expect(server.args[0]?.endsWith(`\\${entry}`), server.args[0]).toBe(true);
    expect(server.args[1]).toBe("mcp");
    // Absolute, both: the client starts node from a working directory of its own.
    for (const path of [server.args[0], server.args[2]]) {
      expect(win32.isAbsolute(path ?? ""), path).toBe(true);
    }
    expect(DOC).toMatch(/NO credential belongs in this file|NO credential belongs in the\s+client config/u);
    // Every served query kind is named, so a reader learns the read surface from
    // the doc rather than by probing the server.
    for (const kind of [
      "work.get_context", "graph.get", "graph.preview", "product_contract.read",
      "events.read", "documents.source_read", "design.read",
    ]) {
      expect(quoted(DOC), kind).toContain(kind);
    }
    // What it cannot do, and the code it gets — a reader who hits this refusal
    // must be able to find it here.
    expect(quoted(DOC)).toContain("CAPABILITY_DENIED");
    // The stdout hazard is the one thing that silently corrupts a client.
    expect(DOC).toContain("stdout on this wire carries JSON-RPC");
  });

  it("names the missing-credential refusal as the two-line shape moe start prints", () => {
    // The first line is the stable code+layer the smoke matches; the doc must quote it in
    // that exact form and describe the detail as the NEXT line, which is where it goes.
    expect(quoted(DOC)).toContain("MOE_UP_ENV_MISSING PROJECT_MANAGER_LAUNCH");
    expect(DOC).toMatch(
      /`MOE_UP_ENV_MISSING PROJECT_MANAGER_LAUNCH`;\s+the next line names the three\s+accepted variables and the sign-in path it checked/u,
    );
  });
});

describe.skipIf(locate("pwsh", PATH_ENTRIES) === null)("moe.ps1 without a runtime", () => {
  it("refuses by name with the host-visible form of 9009 instead of success", () => {
    const scrubbed = withoutNode();
    // Both sides, so the case cannot pass on a host that never had node on PATH: the
    // launcher would then refuse for a condition this run did not create.
    expect(locate("node", PATH_ENTRIES)).not.toBeNull();
    expect(locate("node", scrubbed)).toBeNull();
    const run = runLauncher(scrubbed);
    expect(run.status).toBe(process.platform === "win32" ? 9009 : (9009 & 0xff));
    expect(run.output).toContain("MOE_CLI_NODE_MISSING");
  }, 30_000);

  it("hands a present runtime its own exit code, so the missing-node status names one condition", () => {
    // The entry the launcher joins does not exist beside the emitted script, so node
    // itself refuses. That is the point: the run reached node, and neither the code nor
    // the refusal line belongs to the launcher.
    const run = runLauncher([dirname(process.execPath), ...PATH_ENTRIES]);
    expect(run.status).not.toBe(process.platform === "win32" ? 9009 : (9009 & 0xff));
    expect(run.status).not.toBe(0);
    expect(run.output).not.toContain("MOE_CLI_NODE_MISSING");
  });
});
