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
/// THE SET. Every timing bound below is an expression off this one constant, so
/// the margins between them cannot drift apart if it ever moves again.
///
/// Deliberately far above anything a passing run needs, because the defect being
/// guarded against CANNOT return before the configured timeout by construction:
/// claude-launcher-lifecycle.ts races `boundary.completed` against
/// `ports.delay(limits.timeoutMs)`, so a completion the parent only sees once it
/// tears its endpoint down lands on the delay arm. Measured, the defect tracks
/// this constant ~1:1 (1000ms -> 1488ms, 2500ms -> 2996ms, 6000ms -> 6017ms)
/// against a child that lives 150ms. Raising it costs zero wall-clock — the
/// timeout is never reached on the green path — and every millisecond of it is
/// margin for the bound below. 6_000 was too low: it pinned the defect floor at
/// ~6s, so a bound at half of that went red on a CORRECT run measured at 3_637ms
/// under full-suite parallelism.
const LAUNCH_TIMEOUT_MS = 20_000;
/// The bound DoD 1 asks for: completion must be CHILD-driven, not timeout-driven.
///
/// EXACTLY HALF THE SET — computed, not written down, because that ratio IS the
/// discrimination margin. The defect waits the configured timeout out, so any
/// completion under half of it proves the child was observed. The two populations
/// at 20_000: correct behaviour 959ms and 993ms idle, 3_637ms under full-suite
/// parallelism (2.7x of load headroom below this bound), against a defect floor
/// at >= 20_000ms (2x of clearance above it). The low side is measurement; the
/// high side is the construction above, not a guess about host speed.
///
/// THE VERDICT ALONE WOULD NOT CATCH THE REGRESSION. A broker that still
/// eventually returns PROVEN, but only once the parent tears its endpoint down,
/// satisfies every `truthClass` assertion below. Latency is the only assertion
/// that can tell "the child was observed" from "the timeout was waited out".
const CHILD_DRIVEN_BOUND_MS = LAUNCH_TIMEOUT_MS / 2;
/// The hang guard, kept ABOVE the defect's expected latency on purpose: a
/// regression should fail on the latency bound with a readable number, not be
/// swallowed by a watchdog throw that says only "something took too long". It
/// must clear the timeout itself, since that is where the defect lands — a
/// watchdog left behind at a lower figure would swallow this case's whole point.
const WATCHDOG_MS = LAUNCH_TIMEOUT_MS + 10_000;
/// Last rung of the same ladder: vitest must not kill the case before the
/// watchdog throws, or the failure loses its message the same way.
const CASE_TIMEOUT_MS = WATCHDOG_MS + 15_000;
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
        renderedContext: "sealed context\n",
        contextManifestDigest: "ab".repeat(32),
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
      // The child really did outlive the 50ms control-poll slice, so the case is
      // exercising the scenario it is named for rather than a child that had
      // already exited before the first poll.
      expect(existsSync(elapsedReport)).toBe(true);
      expect(Number(readFileSync(elapsedReport, "utf8"))).toBeGreaterThanOrEqual(100);

      // DoD 1's second half. See CHILD_DRIVEN_BOUND_MS for why this bound.
      expect(totalElapsed).toBeLessThan(CHILD_DRIVEN_BOUND_MS);
      expect(totalElapsed).toBeLessThan(WATCHDOG_MS);
    } finally {
      rmSync(lockPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});
