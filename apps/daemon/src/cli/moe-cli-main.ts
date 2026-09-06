#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgv } from "./moe-cli-argv.js";
import type { CliInit, CliStart } from "./moe-cli-argv.js";
import { WORKSPACE_LINK_FILENAME, ensureWorkspaceLinks } from "./moe-cli-links.js";
import {
  MOE_CONFIG_FILENAME, MOE_INIT_CONFIG_PRESENT, checkNodeVersion, cryptoRandomHex,
  parseMoeConfig, planInit,
} from "./moe-init.js";
import type { InitProbe, MoeConfig } from "./moe-init.js";

/**
 * `moe`: the installed artifact's front door. It owns `init` — scaffolding a
 * store directory, minting the operator credential, writing the config — and
 * hands `start` straight to the EXISTING `moe up` composer. Process supervision,
 * teardown, and the origin announcement all stay there; this file adds none of
 * it back.
 */

/** `start` was pointed at a directory `init` has never run in. */
export const MOE_CLI_CONFIG_ABSENT = "MOE_CLI_CONFIG_ABSENT" as const;
/** The target directory could not be created at all. */
export const MOE_CLI_TARGET_UNUSABLE = "MOE_CLI_TARGET_UNUSABLE" as const;

export interface StartRequest {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly operatorStdin?: true;
  readonly projectRoot: string;
  readonly root: string;
}

export interface ManagerStartRequest {
  readonly operatorStdin?: true;
}

export interface CliIo {
  readonly argv: readonly string[];
  /** The operator's working directory; never inferred from the extracted artifact root. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** INJECTED so the engines guard is testable without a second Node install. */
  readonly nodeVersion: string;
  readonly packageVersion: string;
  readonly randomHex: (bytes: number) => string;
  /** The extracted artifact root (or the repository root in a checkout). */
  readonly root: string;
  readonly startManager: (request: ManagerStartRequest) => Promise<number>;
  readonly startStack: (request: StartRequest) => Promise<number>;
}

const USAGE = Object.freeze([
  "moe — the supervised multi-agent control plane (v0.1, Windows)",
  "",
  "  moe init [dir] [--force]   scaffold a store, mint an operator credential, write the config",
  "  moe start [dir] [--operator-stdin]   start one project and print its plain control-room origin",
  "  moe projects [--operator-stdin]      open the Windows manager at its plain loopback origin",
  "  moe --version              print this build's version",
  "  moe --help                 print this message",
  "",
  "  [dir] defaults to the current directory. Quote a path that contains spaces.",
  "  Pairing: open the plain origin, then type its confirmation label into this foreground process.",
  "  --operator-stdin explicitly enables the same private input over a parent-owned stdin pipe.",
  "  Claude auth: set one of CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY.",
  "  Node >=24.16 <25 is required.",
]);

/**
 * The observations `planInit` decides on. A directory that does not exist yet is
 * reported as empty and writable-if-its-parent-is: the plan, not the probe,
 * owns what that means.
 */
function probeTarget(targetDir: string): InitProbe {
  if (!existsSync(targetDir)) {
    const parent = dirname(targetDir);
    return { entries: [], writable: existsSync(parent) };
  }
  try {
    return { entries: readdirSync(targetDir), writable: true };
  } catch {
    return { entries: [], writable: false };
  }
}

function runInit(invocation: CliInit, io: CliIo): number {
  const targetDir = resolve(io.cwd, invocation.targetDir);
  const plan = planInit({
    force: invocation.force,
    probe: probeTarget(targetDir),
    randomHex: io.randomHex,
    targetDir,
  });
  if (!plan.ok) {
    for (const refusal of plan.refusals) io.log(refusal.message);
    return 1;
  }
  try {
    mkdirSync(targetDir, { recursive: true });
    // `wx` closes the window between the probe above and this write: a second
    // `moe init` racing the first must lose here rather than silently replace a
    // config — and orphan the store the first one minted a credential for.
    for (const file of plan.files) {
      writeFileSync(file.path, file.contents, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      io.log(`${MOE_INIT_CONFIG_PRESENT}: ${MOE_CONFIG_FILENAME}`);
      return 1;
    }
    // A crash is not a refusal: an unusable target is an operator fault with an
    // obvious fix and earns a code, not a raw ENOTDIR stack.
    io.log(`${MOE_CLI_TARGET_UNUSABLE}: ${(error as Error).message}`);
    return 1;
  }
  io.log(`moe init: initialized ${targetDir}`);
  for (const line of plan.disclosures) io.log(line);
  io.log(`moe init: next -> moe start ${invocation.targetDir}`);
  return 0;
}

function readConfig(targetDir: string, io: CliIo): MoeConfig | null {
  const configPath = resolve(targetDir, MOE_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    io.log(`${MOE_CLI_CONFIG_ABSENT}: ${configPath} — run 'moe init' there first`);
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    io.log(`${MOE_CLI_CONFIG_ABSENT}: ${(error as Error).message}`);
    return null;
  }
  const parsed = parseMoeConfig(raw);
  if (!parsed.ok) {
    io.log(parsed.message);
    return null;
  }
  return parsed.config;
}

/** Absent in a repository checkout, where pnpm already owns the links. */
function readLinkManifest(root: string): string | null {
  const path = resolve(root, WORKSPACE_LINK_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function runStart(invocation: CliStart, io: CliIo): Promise<number> {
  const targetDir = resolve(io.cwd, invocation.targetDir);
  const config = readConfig(targetDir, io);
  if (config === null) return 1;
  if (!preparePackagedLinks(io, "start")) return 1;
  io.log(`moe start: project ${config.projectId} -> ${targetDir}`);
  io.log("moe start: one daemon/store/session; goals, tasks, and board stay inside this project");
  return io.startStack({
    env: io.env,
    ...(invocation.operatorStdin === true ? { operatorStdin: true as const } : {}),
    projectRoot: targetDir,
    root: io.root,
  });
}

function preparePackagedLinks(io: CliIo, command: "projects" | "start"): boolean {
  const links = ensureWorkspaceLinks(io.root, readLinkManifest(io.root));
  if (!links.ok) {
    io.log(links.message);
    return false;
  }
  if (links.created.length > 0) {
    io.log(`moe ${command}: linked ${String(links.created.length)} workspace packages`);
  }
  return true;
}

export async function runMoeCli(io: CliIo): Promise<number> {
  const invocation = parseCliArgv(io.argv);
  if (!invocation.ok) {
    io.log(invocation.message);
    return 1;
  }
  if (invocation.command === "version") {
    io.log(io.packageVersion);
    return 0;
  }
  if (invocation.command === "help") {
    for (const line of USAGE) io.log(line);
    return 0;
  }
  // Checked here rather than at parse time: `--version` and `--help` must still
  // answer on a Node this artifact cannot run, or the operator cannot even read
  // which Node it wants.
  const unsupported = checkNodeVersion(io.nodeVersion);
  if (unsupported !== null) {
    io.log(unsupported.message);
    io.log("moe: install Node >=24.16 <25 — https://nodejs.org/en/download");
    return 1;
  }
  if (invocation.command === "init") return runInit(invocation, io);
  if (invocation.command === "projects") {
    if (!preparePackagedLinks(io, "projects")) return 1;
    return await io.startManager({
      ...(invocation.operatorStdin === true ? { operatorStdin: true as const } : {}),
    });
  }
  return await runStart(invocation, io);
}

/** Reads the version out of THIS package's own manifest; never hardcoded. */
function ownVersion(packageRoot: string): string {
  try {
    const raw = readFileSync(resolve(packageRoot, "package.json"), "utf8");
    const found = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof found === "string" ? found : "unknown";
  } catch {
    return "unknown";
  }
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  process.exitCode = await runMoeCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    nodeVersion: process.version,
    packageVersion: ownVersion(packageRoot),
    randomHex: cryptoRandomHex,
    root,
    startManager: async (request) => {
      const { runProjectManagerMain } = await import("../projects/project-manager-main.js");
      return await runProjectManagerMain({
        env: process.env,
        log: (line: string) => process.stdout.write(`${line}\n`),
        ...(process.stdin.isTTY === true || request.operatorStdin === true
          ? { operatorInput: process.stdin } : {}),
        root,
      });
    },
    // Compatibility entry, but no compatibility process boundary: direct
    // starts use the same native per-store lock and stack host as the manager.
    startStack: async (request) => {
      const { runSingleProjectMain } = await import("../projects/project-single-main.js");
      return await runSingleProjectMain({
        env: request.env,
        log: (line: string) => process.stdout.write(`${line}\n`),
        ...(process.stdin.isTTY === true || request.operatorStdin === true
          ? { operatorInput: process.stdin } : {}),
        onSignal: (handler: () => void) => {
          process.on("SIGINT", handler);
          process.on("SIGTERM", handler);
        },
        projectRoot: request.projectRoot,
        root: request.root,
      });
    },
  });
}
