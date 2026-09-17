#!/usr/bin/env node
import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import provider from "../daemon-store-dependencies.js";
import { startDaemon } from "../daemon-entry.js";
import type { DaemonStartOptions } from "../daemon-entry.js";
import { NODE_TRANSFORM_TYPES_FLAG } from "../orchestrator/moe-up-spawn.js";
import { prepareRuntimeMetadataExcludes } from "../repository/runtime-metadata-excludes.js";
import {
  createNodeProjectStackConfigFs,
  resolveProjectStackConfig,
} from "./project-stack-config.js";
import type {
  ProjectStackBindings,
  ProjectStackConfigFs,
} from "./project-stack-config.js";
import {
  PROJECT_STACK_PROTOCOL_VERSION,
  MAX_PROJECT_STACK_FRAME_BYTES,
  encodeProjectStackHostFrame,
} from "./project-stack-protocol.js";
import { PROJECT_STACK_HOST_LAYER, runProjectStackHost } from "./project-stack-host.js";
import { stopWrapperChild } from "./project-stack-wrapper-stop.js";
import type { StoppableWrapperChild } from "./project-stack-wrapper-stop.js";
import type {
  ProjectStackDaemonHandle,
  ProjectStackRefused,
  ProjectStackWrapperHandle,
} from "./project-stack-host.js";
import { wrapperLogPath } from "./project-wrapper-log.js";

export { WRAPPER_LOG_RELATIVE_PATH } from "./project-wrapper-log.js";

interface WrapperLaunch {
  readonly argv: readonly string[];
  readonly command: string;
  readonly options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly shell: false;
    readonly stdio: readonly ["pipe", "ignore" | number, "ignore" | number];
    readonly windowsHide: true;
  };
}

/**
 * `sink` is an open file descriptor the wrapper's stdout AND stderr are written to. Without
 * one the console is dropped. It used to be dropped ALWAYS: seat output tees into the
 * wrapper's stdio (agent-spawner.ts), the host spawned the wrapper with stdio "ignore", and
 * a seat that hung for its whole 30-minute lifetime left no trace anywhere (measured
 * 2026-09-13, seat pid 88288 on a real project: zero connections, nothing on any screen).
 *
 * stdin is a PIPE, never "ignore": it carries the wrapper's stop token (see
 * project-stack-wrapper-stop.ts). With stdin ignored the only stop the host could give the
 * wrapper was TerminateProcess, which skips the exit path that retires the seats.
 */
export function projectStackWrapperLaunch(
  bindings: ProjectStackBindings,
  env: Readonly<Record<string, string | undefined>>,
  wrapperEntry: string,
  sink?: number,
): WrapperLaunch {
  return Object.freeze({
    argv: Object.freeze([NODE_TRANSFORM_TYPES_FLAG, wrapperEntry]),
    command: process.execPath,
    options: Object.freeze({
      cwd: bindings.projectRoot,
      env,
      shell: false as const,
      stdio: sink === undefined
        ? Object.freeze(["pipe", "ignore", "ignore"] as const)
        : Object.freeze(["pipe", sink, sink] as const),
      windowsHide: true as const,
    }),
  });
}

/** Opens the project's wrapper log for append, or answers null when the project refuses it. */
export function openWrapperLog(projectRoot: string): number | null {
  try {
    mkdirSync(join(projectRoot, ".moe-next"), { recursive: true });
    return openSync(wrapperLogPath(projectRoot), "a", 0o600);
  } catch {
    return null;
  }
}

/** The spawned wrapper as its handle needs it: the stop's view, plus the exit code and the spawn error. */
export interface WrapperChild extends StoppableWrapperChild {
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
}

/**
 * The host's handle over a spawned wrapper. `kill` is the ask-then-terminate stop of
 * project-stack-wrapper-stop.ts, never the child's own kill; `completed` settles on the
 * child's exit, so a wrapper that honours the token settles with its own exit code.
 */
export function wrapperHandleFor(child: WrapperChild): ProjectStackWrapperHandle {
  const completed = new Promise<Readonly<{ readonly code: number | null }>>((resolve) => {
    let done = false;
    const settle = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve(Object.freeze({ code }));
    };
    child.once("exit", (code) => { settle(code); });
    child.once("error", () => { settle(null); });
  });
  return Object.freeze({
    completed,
    kill: (): void => { stopWrapperChild(child); },
  });
}

function startNodeWrapper(
  bindings: ProjectStackBindings,
  env: Readonly<Record<string, string | undefined>>,
  wrapperEntry: string,
): ProjectStackWrapperHandle {
  const sink = openWrapperLog(bindings.projectRoot);
  const request = projectStackWrapperLaunch(bindings, env, wrapperEntry, sink ?? undefined);
  const stdio: StdioOptions = sink === null ? ["pipe", "ignore", "ignore"] : ["pipe", sink, sink];
  const child = spawn(request.command, [...request.argv], {
    ...request.options,
    env: { ...request.options.env },
    stdio,
  });
  if (sink !== null) {
    // The child holds its own handle once spawned; this one is closed on either outcome.
    child.once("spawn", () => { try { closeSync(sink); } catch { /* already closed */ } });
    child.once("error", () => { try { closeSync(sink); } catch { /* already closed */ } });
  }
  return wrapperHandleFor(child);
}

/** Bounded newline frames over the private broker pipe; no unbounded readline buffer. */
export async function* projectStackControlLines(input: Readable): AsyncIterable<Uint8Array> {
  let pending = Buffer.alloc(0);
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline + 1);
      pending = pending.subarray(newline + 1);
      if (line.byteLength > MAX_PROJECT_STACK_FRAME_BYTES) {
        yield new Uint8Array(MAX_PROJECT_STACK_FRAME_BYTES + 1);
        return;
      }
      yield line;
    }
    if (pending.byteLength > MAX_PROJECT_STACK_FRAME_BYTES) {
      yield new Uint8Array(MAX_PROJECT_STACK_FRAME_BYTES + 1);
      return;
    }
  }
  if (pending.byteLength > 0) yield pending;
}

/**
 * The hosted daemon's start options. Inside a stack host the daemon's own stdin is never
 * a terminal; its approval path is the host's control frame, fed by the label the parent
 * CLI reads from ITS console. So the flag is the parent's MEASURED fact, carried in as
 * MOE_OPERATOR_CHANNEL. Hardcoded `false` sent artifact users to "pnpm start" with no
 * label to type (measured 2026-09-13 from a real PowerShell console); hardcoded `true`
 * told a piped-stdio operator to type a label nobody read (measured 2026-09-13, Git Bash,
 * `process.stdin.isTTY` undefined, no consumer attached).
 */
export function hostedDaemonStartOptions(bindings: ProjectStackBindings): DaemonStartOptions {
  return Object.freeze({
    assetRoot: bindings.assetRoot,
    assetSecrets: [bindings.credential],
    dependencies: provider,
    pairingOperatorChannelAvailable: bindings.operatorChannelAvailable,
  });
}

export interface ProjectStackHostMainOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ProjectStackConfigFs;
  readonly incarnationId: () => string;
  /**
   * The broker's control pipe, read as bounded frames and released by the host itself once
   * the run is over. The parent ends its write end only when the boundary closes, which is
   * AFTER it has seen the host exit (closeProviderChannels), so a read left armed on the
   * pipe kept the host alive past its own TERMINAL frame: every clean stop ran into the
   * supervisor's 10 s budget and ended as a timed-out kill (measured 2026-09-17, Node
   * v24.16.0: a real host child still alive 5 s after TERMINAL with stdin held open).
   */
  readonly input: Readable;
  readonly log: (line: string) => void;
  readonly prepareRepository: (
    bindings: ProjectStackBindings,
  ) => Promise<Readonly<{ ok: true }> | ProjectStackRefused>;
  readonly startDaemon: (
    bindings: ProjectStackBindings,
  ) => Promise<ProjectStackDaemonHandle | ProjectStackRefused>;
  readonly startWrapper: (bindings: ProjectStackBindings) => ProjectStackWrapperHandle;
  readonly write: (line: string) => void;
}

export async function runProjectStackHostMain(
  argv: readonly string[],
  options: ProjectStackHostMainOptions,
): Promise<number> {
  let incarnationId: string;
  try { incarnationId = options.incarnationId(); }
  catch {
    options.log("PROJECT_STACK_INCARNATION_FAILED PROJECT_STACK_HOST");
    return 1;
  }
  const resolved = resolveProjectStackConfig({ argv, env: options.env, fs: options.fs });
  if (!resolved.ok) {
    const encoded = encodeProjectStackHostFrame({
      code: resolved.code,
      incarnationId,
      kind: "START_REFUSED",
      layer: resolved.layer,
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    if (encoded.ok) options.write(encoded.line);
    options.log(`${resolved.code} ${resolved.layer}`);
    return 1;
  }
  const bindings = resolved.bindings;
  try {
    return await runProjectStackHost({
      controls: projectStackControlLines(options.input),
      incarnationId,
      instanceId: bindings.instanceId,
      log: options.log,
      projectId: bindings.projectId,
      startDaemon: async () => {
        let prepared: Readonly<{ ok: true }> | ProjectStackRefused;
        const fallback: ProjectStackRefused = {
          ok: false, code: "PROJECT_RUNTIME_METADATA_PREPARATION_FAILED", layer: PROJECT_STACK_HOST_LAYER,
        };
        try { prepared = await options.prepareRepository(bindings); }
        catch { prepared = fallback; }
        if (!prepared.ok) {
          const safe = /^[A-Z][A-Z0-9_]{0,127}$/u;
          const refusal = safe.test(prepared.code) && safe.test(prepared.layer) ? prepared : fallback;
          options.log(`${refusal.code} ${refusal.layer}`);
          return refusal;
        }
        return await options.startDaemon(bindings);
      },
      startWrapper: () => options.startWrapper(bindings),
      storePath: bindings.storePath,
      write: options.write,
    });
  } finally {
    // The control pipe is released on EVERY path out of the host loop, a STOP (the read
    // parked at its yield) and a wrapper death (a read still pending) alike: nobody else
    // closes it before the host is gone, and an armed read is a live handle. The TERMINAL
    // frame is already written; a pending stdout write still drains before the exit.
    options.input.destroy();
  }
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const wrapperEntry = fileURLToPath(new URL("../orchestrator/agent-wrapper-main.ts", import.meta.url));
  process.exitCode = await runProjectStackHostMain(process.argv.slice(2), {
    env: process.env,
    fs: createNodeProjectStackConfigFs(),
    incarnationId: randomUUID,
    input: process.stdin,
    log: (line) => process.stderr.write(`${line}\n`),
    prepareRepository: prepareRuntimeMetadataExcludes,
    startDaemon: async (bindings) => startDaemon(hostedDaemonStartOptions(bindings)),
    startWrapper: (bindings) => startNodeWrapper(bindings, process.env, wrapperEntry),
    write: (line) => { process.stdout.write(line); },
  });
}
