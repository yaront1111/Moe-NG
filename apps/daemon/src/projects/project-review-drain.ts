import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import type { RepositoryReviewDrainPort } from "../repository/repository-review-drain-contracts.js";
import { PROJECT_REVIEW_DRAIN_SCRIPT } from "./project-review-drain-script.js";
import { PROJECT_REVIEW_DRAIN_NATIVE } from "./project-review-drain-native.js";

const IDENTITY = "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH";
const UNKNOWN = "RUNTIME_REVIEW_DRAIN_UNPROVEN";
const DETAILS: Readonly<Record<string, string>> = Object.freeze({
  RUNTIME_REVIEW_DRAIN_UNAVAILABLE: "The Windows Job drain observer is unavailable.",
  RUNTIME_REVIEW_DRAIN_ACCESS_DENIED: "Windows denied access to the original runtime process or Job handle.",
  [IDENTITY]: "The original runtime process and Job identity could not be established.",
  [UNKNOWN]: "The original runtime Job was not proven empty.",
});
/** Which proof failed when the Job was not proven empty (addendum 2026-09-15). Words, never authority. */
const REASONS: Readonly<Record<string, string>> = Object.freeze({
  JOB_ACTIVE: "The Job still reported active processes after 20 seconds.",
  CLI_ALIVE: "The original moe command had not exited.",
  BROKER_ALIVE: "The Windows job broker had not exited.",
  DAEMON_ALIVE: "The project daemon had not exited.",
  CONTROLLER_ALIVE: "The agent wrapper had not exited.",
  INPUT_CLOSED: "The caller closed the observer before the drain finished.",
});
const refusal = (code: string) => ({ ok: false as const, code, detail: DETAILS[code] ?? DETAILS[UNKNOWN]! });
/** Starting Windows PowerShell and compiling the observer. Nothing is stopped before it ends. */
const READY_TIMEOUT_MS = 120_000;
/** The drain proof itself, counted from the go signal; the observer's own loop allows 20 s. */
const DRAIN_TIMEOUT_MS = 35_000;
const pid = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));

/** Resolve a standard existing absolute PowerShell executable; never accept caller command text. */
function powershell(): string | null {
  const root = process.env["SystemRoot"];
  if (root === undefined || !win32.isAbsolute(root)) return null;
  try {
    const path = realpathSync(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    return win32.isAbsolute(path) && statSync(path).isFile() ? path : null;
  } catch { return null; }
}

export function decodeProjectReviewDrainFrame(value: unknown, input: { controllerPid: number; notStartedAfter: string }):
  null | { ok: false; code: string; detail: string } | { ok: true; evidence: import("../repository/repository-review-drain-contracts.js").RepositoryReviewDrainEvidence } {
  const exact = (item: unknown, keys: readonly string[]): item is Record<string, unknown> => typeof item === "object" && item !== null
    && !Array.isArray(item) && Object.keys(item).length === keys.length && keys.every((key) => Object.hasOwn(item, key));
  if (exact(value, ["ok", "code"]) && value["ok"] === false && typeof value["code"] === "string" && Object.hasOwn(DETAILS, value["code"])) {
    return refusal(value["code"]);
  }
  if (exact(value, ["ok", "code", "reason"]) && value["ok"] === false && typeof value["code"] === "string"
    && Object.hasOwn(DETAILS, value["code"]) && typeof value["reason"] === "string" && Object.hasOwn(REASONS, value["reason"])) {
    return { ok: false, code: value["code"], detail: `${DETAILS[value["code"]]!} ${REASONS[value["reason"]]!}` };
  }
  if (!exact(value, ["ok", "evidence"]) || value["ok"] !== true) return null;
  const evidence = value["evidence"];
  if (!exact(evidence, ["controllerPid", "controllerStartedAt", "brokerPid", "brokerStartedAt", "cliPid", "daemonPid", "observedAt", "jobEmpty"])) return null;
  const { controllerPid, controllerStartedAt, brokerPid, brokerStartedAt, cliPid, daemonPid, observedAt, jobEmpty } = evidence;
  if (!pid(controllerPid) || controllerPid !== input.controllerPid || !pid(brokerPid) || !pid(cliPid) || !pid(daemonPid)
    || new Set([controllerPid, brokerPid, cliPid, daemonPid]).size !== 4 || jobEmpty !== true
    || !timestamp(controllerStartedAt) || !timestamp(brokerStartedAt) || !timestamp(observedAt)
    || controllerStartedAt > input.notStartedAfter || brokerStartedAt > controllerStartedAt || observedAt < input.notStartedAfter) return null;
  return { ok: true, evidence: { controllerPid, controllerStartedAt, brokerPid, brokerStartedAt, cliPid, daemonPid, observedAt, jobEmpty } };
}

export interface ProjectReviewDrainOptions {
  readonly readyTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  /** Test seam: an observer process speaking the same wire. Production launches Windows PowerShell. */
  readonly launchObserver?: () => ChildProcessWithoutNullStreams;
}

/**
 * The observer's start and the drain have separate budgets (addendum 2026-09-15). Measured on
 * windows-latest: starting Windows PowerShell and compiling the observer took 10 s to over 35 s
 * under load, so one 35 s budget for both refused every drain as "not proven empty" although
 * nothing had been drained. The observer announces `{"ready":true}` after its compile and stops
 * nothing until it reads DRAIN, which is sent only while the start is inside its budget: a start
 * that runs late is refused UNAVAILABLE and provably stopped nothing.
 */
export function createProjectReviewDrainPort(options: ProjectReviewDrainOptions = {}): RepositoryReviewDrainPort {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const lateStart = Object.freeze({ ok: false as const, code: "RUNTIME_REVIEW_DRAIN_UNAVAILABLE",
    detail: `The Windows Job drain observer did not start within ${String(Math.max(1, Math.round(readyTimeoutMs / 1000)))} s; nothing was stopped.` });
  return { async drain(input) {
    if (!pid(input.controllerPid) || !timestamp(input.notStartedAfter) || typeof input.workspace !== "string"
      || !win32.isAbsolute(input.workspace) || input.workspace.startsWith("\\\\") || input.workspace.includes("\0")) return refusal(IDENTITY);
    let child: ChildProcessWithoutNullStreams;
    if (options.launchObserver !== undefined) child = options.launchObserver();
    else {
      if (process.platform !== "win32") return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
      const executable = powershell();
      if (executable === null) return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
      const script = Buffer.from(PROJECT_REVIEW_DRAIN_SCRIPT, "utf16le").toString("base64");
      if (script.length > 30_000) return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
      child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
        windowsHide: true, stdio: "pipe", env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
          .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      });
    }
    let ended = false; let closeRequested = false; let closeConfirmed = false; let output = ""; let outputSize = 0;
    let ready = false; let settled = false; let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveFirst!: (value: ReturnType<typeof decodeProjectReviewDrainFrame> | typeof lateStart) => void;
    const first = new Promise<ReturnType<typeof decodeProjectReviewDrainFrame> | typeof lateStart>((done) => { resolveFirst = done; });
    const finish = (value: ReturnType<typeof decodeProjectReviewDrainFrame> | typeof lateStart): void => {
      if (!settled) { settled = true; resolveFirst(value); }
    };
    const readyTimer = setTimeout(() => { if (!ready) finish(lateStart); }, readyTimeoutMs);
    const closed = new Promise<void>((done) => { child.once("close", () => { ended = true; finish(null); done(); }); });
    child.on("error", () => { finish(null); });
    child.stdin.on("error", () => { finish(null); });
    child.stderr.on("data", () => { /* Drain diagnostic output without exposing source, paths or caller data. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.byteLength;
      if (outputSize > 16_384) { finish(null); child.kill(); return; }
      output += chunk.toString("utf8");
      while (output.includes("\n")) {
        const end = output.indexOf("\n"); const line = output.slice(0, end).trim(); output = output.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (closeRequested && JSON.stringify(value) === '{"closed":true}') closeConfirmed = true;
          else if (!ready && JSON.stringify(value) === '{"ready":true}') {
            ready = true; clearTimeout(readyTimer);
            // A start that already ran past its budget is never told to drain.
            if (!settled && !closeRequested) {
              child.stdin.write("DRAIN\n");
              drainTimer = setTimeout(() => { finish(null); }, drainTimeoutMs);
            }
          } else finish(decodeProjectReviewDrainFrame(value, input));
        } catch { finish(null); }
      }
    });
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      closeRequested = true;
      if (!ended) child.stdin.end("CLOSE\n");
      const kill = setTimeout(() => { child.kill(); }, 2_000);
      try { await closed; } finally { clearTimeout(kill); }
    })();
    child.stdin.write(`${JSON.stringify({ input, nativeSource: PROJECT_REVIEW_DRAIN_NATIVE })}\n`);
    const frame = await first; clearTimeout(readyTimer); if (drainTimer !== undefined) clearTimeout(drainTimer);
    if (frame === null || !frame.ok || ended) { await close(); return frame?.ok === false ? frame : refusal(UNKNOWN); }
    return { ok: true, evidence: frame.evidence, close: async () => { await close(); if (!closeConfirmed) throw new Error(UNKNOWN); } };
  } };
}
