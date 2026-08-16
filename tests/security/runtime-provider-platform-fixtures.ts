/**
 * HOSTILE FIXTURES for the platform group of the runtime-provider axis.
 *
 * NOT a `*.security.ts` file: the lane collects that suffix and a fixture module registering
 * as a suite with no cases would fail `passWithNoTests: false`.
 *
 * IT DECIDES NOTHING. It builds hostile INPUTS and injectable ports; every expected code and
 * layer is written at the case, taken from the boundary's own exported constant. The ports
 * below throw on any call the gate under test must not reach, so a fixture that got further
 * than intended fails loudly instead of passing quietly.
 */

import { PassThrough } from "node:stream";

import { expect } from "vitest";

import { canonicalDigest } from "../../packages/runner/src/canonical.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  observationDigestInput,
} from "../../packages/runner/src/providers/claude/claude-observation.js";
import type {
  ProviderRuntimeObservation,
  RuntimeClosureEntry,
} from "../../packages/runner/src/providers/claude/claude-observation.js";
import type {
  ClaudeRuntimeFactsPort,
  ClaudeRuntimePinRequest,
} from "../../packages/runner/src/providers/claude/claude-runtime-pin.js";
import type { ClaudeRuntimeFsPort } from "../../packages/runner/src/providers/claude/claude-runtime-pin-fs.js";
import {
  PLATFORM_BOUNDARIES,
  PLATFORM_LAYERS,
} from "../../packages/runner/src/platform/platform-contract.js";
import type { PlatformObservation } from "../../packages/runner/src/platform/platform-contract.js";
import type { WindowsBoundaryDeps } from "../../packages/runner/src/platform/windows/windows-boundary.js";
import type { BrokerPipes } from "../../packages/runner/src/platform/windows/windows-broker-process.js";
import { WINDOWS_PROCESS_LAYERS } from "../../packages/runner/src/platform/windows/windows-process-contract.js";
import type { LegOutcome, RefusalExpectation } from "./hostile-harness.js";
import { hostile, layerOf } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";

/** Resolved off the boundaries' OWN declared constants, so a layer that stops being declared
 *  there reddens at import rather than surviving as a string literal nobody rechecks. */
export const CONTRACT_LAYER = layerOf(PLATFORM_LAYERS, "PLATFORM_CONTRACT");
export const WINDOWS_REQUEST = layerOf(WINDOWS_PROCESS_LAYERS, "WINDOWS_PROCESS_REQUEST");
export const WINDOWS_TRANSPORT = layerOf(WINDOWS_PROCESS_LAYERS, "WINDOWS_PROCESS_TRANSPORT");

/** A settled race leg's value as the observation it is, or null if the leg rejected. */
export const seen = (side: { status: string; value?: unknown }): PlatformObservation | null =>
  side.status === "fulfilled" ? (side.value as PlatformObservation) : null;

/**
 * Record ONE side of a race whose value is a platform observation. Per side, never aggregated:
 * an assertion over a race as a whole can hide a double admit, the one defect a race case
 * exists to find. `boundaryName` picks a specific verdict; omitted, the first is read.
 */
export function refusedObservation(
  ledger: Ledger,
  boundary: string,
  side: LegOutcome<unknown>,
  expected: RefusalExpectation,
  boundaryName?: string,
): void {
  expect(side.status).toBe("fulfilled");
  const observed = seen(side);
  const failure =
    boundaryName === undefined ? firstFailure(observed) : failureFor(observed, boundaryName);
  ledger.refusedSide(boundary, { status: "fulfilled", value: failure }, expected);
}

/** Hostile values reused across cases and re-checked by the message-hygiene property, so a
 *  refusal that echoed one back is caught by name rather than by eye. */
export const FORGED_PATH = "C:\\Users\\forged\\.local\\bin\\claude.exe";
export const FORGED_DIGEST = "f".repeat(64);
/** The executable a drifting runtime was swapped FOR. Distinct in both path and digest from the
 *  observed pair above, so the swap changes the digest input rather than merely relabelling it. */
export const SWAPPED_PATH = "C:\\Users\\forged\\.local\\bin\\claude-swapped.exe";
export const SWAPPED_DIGEST = "a".repeat(64);
export const PLATFORM_SECRETS: readonly string[] = Object.freeze([
  FORGED_PATH,
  FORGED_DIGEST,
  SWAPPED_PATH,
  SWAPPED_DIGEST,
]);

/** Reads the failure off the first verdict. Every refusal path in this contract refuses EVERY
 *  boundary, so verdict zero is representative — and the count is asserted, not assumed. */
export function firstFailure(observed: PlatformObservation | null): unknown {
  expect(observed).not.toBeNull();
  expect(observed?.verdicts).toHaveLength(PLATFORM_BOUNDARIES.length);
  expect(observed?.truthClass).toBe("UNKNOWN");
  return observed?.verdicts[0]?.failure;
}

/** Reads the failure for ONE named boundary, so a per-boundary verdict can be pinned. */
export function failureFor(observed: PlatformObservation | null, boundary: string): unknown {
  return observed?.verdicts.find((verdict) => verdict.boundary === boundary)?.failure;
}

/** Every boundary present with an explicit `null`: "I did not observe this" stated, not
 *  omitted. A MISSING key is a coverage gap the adapter refuses differently. */
export const emptyFacts = (): Record<string, unknown> =>
  Object.fromEntries(PLATFORM_BOUNDARIES.map((boundary) => [boundary, null]));

export const onHost = (os: string): Record<string, unknown> => ({
  host: { arch: "x64", os, osVersion: "hostile" },
  asOf: "2026-08-16T00:00:00.000Z",
  maxFactAgeMs: 60_000,
  facts: emptyFacts(),
});

/** A well-formed launch request. Cases mutate ONE field so the gates above the one under test
 *  cannot answer first — gate order here is executable, argv, cwd, environment, then size. */
export const GOOD_LAUNCH = Object.freeze({
  executable: "C:\\broker\\provider.exe",
  argv: Object.freeze(["--version"]),
  cwd: "C:\\work",
  environment: Object.freeze({ PATH: "C:\\Windows" }),
});

/**
 * A broker that NEVER emits a status frame and exits only when the boundary cancels it: the
 * never-terminating provider, driven through the REAL production session rather than mocked
 * around it. `calls` records everything, so a case can assert what was NOT done — the only
 * way to prove "no process was created".
 */
export function silentBroker(calls: string[]): WindowsBoundaryDeps {
  let onExit: ((code: number | null, signal: string | null) => void) | null = null;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const pipes: BrokerPipes = {
    pid: 4242,
    providerStdin: stdin,
    providerStdout: stdout,
    providerStderr: stderr,
    writeControl: (bytes) => calls.push(`writeControl:${bytes.length}`),
    endControl: () => {
      calls.push("endControl");
      // Cancellation is what this provider answers. A provider that ignored it would hit the
      // outer kill timer instead, which is why every case here also carries a bound.
      onExit?.(null, null);
    },
    closeProviderChannels: () => {
      stdin.end();
      stdout.destroy();
      stderr.destroy();
    },
    onStatus: () => undefined,
    onExit: (listener) => {
      onExit = listener;
    },
    onError: () => undefined,
    kill: () => calls.push("kill"),
    dispose: () => calls.push("dispose"),
  };
  return {
    platform: "win32",
    resolveBroker: () => {
      calls.push("resolveBroker");
      return "C:\\broker\\moe-windows-job-broker.exe";
    },
    spawn: (executable) => {
      calls.push(`spawn:${executable}`);
      return pipes;
    },
  };
}

/** Only `hostPlatform` is ever reached: the quote gate sits above every other port call, so a
 *  fixture that got further throws here rather than passing quietly. */
export function pinRequest(platform: string, quote: unknown): ClaudeRuntimePinRequest {
  return hostile<ClaudeRuntimePinRequest>({
    quotedObservation: quote,
    installedRoot: FORGED_PATH,
    pinRoot: FORGED_PATH,
    fs: hostile<ClaudeRuntimeFsPort>({
      hostPlatform: () => platform,
      realpath: () => {
        throw new Error("no filesystem port call may be reached past the quote gate");
      },
    }),
    facts: hostile<ClaudeRuntimeFactsPort>({
      observe: () => {
        throw new Error("no facts port call may be reached past the quote gate");
      },
    }),
    clock: () => "2026-08-16T00:00:00.000Z",
  });
}

/**
 * THE SEVEN-GUARD PROBLEM, and why the two quote fixtures below are built differently.
 *
 * `readQuote` (claude-runtime-pin-closure.ts:105-146) returns
 * `CLAUDE_RUNTIME_QUOTE_INVALID` at the `RUNTIME` layer from SEVEN distinct branches. A case
 * pinning only that code and that layer therefore cannot say WHICH guard answered, and a
 * mutation deleting the drift comparison at :116 survives it — the quote simply refuses one
 * guard later, or not at all, and the assertion stays green. The message is the only stable
 * discriminator production exposes today, so both fixtures are paired with the exact message
 * their intended branch returns (see `QUOTE_MESSAGES`) and asserted through `refusedExactly`.
 */
export const QUOTE_MESSAGES = Object.freeze({
  /** claude-runtime-pin-closure.ts:114 — the digest could not even be recomputed. */
  notCanonicalisable: "quoted observation is not canonicalisable",
  /** claude-runtime-pin-closure.ts:117 — the drift branch. THE ONE this slice must reach. */
  drifted: "quoted digest does not cover its own fields",
  /** claude-runtime-pin-closure.ts:107 — not a record at all. */
  notARecord: "quoted observation is not a record",
});

/** Builds a FULLY-FORMED observation whose digest genuinely covers its own fields, using
 *  production's own `observationDigestInput` rather than a hand-authored hash — a hand-authored
 *  digest on both sides of a comparison is a tautology, and one taken over a different field
 *  list would refuse for the wrong reason. */
function observedRuntime(closure: readonly RuntimeClosureEntry[]): ProviderRuntimeObservation {
  const fields: Omit<ProviderRuntimeObservation, "observationDigest"> = {
    observationVersion: CLAUDE_RUNTIME_OBSERVATION_VERSION,
    providerId: "claude",
    resolvedRuntimeClosure: closure,
    reportedVersion: "1.0.0",
    adapterCapabilitySchemaDigest: "b".repeat(64),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    freshness: { observedAt: "2026-08-16T00:00:00.000Z" },
    truthClass: "PROVEN",
  };
  return Object.freeze({
    ...fields,
    observationDigest: canonicalDigest(observationDigestInput(fields)),
  });
}

/**
 * THE NEGATIVE CONTROL. An honest, undrifted observation the digest gate ACCEPTS. Without one
 * accepted value every refusal on this boundary is equally explained by a gate that refuses
 * everything, and a gate that refuses everything holds no rule. Deliberately NOT recorded in
 * the ledger: it is not a hostile input, and recording it would breach the no-admission
 * invariant it exists to give meaning to.
 */
export const PINNED_QUOTE: ProviderRuntimeObservation = observedRuntime([
  { kind: "EXECUTABLE", path: FORGED_PATH, sha256: FORGED_DIGEST },
]);

/**
 * A runtime that DRIFTED between observation and use: the digest was taken over the closure in
 * `PINNED_QUOTE`, then the executable underneath it was swapped for another path and another
 * digest. Every OTHER field is valid and `observationDigest` is a real hex64, so it survives
 * `isPlainRecord`, `observationDigestInput`, `isHex64`, the version, provider, truth-class,
 * pinning-method and closure-shape guards — leaving `recomputed !== observation.observationDigest`
 * as the ONLY guard that can answer. That is what makes deleting that comparison a red.
 */
export const DRIFTED_QUOTE: ProviderRuntimeObservation = Object.freeze({
  ...PINNED_QUOTE,
  resolvedRuntimeClosure: Object.freeze([
    { kind: "EXECUTABLE", path: SWAPPED_PATH, sha256: SWAPPED_DIGEST } as const,
  ]),
});

/** A quote missing `platformIdentity` and `freshness`, which `observationDigestInput` reads —
 *  so `canonicalDigest` THROWS and the refusal comes from the catch at :114, one guard ABOVE
 *  the drift comparison. Kept as its own fixture precisely so the drift case cannot be answered
 *  by this branch without the message assertion noticing. */
export const UNCANONICALISABLE_QUOTE = Object.freeze({
  observationVersion: CLAUDE_RUNTIME_OBSERVATION_VERSION,
  providerId: "claude",
  truthClass: "PROVEN",
  pinningMethod: "CONTENT_ADDRESSED_COPY",
  observationDigest: FORGED_DIGEST,
  resolvedRuntimeClosure: Object.freeze([
    { kind: "EXECUTABLE", path: FORGED_PATH, sha256: FORGED_DIGEST },
  ]),
});
