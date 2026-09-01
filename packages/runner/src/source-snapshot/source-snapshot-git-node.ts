import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { isHex64 } from "../canonical.js";
import { hermeticGitEnvironment } from "../scope/scope-git.js";
import {
  MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES,
  RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
  SOURCE_SNAPSHOT_GIT_TIMEOUT_MS,
  type SourceSnapshotGitCode,
  type SourceSnapshotGitObserver,
  type SourceSnapshotGitRefusal,
  type SourceSnapshotGitResult,
} from "./source-snapshot-git-contract.js";

export type SourceSnapshotGitCommandResult =
  | Readonly<{ readonly ok: true; readonly stdout: Uint8Array }>
  | Readonly<{ readonly failure: "FAILED" | "OVERFLOW"; readonly ok: false }>;

/** Internal injectable effect port. The package root publishes only the Node factory. */
export interface SourceSnapshotGitNodePort {
  realpath(path: string): string;
  run(repositoryRoot: string, args: readonly string[]): SourceSnapshotGitCommandResult;
}

const HEAD_ARGS = Object.freeze([
  "rev-parse", "--verify", "--quiet", "HEAD^{commit}",
]);
const TOP_LEVEL_ARGS = Object.freeze([
  "rev-parse", "--path-format=absolute", "--show-toplevel",
]);
const OBJECT_ID_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/u;

const refuse = (code: SourceSnapshotGitCode): SourceSnapshotGitRefusal => Object.freeze({
  code, layer: RUNNER_SOURCE_SNAPSHOT_GIT_LAYER, ok: false as const,
});

type Read = Readonly<{ ok: true; value: string }> | SourceSnapshotGitRefusal;
const read = (value: string): Readonly<{ ok: true; value: string }> =>
  Object.freeze({ ok: true as const, value });

function decode(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function objectId(result: SourceSnapshotGitCommandResult): Read {
  if (!result.ok) {
    return refuse(result.failure === "OVERFLOW"
      ? "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW"
      : "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_FAILED");
  }
  if (result.stdout.byteLength > MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW");
  }
  const text = decode(result.stdout);
  const match = text === undefined ? null : OBJECT_ID_LINE.exec(text);
  return match?.[1] === undefined
    ? refuse("RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED") : read(match[1]);
}

function topLevel(result: SourceSnapshotGitCommandResult): Read {
  if (!result.ok) {
    return refuse(result.failure === "OVERFLOW"
      ? "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW"
      : "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_FAILED");
  }
  if (result.stdout.byteLength > MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW");
  }
  const text = decode(result.stdout);
  if (text === undefined || !text.endsWith("\n")) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED");
  }
  const path = text.slice(0, -1);
  return path.length === 0 || path.includes("\n") || path.includes("\r")
    ? refuse("RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED") : read(path);
}

function head(port: SourceSnapshotGitNodePort, repositoryRoot: string): Read {
  return objectId(port.run(repositoryRoot, HEAD_ARGS));
}

/**
 * Pure decision core for deterministic tests. Callers outside this package cannot
 * import it through the package exports map; production composition receives only
 * `createNodeSourceSnapshotGitObserver` below.
 */
export function observeSourceSnapshotGitWithPort(
  repositoryRoot: string,
  expectedBaseRevision: string,
  port: SourceSnapshotGitNodePort,
): SourceSnapshotGitResult {
  if (!isHex64(expectedBaseRevision)) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID");
  }

  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = port.realpath(repositoryRoot);
  } catch {
    return refuse("RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE");
  }
  const root = topLevel(port.run(realRepositoryRoot, TOP_LEVEL_ARGS));
  if (!root.ok) return root;
  let observedRoot: string;
  try {
    observedRoot = port.realpath(root.value);
  } catch {
    return refuse("RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH");
  }
  if (observedRoot !== realRepositoryRoot) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH");
  }

  const before = head(port, realRepositoryRoot);
  if (!before.ok) return before;
  if (before.value !== expectedBaseRevision) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH");
  }
  const rawTree = port.run(realRepositoryRoot, [
    "rev-parse", "--verify", `${expectedBaseRevision}^{tree}`,
  ]);
  if (!rawTree.ok && rawTree.failure === "FAILED") {
    return refuse("RUNNER_SOURCE_SNAPSHOT_TREE_UNREADABLE");
  }
  const tree = objectId(rawTree);
  if (!tree.ok) return tree;

  const after = head(port, realRepositoryRoot);
  if (!after.ok) return after;
  if (after.value !== expectedBaseRevision) {
    return refuse("RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH");
  }
  return Object.freeze({
    observation: Object.freeze({
      baseRevisionHash: expectedBaseRevision,
      realRepositoryRoot,
      repositoryBaseTree: tree.value,
    }),
    ok: true as const,
  });
}

function command(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): SourceSnapshotGitCommandResult {
  try {
    const stdout = execFileSync("git", [
      "--no-replace-objects",
      "-c", `safe.directory=${repositoryRoot}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      ...args,
    ], {
      cwd: repositoryRoot,
      encoding: "buffer",
      env: environment,
      maxBuffer: MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SOURCE_SNAPSHOT_GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return Object.freeze({ ok: true as const, stdout: new Uint8Array(stdout) });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return Object.freeze({
      failure: code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? ("OVERFLOW" as const) : ("FAILED" as const),
      ok: false as const,
    });
  }
}

/** Production Git tree observer: fixed root, hermetic environment, fixed argv. */
export function createNodeSourceSnapshotGitObserver(
  repositoryRoot: string,
  baseEnvironment: NodeJS.ProcessEnv,
): SourceSnapshotGitObserver {
  const environment = hermeticGitEnvironment(baseEnvironment);
  const port: SourceSnapshotGitNodePort = Object.freeze({
    realpath: (path: string): string => realpathSync(path),
    run: (realRoot: string, args: readonly string[]): SourceSnapshotGitCommandResult =>
      command(realRoot, environment, args),
  });
  return Object.freeze({
    observe: (expectedBaseRevision: string): SourceSnapshotGitResult =>
      observeSourceSnapshotGitWithPort(repositoryRoot, expectedBaseRevision, port),
  });
}
