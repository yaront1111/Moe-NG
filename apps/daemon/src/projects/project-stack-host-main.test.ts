import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_VERSION,
} from "./project-stack-protocol.js";
import {
  projectStackControlLines,
  projectStackWrapperLaunch,
  runProjectStackHostMain,
} from "./project-stack-host-main.js";
import type { ProjectStackConfigFs } from "./project-stack-config.js";

const CONFIG_PATH = "C:\\work\\alpha\\moe.config.json";
const ASSET_ROOT = "C:\\Moe\\control-room";
const STORE_PATH = "C:\\work\\alpha\\store.sqlite";
const CREDENTIAL = "ab".repeat(32);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const INCARNATION_ID = "22222222-2222-4222-8222-222222222222";

const configFs = (): ProjectStackConfigFs => ({
  canonicalDirectory: (path) => path,
  canonicalFile: (path) => path,
  readConfig: () => JSON.stringify({
    credential: CREDENTIAL,
    projectId: "alpha",
    schemaVersion: "moe-cli-config/1",
    storePath: STORE_PATH,
  }),
});

describe("projectStackControlLines", () => {
  it("reassembles split frames and keeps two frames separate", async () => {
    const input = Readable.from([Buffer.from('{"one":1}\n{"tw'), Buffer.from('o":2}\r\n')]);
    const lines: string[] = [];
    for await (const line of projectStackControlLines(input)) lines.push(Buffer.from(line).toString());
    expect(lines).toEqual(['{"one":1}\n', '{"two":2}\r\n']);
  });

  it("returns one over-cap sentinel and stops buffering hostile input", async () => {
    const input = Readable.from([Buffer.alloc(MAX_PROJECT_STACK_FRAME_BYTES + 10, 0x78)]);
    const lines: Uint8Array[] = [];
    for await (const line of projectStackControlLines(input)) lines.push(line);
    expect(lines.map((line) => line.byteLength)).toEqual([MAX_PROJECT_STACK_FRAME_BYTES + 1]);
  });
});

const env = {
  MOE_DAEMON_CREDENTIAL: CREDENTIAL,
  MOE_PROJECT_ID: "alpha",
  MOE_PROJECT_INSTANCE_ID: INSTANCE_ID,
  MOE_STORE_PATH: STORE_PATH,
};

async function* stopControl(): AsyncIterable<string> {
  yield JSON.stringify({
    instanceId: INSTANCE_ID, kind: "STOP", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  });
}

describe("runProjectStackHostMain", () => {
  it("composes the proven config into one daemon and one wrapper", async () => {
    const lines: string[] = [];
    let daemonBindings: unknown;
    let wrapperBindings: unknown;
    let wrapperKills = 0;
    const code = await runProjectStackHostMain([
      `--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`,
    ], {
      controls: stopControl(),
      env,
      fs: configFs(),
      incarnationId: () => INCARNATION_ID,
      log: () => undefined,
      startDaemon: async (bindings) => {
        daemonBindings = bindings;
        return {
          approvePairing: () => ({ ok: true, state: "APPROVED" }),
          origin: "http://127.0.0.1:49152",
          shutdown: async () => ({ ok: true }),
        };
      },
      startWrapper: (bindings) => {
        wrapperBindings = bindings;
        return {
          completed: new Promise((resolve) => {
            setImmediate(() => { if (wrapperKills > 0) resolve({ code: 0 }); });
          }),
          kill: () => { wrapperKills += 1; },
        };
      },
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(daemonBindings).toEqual(wrapperBindings);
    expect(daemonBindings).toMatchObject({ instanceId: INSTANCE_ID, projectRoot: "C:\\work\\alpha" });
    expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(["READY", "TERMINAL"]);
  });

  it("refuses invalid configuration before starting any authority", async () => {
    let starts = 0;
    const logs: string[] = [];
    const code = await runProjectStackHostMain([
      `--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`, "--shell=cmd.exe",
    ], {
      controls: stopControl(),
      env,
      fs: configFs(),
      incarnationId: () => INCARNATION_ID,
      log: (line) => logs.push(line),
      startDaemon: async () => { starts += 1; throw new Error("must not start"); },
      startWrapper: () => { starts += 1; throw new Error("must not start"); },
      write: () => undefined,
    });
    expect(code).toBe(1);
    expect(starts).toBe(0);
    expect(logs).toEqual(["PROJECT_STACK_ARGUMENTS_INVALID PROJECT_STACK_HOST"]);
  });
});

describe("project stack production wrapper launch", () => {
  it("loads the physical host entry through Node's shipped JavaScript bridges", () => {
    const entry = join(import.meta.dirname, "project-stack-host-main.ts");
    const source = `import(${JSON.stringify(pathToFileURL(entry).href)}).then(() => {})`;
    const probe = spawnSync(process.execPath, ["--experimental-transform-types", "-e", source], {
      cwd: join(import.meta.dirname, "..", "..", "..", ".."),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(`${probe.stdout ?? ""}${probe.stderr ?? ""}`).not.toContain("Error [");
    expect(probe.status).toBe(0);
  }, 60_000);

  it("uses the project root, absolute wrapper entry, transform flag, and no shell", () => {
    const request = projectStackWrapperLaunch({
      assetRoot: ASSET_ROOT,
      configPath: CONFIG_PATH,
      credential: CREDENTIAL,
      instanceId: INSTANCE_ID,
      projectId: "alpha",
      projectRoot: "C:\\work\\alpha",
      storePath: STORE_PATH,
    }, env, "C:\\Moe\\apps\\daemon\\src\\orchestrator\\agent-wrapper-main.ts");
    expect(request).toEqual({
      argv: ["--experimental-transform-types", "C:\\Moe\\apps\\daemon\\src\\orchestrator\\agent-wrapper-main.ts"],
      command: process.execPath,
      options: {
        cwd: "C:\\work\\alpha",
        env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    });
  });

  it("ships the exact host entry selected by the curated runner boundary", () => {
    expect(existsSync(join(import.meta.dirname, "project-stack-host-main.ts"))).toBe(true);
  });
});
