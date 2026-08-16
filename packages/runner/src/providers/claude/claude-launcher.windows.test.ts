import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  activateEffect,
  buildProviderRuntimeObservation,
  launchClaude,
  type ClaudeLaunchRequest,
  type ClaudeLaunchSelection,
} from "@moe/runner";
import { createNodeClaudeRuntimeFs } from "./claude-runtime-pin.js";
import {
  makeActivationRequest,
  makeClaim,
  makeIntent,
} from "../../supervisor/effect-test-fixtures.js";

const MODEL = "claude-opus-5-20260514";
const EFFORT = "high";
const PROVIDER_DELAY_MS = 150;
const LAUNCH_TIMEOUT_MS = 1_000;
const WATCHDOG_MS = 3_000;
const WINDOWS_HOST = process.platform === "win32";
const WINDOWS_CASES = Object.freeze([
  Object.freeze({ name: "stays alive beyond the control poll slice", delayMs: PROVIDER_DELAY_MS }),
] as const);

const digestText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function beforeWatchdog<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PUBLIC_LAUNCH_WATCHDOG_${WATCHDOG_MS}MS`)), WATCHDOG_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function selection(): ClaudeLaunchSelection {
  return Object.freeze({
    provider: "claude",
    selectedModelId: MODEL,
    modelSnapshotKind: "DATED_SNAPSHOT",
    modelSnapshotEvidence: `${MODEL}/build-2026-05-14`,
    reasoningEffort: EFFORT,
    profileRevisionId: "profile-windows-control-poll-1",
    configurationDigest: "1c".repeat(32),
    policyDigest: "2d".repeat(32),
    orchestrationDigest: "3e".repeat(32),
    concurrencyCeiling: 1,
  });
}

it("declares exactly one real Windows control-poll conformance case", () => {
  expect(WINDOWS_CASES).toHaveLength(1);
  expect(WINDOWS_CASES.map((entry) => entry.name)).toEqual([
    "stays alive beyond the control poll slice",
  ]);
  expect(WINDOWS_CASES[0]?.delayMs).toBeGreaterThan(50);
});

describe.skipIf(!WINDOWS_HOST)("the public Windows Claude launcher", () => {
  it(WINDOWS_CASES[0].name, async () => {
    expect(process.platform).toBe("win32");
    expect(process.arch).toBe("x64");
    const root = mkdtempSync(join(tmpdir(), "moe-launch-control-poll-"));
    const installedRoot = join(root, "installed");
    const pinRoot = join(root, "pins");
    const executable = join(installedRoot, "claude.exe");
    const elapsedReport = join(root, "provider-elapsed.txt");
    const lockIdentity = `lock-control-poll-${process.pid}-${Date.now()}`;
    const lockPath = join(tmpdir(), "moe-claude-launch-locks", `${digestText(lockIdentity)}.lock`);
    mkdirSync(installedRoot, { recursive: true });
    copyFileSync(process.execPath, executable);

    try {
      const platformIdentity = Object.freeze({
        os: "win32",
        arch: process.arch,
        osVersion: release(),
      });
      const reportedVersion = process.version;
      const capabilityDigest = digestText("moe-windows-control-poll-capability/1");
      const built = buildProviderRuntimeObservation({
        resolvedRuntimeClosure: [{
          kind: "EXECUTABLE",
          path: executable,
          sha256: await digestFile(executable),
        }],
        reportedVersion,
        adapterCapabilitySchemaDigest: capabilityDigest,
        pinningMethod: "CONTENT_ADDRESSED_COPY",
        platformIdentity,
        clock: { observedAt: () => "2026-08-16T00:00:00.000Z" },
      });
      if (!built.ok) throw new Error(`${built.code}: ${built.message}`);

      const claim = makeClaim({ lockIdentity });
      const intent = makeIntent({
        runtimeObservationDigest: built.observation.observationDigest,
      });
      const activated = activateEffect(makeActivationRequest({
        intent,
        claim,
        lockIdentity,
        observedRuntimeDigest: built.observation.observationDigest,
      }));
      if (activated.kind !== "ACTIVATED") {
        throw new Error(`${activated.failure.layer}/${activated.failure.code}`);
      }

      const stdoutText = "moe-control-poll-stdout\n";
      const stderrText = "moe-control-poll-stderr\n";
      const script = [
        "const fs=require('node:fs');const started=Date.now();",
        `process.stdout.write(${JSON.stringify(stdoutText)});`,
        `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(elapsedReport)},String(Date.now()-started));`,
        `process.stderr.write(${JSON.stringify(stderrText)});},${WINDOWS_CASES[0].delayMs});`,
      ].join("");
      const request: ClaudeLaunchRequest = {
        runtime: {
          quotedObservation: built.observation,
          installedRoot,
          pinRoot,
          fs: createNodeClaudeRuntimeFs(),
          facts: { observe: async () => ({ platformIdentity, reportedVersion,
            adapterCapabilitySchemaDigest: capabilityDigest }) },
          clock: { observedAt: () => "2026-08-16T00:00:01.000Z" },
        },
        duplicateDelivery: null,
        effect: activated.commit.intent,
        attempt: activated.commit.attempt,
        grant: activated.commit.grant,
        claim,
        wrapperIdentity: claim.wrapperIdentity,
        bootstrapCredentialDigest: "ab".repeat(32),
        priorRegistration: null,
        argv: ["--eval", script, "--", "--model", MODEL, "--effort", EFFORT],
        cwd: installedRoot,
        environment: {
          SYSTEMROOT: process.env["SYSTEMROOT"] ?? "C:\\Windows",
          TEMP: process.env["TEMP"] ?? root,
          TMP: process.env["TMP"] ?? root,
        },
        reconciliation: null,
        limits: { stdoutBytes: 4_096, stderrBytes: 4_096, tailBytes: 256,
          timeoutMs: LAUNCH_TIMEOUT_MS },
        launchSelection: selection(),
      };

      const startedAt = performance.now();
      const result = await beforeWatchdog(launchClaude(request));
      const totalElapsed = performance.now() - startedAt;
      expect(result).toMatchObject({
        kind: "OBSERVED",
        ok: true,
        truthClass: "PROVEN",
        code: null,
        layer: null,
      });
      if (result.kind !== "OBSERVED") throw new Error("the public launcher did not observe a run");
      expect(result.observation).toMatchObject({
        truthClass: "PROVEN",
        reasonCode: null,
        reasonLayer: null,
        exit: { kind: "EXITED", code: 0 },
      });

      const stdout = Buffer.from(result.observation.stdout.capturedBase64, "base64");
      const stderr = Buffer.from(result.observation.stderr.capturedBase64, "base64");
      expect(stdout.toString("utf8")).toBe(stdoutText);
      expect(stderr.toString("utf8")).toBe(stderrText);
      expect(result.observation.stdout).toMatchObject({
        byteLength: Buffer.byteLength(stdoutText),
        sha256: digestText(stdoutText),
        complete: true,
        truncated: false,
      });
      expect(result.observation.stderr).toMatchObject({
        byteLength: Buffer.byteLength(stderrText),
        sha256: digestText(stderrText),
        complete: true,
        truncated: false,
      });
      expect(existsSync(elapsedReport)).toBe(true);
      expect(Number(readFileSync(elapsedReport, "utf8"))).toBeGreaterThanOrEqual(100);
      expect(totalElapsed).toBeLessThan(WATCHDOG_MS);
    } finally {
      rmSync(lockPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
