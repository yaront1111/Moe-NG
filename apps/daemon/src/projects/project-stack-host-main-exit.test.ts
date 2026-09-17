import { spawn } from "node:child_process";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { PROJECT_STACK_PROTOCOL_VERSION } from "./project-stack-protocol.js";
import { runProjectStackHostMain } from "./project-stack-host-main.js";
import type { ProjectStackConfigFs } from "./project-stack-config.js";

const CONFIG_PATH = "C:\\work\\alpha\\moe.config.json";
const ASSET_ROOT = "C:\\Moe\\control-room";
const STORE_PATH = "C:\\work\\alpha\\store.sqlite";
const CREDENTIAL = "ab".repeat(32);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const INCARNATION_ID = "22222222-2222-4222-8222-222222222222";
const ARGV = [`--config=${CONFIG_PATH}`, `--asset-root=${ASSET_ROOT}`];

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

const env = {
  MOE_DAEMON_CREDENTIAL: CREDENTIAL,
  MOE_PROJECT_ID: "alpha",
  MOE_PROJECT_INSTANCE_ID: INSTANCE_ID,
  MOE_STORE_PATH: STORE_PATH,
};

const STOP_LINE = `${JSON.stringify({
  instanceId: INSTANCE_ID, kind: "STOP", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
})}\n`;

/** A daemon and a token-honouring wrapper in miniature, as the child process spells them. */
const FAKE_AUTHORITIES = [
  "prepareRepository: async () => ({ ok: true }),",
  "startDaemon: async () => ({",
  "  approvePairing: () => ({ ok: true, state: 'APPROVED' }),",
  "  origin: 'http://127.0.0.1:49152',",
  "  shutdown: async () => ({ ok: true }),",
  "}),",
  "startWrapper: () => {",
  "  let stop = () => undefined;",
  "  const completed = new Promise((resolve) => { stop = () => resolve({ code: 0 }); });",
  "  return { completed, kill: () => stop() };",
  "},",
].join("\n");

const delay = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await delay(25);
  return condition();
}

describe("runProjectStackHostMain control pipe", () => {
  it("exits on its own after a STOP while the parent still holds its stdin open", async () => {
    // The broker ends the host's stdin only when the boundary closes, AFTER it has seen the
    // host exit (closeProviderChannels); the host cannot wait for that. A real child on a
    // real pipe, wired as the main block wires it: a read left armed on stdin kept the host
    // alive past its own TERMINAL frame, so every clean stop ran into the supervisor's
    // 10 s budget and ended as a timed-out kill (measured 2026-09-17: still alive 5 s on).
    const entry = pathToFileURL(join(import.meta.dirname, "project-stack-host-main.ts")).href;
    const source = [
      `const { runProjectStackHostMain } = await import(${JSON.stringify(entry)});`,
      `process.exitCode = await runProjectStackHostMain(${JSON.stringify(ARGV)}, {`,
      `  env: ${JSON.stringify(env)},`,
      "  fs: {",
      "    canonicalDirectory: (path) => path,",
      "    canonicalFile: (path) => path,",
      `    readConfig: () => ${JSON.stringify(configFs().readConfig(CONFIG_PATH))},`,
      "  },",
      `  incarnationId: () => ${JSON.stringify(INCARNATION_ID)},`,
      "  input: process.stdin,",
      "  log: (line) => process.stderr.write(`${line}\\n`),",
      FAKE_AUTHORITIES,
      "  write: (line) => { process.stdout.write(line); },",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source], {
      cwd: join(import.meta.dirname, "..", "..", "..", ".."),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errors = "";
    let exit: number | null | undefined;
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.stdin.on("error", () => undefined);
    child.on("exit", (code) => { exit = code; });
    const kinds = (): string[] => output.split("\n").slice(0, -1)
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    try {
      expect(await until(() => kinds().includes("READY") || exit !== undefined, 60_000), errors).toBe(true);
      expect(exit, errors).toBeUndefined();
      // The STOP goes down the pipe and the pipe stays OPEN, exactly as the broker holds it.
      child.stdin.write(STOP_LINE);
      expect(await until(() => kinds().includes("TERMINAL") || exit !== undefined, 10_000), errors).toBe(true);
      const exited = await until(() => exit !== undefined, 5_000);
      expect(exited, `host still alive 5 s after its TERMINAL frame with stdin held open; stderr: ${errors}`).toBe(true);
      expect(exit, errors).toBe(0);
      expect(kinds()).toEqual(["READY", "TERMINAL"]);
    } finally {
      if (exit === undefined) child.kill();
      child.stdin.end();
    }
  }, 90_000);

  it("releases a held-open control input once the run is over, on the wrapper's own exit too", async () => {
    // Both ways out of the control loop: a STOP parks the read at its yield, a wrapper
    // death leaves a read PENDING on the pipe. The far end is never closed here, as the
    // broker never closes it before the host is gone.
    for (const outcome of ["STOP", "WRAPPER"] as const) {
      const input = new PassThrough();
      if (outcome === "STOP") input.write(STOP_LINE);
      const code = await runProjectStackHostMain(ARGV, {
        env,
        fs: configFs(),
        incarnationId: () => INCARNATION_ID,
        input,
        log: () => undefined,
        prepareRepository: async () => ({ ok: true }),
        startDaemon: async () => ({
          approvePairing: () => ({ ok: true, state: "APPROVED" }),
          origin: "http://127.0.0.1:49152",
          shutdown: async () => ({ ok: true }),
        }),
        startWrapper: () => {
          let stop = (): void => undefined;
          const completed = outcome === "WRAPPER"
            ? Promise.resolve({ code: 5 })
            : new Promise<{ code: number }>((resolve) => { stop = () => { resolve({ code: 0 }); }; });
          return { completed, kill: () => { stop(); } };
        },
        write: () => undefined,
      });
      expect(code, outcome).toBe(outcome === "STOP" ? 0 : 5);
      expect(input.destroyed, `${outcome}: the control input is still open after the run`).toBe(true);
    }
  });
});
