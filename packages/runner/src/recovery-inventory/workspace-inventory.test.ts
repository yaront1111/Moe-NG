/**
 * Behaviour contract for the WORKSPACE recovery-inventory adapter.
 *
 * The bytes are real: every workspace here is an `mkdtemp` directory under the OS
 * temp root with files actually written to disk, scanned by the production
 * enumerator and sealed through the shipped `buildInputManifest` /
 * `buildResultManifest`. Nothing reimplements a manifest, a digest or a path
 * normalizer, and every refusal is driven end to end through the shipped
 * `collectRecoveryInventory`, which is the surface that mints codes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCOPE_OBSERVATION_VERSION,
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
  scopeObservationDigestInput,
} from "@moe/runner";
import type {
  RecoveryInventoryCoverageProof,
  RecoveryInventoryReport,
  RecoveryInventoryResult,
  RecoveryInventoryUnknownReason,
  ScopeObservation,
  WorkspaceProducer,
} from "@moe/runner";

import { canonicalDigest } from "../canonical.js";
import {
  providerLockInventoryRegistration,
  type ProviderLockInventoryInput,
} from "./provider-lock-inventory.js";
import { identityKey, readIdentity } from "./recovery-inventory-shape.js";
import {
  enumerateWorkspaceInventory,
  workspaceInventoryRegistration,
  type WorkspaceInventoryInput,
  type WorkspaceInventoryListing,
  type WorkspaceInventorySource,
} from "./workspace-inventory.js";

const CLASS = "WORKSPACE";
const LAYER = "INVENTORY_ADAPTER";
const UNKNOWN_CODE = "RECOVERY_INVENTORY_COVERAGE_UNKNOWN";
const PROJECT = "moe-next";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const BASE = "1".repeat(40);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PRODUCER: WorkspaceProducer = { kind: "BASE" };
const CLOCK = { observedAt: () => OBSERVED_AT };

/** Counts coverage cases actually generated: a sweep producing nothing must fail. */
const GENERATED: string[] = [];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moe-recovery-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, contents: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function sealedObservation(scopePath: string): ScopeObservation {
  const body = {
    observationVersion: SCOPE_OBSERVATION_VERSION,
    baseIdentity: BASE,
    worktreeIdentity: "worktree-1",
    canonicalEntries: [{ path: scopePath, attribution: "CLEAN" as const, attributionReason: "tracked and clean" }],
    gitAttribution: {
      headCommit: BASE,
      changedPaths: [],
      dirtyPaths: [],
      stagedPaths: [],
      untrackedPaths: [],
      unmergedPaths: [],
      ignoredPaths: [],
    },
    observedAt: "2026-08-05T11:00:00.000Z",
    observerVersion: "git-2.45",
  };
  return { ...body, sha256: canonicalDigest(scopeObservationDigestInput(body)) };
}

function source(overrides: Partial<WorkspaceInventorySource> = {}): WorkspaceInventorySource {
  return {
    workspaceRef: "ws/alpha",
    baseIdentity: BASE,
    rootPath: root,
    producer: PRODUCER,
    result: null,
    ...overrides,
  };
}

function input(listing: Partial<WorkspaceInventoryListing> & { throws?: boolean } = {}): WorkspaceInventoryInput {
  return {
    clock: CLOCK,
    port: {
      list: () => {
        if (listing.throws === true) {
          throw new Error("workspace lister is unreachable");
        }
        return {
          workspaces: listing.workspaces ?? [source()],
          listingComplete: listing.listingComplete ?? true,
        };
      },
    },
  };
}

const CONTEXT = {
  class: CLASS,
  projectTag: PROJECT,
  backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A },
  incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B },
  window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
} as const;

function request(classes: readonly string[] = [CLASS]): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { ...CONTEXT.backup },
    incarnation: { ...CONTEXT.incarnation },
    window: { ...CONTEXT.window },
    configuredClasses: [...classes],
  };
}

async function collect(
  listing: Partial<WorkspaceInventoryListing> & { throws?: boolean } = {},
): Promise<RecoveryInventoryReport> {
  const registry = createRecoveryInventoryRegistry([workspaceInventoryRegistration(input(listing))]);
  const result: RecoveryInventoryResult = await collectRecoveryInventory(request(), registry);
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofFor(report: RecoveryInventoryReport, cls: string = CLASS): RecoveryInventoryCoverageProof {
  const proof = report.proofs.find((candidate) => candidate.class === cls);
  if (proof === undefined) {
    throw new Error(`configured class ${cls} vanished from the report`);
  }
  GENERATED.push(cls);
  return proof;
}

function summary(proof: RecoveryInventoryCoverageProof): Record<string, unknown> {
  return { truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer };
}

const COMPLETE_PROOF = { truth: "COMPLETE", code: null, reason: null, layer: LAYER };

function expectUnknown(report: RecoveryInventoryReport, reason: RecoveryInventoryUnknownReason): void {
  expect(summary(proofFor(report))).toEqual({
    truth: "UNKNOWN",
    code: UNKNOWN_CODE,
    reason,
    layer: LAYER,
  });
  expect(report.coverage).toBe("UNKNOWN");
  expect(report.items).toHaveLength(0);
}

function factsOf(report: RecoveryInventoryReport, path: string): Record<string, unknown> {
  const found = report.items.find(
    (candidate) => candidate.identity.kind === "PATH" && candidate.identity.path === path,
  );
  if (found === undefined) {
    throw new Error(`no inventory item for external identity ${path}`);
  }
  return { ...found.facts };
}

describe("workspace enumeration over real filesystem bytes", () => {
  it("binds every sealed manifest entry to the class, a stable identity and a source proof", async () => {
    write("alpha.txt", "alpha");
    write("nested/beta.txt", "beta");
    const report = await collect();
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(report.coverage).toBe("COMPLETE");
    expect(report.items).toHaveLength(2);
    for (const item of report.items) {
      expect(item.class).toBe(CLASS);
      expect(item.projectTag).toBe(PROJECT);
      expect(item.observedAt).toBe(OBSERVED_AT);
      expect(item.sourceProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    const alpha = factsOf(report, "ws/alpha/alpha.txt");
    const beta = factsOf(report, "ws/alpha/nested/beta.txt");
    expect(alpha["byteLength"]).toBe(5);
    expect(beta["byteLength"]).toBe(4);
    expect(alpha["sha256"]).not.toBe(beta["sha256"]);
    expect(alpha).toEqual({
      origin: "INPUT",
      byteLength: 5,
      sha256: alpha["sha256"],
      producerKind: "BASE",
      baseIdentity: BASE,
    });
    expect(String(alpha["sha256"])).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("seals a result manifest for a workspace that declares one", async () => {
    write("alpha.txt", "alpha");
    const report = await collect({
      workspaces: [source({ result: { scopeObservation: sealedObservation("alpha.txt"), authoredPaths: [], declaredArtifactRefs: [] } })],
    });
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(report.items).toHaveLength(2);
    const sealed = report.items.find((item) => item.identity.kind === "OPAQUE");
    expect(sealed?.identity).toEqual({ kind: "OPAQUE", id: "workspace-result:ws/alpha" });
    expect(sealed?.facts["origin"]).toBe("RESULT");
    expect(sealed?.facts["inheritedCount"]).toBe(1);
    expect(sealed?.facts["authoredCount"]).toBe(0);
    expect(String(sealed?.facts["inputManifestSha256"])).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("two entries claiming one external identity", () => {
  it("normalizes both spellings onto a single identity key", () => {
    write("alpha.txt", "alpha");
    const reading = enumerateWorkspaceInventory(
      input({ workspaces: [source(), source({ workspaceRef: "ws\\alpha" })] }),
      CONTEXT,
    );
    return reading.then((resolved) => {
      if (resolved.status !== "ENUMERATED") {
        throw new Error(`expected an enumeration, got ${resolved.status}`);
      }
      expect(resolved.items).toHaveLength(2);
      const [first, second] = resolved.items as readonly { identity: unknown }[];
      const left = readIdentity(first?.identity);
      const right = readIdentity(second?.identity);
      if (left === null || right === null) {
        throw new Error("the enumerator emitted an identity the shipped reader rejects");
      }
      // The raw spellings differ; the shipped reader is what folds them together.
      expect(JSON.stringify(first?.identity)).not.toBe(JSON.stringify(second?.identity));
      expect(identityKey(left)).toBe(identityKey(right));
    });
  });

  it("refuses rather than merging them", async () => {
    write("alpha.txt", "alpha");
    const report = await collect({ workspaces: [source(), source({ workspaceRef: "ws\\alpha" })] });
    expect(summary(proofFor(report))).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(report.items).toHaveLength(0);
  });
});

describe("silence is never absence", () => {
  it("refuses with NEGATIVE_PROOF_MISSING when nothing at all was sealed", async () => {
    expectUnknown(await collect({ workspaces: [] }), "NEGATIVE_PROOF_MISSING");
  });

  it("admits an empty workspace against the sealed empty manifest that proves it", async () => {
    const report = await collect();
    const proof = proofFor(report);
    expect(summary(proof)).toEqual(COMPLETE_PROOF);
    expect(proof.itemCount).toBe(0);
    expect(proof.negativeProofDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("truncates rather than reporting an unreadable root as empty", async () => {
    const report = await collect({ workspaces: [source({ rootPath: join(root, "absent") })] });
    expectUnknown(report, "RESULT_TRUNCATED");
  });

  it("truncates when the lister cannot prove it saw every workspace", async () => {
    write("alpha.txt", "alpha");
    expectUnknown(await collect({ listingComplete: false }), "RESULT_TRUNCATED");
  });
});

describe("availability and ceiling refusals", () => {
  it("reports ENUMERATOR_UNAVAILABLE when the lister throws", async () => {
    expectUnknown(await collect({ throws: true }), "ENUMERATOR_UNAVAILABLE");
  });

  it("reports ENUMERATOR_UNAVAILABLE when the input manifest refuses to seal", async () => {
    write("alpha.txt", "alpha");
    const report = await collect({ workspaces: [source({ baseIdentity: "not-a-commit" })] });
    expectUnknown(report, "ENUMERATOR_UNAVAILABLE");
  });

  it("reports ENUMERATOR_UNAVAILABLE when the result manifest refuses to seal", async () => {
    write("alpha.txt", "alpha");
    const report = await collect({
      workspaces: [
        source({
          result: {
            scopeObservation: sealedObservation("declared"),
            authoredPaths: ["outside/scope.txt"],
            declaredArtifactRefs: [],
          },
        }),
      ],
    });
    expectUnknown(report, "ENUMERATOR_UNAVAILABLE");
  });

  it("reports RESULT_OVER_LIMIT one item above the ceiling", async () => {
    const observation = sealedObservation("alpha.txt");
    const workspaces = Array.from({ length: 4097 }, (_ignored, index) =>
      source({
        workspaceRef: `ws/w${index}`,
        result: { scopeObservation: observation, authoredPaths: [], declaredArtifactRefs: [] },
      }),
    );
    expect(workspaces).toHaveLength(4097);
    expectUnknown(await collect({ workspaces }), "RESULT_OVER_LIMIT");
  }, 60_000);
});

/**
 * DoD 4: the registration seam, proven WITHOUT editing the aggregate. Both
 * enumerators are composed into one caller-supplied tuple exactly as the daemon
 * coordinator will compose them; `recovery-inventory.ts` is not touched.
 */
const PLATFORM = { os: "windows", arch: "x64", osVersion: "10.0.26200" };

function providerInput(exit: unknown = { kind: "EXITED", code: 0 }): ProviderLockInventoryInput {
  const probe = {
    resolvedRuntimeClosure: [],
    reportedVersion: "v1",
    schemaVersion: null,
    pinningMethod: "UNSUPPORTED" as const,
    structuredSample: null,
    rawSampleBase64: null,
    cancelObservation: null,
    processTreeObservation: { childrenBefore: 2, childrenAfter: 0 },
    runEnumeration: { enumeratedRunIds: ["run-a"], provenAbsentRunId: "run-z" },
    tokenizer: null,
    declaredContextLimit: null,
    helpText: null,
    resumeClaim: null,
  };
  return {
    clock: CLOCK,
    claude: { port: { report: () => probe }, clock: CLOCK, platformIdentity: PLATFORM },
    codex: {
      port: { report: () => ({ ...probe, cwdObservation: null }) },
      clock: CLOCK,
      platformIdentity: PLATFORM,
    },
    port: {
      governingClaim: () => ({
        claimId: "claim-1",
        intentId: "intent-1",
        wrapperIdentity: "wrapper-1",
        lockIdentity: "lock-1",
        claimedAt: "2026-08-05T11:00:00.000Z",
      }),
      launchLockRecords: () => [],
      processRecords: () => [{ processIdentity: "pid-1", exit, reconciliation: null }],
    },
  };
}

const BOTH = ["PROVIDER_PROCESS_LAUNCH_LOCK", CLASS];

async function collectBoth(
  registrations: readonly ReturnType<typeof workspaceInventoryRegistration>[],
): Promise<RecoveryInventoryReport> {
  const result = await collectRecoveryInventory(request(BOTH), createRecoveryInventoryRegistry(registrations));
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofShapes(report: RecoveryInventoryReport): readonly Record<string, unknown>[] {
  return report.proofs.map((proof) => ({ class: proof.class, ...summary(proof) }));
}

describe("the registration seam for both classes", () => {
  it("reports COMPLETE for both only when both enumerators proved completeness", async () => {
    write("alpha.txt", "alpha");
    const report = await collectBoth([
      providerLockInventoryRegistration(providerInput()),
      workspaceInventoryRegistration(input()),
    ]);
    expect(proofShapes(report)).toEqual([
      { class: "PROVIDER_PROCESS_LAUNCH_LOCK", ...COMPLETE_PROOF },
      { class: CLASS, ...COMPLETE_PROOF },
    ]);
    expect(report.coverage).toBe("COMPLETE");
    expect(summary(proofFor(report, "PROVIDER_PROCESS_LAUNCH_LOCK"))).toEqual(COMPLETE_PROOF);
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(report.items).toHaveLength(2);
  });

  it("answers ENUMERATOR_UNREGISTERED for a configured class nobody registered", async () => {
    write("alpha.txt", "alpha");
    const report = await collectBoth([providerLockInventoryRegistration(providerInput())]);
    expect(proofShapes(report)).toEqual([
      { class: "PROVIDER_PROCESS_LAUNCH_LOCK", ...COMPLETE_PROOF },
      { class: CLASS, truth: "UNKNOWN", code: UNKNOWN_CODE, reason: "ENUMERATOR_UNREGISTERED", layer: LAYER },
    ]);
    expect(report.coverage).toBe("UNKNOWN");
    expect(summary(proofFor(report, "PROVIDER_PROCESS_LAUNCH_LOCK"))).toEqual(COMPLETE_PROOF);
    expect(proofFor(report).reason).toBe("ENUMERATOR_UNREGISTERED");
  });

  it("does not let the other class vanish when the provider slice is unregistered", async () => {
    write("alpha.txt", "alpha");
    const report = await collectBoth([workspaceInventoryRegistration(input())]);
    expect(proofShapes(report)).toEqual([
      {
        class: "PROVIDER_PROCESS_LAUNCH_LOCK",
        truth: "UNKNOWN",
        code: UNKNOWN_CODE,
        reason: "ENUMERATOR_UNREGISTERED",
        layer: LAYER,
      },
      { class: CLASS, ...COMPLETE_PROOF },
    ]);
    expect(report.coverage).toBe("UNKNOWN");
    expect(proofFor(report, "PROVIDER_PROCESS_LAUNCH_LOCK").reason).toBe("ENUMERATOR_UNREGISTERED");
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
  });

  it("never lets a later COMPLETE launder an earlier UNKNOWN", async () => {
    write("alpha.txt", "alpha");
    const report = await collectBoth([
      providerLockInventoryRegistration(providerInput({ kind: "UNOBSERVED" })),
      workspaceInventoryRegistration(input()),
    ]);
    expect(proofShapes(report)).toEqual([
      {
        class: "PROVIDER_PROCESS_LAUNCH_LOCK",
        truth: "UNKNOWN",
        code: UNKNOWN_CODE,
        reason: "RESULT_TRUNCATED",
        layer: LAYER,
      },
      { class: CLASS, ...COMPLETE_PROOF },
    ]);
    expect(report.coverage).toBe("UNKNOWN");
    // The truncated class contributes nothing; the proven one keeps its rows.
    expect(proofFor(report, "PROVIDER_PROCESS_LAUNCH_LOCK").itemCount).toBe(0);
    expect(proofFor(report).itemCount).toBe(1);
    expect(report.items.map((item) => item.class)).toEqual([CLASS]);
  });
});

describe("coverage sweep", () => {
  it("generated a coverage case for both classes on every arm above", () => {
    expect(GENERATED.filter((entry) => entry === CLASS)).toHaveLength(15);
    expect(GENERATED.filter((entry) => entry === "PROVIDER_PROCESS_LAUNCH_LOCK")).toHaveLength(4);
    expect(GENERATED.length).toBeGreaterThan(0);
  });
});
