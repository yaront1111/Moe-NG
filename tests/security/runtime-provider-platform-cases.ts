/**
 * Executable hostile-case inventory for the platform/runtime-closure slice.
 *
 * The sibling security runner executes these exact run functions. Completeness can therefore
 * consume the exported boundary and arm identities without granting coverage to source text
 * that never executes.
 */

import { expect } from "vitest";

import { PLATFORM_LINUX_LAYER } from "../../packages/runner/src/platform/linux-facts.js";
import { observeLinuxPlatform } from "../../packages/runner/src/platform/linux-observation.js";
import { PLATFORM_MACOS_LAYER } from "../../packages/runner/src/platform/macos/macos-facts.js";
import { observeMacosPlatform } from "../../packages/runner/src/platform/macos/macos-observation.js";
import { MAX_PLATFORM_IDENTITY_CHARS } from "../../packages/runner/src/platform/platform-contract.js";
import { openWindowsProcessBoundary } from "../../packages/runner/src/platform/windows/windows-boundary.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { CLAUDE_RUNTIME_PIN_HOSTILE_CASES } from "./runtime-provider-pin-cases.js";
import { RUNTIME_BOUND as BOUND, hostile } from "./runtime-provider-ledger.js";
import type { Arm, Ledger } from "./runtime-provider-ledger.js";
import {
  CONTRACT_LAYER as CONTRACT,
  FORGED_PATH,
  GOOD_LAUNCH,
  WINDOWS_REQUEST as REQUEST,
  WINDOWS_TRANSPORT as TRANSPORT,
  emptyFacts,
  firstFailure,
  onHost,
  refusedObservation,
  seen,
  silentBroker,
} from "./runtime-provider-platform-fixtures.js";

const CONTRACT_BOUNDARY = "PLATFORM_LAYERS";
const PLATFORM_BOUNDARY = "PLATFORM_BOUNDARIES";
const LINUX_BOUNDARY = "PLATFORM_LINUX_LAYER";
const MACOS_BOUNDARY = "PLATFORM_MACOS_LAYER";
const WINDOWS_BOUNDARY = "WINDOWS_PROCESS_LAYERS";

export type PlatformRuntimeBoundary =
  | "CLAUDE_RUNTIME_PIN_LAYER"
  | typeof CONTRACT_BOUNDARY
  | typeof LINUX_BOUNDARY
  | typeof MACOS_BOUNDARY
  | typeof PLATFORM_BOUNDARY
  | typeof WINDOWS_BOUNDARY;

export interface PlatformRuntimeHostileCase {
  readonly arm: Arm;
  readonly boundary: PlatformRuntimeBoundary;
  /** The suffix after the arm; the runner reconstructs the original full Vitest title. */
  readonly name: string;
  readonly run: (ledger: Ledger) => Promise<void>;
}

const malformedPlatform = { code: "PLATFORM_FACT_MALFORMED", layer: CONTRACT };
const incompletePlatform = {
  code: "PLATFORM_COVERAGE_INCOMPLETE",
  layer: PLATFORM_LINUX_LAYER,
};
const linuxMismatch = { code: "PLATFORM_HOST_MISMATCH", layer: PLATFORM_LINUX_LAYER };
const macosMismatch = { code: "PLATFORM_HOST_MISMATCH", layer: PLATFORM_MACOS_LAYER };

const PLATFORM_HOSTILE_CASES: readonly PlatformRuntimeHostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    boundary: CONTRACT_BOUNDARY,
    name: "a forged host identity is refused by the neutral contract, not by an adapter",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => observeLinuxPlatform({ ...onHost("linux"), host: { os: "linux" } }),
        async () => observeMacosPlatform({ ...onHost("darwin"), host: FORGED_PATH }),
      );
      ledger.refused(CONTRACT_BOUNDARY, "BEFORE", firstFailure(outcome.probe), malformedPlatform);
      ledger.refused(CONTRACT_BOUNDARY, "BEFORE", firstFailure(outcome.effect), malformedPlatform);
    },
  },
  {
    arm: "AFTER",
    boundary: CONTRACT_BOUNDARY,
    name: "an identity field past MAX_PLATFORM_IDENTITY_CHARS still cannot name a host",
    async run(ledger) {
      const overlong = "x".repeat(MAX_PLATFORM_IDENTITY_CHARS + 1);
      const outcome = await probeAfter(
        BOUND,
        async () => observeLinuxPlatform({ ...onHost("linux"), maxFactAgeMs: -1 }),
        async () =>
          observeLinuxPlatform({
            ...onHost("linux"),
            host: { arch: "x64", os: "linux", osVersion: overlong },
          }),
      );
      ledger.refused(CONTRACT_BOUNDARY, "AFTER", firstFailure(outcome.effect), malformedPlatform);
      ledger.refused(CONTRACT_BOUNDARY, "AFTER", firstFailure(outcome.probe), malformedPlatform);
    },
  },
  {
    arm: "RACE",
    boundary: CONTRACT_BOUNDARY,
    name: "two unusable inputs contend and neither yields a host record",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => observeLinuxPlatform(null),
        async () => observeMacosPlatform([onHost("darwin")]),
      );
      for (const side of [outcome.left, outcome.right]) {
        expect(seen(side)?.host).toBeNull();
        refusedObservation(ledger, CONTRACT_BOUNDARY, side, malformedPlatform);
      }
    },
  },
  {
    arm: "BEFORE",
    boundary: PLATFORM_BOUNDARY,
    name: "a boundary name outside the frozen set is refused as incomplete coverage",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () =>
          observeLinuxPlatform({
            ...onHost("linux"),
            facts: { ...emptyFacts(), FORGED_BOUNDARY: null },
          }),
        async () => observeLinuxPlatform({ ...onHost("linux"), facts: {} }),
      );
      ledger.refused(PLATFORM_BOUNDARY, "BEFORE", firstFailure(outcome.probe), incompletePlatform);
      ledger.refused(PLATFORM_BOUNDARY, "BEFORE", firstFailure(outcome.effect), incompletePlatform);
    },
  },
  {
    arm: "AFTER",
    boundary: PLATFORM_BOUNDARY,
    name: "dropping one boundary after a complete set is a gap, never a silent absence",
    async run(ledger) {
      const partial = emptyFacts();
      delete partial["LOCK"];
      const outcome = await probeAfter(
        BOUND,
        async () => observeMacosPlatform({ ...onHost("darwin"), facts: emptyFacts() }),
        async () => observeMacosPlatform({ ...onHost("darwin"), facts: partial }),
      );
      ledger.refused(PLATFORM_BOUNDARY, "AFTER", firstFailure(outcome.effect), {
        code: "PLATFORM_FACT_ABSENT",
        layer: PLATFORM_MACOS_LAYER,
      });
      ledger.refused(PLATFORM_BOUNDARY, "AFTER", firstFailure(outcome.probe), {
        code: "PLATFORM_COVERAGE_INCOMPLETE",
        layer: PLATFORM_MACOS_LAYER,
      });
    },
  },
  {
    arm: "RACE",
    boundary: PLATFORM_BOUNDARY,
    name: "a case-shifted and a non-record fact set contend; neither is accepted",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () =>
          observeLinuxPlatform({ ...onHost("linux"), facts: { ...emptyFacts(), lock: null } }),
        async () => observeLinuxPlatform({ ...onHost("linux"), facts: hostile<unknown>([]) }),
      );
      for (const side of [outcome.left, outcome.right]) {
        refusedObservation(ledger, PLATFORM_BOUNDARY, side, incompletePlatform);
      }
    },
  },
  {
    arm: "BEFORE",
    boundary: LINUX_BOUNDARY,
    name: "a win32 host is refused BY THE LINUX ADAPTER rather than skipped",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => observeLinuxPlatform(onHost("win32")),
        async () => observeLinuxPlatform(onHost("darwin")),
      );
      ledger.refused(LINUX_BOUNDARY, "BEFORE", firstFailure(outcome.probe), linuxMismatch);
      ledger.refused(LINUX_BOUNDARY, "BEFORE", firstFailure(outcome.effect), linuxMismatch);
    },
  },
  {
    arm: "AFTER",
    boundary: LINUX_BOUNDARY,
    name: "an unsupported architecture on a real linux host refuses at the linux layer",
    async run(ledger) {
      const arch = (value: string): unknown => ({
        ...onHost("linux"),
        host: { arch: value, os: "linux", osVersion: "6.1" },
      });
      const outcome = await probeAfter(
        BOUND,
        async () => observeLinuxPlatform(arch("s390x")),
        async () => observeLinuxPlatform(arch("riscv64")),
      );
      const unsupported = {
        code: "PLATFORM_ARCH_UNSUPPORTED",
        layer: PLATFORM_LINUX_LAYER,
      };
      ledger.refused(LINUX_BOUNDARY, "AFTER", firstFailure(outcome.effect), unsupported);
      ledger.refused(LINUX_BOUNDARY, "AFTER", firstFailure(outcome.probe), unsupported);
    },
  },
  {
    arm: "RACE",
    boundary: LINUX_BOUNDARY,
    name: "an asserted-not-observed PROVEN fact never raises the truth class",
    async run(ledger) {
      const forged = {
        host: { arch: "x64", os: "linux", osVersion: "6.1" },
        observedAt: "2026-08-16T00:00:00.000Z",
        truthClass: "PROVEN",
        fact: { path: FORGED_PATH, resolvedPath: FORGED_PATH, symlinkTarget: null },
      };
      const outcome = await probeRacing(
        BOUND,
        async () =>
          observeLinuxPlatform({
            ...onHost("linux"),
            host: forged.host,
            facts: { ...emptyFacts(), PATH_SYMLINK: forged },
          }),
        async () => observeLinuxPlatform(onHost("android")),
      );
      expect(seen(outcome.left)?.truthClass).toBe("UNKNOWN");
      const absent = { code: "PLATFORM_FACT_ABSENT", layer: PLATFORM_LINUX_LAYER };
      refusedObservation(ledger, LINUX_BOUNDARY, outcome.left, absent, "LOCK");
      refusedObservation(ledger, LINUX_BOUNDARY, outcome.right, linuxMismatch);
    },
  },
  {
    arm: "BEFORE",
    boundary: MACOS_BOUNDARY,
    name: "a win32 host is refused BY THE MACOS ADAPTER rather than skipped",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => observeMacosPlatform(onHost("win32")),
        async () => observeMacosPlatform(onHost("linux")),
      );
      ledger.refused(MACOS_BOUNDARY, "BEFORE", firstFailure(outcome.probe), macosMismatch);
      ledger.refused(MACOS_BOUNDARY, "BEFORE", firstFailure(outcome.effect), macosMismatch);
    },
  },
  {
    arm: "AFTER",
    boundary: MACOS_BOUNDARY,
    name: "the macos adapter answers as itself, never as the linux one",
    async run(ledger) {
      const ppc = {
        ...onHost("darwin"),
        host: { arch: "ppc", os: "darwin", osVersion: "24" },
      };
      const outcome = await probeAfter(
        BOUND,
        async () => observeMacosPlatform(onHost("darwin")),
        async () => observeMacosPlatform(ppc),
      );
      ledger.refused(MACOS_BOUNDARY, "AFTER", firstFailure(outcome.effect), {
        code: "PLATFORM_FACT_ABSENT",
        layer: PLATFORM_MACOS_LAYER,
      });
      ledger.refused(MACOS_BOUNDARY, "AFTER", firstFailure(outcome.probe), {
        code: "PLATFORM_ARCH_UNSUPPORTED",
        layer: PLATFORM_MACOS_LAYER,
      });
    },
  },
  {
    arm: "RACE",
    boundary: MACOS_BOUNDARY,
    name: "a linux fixture and a darwin fixture contend without borrowing each other's layer",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => observeMacosPlatform(onHost("linux")),
        async () => observeLinuxPlatform(onHost("darwin")),
      );
      refusedObservation(ledger, MACOS_BOUNDARY, outcome.left, macosMismatch);
      refusedObservation(ledger, MACOS_BOUNDARY, outcome.right, {
        code: "PLATFORM_HOST_MISMATCH",
        layer: PLATFORM_LINUX_LAYER,
      });
    },
  },
  {
    arm: "BEFORE",
    boundary: WINDOWS_BOUNDARY,
    name: "a non-win32 host refuses at the request layer without resolving a broker",
    async run(ledger) {
      const calls: string[] = [];
      const off = (platform: string): unknown =>
        openWindowsProcessBoundary(GOOD_LAUNCH, {
          deps: { ...silentBroker(calls), platform },
        });
      const outcome = await probeBefore(
        BOUND,
        async () => off("linux"),
        async () => off("darwin"),
      );
      expect(calls).toEqual([]);
      const unsupported = {
        code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED",
        layer: REQUEST,
      };
      ledger.refused(WINDOWS_BOUNDARY, "BEFORE", outcome.probe, unsupported);
      ledger.refused(WINDOWS_BOUNDARY, "BEFORE", outcome.effect, unsupported);
    },
  },
  {
    arm: "AFTER",
    boundary: WINDOWS_BOUNDARY,
    name: "argv and environment faults each keep their own code on a real win32 host",
    async run(ledger) {
      const calls: string[] = [];
      const deps = silentBroker(calls);
      const outcome = await probeAfter(
        BOUND,
        async () =>
          openWindowsProcessBoundary(
            { ...GOOD_LAUNCH, argv: [hostile<string>(null)] },
            { deps },
          ),
        async () =>
          openWindowsProcessBoundary(
            { ...GOOD_LAUNCH, environment: { LD_PRELOAD: "/tmp/evil/lib/x.so" } },
            { deps },
          ),
      );
      expect(calls).toEqual([]);
      ledger.refused(WINDOWS_BOUNDARY, "AFTER", outcome.effect, {
        code: "PROCESS_BOUNDARY_ARGV_REJECTED",
        layer: REQUEST,
      });
      ledger.refused(WINDOWS_BOUNDARY, "AFTER", outcome.probe, {
        code: "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
        layer: REQUEST,
      });
    },
  },
  {
    arm: "RACE",
    boundary: WINDOWS_BOUNDARY,
    name: "a never-terminating broker reaches its stable timeout while a malformed request refuses",
    async run(ledger) {
      const calls: string[] = [];
      const opened = openWindowsProcessBoundary(GOOD_LAUNCH, {
        timeoutMs: 150,
        deps: silentBroker(calls),
      });
      expect("completed" in opened).toBe(true);
      const outcome = await probeRacing(
        BOUND,
        async () => await (opened as { completed: Promise<unknown> }).completed,
        async () =>
          openWindowsProcessBoundary(hostile<unknown>({ executable: 1 }), {
            deps: silentBroker([]),
          }),
      );
      expect(calls).toContain("endControl");
      ledger.refusedSide(WINDOWS_BOUNDARY, outcome.left, {
        code: "PROCESS_BOUNDARY_LAUNCH_TIMED_OUT",
        layer: TRANSPORT,
      });
      ledger.refusedSide(WINDOWS_BOUNDARY, outcome.right, {
        code: "PROCESS_BOUNDARY_REQUEST_MALFORMED",
        layer: REQUEST,
      });
    },
  },
]);

/** Every row exported here is executed by runtime-provider-platform.security.ts. */
export const PLATFORM_RUNTIME_HOSTILE_CASES: readonly PlatformRuntimeHostileCase[] =
  Object.freeze([
    ...PLATFORM_HOSTILE_CASES,
    ...CLAUDE_RUNTIME_PIN_HOSTILE_CASES,
  ]);
