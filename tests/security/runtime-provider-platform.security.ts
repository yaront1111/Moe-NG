/**
 * HOSTILE COVERAGE — the PLATFORM AND RUNTIME-CLOSURE group of the runtime-provider axis.
 *
 * Six of the roster's thirty-one `axis: "runtime-provider"` boundaries; the other twenty-five
 * live in the launch, evidence and project-runtime slices.
 * The partition is declared once in `runtime-provider-invariants.ts` and its union is checked
 * against the roster's committed bytes in the evidence file, so a boundary owned by nobody
 * reddens. `CLAUDE_RUNTIME_PIN_LAYER`'s cases live in `runtime-provider-pin-cases.ts` and
 * register here through `describePinBoundary(ledger)`; they count in this file's ledger.
 *
 * NO CASE SKIPS, which matters more here than anywhere else on this axis: `PLATFORM_BOUNDARIES`
 * spans linux, macos and win32 and this suite runs on one host. It does not need to, because the
 * surfaces were measured: `observeLinuxPlatform`/`observeMacosPlatform` are PURE classifiers of
 * caller-supplied facts (no `process.platform`, no `child_process`), so BOTH execute here and
 * each platform's unsupported arm is its own `PLATFORM_HOST_MISMATCH` at its own layer;
 * `openWindowsProcessBoundary` takes `deps.platform`; `prepareClaudeRuntimePin` reads the host
 * through its injected `fs.hostPlatform()`. Every arm EXECUTES, the linux, macos and windows arms
 * are asserted individually, and `assertPositiveCounts` reddens if one produced nothing.
 *
 * TWO MEASURED WINDOWS TRAPS. `openWindowsProcessBoundary` is SYNCHRONOUS on its refusal path
 * (`WindowsProcessBoundary | WindowsProcessUnknown`), so nothing here awaits a rejection that
 * already returned; and its `DEFAULT_TIMEOUT_MS` is 30 MINUTES, so the one case that opens a
 * session passes an explicit bound instead of inheriting it — under `fileParallelism: false` an
 * inherited default turns a hung boundary into a half-hour stall rather than a red.
 */

import { describe, expect, it } from "vitest";

import { PLATFORM_LINUX_LAYER } from "../../packages/runner/src/platform/linux-facts.js";
import { observeLinuxPlatform } from "../../packages/runner/src/platform/linux-observation.js";
import { PLATFORM_MACOS_LAYER } from "../../packages/runner/src/platform/macos/macos-facts.js";
import { observeMacosPlatform } from "../../packages/runner/src/platform/macos/macos-observation.js";
import { MAX_PLATFORM_IDENTITY_CHARS } from "../../packages/runner/src/platform/platform-contract.js";
import { openWindowsProcessBoundary } from "../../packages/runner/src/platform/windows/windows-boundary.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  RUNTIME_BOUND as BOUND,
  RUNTIME_PROVIDER_PARTITION,
  createLedger,
  describeSliceInvariants,
  hostile,
} from "./runtime-provider-ledger.js";
import { describePinBoundary } from "./runtime-provider-pin-cases.js";
import {
  CONTRACT_LAYER as CONTRACT,
  FORGED_PATH,
  GOOD_LAUNCH,
  PLATFORM_SECRETS,
  WINDOWS_REQUEST as REQUEST,
  WINDOWS_TRANSPORT as TRANSPORT,
  emptyFacts,
  firstFailure,
  onHost,
  refusedObservation,
  seen,
  silentBroker,
} from "./runtime-provider-platform-fixtures.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.PLATFORM;
const ledger = createLedger();

// ── PLATFORM_LAYERS ───────────────────────────────────────────────────────────────────────
// The OS-neutral shape gate. Every fixture is malformed in a way the ADAPTER cannot reach — an
// unusable host record is refused before any OS judgement — so PLATFORM_CONTRACT is provably
// the layer that answered rather than PLATFORM_LINUX or PLATFORM_MACOS.
describe("PLATFORM_LAYERS", () => {
  const boundary = "PLATFORM_LAYERS";
  const malformed = { code: "PLATFORM_FACT_MALFORMED", layer: CONTRACT };

  it("BEFORE — a forged host identity is refused by the neutral contract, not by an adapter", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => observeLinuxPlatform({ ...onHost("linux"), host: { os: "linux" } }),
      async () => observeMacosPlatform({ ...onHost("darwin"), host: FORGED_PATH }),
    );
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.probe), malformed);
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.effect), malformed);
  });

  it("AFTER — an identity field past MAX_PLATFORM_IDENTITY_CHARS still cannot name a host", async () => {
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
    ledger.refused(boundary, "AFTER", firstFailure(outcome.effect), malformed);
    ledger.refused(boundary, "AFTER", firstFailure(outcome.probe), malformed);
  });

  it("RACE — two unusable inputs contend and neither yields a host record", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => observeLinuxPlatform(null),
      async () => observeMacosPlatform([onHost("darwin")]),
    );
    for (const side of [outcome.left, outcome.right]) {
      // A refusal that could not read a host must NOT invent a default one.
      expect(seen(side)?.host).toBeNull();
      refusedObservation(ledger, boundary, side, malformed);
    }
  });
});

// ── PLATFORM_BOUNDARIES ───────────────────────────────────────────────────────────────────
// The frozen boundary vocabulary. Each fixture carries a USABLE host and instant so the shape
// gate above cannot answer first; what is wrong is the boundary SET, which the adapter owns.
describe("PLATFORM_BOUNDARIES", () => {
  const boundary = "PLATFORM_BOUNDARIES";
  const incomplete = { code: "PLATFORM_COVERAGE_INCOMPLETE", layer: PLATFORM_LINUX_LAYER };

  it("BEFORE — a boundary name outside the frozen set is refused as incomplete coverage", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () =>
        observeLinuxPlatform({
          ...onHost("linux"),
          facts: { ...emptyFacts(), FORGED_BOUNDARY: null },
        }),
      async () => observeLinuxPlatform({ ...onHost("linux"), facts: {} }),
    );
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.probe), incomplete);
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.effect), incomplete);
  });

  it("AFTER — dropping one boundary after a complete set is a gap, never a silent absence", async () => {
    const partial = emptyFacts();
    delete partial["LOCK"];
    const outcome = await probeAfter(
      BOUND,
      async () => observeMacosPlatform({ ...onHost("darwin"), facts: emptyFacts() }),
      async () => observeMacosPlatform({ ...onHost("darwin"), facts: partial }),
    );
    // The complete-but-unobserved set is a DIFFERENT refusal: it reaches per-boundary
    // classification and answers ABSENT, which is what makes the gap attributable to the set.
    ledger.refused(boundary, "AFTER", firstFailure(outcome.effect), {
      code: "PLATFORM_FACT_ABSENT",
      layer: PLATFORM_MACOS_LAYER,
    });
    ledger.refused(boundary, "AFTER", firstFailure(outcome.probe), {
      code: "PLATFORM_COVERAGE_INCOMPLETE",
      layer: PLATFORM_MACOS_LAYER,
    });
  });

  it("RACE — a case-shifted and a non-record fact set contend; neither is accepted", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () =>
        observeLinuxPlatform({ ...onHost("linux"), facts: { ...emptyFacts(), lock: null } }),
      async () => observeLinuxPlatform({ ...onHost("linux"), facts: hostile<unknown>([]) }),
    );
    for (const side of [outcome.left, outcome.right]) {
      refusedObservation(ledger, boundary, side, incomplete);
    }
  });
});

// ── PLATFORM_LINUX_LAYER ──────────────────────────────────────────────────────────────────
// The linux arm. It EXECUTES on this win32 host because the adapter classifies caller-supplied
// facts; the unsupported case is not a skip but the adapter's own PLATFORM_HOST_MISMATCH.
describe("PLATFORM_LINUX_LAYER", () => {
  const boundary = "PLATFORM_LINUX_LAYER";
  const mismatch = { code: "PLATFORM_HOST_MISMATCH", layer: PLATFORM_LINUX_LAYER };

  it("BEFORE — a win32 host is refused BY THE LINUX ADAPTER rather than skipped", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => observeLinuxPlatform(onHost("win32")),
      async () => observeLinuxPlatform(onHost("darwin")),
    );
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.probe), mismatch);
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.effect), mismatch);
  });

  it("AFTER — an unsupported architecture on a real linux host refuses at the linux layer", async () => {
    const arch = (value: string): unknown => ({
      ...onHost("linux"),
      host: { arch: value, os: "linux", osVersion: "6.1" },
    });
    const outcome = await probeAfter(
      BOUND,
      async () => observeLinuxPlatform(arch("s390x")),
      async () => observeLinuxPlatform(arch("riscv64")),
    );
    // Both fixtures are well-formed LINUX hosts, so the neutral shape gate cannot answer first
    // and the architecture rule — which only this adapter owns — is provably what refused.
    const unsupported = { code: "PLATFORM_ARCH_UNSUPPORTED", layer: PLATFORM_LINUX_LAYER };
    ledger.refused(boundary, "AFTER", firstFailure(outcome.effect), unsupported);
    ledger.refused(boundary, "AFTER", firstFailure(outcome.probe), unsupported);
  });

  it("RACE — an asserted-not-observed PROVEN fact never raises the truth class", async () => {
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
    // Six boundaries were never observed, so the aggregate stays UNKNOWN whatever the forged
    // envelope claims about itself.
    expect(seen(outcome.left)?.truthClass).toBe("UNKNOWN");
    const absent = { code: "PLATFORM_FACT_ABSENT", layer: PLATFORM_LINUX_LAYER };
    refusedObservation(ledger, boundary, outcome.left, absent, "LOCK");
    refusedObservation(ledger, boundary, outcome.right, mismatch);
  });
});

// ── PLATFORM_MACOS_LAYER ──────────────────────────────────────────────────────────────────
// The macos arm, asserted INDEPENDENTLY of the linux one: the two adapters deliberately do not
// delegate to each other, so a darwin refusal spelled PLATFORM_LINUX would be an inherited
// judgement, which is exactly what this seam exists to prevent.
describe("PLATFORM_MACOS_LAYER", () => {
  const boundary = "PLATFORM_MACOS_LAYER";
  const mismatch = { code: "PLATFORM_HOST_MISMATCH", layer: PLATFORM_MACOS_LAYER };

  it("BEFORE — a win32 host is refused BY THE MACOS ADAPTER rather than skipped", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => observeMacosPlatform(onHost("win32")),
      async () => observeMacosPlatform(onHost("linux")),
    );
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.probe), mismatch);
    ledger.refused(boundary, "BEFORE", firstFailure(outcome.effect), mismatch);
  });

  it("AFTER — the macos adapter answers as itself, never as the linux one", async () => {
    const ppc = { ...onHost("darwin"), host: { arch: "ppc", os: "darwin", osVersion: "24" } };
    const outcome = await probeAfter(
      BOUND,
      async () => observeMacosPlatform(onHost("darwin")),
      async () => observeMacosPlatform(ppc),
    );
    // The healthy-host leg ran FIRST and reaches per-boundary classification, so its refusal is
    // the adapter's absence verdict — proof the mismatch arm above was not answering here.
    ledger.refused(boundary, "AFTER", firstFailure(outcome.effect), {
      code: "PLATFORM_FACT_ABSENT",
      layer: PLATFORM_MACOS_LAYER,
    });
    ledger.refused(boundary, "AFTER", firstFailure(outcome.probe), {
      code: "PLATFORM_ARCH_UNSUPPORTED",
      layer: PLATFORM_MACOS_LAYER,
    });
  });

  it("RACE — a linux fixture and a darwin fixture contend without borrowing each other's layer", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => observeMacosPlatform(onHost("linux")),
      async () => observeLinuxPlatform(onHost("darwin")),
    );
    refusedObservation(ledger, boundary, outcome.left, mismatch);
    refusedObservation(ledger, boundary, outcome.right, {
      code: "PLATFORM_HOST_MISMATCH",
      layer: PLATFORM_LINUX_LAYER,
    });
  });
});

// ── WINDOWS_PROCESS_LAYERS ────────────────────────────────────────────────────────────────
// The process seam. Every case injects `deps`, so no real broker is spawned and the recorded
// call log proves what was NOT done. `openWindowsProcessBoundary` returns its refusal
// SYNCHRONOUSLY, so nothing below awaits a rejection that already happened.
describe("WINDOWS_PROCESS_LAYERS", () => {
  const boundary = "WINDOWS_PROCESS_LAYERS";

  it("BEFORE — a non-win32 host refuses at the request layer without resolving a broker", async () => {
    const calls: string[] = [];
    const off = (platform: string): unknown =>
      openWindowsProcessBoundary(GOOD_LAUNCH, { deps: { ...silentBroker(calls), platform } });
    const outcome = await probeBefore(
      BOUND,
      async () => off("linux"),
      async () => off("darwin"),
    );
    // ZERO process calls: the assertion the platform gate exists to support.
    expect(calls).toEqual([]);
    const unsupported = { code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED", layer: REQUEST };
    ledger.refused(boundary, "BEFORE", outcome.probe, unsupported);
    ledger.refused(boundary, "BEFORE", outcome.effect, unsupported);
  });

  it("AFTER — argv and environment faults each keep their own code on a real win32 host", async () => {
    const calls: string[] = [];
    const deps = silentBroker(calls);
    const outcome = await probeAfter(
      BOUND,
      async () =>
        openWindowsProcessBoundary({ ...GOOD_LAUNCH, argv: [hostile<string>(null)] }, { deps }),
      async () =>
        openWindowsProcessBoundary(
          { ...GOOD_LAUNCH, environment: { LD_PRELOAD: "/tmp/evil/lib/x.so" } },
          { deps },
        ),
    );
    expect(calls).toEqual([]);
    // Argv ran FIRST. Both fixtures carry a valid executable and cwd, so no earlier gate can
    // answer and each fault provably keeps its own code.
    ledger.refused(boundary, "AFTER", outcome.effect, {
      code: "PROCESS_BOUNDARY_ARGV_REJECTED",
      layer: REQUEST,
    });
    ledger.refused(boundary, "AFTER", outcome.probe, {
      code: "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
      layer: REQUEST,
    });
  });

  it("RACE — a never-terminating broker reaches its stable timeout while a malformed request refuses", async () => {
    const calls: string[] = [];
    const opened = openWindowsProcessBoundary(GOOD_LAUNCH, {
      // 150ms: four orders of magnitude below DEFAULT_TIMEOUT_MS and far below MAX_BOUND_MS.
      // Inheriting the default would stall this lane for thirty minutes instead of reddening.
      timeoutMs: 150,
      deps: silentBroker(calls),
    });
    expect("completed" in opened).toBe(true);
    const outcome = await probeRacing(
      BOUND,
      async () => await (opened as { completed: Promise<unknown> }).completed,
      async () =>
        openWindowsProcessBoundary(hostile<unknown>({ executable: 1 }), { deps: silentBroker([]) }),
    );
    // It TERMINATED: the cancel reached the broker rather than the bound expiring.
    expect(calls).toContain("endControl");
    ledger.refusedSide(boundary, outcome.left, {
      code: "PROCESS_BOUNDARY_LAUNCH_TIMED_OUT",
      layer: TRANSPORT,
    });
    ledger.refusedSide(boundary, outcome.right, {
      code: "PROCESS_BOUNDARY_REQUEST_MALFORMED",
      layer: REQUEST,
    });
  });
});

describePinBoundary(ledger);

describeSliceInvariants("platform group", ledger, OWNED, PLATFORM_SECRETS, 12);
