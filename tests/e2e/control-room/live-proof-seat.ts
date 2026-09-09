/**
 * THE REAL PROVIDER SEAT for the epic-final live proof's landing leg.
 *
 * WHY THIS FILE EXISTS AT ALL. Round 1 of this row delivered its node code from a literal
 * table inside `live-proof-workspace.ts` and disclosed it plainly as "the ONE double". QA
 * rejected that (comment-b8cb1fc1 item 2) and it was right to: governor-608c8a78 had already
 * refused the waiver twice (comment-14754137, comment-f3a33015), and a truthful disclosure is
 * not an authorization. The row's description says REAL SEATS. So the bytes of every node
 * module in this proof are now written by a real provider CLI, spawned by the shipped wrapper
 * through its own `MOE_AGENT_COMMAND` seam.
 *
 * WHAT IS LEFT HERE, AND WHY IT IS NOT A DOUBLE. This module writes a LAUNCHER, not a node.
 * The launcher does three things the wrapper's seam does not do for us and a provider cannot
 * be asked to do reliably: it works out WHICH node's mission it just received (the wrapper
 * staffs every ready item through one command, so a seat that ignored stdin would deliver a
 * node on behalf of a mission that never claimed it), it marks the window it was alive in so
 * the concurrency clause has a falsifiable witness, and it refuses when the provider wrote
 * nothing. It contains no product code and no assertion: `SEAT_PROVIDER_WROTE_NOTHING` is the
 * only outcome it can manufacture, and that outcome is a FAILURE.
 *
 * THE PROVIDER'S BRIEF IS THE PRODUCT'S OWN. The mission text comes from production
 * (`agent-mission-text.ts`'s `codeMission`), and the acceptance checks the provider is pointed
 * at are the ones the browser's approved contract produced, committed into the product
 * repository before any seat runs. Nothing tells the provider what to type; it is told what
 * must hold, which is what a coding agent is for.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CODING_BUILTIN_TOOLS }
  from "../../../apps/daemon/src/orchestrator/agent-role-contract.js";
import { landingSeatClaim } from "./lane-landing.js";

/** How long one provider seat is given to read its brief and write one module. */
export const PROVIDER_SEAT_BUDGET_MS = 600_000;

/**
 * The seat's argv, and every flag is here because the SHIPPED spawner passes it.
 *
 * `--allowedTools` IS LOAD-BEARING AND `--dangerously-skip-permissions` DOES NOT WORK HERE.
 * MEASURED 2026-09-09, verbatim from the CLI's own stderr when the seat is spawned in the
 * environment `agentEnvironment` builds:
 *
 *   "Permission mode forced to default - CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set
 *    (allowed_non_write_users hardening). Declare allowedTools explicitly, or set
 *    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to opt out."
 *
 * The daemon sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` deliberately
 * (agent-spawn-environment.ts:75), so a seat that asks to skip permissions is silently put back
 * on the default mode and every Write is refused -- observed as five consecutive provider turns
 * that designed the module correctly, could not create the file, and reported
 * SEAT_PROVIDER_WROTE_NOTHING. The remedy is the CLI's own: declare the tools. Production's
 * claude seats already do (`agent-spawner.ts:149-150`), so NOTHING IN THE DAEMON CHANGES; this
 * lane simply stops being the one caller that did it differently.
 *
 * The roster is IMPORTED from `agent-role-contract.ts` rather than retyped, so a tool the
 * product grants or withdraws from a coding seat moves this lane with it. The MCP half of
 * `CODING_TOOLS` is deliberately absent: this seat writes code and exits, and the round is
 * submitted over the daemon's command edge by the lane, so granting it MCP would hand it a
 * board it has no business touching. `--strict-mcp-config` with no `--mcp-config` is what makes
 * that absence real rather than nominal -- without it the CLI would load the OPERATOR'S OWN MCP
 * servers, including a live moe.
 */
const SEAT_ARGV: readonly string[] = Object.freeze([
  "-p",
  // Production's isolation, restated flag for flag: no user/project/local settings (so no hooks
  // and no plugins), no slash commands, no session file, no MCP server at all.
  "--setting-sources", "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools", CODING_BUILTIN_TOOLS,
  "--allowedTools", CODING_BUILTIN_TOOLS,
]);

/**
 * The provider executable.
 *
 * `MOE_LIVE_PROOF_AGENT` overrides it so an operator can point this at `codex` or another CLI
 * without editing the lane; unset it resolves to `claude`, which is the daemon's own default
 * (`activation-command-entry.ts:73`). Resolved to an ABSOLUTE path by the caller when it can
 * be, because the launcher runs with `shell: false` and a bare name on Windows resolves
 * against a PATH the wrapper does not promise.
 */
export const providerExecutable = (): string =>
  process.env["MOE_LIVE_PROOF_AGENT"] ?? "claude";

/** What one seat is asked for: its node, its module, and the checks that judge it. */
export interface LiveSeatBrief {
  /** Repository-relative check files whose assertions this node's module must satisfy. */
  readonly checks: readonly string[];
  readonly nodeKey: string;
  /** The node's own objective, as the compiled plan states it. */
  readonly objective: string;
  /** Repository-relative path of the module this seat delivers. */
  readonly modulePath: string;
}

/**
 * The instruction that rides on top of the daemon's mission.
 *
 * IT NAMES CONSTRAINTS, NEVER CONTENT. The one file, the module format, the checks to run and
 * the prohibition on touching anything else are all facts about the WORKSPACE the lander is
 * about to commit -- a provider that wrote three files would have the other two committed
 * under this node's landing, and a provider that edited a check would be grading itself. No
 * line below describes an export name, a code, a signature or a behaviour: those live only in
 * the checks, which came from the browser-approved contract.
 */
export function seatInstruction(brief: LiveSeatBrief): string {
  return [
    "",
    "",
    "=== HOW THIS WORKSPACE EXPECTS YOUR WORK ===",
    `Write EXACTLY ONE file: ${brief.modulePath} (relative to your working directory).`,
    "It is an ES module (.mjs) run by plain Node directly, with no build step, no TypeScript",
    "and no installed dependencies: use only `export function` / `export const` and the Node",
    "standard library. Create its directory if it does not exist. The repository's existing",
    "package.json declares no dependencies and you must not add any.",
    "",
    "THE ACCEPTANCE CHECKS ARE THE CONTRACT, and they are already in this workspace:",
    ...brief.checks.map((check) => `  ${check}`),
    "Read every one of them. They import your module and assert against it, so they define the",
    "exact export names, arguments, return shapes and codes your module must produce. Run each",
    "one with `node <check>` from the working directory until it prints its VERIFIED line and",
    "exits 0. `node verify.mjs` must also exit 0.",
    "",
    "DO NOT create, edit, delete or move ANY other file -- not the checks, not verify.mjs, not",
    "another node's module, not a package.json, not a README. The daemon commits whatever",
    "changed in this repository under YOUR node's landing, and it re-runs the checks itself, so",
    "an edit to a check would be caught and a stray file would be attributed to you.",
    "Do not run git. Do not commit. Do not call any moe tool. Write the file, verify it, stop.",
  ].join("\n");
}

/**
 * Writes the launcher the wrapper spawns as `MOE_AGENT_COMMAND`, and returns its path.
 *
 * `rendezvous` names the nodes whose windows the concurrency clause is about; a node outside
 * that set records `peerSeen: false` and is not asked to observe anyone. Peers are OBSERVED,
 * never waited for: the repository delivery coordinator admits one checkout owner per
 * repository root, so a seat that blocked until its peer was also delivering would hold the
 * reservation its peer is refused on -- measured 2026-09-09 as REPOSITORY_EXECUTION_BUSY.
 */
export function liveProviderSeat(options: {
  readonly briefs: readonly LiveSeatBrief[];
  readonly dir: string;
  readonly executable: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly rendezvous: readonly string[];
  readonly workspace: string;
}): { readonly command: string; readonly executable: string } {
  const claims = options.briefs.map((brief) => ({
    brief,
    claim: landingSeatClaim(options.refs[brief.nodeKey] ?? ""),
    instruction: seatInstruction(brief),
    peers: options.rendezvous.includes(brief.nodeKey)
      ? options.rendezvous.filter((row) => row !== brief.nodeKey) : [],
    target: join(options.workspace, brief.modulePath).replaceAll("\\", "/"),
  }));
  const jsPath = join(options.dir, "live-proof-provider-seat.js");
  writeFileSync(jsPath, launcherSource({
    budgetMs: PROVIDER_SEAT_BUDGET_MS,
    claims,
    executable: options.executable,
    marks: options.dir.replaceAll("\\", "/"),
    workspace: options.workspace.replaceAll("\\", "/"),
  }), "utf8");
  const cmdPath = join(options.dir, "live-proof-provider-seat.cmd");
  const shPath = join(options.dir, "live-proof-provider-seat.sh");
  writeFileSync(cmdPath,
    `@echo off\r\n"${process.execPath}" "%~dp0live-proof-provider-seat.js"\r\nexit /b %ERRORLEVEL%\r\n`,
    "utf8");
  writeFileSync(shPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/live-proof-provider-seat.js"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return {
    command: process.platform === "win32" ? cmdPath : shPath,
    executable: options.executable,
  };
}

/**
 * The launcher's body, as CommonJS text.
 *
 * WRITTEN AS TEXT rather than compiled because the wrapper spawns an OS command, not a module,
 * and this lane must not depend on a build step running before the seat is staffed. Every
 * value the launcher needs is JSON-embedded, so it reads no configuration of its own beyond
 * the mission on stdin.
 */
function launcherSource(config: {
  readonly budgetMs: number;
  readonly claims: readonly unknown[];
  readonly executable: string;
  readonly marks: string;
  readonly workspace: string;
}): string {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawnSync } = require("node:child_process");',
    `const CLAIMS = ${JSON.stringify(config.claims)};`,
    `const MARKS = ${JSON.stringify(config.marks)};`,
    `const WORKSPACE = ${JSON.stringify(config.workspace)};`,
    `const AGENT = ${JSON.stringify(config.executable)};`,
    `const ARGV = ${JSON.stringify(SEAT_ARGV)};`,
    `const BUDGET_MS = ${String(config.budgetMs)};`,
    "const chunks = [];",
    'process.stdin.on("error", function () { process.exit(0); });',
    'process.stdin.on("data", function (chunk) { chunks.push(chunk); });',
    'process.stdin.on("end", function () {',
    '  const mission = Buffer.concat(chunks).toString("utf8");',
    "  const mine = CLAIMS.find(function (row) { return mission.indexOf(row.claim) !== -1; });",
    "  if (mine === undefined) process.exit(0);",
    "  const startedAt = Date.now();",
    "  const mark = function (suffix, body) {",
    '    fs.writeFileSync(path.join(MARKS, "seat-" + mine.brief.nodeKey + suffix), JSON.stringify(body));',
    "  };",
    "  mark(\".start\", { agent: AGENT, startedAt: startedAt });",
    "  const peerSeen = mine.peers.every(function (key) {",
    '    return fs.existsSync(path.join(MARKS, "seat-" + key + ".start"));',
    "  });",
    "  const before = fs.existsSync(mine.target);",
    "  const run = spawnSync(AGENT, ARGV, {",
    "    cwd: WORKSPACE, encoding: \"utf8\", input: mission + mine.instruction,",
    "    maxBuffer: 32 * 1024 * 1024, shell: false, timeout: BUDGET_MS, windowsHide: true,",
    "  });",
    '  const transcript = String(run.stdout || "") + String(run.stderr || "");',
    "  const wrote = fs.existsSync(mine.target)",
    '    && fs.readFileSync(mine.target, "utf8").trim().length > 0;',
    "  if (!wrote) {",
    '    process.stderr.write("SEAT_PROVIDER_WROTE_NOTHING node=" + mine.brief.nodeKey',
    '      + " agent=" + AGENT + " status=" + String(run.status) + " existedBefore=" + String(before)',
    '      + " tail=" + JSON.stringify(transcript.slice(-1500)) + "\\n");',
    '    mark(".end", { agent: AGENT, endedAt: Date.now(), ok: false, peerSeen: peerSeen,',
    "      providerStatus: run.status === undefined ? null : run.status, startedAt: startedAt,",
    "      transcriptTail: transcript.slice(-1500) });",
    "    process.exit(1);",
    "  }",
    '  mark(".end", { agent: AGENT, endedAt: Date.now(),',
    '    moduleBytes: fs.statSync(mine.target).size, ok: true, peerSeen: peerSeen,',
    "    providerStatus: run.status === undefined ? null : run.status, startedAt: startedAt,",
    "    transcriptTail: transcript.slice(-1500) });",
    "  process.exit(0);",
    "});",
    "",
  ].join("\n");
}
