/**
 * Tests for the canary's host-evidence gate.
 *
 * The gate exists because a self-host claim may not rest on a runtime the test
 * named for itself. Two properties are asserted here and they need different
 * instruments: every refusal arm is driven from a hand-authored case, because a
 * host that reports the wrong version cannot be produced on demand; and the real
 * no-argument path is driven against THIS host, because a gate only ever
 * exercised through hand-authored input proves nothing about the machine the
 * canary will actually run on.
 *
 * Every refusal assertion pins the exact code (epic rail 6). Asserting "it
 * refused" would stay green if a different arm started answering first, and the
 * arms here are ordered — a case meant to prove the version check would be
 * silently answered by the digest check above it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildProviderRuntimeObservation,
  type ProviderRuntimeObservation,
} from "../../../packages/runner/src/providers/claude/claude-observation.js";
import type {
  DiscoverInstalledClaudeRuntimeResult,
} from "../../../packages/runner/src/providers/claude/claude-runtime-discovery.js";

import { createLogicalClock } from "./e2e-harness.js";
import {
  HOST_RUNTIME_EVIDENCE_ERROR_CODES,
  SEEDED_LOW_RISK_TASK,
  acceptHostRuntimeEvidence,
  observeHostClaudeRuntime,
  type HostRuntimeReadings,
} from "./foundation-fixtures.js";
import { NODE_REF } from "./j1-loop-harness.js";

const run = promisify(execFile);

const CLOSURE_PATH = "C:/hand/authored/claude.exe";
const CLOSURE_SHA256 = "3333333333333333333333333333333333333333333333333333333333333333";
const SCHEMA_DIGEST = "4444444444444444444444444444444444444444444444444444444444444444";
const REPORTED_VERSION = "2.1.235 (Claude Code)";

/**
 * A base observation from the PRODUCTION builder, so a contract change reddens
 * here rather than drifting. Variants below override single fields on top of it:
 * the gate's subject is the field, and building each variant by hand would let a
 * second difference sneak in and answer for the one under test.
 */
function baseObservation(): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: CLOSURE_PATH, sha256: CLOSURE_SHA256 }],
    reportedVersion: REPORTED_VERSION,
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: createLogicalClock(),
  });
  if (built.ok !== true) throw new Error(`base observation refused with ${built.code}`);
  return built.observation;
}

const found = (observation: ProviderRuntimeObservation): DiscoverInstalledClaudeRuntimeResult =>
  ({ ok: true, observation, installedRoot: "C:/hand/authored" });

const readings = (
  digest: string | null, version: string | null, path = CLOSURE_PATH,
): HostRuntimeReadings => ({ digests: new Map([[path, digest]]), version });

/** What an accepting host looks like: same bytes, same version, nothing else. */
const agreeingReadings = (): HostRuntimeReadings => readings(CLOSURE_SHA256, REPORTED_VERSION);

describe("the canary's exclusive identity", () => {
  /**
   * A binding test, not a value test. Asserting `NODE_REF === "node-code-1"`
   * would stay green with the harness holding its own literal, which is the
   * defect: the identity the seed installs and the identity the exclusivity
   * assertion samples have to be the SAME object, not two that agree today.
   */
  it("is one identity: the real-process harness reads the node from the fixture", () => {
    expect(NODE_REF).toBe(SEEDED_LOW_RISK_TASK.nodeRef);
    expect(SEEDED_LOW_RISK_TASK.projectId).toBe("moe-e2e-j1");
    expect(SEEDED_LOW_RISK_TASK.exclusive).toBe(true);
    expect(Object.isFrozen(SEEDED_LOW_RISK_TASK)).toBe(true);
  });
});

describe("host runtime evidence gate", () => {
  it("lists every code it can mint, frozen, sorted, with no duplicates", () => {
    expect([...HOST_RUNTIME_EVIDENCE_ERROR_CODES]).toEqual([
      "CANARY_HOST_RUNTIME_CLOSURE_EMPTY",
      "CANARY_HOST_RUNTIME_DIGEST_MISMATCH",
      "CANARY_HOST_RUNTIME_DISCOVERY_REFUSED",
      "CANARY_HOST_RUNTIME_PLATFORM_MISMATCH",
      "CANARY_HOST_RUNTIME_UNPROVEN",
      "CANARY_HOST_RUNTIME_VERSION_MISMATCH",
    ]);
    expect(Object.isFrozen(HOST_RUNTIME_EVIDENCE_ERROR_CODES)).toBe(true);
    expect(new Set(HOST_RUNTIME_EVIDENCE_ERROR_CODES).size)
      .toBe(HOST_RUNTIME_EVIDENCE_ERROR_CODES.length);
  });

  it("accepts a host whose bytes and version still agree with the observation", () => {
    const accepted = acceptHostRuntimeEvidence(found(baseObservation()), agreeingReadings());
    expect(accepted.ok).toBe(true);
    expect(accepted.ok === true && accepted.installedRoot).toBe("C:/hand/authored");
    expect(accepted.ok === true && accepted.observation.reportedVersion).toBe(REPORTED_VERSION);
  });

  it("passes a discovery refusal through with the RUNTIME layer's own code intact", () => {
    const refusal = acceptHostRuntimeEvidence(
      { truthClass: "UNKNOWN", code: "CLAUDE_RUNTIME_PATH_DUPLICATE", layer: "RUNTIME",
        message: "two runtimes resolved" } as DiscoverInstalledClaudeRuntimeResult,
      agreeingReadings(),
    );
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_DISCOVERY_REFUSED");
    expect(refusal.ok === false && refusal.runtimeCode).toBe("CLAUDE_RUNTIME_PATH_DUPLICATE");
  });

  it("refuses an observation that is not PROVEN with CANARY_HOST_RUNTIME_UNPROVEN", () => {
    const unproven = { ...baseObservation(), truthClass: "UNKNOWN" } as ProviderRuntimeObservation;
    const refusal = acceptHostRuntimeEvidence(found(unproven), agreeingReadings());
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_UNPROVEN");
    expect(refusal.ok === false && refusal.runtimeCode).toBe(null);
  });

  it("refuses a non-win32 platform identity with CANARY_HOST_RUNTIME_PLATFORM_MISMATCH", () => {
    const linux = {
      ...baseObservation(), platformIdentity: { os: "linux", arch: "x64", osVersion: "6.8.0" },
    } as ProviderRuntimeObservation;
    const refusal = acceptHostRuntimeEvidence(found(linux), agreeingReadings());
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_PLATFORM_MISMATCH");
  });

  it("refuses an empty closure with CANARY_HOST_RUNTIME_CLOSURE_EMPTY", () => {
    const empty = { ...baseObservation(), resolvedRuntimeClosure: [] } as ProviderRuntimeObservation;
    const refusal = acceptHostRuntimeEvidence(found(empty), agreeingReadings());
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_CLOSURE_EMPTY");
  });

  it("refuses bytes that changed under the observation with CANARY_HOST_RUNTIME_DIGEST_MISMATCH", () => {
    const other = "5555555555555555555555555555555555555555555555555555555555555555";
    const refusal = acceptHostRuntimeEvidence(
      found(baseObservation()), readings(other, REPORTED_VERSION),
    );
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_DIGEST_MISMATCH");
  });

  it("refuses an unreadable closure path with the same digest code, never as agreement", () => {
    const refusal = acceptHostRuntimeEvidence(
      found(baseObservation()), readings(null, REPORTED_VERSION),
    );
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_DIGEST_MISMATCH");
  });

  it("refuses a closure path this host never read at all, rather than skipping it", () => {
    const refusal = acceptHostRuntimeEvidence(
      found(baseObservation()), readings(CLOSURE_SHA256, REPORTED_VERSION, "C:/somewhere/else.exe"),
    );
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_DIGEST_MISMATCH");
  });

  it("refuses a version the executable does not report with CANARY_HOST_RUNTIME_VERSION_MISMATCH", () => {
    const refusal = acceptHostRuntimeEvidence(
      found(baseObservation()), readings(CLOSURE_SHA256, "2.0.0 (Claude Code)"),
    );
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_VERSION_MISMATCH");
  });

  it("refuses an unreadable version with the version code, never as agreement", () => {
    const refusal = acceptHostRuntimeEvidence(found(baseObservation()), readings(CLOSURE_SHA256, null));
    expect(refusal.ok === false && refusal.code).toBe("CANARY_HOST_RUNTIME_VERSION_MISMATCH");
  });
});

/**
 * The real path, against the machine the suite is running on.
 *
 * Three arms, and NONE of them is a skip: every one pins a literal code. A host
 * without an install is a host fact, not a defect — but it may only be claimed
 * when the install really is absent, so that arm re-checks the known location
 * itself. Without that check a discovery regression on a machine that DOES have
 * Claude would take the tolerant arm and read as green, which is the same
 * silent-degradation defect an env-gated skip produces.
 */
describe("host runtime evidence, observed on this host", () => {
  const knownInstall = join(homedir(), ".local", "bin", "claude.exe");

  it("observes the installed runtime, or names the layer that refused", async () => {
    const evidence = await observeHostClaudeRuntime();
    if (process.platform !== "win32") {
      expect(evidence.ok).toBe(false);
      expect(evidence.ok === false && evidence.code).toBe("CANARY_HOST_RUNTIME_DISCOVERY_REFUSED");
      expect(evidence.ok === false && evidence.runtimeCode)
        .toBe("CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED");
      return;
    }
    if (evidence.ok !== true) {
      expect(evidence.code).toBe("CANARY_HOST_RUNTIME_DISCOVERY_REFUSED");
      expect(evidence.runtimeCode).toBe("CLAUDE_RUNTIME_PATH_MISSING");
      // A host holding an install may NOT settle for the missing-install arm.
      expect(existsSync(knownInstall)).toBe(false);
      return;
    }
    expect(evidence.observation.truthClass).toBe("PROVEN");
    expect(evidence.observation.providerId).toBe("claude");
    expect(evidence.observation.platformIdentity.os).toBe("win32");
    expect(evidence.observation.resolvedRuntimeClosure.length).toBeGreaterThan(0);
    expect(evidence.installedRoot.length).toBeGreaterThan(0);

    // Independent operands: the digest is recomputed here from the file, and the
    // version is read by executing the binary again. Comparing the observation
    // against itself would pass on a host where neither is true any more.
    const executable = evidence.observation.resolvedRuntimeClosure
      .find((entry) => entry.kind === "EXECUTABLE");
    expect(executable).toBeDefined();
    const digest = createHash("sha256")
      .update(await readFile((executable as { path: string }).path)).digest("hex");
    expect(digest).toBe((executable as { sha256: string }).sha256.toLowerCase());
    const probe = await run((executable as { path: string }).path, ["--version"], {
      cwd: evidence.installedRoot,
    });
    expect(probe.stdout.split("\n")[0]?.trim()).toBe(evidence.observation.reportedVersion);
  }, 60_000);
});
