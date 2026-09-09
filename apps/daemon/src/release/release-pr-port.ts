import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseHead } from "./release-head-proof.js";

/**
 * Opening the proof-carrying pull request, through the `gh` CLI and nothing else.
 *
 * gh ONLY — no token path and no REST fallback (task rail 1). A per-goal API token is
 * secret handling, which this row's FEATURES ONLY rail puts out of scope, and the
 * operator's machine already holds the git credentials the publisher pushes with, so
 * `gh` inherits an auth story that exists instead of inventing a second one. `gh` absent
 * or unauthenticated REFUSES cleanly, carrying whatever the tool actually said.
 *
 * The port is an interface with an injected `spawn`, so every arm below is testable
 * OFFLINE — no network, no `gh` on the box, no GitHub account.
 */

export interface ReleasePrRequest {
  readonly remoteUrl: string;
  readonly sha: string;
  readonly base: string;
  readonly body: string;
  readonly head: string;
  readonly title: string;
}

export type ReleasePrResult =
  | Readonly<{ readonly ok: true; readonly prUrl: string }>
  | Readonly<{
    readonly ok: false;
    /** The OS error code when the process never started (`ENOENT` = no gh), else null. */
    readonly spawnErrorCode: string | null;
    readonly stderrLastLine: string;
  }>;

export interface ReleasePrPort {
  open(request: ReleasePrRequest): Promise<ReleasePrResult>;
}

export type SpawnGhProcess = (
  command: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess;

export interface GhReleasePrPortConfig {
  readonly verifyHead?: (request: ReleasePrRequest) => Promise<boolean>;
  readonly cwd: string;
  readonly spawn?: SpawnGhProcess;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Enough stderr to find the real last line, bounded so a chatty failure cannot grow forever. */
const STDERR_TAIL_LIMIT = 8_192;

/**
 * The executable is the BARE NAME. Windows `CreateProcess` appends `.exe` for an
 * extension-less name, so hard-coding `gh.exe` breaks posix and `gh.cmd` breaks both.
 * `shell: false` throughout: a shell would re-parse the title and body path, and a goal
 * title is operator-supplied text.
 */
export const GH_EXECUTABLE = "gh" as const;

/**
 * The argv, exported so a test can assert it BYTE FOR BYTE rather than re-deriving the
 * recipe it is supposed to be checking. Identical on win32 and posix — nothing here
 * reads the platform.
 */
export function ghPrArgv(
  request: ReleasePrRequest, bodyFile: string,
): readonly string[] {
  return [
    "pr", "create",
    "--repo", request.remoteUrl,
    "--base", request.base,
    "--head", request.head,
    "--title", request.title,
    "--body-file", bodyFile,
  ];
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function refusal(stderr: string, spawnErrorCode: string | null): Extract<ReleasePrResult, { ok: false }> {
  return { ok: false, spawnErrorCode, stderrLastLine: lastNonEmptyLine(stderr) };
}

type GhOutput = Readonly<{ ok: true; output: string }> | Extract<ReleasePrResult, { ok: false }>;

/**
 * One `gh pr create`. Never rejects: every failure mode — the process not starting, a
 * non-zero exit, a timeout — resolves to an `ok:false` the caller can put in a refusal
 * detail. A port that threw would make "the PR did not open" indistinguishable from a
 * bug in this module at the call site.
 */
function runGh(
  spawn: SpawnGhProcess, cwd: string, timeoutMs: number, argv: readonly string[],
): Promise<GhOutput> {
  return new Promise<GhOutput>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GhOutput): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(GH_EXECUTABLE, argv, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A synchronous spawn throw has no stderr to quote, and no child to kill.
      finish(refusal("", errorCodeOf(error)));
      return;
    }

    const killBestEffort = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };

    timer = setTimeout(() => {
      killBestEffort();
      finish(refusal(stderr, null));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: unknown) => { stdout = (stdout + String(chunk)).slice(-65_536); });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_LIMIT);
    });
    // `gh` absent surfaces as an `error` event with code ENOENT and NO stderr at all;
    // `lastNonEmptyLine("")` is "", so the caller still gets something true to say.
    child.on("error", (error: unknown) => {
      killBestEffort();
      finish(refusal(stderr, errorCodeOf(error)));
    });
    child.on("close", (code: number | null) => {
      const output = stdout.trim();
      if (code === 0 && output.length > 0) {
        finish({ ok: true, output });
        return;
      }
      finish(refusal(stderr, null));
    });
  });
}

/**
 * THE BODY GOES IN A TEMP FILE, never in argv. A dossier is multi-kilobyte markdown and
 * Windows caps a command line at 32767 characters, so an argv body would truncate the
 * evidence SILENTLY — the PR would open, look fine, and carry half a proof.
 *
 * The directory is removed in a `finally` on every exit path, including timeout, spawn
 * error and an exception from the write itself.
 */
export function createGhReleasePrPort(config: GhReleasePrPortConfig): ReleasePrPort {
  const spawn = config.spawn ?? (nodeSpawn as SpawnGhProcess);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async open(request: ReleasePrRequest): Promise<ReleasePrResult> {
      let directory: string | null = null;
      try {
        const proven = await (config.verifyHead === undefined
          ? verifyReleaseHead(config.cwd, request) : config.verifyHead(request));
        if (!proven) return refusal("RELEASE_HEAD_CHANGED", null);
        directory = await mkdtemp(join(tmpdir(), "moe-release-pr-"));
        const bodyFile = join(directory, "body.md");
        await writeFile(bodyFile, request.body, "utf8");
        const created = await runGh(spawn, config.cwd, timeoutMs, ghPrArgv(request, bodyFile));
        if (!created.ok) return created;
        const prUrl = lastNonEmptyLine(created.output);
        if (!/^https:\/\/[^\s]+\/pull\/\d+$/u.test(prUrl)) return refusal("RELEASE_PR_URL_INVALID", null);
        // The publisher's mutable branch can move after ls-remote. Measure the actual
        // created PR before recording a receipt that claims it carries the approved SHA.
        const viewed = await runGh(spawn, config.cwd, timeoutMs, ["pr", "view", prUrl,
          "--repo", request.remoteUrl, "--json", "url,headRefOid,headRefName,baseRefName,state"]);
        if (!viewed.ok) return refusal(`RELEASE_PR_HEAD_UNPROVEN: ${prUrl}`, viewed.spawnErrorCode);
        let proof: unknown;
        try { proof = JSON.parse(viewed.output); }
        catch { return refusal(`RELEASE_PR_HEAD_UNPROVEN: ${prUrl}`, null); }
        if (typeof proof !== "object" || proof === null
          || !("headRefOid" in proof) || proof.headRefOid !== request.sha
          || !("headRefName" in proof) || proof.headRefName !== request.head
          || !("baseRefName" in proof) || proof.baseRefName !== request.base
          || !("url" in proof) || proof.url !== prUrl
          || !("state" in proof) || proof.state !== "OPEN") {
          return refusal(`RELEASE_PR_HEAD_CHANGED: ${prUrl}`, null);
        }
        return { ok: true, prUrl };
      } catch (error) {
        return refusal("", errorCodeOf(error));
      } finally {
        if (directory !== null) {
          await rm(directory, { force: true, recursive: true }).catch(() => undefined);
        }
      }
    },
  };
}
