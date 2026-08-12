import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll } from "vitest";

import { canonicalDigest } from "../../canonical.js";
import {
  type WindowsProcessBoundary,
} from "../../platform/windows/windows-boundary.js";
import {
  type WindowsProcessOutcome,
  type WindowsProcessUnknown,
} from "../../platform/windows/windows-process-contract.js";
import { activateEffect } from "../../supervisor/effect-activation.js";
import { consumeActivationGrant, validateActivationCommit } from "../../supervisor/effect-grant.js";
import { makeActivationRequest, makeClaim } from "../../supervisor/effect-test-fixtures.js";
import { registerLaunchLock } from "../../supervisor/launch-lock.js";
import { resolveDuplicateDelivery } from "../../supervisor/duplicate-delivery.js";
import { intakeProcessObservation } from "../../supervisor/process-observation.js";
import {
  buildProviderRuntimeObservation,
} from "./claude-observation.js";
import {
  createNodeClaudeRuntimeFs,
  prepareClaudeRuntimePin,
  type ClaudeRuntimePinRequest,
  type PreparedClaudeRuntime,
} from "./claude-runtime-pin.js";
import {
  type ClaudeLaunchRequest,
  type ClaudeLaunchResult,
  type ClaudeLauncherDependencies,
} from "./claude-launcher.js";

export const DIGEST = "ab".repeat(32);
export const PROCESS = Object.freeze({ pid: 4242, creationTime: 134309515541692727n });
export const PROVEN: WindowsProcessOutcome = Object.freeze({
  truthClass: "PROVEN", identity: PROCESS, exitCode: 0,
});
const COMMIT_RESULT = activateEffect(makeActivationRequest());
if (COMMIT_RESULT.kind !== "ACTIVATED") throw new Error("production activation fixture refused");
export const COMMIT = COMMIT_RESULT.commit;
export const CLAIM = makeClaim();

let tempRoot = "";
export let runtimeRequest: ClaudeRuntimePinRequest;
export let prepared: PreparedClaudeRuntime;

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "moe-launcher-")));
  const installedRoot = join(tempRoot, "Claude");
  const executable = join(installedRoot, "claude.exe");
  mkdirSync(installedRoot, { recursive: true });
  writeFileSync(executable, "MZ-claude-launcher-test");
  const observation = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: executable, sha256: sha256("MZ-claude-launcher-test") }],
    reportedVersion: "claude-cli/1.2.3",
    adapterCapabilitySchemaDigest: canonicalDigest({ schema: "claude-capability/1" }),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: { observedAt: () => "2026-08-12T08:00:00.000Z" },
  });
  if (!observation.ok) throw new Error(`production quote fixture refused: ${observation.code}`);
  runtimeRequest = {
    quotedObservation: observation.observation,
    installedRoot,
    pinRoot: join(tempRoot, "pins"),
    fs: createNodeClaudeRuntimeFs(),
    facts: { observe: async () => ({
      platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
      reportedVersion: "claude-cli/1.2.3",
      adapterCapabilitySchemaDigest: canonicalDigest({ schema: "claude-capability/1" }),
    }) },
    clock: { observedAt: () => "2026-08-12T08:00:01.000Z" },
  };
  const pinned = await prepareClaudeRuntimePin(runtimeRequest);
  if (!pinned.ok) throw new Error(`production runtime fixture refused: ${pinned.code}`);
  prepared = pinned;
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

export interface BoundaryHarness {
  readonly boundary: WindowsProcessBoundary;
  readonly log: string[];
  readonly requests: unknown[];
  trigger(): void;
}

export function boundaryHarness(options: {
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly started?: Promise<typeof PROCESS | WindowsProcessUnknown>;
  readonly completed?: Promise<WindowsProcessOutcome>;
  readonly closeOutcome?: WindowsProcessOutcome;
  readonly streamError?: "stdout" | "stderr";
  readonly stderrFirst?: boolean;
} = {}): BoundaryHarness {
  const log: string[] = [];
  const requests: unknown[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const finish = (stream: PassThrough, bytes: Uint8Array, fail: boolean): void => {
    if (fail) stream.destroy(new Error("scripted stream failure"));
    else stream.end(bytes);
  };
  return {
    log,
    requests,
    trigger: () => queueMicrotask(() => {
      const writes = [
        () => finish(stdout, options.stdout ?? Buffer.from("stdout"), options.streamError === "stdout"),
        () => finish(stderr, options.stderr ?? Buffer.from("stderr"), options.streamError === "stderr"),
      ];
      for (const write of options.stderrFirst === true ? writes.reverse() : writes) write();
    }),
    boundary: {
      started: options.started ?? Promise.resolve(PROCESS),
      completed: options.completed ?? Promise.resolve(PROVEN),
      providerStdin: stdin,
      providerStdout: stdout,
      providerStderr: stderr,
      cancel: () => log.push("cancel"),
      close: async () => {
        log.push("close");
        if (!stdout.destroyed && !stdout.writableEnded) stdout.end();
        if (!stderr.destroyed && !stderr.writableEnded) stderr.end();
        stdin.end();
        return options.closeOutcome ?? PROVEN;
      },
    },
  };
}

export function dependencies(harness: BoundaryHarness, log: string[]): ClaudeLauncherDependencies {
  let tick = 0;
  return {
    prepareRuntime: async () => { log.push("runtime"); return prepared; },
    resolveDuplicate: (value) => { log.push("duplicate"); return resolveDuplicateDelivery(value); },
    validateCommit: (effect, attempt, grant) => {
      log.push("validate"); return validateActivationCommit(effect, attempt, grant);
    },
    consumeGrant: (grant, wrapper) => { log.push("consume"); return consumeActivationGrant(grant, wrapper); },
    openBoundary: (request) => {
      log.push("open"); harness.requests.push(request); harness.trigger(); return harness.boundary;
    },
    registerLock: (registration, claim, prior) => {
      log.push("register"); return registerLaunchLock(registration, claim, prior);
    },
    observeProcess: (exit, reconciliation) => {
      log.push("observe"); return intakeProcessObservation(exit, reconciliation);
    },
    now: () => `2026-08-12T08:00:0${tick++}.000Z`,
    delay: async () => await new Promise<void>(() => undefined),
  };
}

export function request(overrides: Partial<ClaudeLaunchRequest> = {}): ClaudeLaunchRequest {
  return {
    runtime: runtimeRequest,
    duplicateDelivery: null,
    effect: COMMIT.intent,
    attempt: COMMIT.attempt,
    grant: COMMIT.grant,
    claim: CLAIM,
    wrapperIdentity: CLAIM.wrapperIdentity,
    bootstrapCredentialDigest: DIGEST,
    priorRegistration: null,
    argv: ["--print", "hello"],
    cwd: "C:\\work",
    environment: { SYSTEMROOT: "C:\\Windows", LANG: "en_US.UTF-8" },
    reconciliation: null,
    limits: { stdoutBytes: 64, stderrBytes: 64, tailBytes: 4, timeoutMs: 1_000 },
    ...overrides,
  };
}

export function failureOf(result: ClaudeLaunchResult): { code: string; layer: string } {
  if (result.truthClass === "PROVEN") throw new Error(`expected failure, received ${result.kind}`);
  if (result.code === null || result.layer === null) throw new Error("failure omitted code or layer");
  return { code: result.code, layer: result.layer };
}

