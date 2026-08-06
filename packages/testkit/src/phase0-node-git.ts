import { execFile } from "node:child_process";
import { normalize, resolve } from "node:path";

import { PHASE0_MAX_STATUS_BYTES, type GitObjectFormat } from "@moe/contracts";

import type {
  Phase0HeadPathIdentity,
  Phase0RawRepositorySnapshot,
} from "./phase0-evidence-capture.js";
import { nodePortError } from "./phase0-node-paths.js";

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) {
      environment[key] = value;
    }
  }
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGit(repository: string, args: readonly string[], label: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-replace-objects",
        "-c",
        `safe.directory=${repository}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      {
        cwd: repository,
        encoding: "buffer",
        env: isolatedGitEnvironment(),
        maxBuffer: PHASE0_MAX_STATUS_BYTES,
        shell: false,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`PHASE0_NODE_GIT_COMMAND_FAILED: ${label}`));
          return;
        }
        resolve(new Uint8Array(stdout));
      },
    );
  });
}

function decodeSingleLine(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", label);
  }
  const value = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (value.length === 0 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", label);
  }
  return value;
}

function sameRepositoryPath(left: string, right: string): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertRepositoryTopLevel(repository: string): Promise<void> {
  const topLevel = decodeSingleLine(
    await runGit(repository, ["rev-parse", "--show-toplevel"], "top-level"),
    "top-level",
  );
  if (!sameRepositoryPath(topLevel, repository)) {
    nodePortError("PHASE0_NODE_GIT_TOP_LEVEL_MISMATCH", topLevel);
  }
}

async function readObjectFormat(repository: string): Promise<GitObjectFormat> {
  const format = decodeSingleLine(
    await runGit(repository, ["rev-parse", "--show-object-format"], "object-format"),
    "object-format",
  );
  if (format !== "sha1" && format !== "sha256") {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "object-format");
  }
  return format;
}

async function readHead(repository: string, format: GitObjectFormat): Promise<string> {
  const head = decodeSingleLine(
    await runGit(repository, ["rev-parse", "--verify", "HEAD"], "HEAD"),
    "HEAD",
  );
  const pattern = format === "sha1" ? SHA1_PATTERN : SHA256_PATTERN;
  if (!pattern.test(head)) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "HEAD");
  }
  return head;
}

export async function readGitRepositorySnapshot(
  sourceRepository: string,
  statusCommand: string,
): Promise<Phase0RawRepositorySnapshot> {
  await assertRepositoryTopLevel(sourceRepository);
  const objectFormat = await readObjectFormat(sourceRepository);
  const beforeHead = await readHead(sourceRepository, objectFormat);
  const statusBytes = await runGit(
    sourceRepository,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    "status",
  );
  const afterHead = await readHead(sourceRepository, objectFormat);
  if (beforeHead !== afterHead) {
    nodePortError("PHASE0_NODE_REPOSITORY_CHANGED_DURING_SNAPSHOT", "HEAD");
  }
  return Object.freeze({
    head: beforeHead,
    objectFormat,
    sourceRepository,
    statusBytes,
    statusCommand,
  });
}

function parseLsTree(
  bytes: Uint8Array,
  expectedPath: string,
  format: GitObjectFormat,
): Phase0HeadPathIdentity | null {
  if (bytes.byteLength === 0) {
    return null;
  }
  if (bytes[bytes.byteLength - 1] !== 0 || bytes.slice(0, -1).includes(0)) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree framing");
  }
  let record: string;
  try {
    record = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, -1));
  } catch {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree UTF-8");
  }
  const separator = record.indexOf("\t");
  if (separator < 0 || record.slice(separator + 1) !== expectedPath) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree path");
  }
  const header = record.slice(0, separator).split(" ");
  if (header.length !== 3 || !/^[0-7]{6}$/.test(header[0]!)) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree header");
  }
  const objectType = header[1]!;
  const oid = header[2]!;
  if (!(["blob", "tree", "commit"] as const).includes(objectType as "blob" | "tree" | "commit")) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree type");
  }
  const oidPattern = format === "sha1" ? SHA1_PATTERN : SHA256_PATTERN;
  if (!oidPattern.test(oid)) {
    return nodePortError("PHASE0_NODE_GIT_OUTPUT_INVALID", "ls-tree oid");
  }
  return Object.freeze({ objectType, oid });
}

export async function lookupGitPathAtCommit(
  sourceRepository: string,
  commit: string,
  relativePath: string,
): Promise<Phase0HeadPathIdentity | null> {
  await assertRepositoryTopLevel(sourceRepository);
  const format = await readObjectFormat(sourceRepository);
  const commitPattern = format === "sha1" ? SHA1_PATTERN : SHA256_PATTERN;
  if (!commitPattern.test(commit)) {
    return nodePortError("PHASE0_NODE_COMMIT_INVALID", commit);
  }
  const output = await runGit(
    sourceRepository,
    ["ls-tree", "-z", "--full-tree", commit, "--", relativePath],
    "ls-tree",
  );
  return parseLsTree(output, relativePath, format);
}
