import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_VERSION,
} from "./project-stack-protocol.js";
import { WRAPPER_STDIN_STOP_TOKEN } from "../orchestrator/process-runner-lifecycle.js";
import {
  WRAPPER_LOG_RELATIVE_PATH,
  hostedDaemonStartOptions,
  openWrapperLog,
  projectStackControlLines,
  projectStackWrapperLaunch,
  runProjectStackHostMain,
  wrapperHandleFor,
} from "./project-stack-host-main.js";
import { resolveProjectStackConfig } from "./project-stack-config.js";
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
    const effects: string[] = [];
    let preparedBindings: unknown;
    let daemonBindings: unknown;
    let wrapperBindings: unknown;
    let wrapperKills = 0;
    const code = await runProjectStackHostMain([
      `--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`,
    ], {
      env,
      fs: configFs(),
      incarnationId: () => INCARNATION_ID,
      input: Readable.from(stopControl()),
      log: () => undefined,
      prepareRepository: async (bindings) => {
        preparedBindings = bindings;
        await Promise.resolve();
        effects.push("prepared");
        return { ok: true };
      },
      startDaemon: async (bindings) => {
        effects.push("daemon");
        daemonBindings = bindings;
        return {
          approvePairing: () => ({ ok: true, state: "APPROVED" }),
          origin: "http://127.0.0.1:49152",
          shutdown: async () => ({ ok: true }),
        };
      },
      startWrapper: (bindings) => {
        effects.push("wrapper");
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
    expect(effects).toEqual(["prepared", "daemon", "wrapper"]);
    expect(preparedBindings).toEqual(daemonBindings);
    expect(daemonBindings).toEqual(wrapperBindings);
    expect(daemonBindings).toMatchObject({ instanceId: INSTANCE_ID, projectRoot: "C:\\work\\alpha" });
    expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(["READY", "TERMINAL"]);
  });

  it("refuses invalid configuration before starting any authority", async () => {
    let starts = 0;
    let preparations = 0;
    const logs: string[] = [];
    const code = await runProjectStackHostMain([
      `--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`, "--shell=cmd.exe",
    ], {
      env,
      fs: configFs(),
      incarnationId: () => INCARNATION_ID,
      input: Readable.from(stopControl()),
      log: (line) => logs.push(line),
      prepareRepository: async () => { preparations += 1; return { ok: true }; },
      startDaemon: async () => { starts += 1; throw new Error("must not start"); },
      startWrapper: () => { starts += 1; throw new Error("must not start"); },
      write: () => undefined,
    });
    expect(code).toBe(1);
    expect(starts).toBe(0);
    expect(preparations).toBe(0);
    expect(logs).toEqual(["PROJECT_STACK_ARGUMENTS_INVALID PROJECT_STACK_HOST"]);
  });

  it.each(["refused", "thrown", "unsafe refusal"] as const)(
    "refuses failed repository preparation before daemon or wrapper effects (%s)",
    async (failure) => {
      let starts = 0;
      const lines: string[] = [];
      const logs: string[] = [];
      const code = await runProjectStackHostMain([
        `--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`,
      ], {
        env, fs: configFs(), incarnationId: () => INCARNATION_ID, input: Readable.from(stopControl()),
        log: (line) => logs.push(line),
        prepareRepository: async () => {
          if (failure === "thrown") throw new Error(`private credential ${CREDENTIAL}`);
          return failure === "refused"
            ? { ok: false, code: "RUNTIME_METADATA_EXCLUDES_UNAVAILABLE", layer: "RUNTIME_METADATA_EXCLUDES" }
            : { ok: false, code: CREDENTIAL, layer: `private credential ${CREDENTIAL}` };
        },
        startDaemon: async () => { starts += 1; throw new Error("must not start"); },
        startWrapper: () => { starts += 1; throw new Error("must not start"); },
        write: (line) => lines.push(line),
      });
      expect(code).toBe(1);
      expect(starts).toBe(0);
      const expected = failure === "refused"
        ? { code: "RUNTIME_METADATA_EXCLUDES_UNAVAILABLE", layer: "RUNTIME_METADATA_EXCLUDES" }
        : { code: "PROJECT_RUNTIME_METADATA_PREPARATION_FAILED", layer: "PROJECT_STACK_HOST" };
      expect(lines.map((line) => JSON.parse(line))).toEqual([{
        ...expected, incarnationId: INCARNATION_ID, kind: "START_REFUSED",
        schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
      }]);
      expect(logs).toEqual([`${expected.code} ${expected.layer}`]);
      expect(JSON.stringify({ lines, logs })).not.toContain(CREDENTIAL);
    },
  );
});

describe("project stack production wrapper launch", () => {
  it("loads the physical host entry through its JavaScript bridges under plain strip-only node", () => {
    // The runner boundary starts this entry with no transform flag, so neither does this probe.
    // The negative control proving plain node refuses a parameter property is in moe-up-main.test.ts.
    const entry = join(import.meta.dirname, "project-stack-host-main.ts");
    const loaded = "HOST_ENTRY_LOADED";
    const source = `import(${JSON.stringify(pathToFileURL(entry).href)})`
      + `.then(() => console.log(${JSON.stringify(loaded)}))`;
    const probe = spawnSync(process.execPath, ["-e", source], {
      cwd: join(import.meta.dirname, "..", "..", "..", ".."),
      encoding: "utf8",
      timeout: 60_000,
    });
    const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    expect(text).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(text).not.toContain("Error [");
    expect(text).toContain(loaded);
    expect(probe.status).toBe(0);
  }, 60_000);

  it("uses the project root, plain node on the absolute wrapper entry, and no shell", () => {
    const request = projectStackWrapperLaunch({
      assetRoot: ASSET_ROOT,
      configPath: CONFIG_PATH,
      credential: CREDENTIAL,
      instanceId: INSTANCE_ID,
      operatorChannelAvailable: false,
      projectId: "alpha",
      projectRoot: "C:\\work\\alpha",
      storePath: STORE_PATH,
    }, env, "C:\\Moe\\apps\\daemon\\src\\orchestrator\\agent-wrapper-main.ts");
    expect(request).toEqual({
      argv: ["C:\\Moe\\apps\\daemon\\src\\orchestrator\\agent-wrapper-main.ts"],
      command: process.execPath,
      options: {
        cwd: "C:\\work\\alpha",
        env,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    });
  });

  it("writes the wrapper's stdout AND stderr to the sink it was given, stdin piped for the stop token", () => {
    const request = projectStackWrapperLaunch({
      assetRoot: ASSET_ROOT,
      configPath: CONFIG_PATH,
      credential: CREDENTIAL,
      instanceId: INSTANCE_ID,
      operatorChannelAvailable: false,
      projectId: "alpha",
      projectRoot: "C:\work\alpha",
      storePath: STORE_PATH,
    }, env, "C:\Moe\apps\daemon\src\orchestrator\agent-wrapper-main.ts", 7);
    // Both streams to ONE descriptor: a seat's stderr (the crash) must land beside its stdout.
    // stdin is the pipe the stop token travels on: with it ignored the host's only stop was
    // TerminateProcess, and a seat live at stop time held the Job open past the broker's poll.
    expect(request.options.stdio).toEqual(["pipe", 7, 7]);
  });

  it("opens <project>/.moe-next/wrapper.log for append and answers null where it cannot", () => {
    const { mkdtempSync, closeSync, existsSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const root = mkdtempSync(join(tmpdir(), "moe-wrapper-log-"));
    try {
      const fd = openWrapperLog(root);
      expect(fd).not.toBeNull();
      if (fd !== null) closeSync(fd);
      expect(existsSync(join(root, WRAPPER_LOG_RELATIVE_PATH))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    // A FILE where the project directory should be: mkdir refuses, and the launch falls back
    // to "ignore" instead of failing the whole project start over a log.
    const blocker = mkdtempSync(join(tmpdir(), "moe-wrapper-log-blocker-"));
    try {
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(join(blocker, "file"), "");
      expect(openWrapperLog(join(blocker, "file"))).toBeNull();
    } finally {
      rmSync(blocker, { force: true, recursive: true });
    }
  });

  it("ships the exact host entry selected by the curated runner boundary", () => {
    expect(existsSync(join(import.meta.dirname, "project-stack-host-main.ts"))).toBe(true);
  });
});

describe("hostedDaemonStartOptions", () => {
  it("forwards the MEASURED operator-channel fact instead of asserting one", () => {
    // The daemon's stdin is a pipe from the host, never a terminal; the label reaches it
    // through the host frame ONLY when the parent CLI attached a console consumer. A
    // hardcoded `true` made the control room tell a piped-stdio operator to type a label
    // nobody read (measured 2026-09-13); a hardcoded `false` sent artifact users to
    // "pnpm start". Both arms, so neither literal can come back.
    for (const [value, expected] of [["true", true], ["false", false]] as const) {
      const resolved = resolveProjectStackConfig({
        argv: [`--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`],
        env: { ...env, MOE_OPERATOR_CHANNEL: value },
        fs: configFs(),
      });
      if (!resolved.ok) throw new Error(resolved.code);
      const options = hostedDaemonStartOptions(resolved.bindings);
      expect(options.pairingOperatorChannelAvailable, value).toBe(expected);
      expect(options.assetRoot).toBe(ASSET_ROOT);
      expect(options.assetSecrets).toEqual([CREDENTIAL]);
    }
  });

  it("carries a log through, which is the daemon's whole log channel on this path", () => {
    // `DaemonStartOptions.log` is forwarded straight into the listener. While this object
    // omitted it, `listening on <origin>` and LISTENER_REQUEST_FAILED — the only host-side
    // record that a route answered 500 — were both `log?.()` no-ops on the path `moe start`
    // takes. `moe-daemon` and `moe up` never had the hole; both pass a log of their own.
    const resolved = resolveProjectStackConfig({
      argv: [`--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`],
      env: { ...env, MOE_OPERATOR_CHANNEL: "true" },
      fs: configFs(),
    });
    if (!resolved.ok) throw new Error(resolved.code);
    const lines: string[] = [];

    const options = hostedDaemonStartOptions(resolved.bindings, (line) => { lines.push(line); });
    options.log?.("listening on http://127.0.0.1:1234");

    expect(lines).toEqual(["listening on http://127.0.0.1:1234"]);
  });

  it("omits the log when none is supplied, so the old callers are byte-identical", () => {
    const resolved = resolveProjectStackConfig({
      argv: [`--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`],
      env: { ...env, MOE_OPERATOR_CHANNEL: "true" },
      fs: configFs(),
    });
    if (!resolved.ok) throw new Error(resolved.code);

    expect("log" in hostedDaemonStartOptions(resolved.bindings)).toBe(false);
  });
});

describe("wrapperHandleFor", () => {
  // The token-honouring wrapper in miniature: exits 0 on the host's stop token and 3 on any
  // other line. A real child, not a fake: the pin is that the handle's kill reaches a live
  // stdin and that the child's OWN exit code, not a termination, settles `completed`.
  const OBEYING_CHILD = [
    "process.stdin.setEncoding('utf8');",
    "let pending = '';",
    "process.stdin.on('data', (chunk) => {",
    "  pending += chunk;",
    "  const lines = pending.split(/\\r?\\n/);",
    "  pending = lines.pop() ?? '';",
    `  for (const line of lines) process.exit(line === ${JSON.stringify(WRAPPER_STDIN_STOP_TOKEN)} ? 0 : 3);`,
    "});",
  ].join("\n");

  it("asks a real child to stop over its stdin and settles on the child's own exit, never its kill", async () => {
    const child = spawn(process.execPath, ["-e", OBEYING_CHILD], {
      stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
    });
    const terminate = child.kill.bind(child);
    let kills = 0;
    child.kill = (): boolean => { kills += 1; return terminate(); };
    try {
      const handle = wrapperHandleFor(child);
      handle.kill();
      // `kill: () => child.kill()` fails BOTH lines: the child is terminated (code null on
      // win32, a signal elsewhere) and its own kill is the one that did it.
      await expect(handle.completed).resolves.toEqual({ code: 0 });
      expect(kills).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) terminate();
    }
  }, 15_000);
});
