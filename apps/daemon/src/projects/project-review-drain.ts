import { spawn } from "node:child_process";
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
const refusal = (code: string) => ({ ok: false as const, code, detail: DETAILS[code] ?? DETAILS[UNKNOWN]! });
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

export function createProjectReviewDrainPort(): RepositoryReviewDrainPort {
  return { async drain(input) {
    if (!pid(input.controllerPid) || !timestamp(input.notStartedAfter) || typeof input.workspace !== "string"
      || !win32.isAbsolute(input.workspace) || input.workspace.startsWith("\\\\") || input.workspace.includes("\0")) return refusal(IDENTITY);
    if (process.platform !== "win32") return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
    const executable = powershell();
    if (executable === null) return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
    const script = Buffer.from(PROJECT_REVIEW_DRAIN_SCRIPT, "utf16le").toString("base64");
    if (script.length > 30_000) return refusal("RUNTIME_REVIEW_DRAIN_UNAVAILABLE");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
      windowsHide: true, stdio: "pipe", env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    });
    let ended = false; let closeRequested = false; let closeConfirmed = false; let output = ""; let outputSize = 0;
    let finish!: (value: ReturnType<typeof decodeProjectReviewDrainFrame>) => void;
    const first = new Promise<ReturnType<typeof decodeProjectReviewDrainFrame>>((done) => { finish = done; });
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
          else finish(decodeProjectReviewDrainFrame(value, input));
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
    const timeout = setTimeout(() => { finish(null); }, 35_000);
    child.stdin.write(`${JSON.stringify({ input, nativeSource: PROJECT_REVIEW_DRAIN_NATIVE })}\n`);
    const frame = await first; clearTimeout(timeout);
    if (frame === null || !frame.ok || ended) { await close(); return frame?.ok === false ? frame : refusal(UNKNOWN); }
    return { ok: true, evidence: frame.evidence, close: async () => { await close(); if (!closeConfirmed) throw new Error(UNKNOWN); } };
  } };
}
