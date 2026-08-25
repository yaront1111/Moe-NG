#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import provider from "../daemon-store-dependencies.js";
import { startDaemon } from "../daemon-entry.js";
import { NODE_TRANSFORM_TYPES_FLAG } from "../orchestrator/moe-up-spawn.js";
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
import { runProjectStackHost } from "./project-stack-host.js";
import type {
  ProjectStackDaemonHandle,
  ProjectStackRefused,
  ProjectStackWrapperHandle,
} from "./project-stack-host.js";

interface WrapperLaunch {
  readonly argv: readonly string[];
  readonly command: string;
  readonly options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
  };
}

export function projectStackWrapperLaunch(
  bindings: ProjectStackBindings,
  env: Readonly<Record<string, string | undefined>>,
  wrapperEntry: string,
): WrapperLaunch {
  return Object.freeze({
    argv: Object.freeze([NODE_TRANSFORM_TYPES_FLAG, wrapperEntry]),
    command: process.execPath,
    options: Object.freeze({
      cwd: bindings.projectRoot,
      env,
      shell: false as const,
      stdio: "ignore" as const,
      windowsHide: true as const,
    }),
  });
}

function startNodeWrapper(
  bindings: ProjectStackBindings,
  env: Readonly<Record<string, string | undefined>>,
  wrapperEntry: string,
): ProjectStackWrapperHandle {
  const request = projectStackWrapperLaunch(bindings, env, wrapperEntry);
  const child = spawn(request.command, [...request.argv], {
    ...request.options,
    env: { ...request.options.env },
  });
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
    kill: (): void => { child.kill(); },
  });
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

export interface ProjectStackHostMainOptions {
  readonly controls: AsyncIterable<string | Uint8Array>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ProjectStackConfigFs;
  readonly incarnationId: () => string;
  readonly log: (line: string) => void;
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
  return await runProjectStackHost({
    controls: options.controls,
    incarnationId,
    instanceId: bindings.instanceId,
    log: options.log,
    projectId: bindings.projectId,
    startDaemon: () => options.startDaemon(bindings),
    startWrapper: () => options.startWrapper(bindings),
    storePath: bindings.storePath,
    write: options.write,
  });
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const wrapperEntry = fileURLToPath(new URL("../orchestrator/agent-wrapper-main.ts", import.meta.url));
  process.exitCode = await runProjectStackHostMain(process.argv.slice(2), {
    controls: projectStackControlLines(process.stdin),
    env: process.env,
    fs: createNodeProjectStackConfigFs(),
    incarnationId: randomUUID,
    log: (line) => process.stderr.write(`${line}\n`),
    startDaemon: async (bindings) => startDaemon({
      assetRoot: bindings.assetRoot,
      assetSecrets: [bindings.credential],
      dependencies: provider,
    }),
    startWrapper: (bindings) => startNodeWrapper(bindings, process.env, wrapperEntry),
    write: (line) => { process.stdout.write(line); },
  });
}
