#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareRuntimeMetadataExcludes } from "../repository/runtime-metadata-excludes.js";
import { parseCliArgv } from "./moe-cli-argv.js";
import type { CliInit, CliRecoverReview, CliRecoverReplan, CliStart } from "./moe-cli-argv.js";
import { isMainModule } from "./moe-cli-entry.js";
import { MOE_CLI_CONFIG_ABSENT, preparePackagedLinks, readConfig } from "./moe-cli-project.js";
import {
  MOE_CONFIG_FILENAME, MOE_INIT_CONFIG_PRESENT, checkNodeVersion, cryptoRandomHex, planInit,
} from "./moe-init.js";
import type { InitProbe, MoeConfig } from "./moe-init.js";

/**
 * `moe`: the installed artifact's front door. It owns `init` — scaffolding a
 * store directory, minting the operator credential, writing the config — and
 * hands `start` to the single-project composer (`runSingleProjectMain`) and
 * `projects` to the Windows manager. Process supervision, teardown, and the
 * origin announcement all stay there; this file adds none of it back. (`moe up`
 * is the repository checkout's dev composer and is not on this path.)
 */

/** Re-exported: it was declared here before `moe mcp` needed the same reader. */
export { MOE_CLI_CONFIG_ABSENT };
/** The target directory could not be created at all. */
export const MOE_CLI_TARGET_UNUSABLE = "MOE_CLI_TARGET_UNUSABLE" as const;

export interface StartRequest {
  readonly artifactRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly operatorStdin?: true;
  readonly projectRoot: string;
}

export interface ManagerStartRequest {
  readonly operatorStdin?: true;
}

export interface ReviewRecoveryRequest extends StartRequest {
  readonly automatic?: true;
  readonly config: MoeConfig;
  readonly log: (line: string) => void;
}
/**
 * `released` counts owners freed BEFORE a refusal. A replan release walks every replanned owner
 * in turn, so a failure on the second leaves the first genuinely released — and the startup line
 * below used to promise that every reservation was kept. A refusal that misreports what it did
 * is worse than the failure it reports, so the count travels with it. Absent means none.
 */
export type ReviewRecoveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly released?: number };

export interface CliIo {
  /** The extracted artifact root (or the repository root in a checkout). */
  readonly artifactRoot: string;
  readonly argv: readonly string[];
  /** The operator's working directory; never inferred from the extracted artifact root. */
  readonly cwd: string;
  /**
   * STDERR. Separate from `log` because `moe mcp` hands stdout to a JSON-RPC
   * client: one banner line on the wrong sink corrupts the client's framing.
   * Required, not optional, so every composition root has to answer where its
   * diagnostics go rather than silently dropping them.
   */
  readonly diagnostic: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** INJECTED so the engines guard is testable without a second Node install. */
  readonly nodeVersion: string;
  readonly packageVersion: string;
  readonly randomHex: (bytes: number) => string;
  readonly recoverReplan?: (request: ReviewRecoveryRequest) => Promise<ReviewRecoveryResult>;
  readonly recoverReview?: (request: ReviewRecoveryRequest) => Promise<ReviewRecoveryResult>;
  readonly startManager: (request: ManagerStartRequest) => Promise<number>;
  readonly startStack: (request: StartRequest) => Promise<number>;
}

const USAGE = Object.freeze([
  "moe — the supervised multi-agent control plane (v0.1, Windows)",
  "",
  "  moe init [dir] [--force]   scaffold a store, mint an operator credential, write the config",
  "  moe start [dir] [--operator-stdin]   start one project and print its plain control-room origin",
  "  moe mcp [dir]             serve this project to a headless MCP client over stdio (no browser, no pairing)",
  "  moe recover-review [dir] [--operator-stdin]   drain a blocked review runtime, recover it, and restart",
  "  moe recover-replan [dir] [--operator-stdin]   release a retired replan after preserving its reviewed commit, and restart",
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

async function runInit(invocation: CliInit, io: CliIo): Promise<number> {
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
    const prepared = await prepareRuntimeMetadataExcludes({
      configPath: plan.configPath, initializing: true, projectRoot: targetDir, storePath: plan.storePath,
    });
    if (!prepared.ok) {
      io.log(`${prepared.code} ${prepared.layer}`);
      return 1;
    }
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

async function runStart(invocation: CliStart, io: CliIo): Promise<number> {
  const targetDir = resolve(io.cwd, invocation.targetDir);
  const config = readConfig(targetDir, io);
  if (config === null) return 1;
  if (!preparePackagedLinks(io, "start")) return 1;
  if (io.recoverReplan !== undefined) {
    let recovered: ReviewRecoveryResult;
    try { recovered = await io.recoverReplan({ artifactRoot: io.artifactRoot, env: io.env,
      config, projectRoot: targetDir, log: io.log, automatic: true }); }
    catch { recovered = { ok: false, code: "MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE" }; }
    // A startup release that cannot be proved keeps every reservation exactly as it was. Refusing
    // to start never made one provable: it left the whole project unstartable (addendum 2026-09-15).
    if (!recovered.ok) {
      const freed = recovered.released ?? 0;
      io.log(freed > 0
        ? `moe start: ${recovered.code}: the startup replan release stopped after freeing ${String(freed)} replanned owner(s); the rest are kept as they were and the project starts`
        : `moe start: ${recovered.code}: the startup replan release was not proved; every repository reservation is kept as it was and the project starts`);
    }
    const current = readConfig(targetDir, io);
    if (current === null || JSON.stringify(current) !== JSON.stringify(config)) {
      io.log("MOE_CLI_REPLAN_RECOVERY_CONFIG_CHANGED"); return 1;
    }
  }
  io.log(`moe start: project ${config.projectId} -> ${targetDir}`);
  io.log("moe start: one daemon/store/session; goals, tasks, and board stay inside this project");
  return io.startStack({
    artifactRoot: io.artifactRoot,
    env: io.env,
    ...(invocation.operatorStdin === true ? { operatorStdin: true as const } : {}),
    projectRoot: targetDir,
  });
}

async function runRecoverReview(invocation: CliRecoverReview | CliRecoverReplan, io: CliIo): Promise<number> {
  const recover = invocation.command === "recover-replan" ? io.recoverReplan : io.recoverReview;
  const projectRoot = resolve(io.cwd, invocation.targetDir);
  const config = readConfig(projectRoot, io);
  if (config === null || !preparePackagedLinks(io, invocation.command)) return 1;
  if (recover === undefined) {
    io.log("MOE_CLI_REVIEW_RECOVERY_UNAVAILABLE"); return 1;
  }
  io.log(`moe ${invocation.command}: checking blocked review in ${projectRoot}`);
  let recovered: ReviewRecoveryResult;
  try {
    recovered = await recover({ artifactRoot: io.artifactRoot, env: io.env,
      config, projectRoot, log: io.log });
  } catch { recovered = { ok: false, code: "MOE_CLI_REVIEW_RECOVERY_UNAVAILABLE" }; }
  if (!recovered.ok) { io.log(recovered.code); return 1; }
  const current = readConfig(projectRoot, io);
  if (current === null || JSON.stringify(current) !== JSON.stringify(config)) {
    io.log("MOE_CLI_REVIEW_RECOVERY_CONFIG_CHANGED"); return 1;
  }
  io.log(`moe ${invocation.command}: existing work preserved; starting the repaired runtime`);
  return runStart({ ...invocation, command: "start" }, io);
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
  if (invocation.command === "recover-review" || invocation.command === "recover-replan") return runRecoverReview(invocation, io);
  if (invocation.command === "mcp") {
    const { runMcp } = await import("./moe-cli-mcp.js");
    return await runMcp(invocation, io);
  }
  if (invocation.command === "projects") {
    if (!preparePackagedLinks(io, "projects")) return 1;
    return await io.startManager({
      ...(invocation.operatorStdin === true ? { operatorStdin: true as const } : {}),
    });
  }
  return await runStart(invocation, io);
}

/** Reads the version out of THIS package's own manifest; never hardcoded. */
function ownVersion(artifactRoot: string): string {
  try {
    const raw = readFileSync(resolve(artifactRoot, "apps", "daemon", "package.json"), "utf8");
    const found = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof found === "string" ? found : "unknown";
  } catch {
    return "unknown";
  }
}

// Not `import.meta.main` alone: the flag is undefined on Node 23.6-23.11 and 24.0-24.1, which
// already load this file, and the refusal above never ran there (moe-cli-entry.ts).
if (isMainModule(import.meta, process.argv[1])) {
  const artifactRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  process.exitCode = await runMoeCli({
    artifactRoot,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    diagnostic: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    nodeVersion: process.version,
    packageVersion: ownVersion(artifactRoot),
    randomHex: cryptoRandomHex,
    recoverReplan: async (request) => {
      const { runProjectReplanRecovery } = await import("./moe-cli-replan-recovery.js");
      return await runProjectReplanRecovery(request);
    },
    recoverReview: async (request) => {
      const { runProjectReviewRecovery } = await import("./moe-cli-review-recovery.js");
      return await runProjectReviewRecovery(request);
    },
    startManager: async (request) => {
      const { runProjectManagerMain } = await import("../projects/project-manager-main.js");
      return await runProjectManagerMain({
        env: process.env,
        log: (line: string) => process.stdout.write(`${line}\n`),
        ...(process.stdin.isTTY === true || request.operatorStdin === true
          ? { operatorInput: process.stdin } : {}),
        root: artifactRoot,
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
        root: request.artifactRoot,
      });
    },
  });
}
