/**
 * The registration seam for this slice's two classes, proven WITHOUT editing the
 * aggregate.
 *
 * `createRecoveryInventoryRegistry` takes an immutable caller-supplied tuple
 * precisely so a sibling adapter slice cannot change its behaviour by importing
 * it, so every arm here composes its own tuple exactly as the daemon coordinator
 * will. `recovery-inventory.ts` is not touched by this task.
 *
 * The last describe composes ALL FOUR classes — the first point at which the whole
 * node-side recovery-inventory surface exists at once. Slice 2's registrations are
 * imported read-only; neither of its files is modified.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
} from "@moe/runner";
import type {
  RecoveryInventoryClass,
  RecoveryInventoryRegistration,
  RecoveryInventoryReport,
} from "@moe/runner";

import { createNodeArtifactFs } from "../artifacts/artifact-node-fs.js";
import { createArtifactStore } from "../artifacts/artifact-store.js";
import { MAX_SCOPE_OBSERVATION_BYTES, createNodeGitObserver, hermeticGitEnvironment } from "../scope/scope-git.js";
import { artifactObjectInventoryRegistration } from "./artifact-object-inventory.js";
import { gitIntegrationInventoryRegistration } from "./git-integration-inventory.js";
import { providerLockInventoryRegistration, type ProviderLockInventoryInput } from "./provider-lock-inventory.js";
import { workspaceInventoryRegistration } from "./workspace-inventory.js";

const GIT = "GIT_INTEGRATION_ON_DISK";
const ARTIFACT = "ARTIFACT_OBJECT_STAGING";
const PROVIDER = "PROVIDER_PROCESS_LAUNCH_LOCK";
const WORKSPACE = "WORKSPACE";
const LAYER = "INVENTORY_ADAPTER";
const UNKNOWN_CODE = "RECOVERY_INVENTORY_COVERAGE_UNKNOWN";
const PROJECT = "moe-next";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const CLOCK = { observedAt: () => OBSERVED_AT };
const BASE = "1".repeat(40);
const ENV = hermeticGitEnvironment(process.env);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moe-recovery-seam-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    env: ENV,
    maxBuffer: MAX_SCOPE_OBSERVATION_BYTES,
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30_000,
    windowsHide: true,
  });
}

function directory(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function gitRegistration(repositoryName = "repo"): RecoveryInventoryRegistration {
  const repository = directory(repositoryName);
  git(repository, ["init"]);
  git(repository, ["checkout", "-b", "base"]);
  writeFileSync(join(repository, "tracked.txt"), "tracked");
  git(repository, ["add", "--", "tracked.txt"]);
  git(repository, [
    "-c", "user.name=Moe", "-c", "user.email=moe@example.invalid",
    "commit", "-m", "base",
  ]);
  return gitIntegrationInventoryRegistration({
    observer: createNodeGitObserver(repository, ENV),
    clock: CLOCK,
  });
}

/** An absent repository: the directory exists, no repository does. */
function unreadableGitRegistration(): RecoveryInventoryRegistration {
  return gitIntegrationInventoryRegistration({
    observer: createNodeGitObserver(directory("not-a-repo"), ENV),
    clock: CLOCK,
  });
}

function artifactRegistration(storeName = "store"): RecoveryInventoryRegistration {
  const storeRoot = directory(storeName);
  let counter = 0;
  const store = createArtifactStore({
    root: storeRoot,
    fs: createNodeArtifactFs(),
    nextStagingCounter: () => (counter += 1),
  });
  expect(store.stageArtifact(new TextEncoder().encode("alpha")).ok).toBe(true);
  return artifactObjectInventoryRegistration({ store, clock: CLOCK });
}

const PLATFORM = { os: "windows", arch: "x64", osVersion: "10.0.26200" };

/** Slice 2's fixture shape, used read-only so the four-class arm can exist. */
function providerInput(): ProviderLockInventoryInput {
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
      processRecords: () => [{ processIdentity: "pid-1", exit: { kind: "EXITED", code: 0 }, reconciliation: null }],
    },
  };
}

function workspaceRegistration(): RecoveryInventoryRegistration {
  const rootPath = directory("workspace");
  writeFileSync(join(rootPath, "alpha.txt"), "alpha");
  return workspaceInventoryRegistration({
    clock: CLOCK,
    port: {
      list: () => ({
        workspaces: [
          { workspaceRef: "ws/alpha", baseIdentity: BASE, rootPath, producer: { kind: "BASE" }, result: null },
        ],
        listingComplete: true,
      }),
    },
  });
}

function request(classes: readonly RecoveryInventoryClass[]): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: "a".repeat(64) },
    incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: "b".repeat(64) },
    window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
    configuredClasses: [...classes],
  };
}

async function collect(
  classes: readonly RecoveryInventoryClass[],
  registrations: readonly RecoveryInventoryRegistration[],
): Promise<RecoveryInventoryReport> {
  const result = await collectRecoveryInventory(
    request(classes),
    createRecoveryInventoryRegistry(registrations),
  );
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

/** Whole-object equality per proof: never `.length`, never truthiness. */
function proofShapes(report: RecoveryInventoryReport): readonly Record<string, unknown>[] {
  return report.proofs.map((proof) => ({
    class: proof.class,
    truth: proof.truth,
    code: proof.code,
    reason: proof.reason,
    layer: proof.layer,
  }));
}

const complete = (cls: string): Record<string, unknown> => ({
  class: cls,
  truth: "COMPLETE",
  code: null,
  reason: null,
  layer: LAYER,
});

const unknown = (cls: string, reason: string): Record<string, unknown> => ({
  class: cls,
  truth: "UNKNOWN",
  code: UNKNOWN_CODE,
  reason,
  layer: LAYER,
});

const BOTH: readonly RecoveryInventoryClass[] = [GIT, ARTIFACT];

describe("the two classes this slice owns, composed through the aggregate", () => {
  it("reports COMPLETE for both only when both enumerators proved completeness", async () => {
    const report = await collect(BOTH, [gitRegistration(), artifactRegistration()]);
    expect(proofShapes(report)).toEqual([complete(GIT), complete(ARTIFACT)]);
    expect(report.coverage).toBe("COMPLETE");
    // One branch ref plus one staged object: both classes contributed rows.
    expect(report.items.map((item) => item.class)).toEqual([GIT, ARTIFACT]);
    for (const proof of report.proofs) {
      expect(proof.itemCount).toBe(1);
      expect(proof.negativeProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("answers ENUMERATOR_UNREGISTERED for a configured class nobody registered", async () => {
    const report = await collect(BOTH, [artifactRegistration()]);
    expect(proofShapes(report)).toEqual([
      unknown(GIT, "ENUMERATOR_UNREGISTERED"),
      complete(ARTIFACT),
    ]);
    expect(report.coverage).toBe("UNKNOWN");
  });

  it("does not let the artifact class vanish when only the git slice is registered", async () => {
    const report = await collect(BOTH, [gitRegistration()]);
    expect(proofShapes(report)).toEqual([
      complete(GIT),
      unknown(ARTIFACT, "ENUMERATOR_UNREGISTERED"),
    ]);
    expect(report.coverage).toBe("UNKNOWN");
  });

  it("never lets a later COMPLETE launder an earlier UNKNOWN", async () => {
    const report = await collect(BOTH, [unreadableGitRegistration(), artifactRegistration()]);
    expect(proofShapes(report)).toEqual([
      unknown(GIT, "ENUMERATOR_UNAVAILABLE"),
      complete(ARTIFACT),
    ]);
    expect(report.coverage).toBe("UNKNOWN");
    // The unproven class contributes nothing; the proven one keeps its rows.
    expect(report.proofs[0]?.itemCount).toBe(0);
    expect(report.items.map((item) => item.class)).toEqual([ARTIFACT]);
  });

  it("keeps a class UNKNOWN when its enumerator could not prove it saw everything", async () => {
    const store = createArtifactStore({
      root: join(root, "never-created"),
      fs: createNodeArtifactFs(),
      nextStagingCounter: () => 1,
    });
    const report = await collect(BOTH, [
      gitRegistration(),
      artifactObjectInventoryRegistration({ store, clock: CLOCK }),
    ]);
    expect(proofShapes(report)).toEqual([
      complete(GIT),
      unknown(ARTIFACT, "ENUMERATOR_UNAVAILABLE"),
    ]);
    expect(report.items.map((item) => item.class)).toEqual([GIT]);
  });
});

describe("all four node-side classes at once", () => {
  it("reports every configured class exactly once, in frozen vocabulary order", async () => {
    const report = await collect([PROVIDER, WORKSPACE, GIT, ARTIFACT], [
      // Deliberately out of vocabulary order: the report must not depend on it.
      artifactRegistration(),
      gitRegistration(),
      workspaceRegistration(),
      providerLockInventoryRegistration(providerInput()),
    ]);
    expect(proofShapes(report)).toEqual([
      complete(PROVIDER),
      complete(WORKSPACE),
      complete(GIT),
      complete(ARTIFACT),
    ]);
    expect(report.coverage).toBe("COMPLETE");
    expect(report.items.map((item) => item.class)).toEqual([PROVIDER, WORKSPACE, GIT, ARTIFACT]);
    expect(report.inventoryDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("leaves the other three intact when one of the four is unregistered", async () => {
    const report = await collect([PROVIDER, WORKSPACE, GIT, ARTIFACT], [
      providerLockInventoryRegistration(providerInput()),
      workspaceRegistration(),
      artifactRegistration(),
    ]);
    expect(proofShapes(report)).toEqual([
      complete(PROVIDER),
      complete(WORKSPACE),
      unknown(GIT, "ENUMERATOR_UNREGISTERED"),
      complete(ARTIFACT),
    ]);
    expect(report.coverage).toBe("UNKNOWN");
  });
});
