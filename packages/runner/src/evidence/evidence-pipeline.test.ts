import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Hex, type ArtifactFsPort, type ArtifactRef } from "../artifacts/artifact-contract.js";
import { createArtifactStore } from "../artifacts/artifact-store.js";
import { buildProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type { ProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type { GitObserver } from "../scope/scope-contract.js";
import { observeScope } from "../scope/scope-observation.js";
import type {
  WorkspaceInputManifest,
  WorkspaceResultManifest,
} from "../workspace/workspace-contract.js";
import { buildResultManifest } from "../workspace/workspace-manifest.js";
import { rematerializeCandidate, type CandidateTreeEntry } from "./candidate-rematerialization.js";
import type { CandidateTreePort } from "./candidate-rematerialization.js";
import { buildEvidenceReceipt } from "./evidence-receipt.js";
import { buildVerificationRecipe } from "./verification-recipe.js";
import type { VerificationRecipe } from "./evidence-contract.js";
import type { ObservedVerifierExecution } from "./verifier-execution.js";

/**
 * The whole path in one place: recipe -> clean rematerialization -> observed
 * execution -> receipt. Nothing here spawns anything; the execution is an
 * observation the caller supplies, exactly as the provider adapter models one.
 */
const ARTIFACT_ROOT = join("D:", "pipeline-artifacts");
const HEAD = "0".repeat(40);
const SCHEMA_DIGEST = "c".repeat(64);
const OBSERVED_AT = "2026-08-08T09:00:00Z";
const STARTED_AT = "2026-08-08T10:00:00Z";
const COMPLETED_AT = "2026-08-08T10:00:04Z";

const INPUT_PATH = "pkg/src/base.ts";
const AUTHORED_PATH = "pkg/src/authored.ts";
const OUTPUT_PATH = "pkg/out/report.json";

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

class MemoryFs implements ArtifactFsPort {
  readonly files = new Map<string, Uint8Array>();
  private nextFd = 10;
  private readonly open = new Map<number, string>();

  openWrite(path: string): number {
    const fd = this.nextFd++;
    this.open.set(fd, path);
    return fd;
  }

  write(fd: number, bytes: Uint8Array): void {
    const path = this.open.get(fd);
    if (path === undefined) {
      throw new Error("write on unknown fd");
    }
    this.files.set(path, bytes);
  }

  fsync(): void {}

  close(fd: number): void {
    this.open.delete(fd);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  rename(from: string, to: string): void {
    const bytes = this.files.get(from);
    if (bytes === undefined) {
      throw new Error(`rename of missing ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  persistAfterRename(): void {}

  readAll(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      throw new Error(`no object at ${path}`);
    }
    return bytes;
  }

  unlink(path: string): void {
    this.files.delete(path);
  }
}

class MemoryCandidate implements CandidateTreePort {
  readonly tree = new Map<string, Uint8Array>();

  list(): readonly CandidateTreeEntry[] {
    return [...this.tree.entries()].map(([path, bytes]) => ({
      path,
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    }));
  }

  write(path: string, bytes: Uint8Array): void {
    this.tree.set(path, bytes);
  }

  remove(path: string): void {
    this.tree.delete(path);
  }
}

function fakeGit(): GitObserver {
  return {
    headCommit: () => HEAD,
    statusPorcelainV2: () => textBytes(`# branch.oid ${HEAD}\0`),
    lsFilesTracked: () => [],
    lsFilesIgnored: () => [],
    submodulePaths: () => [],
  };
}

function observationFixture(): ProviderRuntimeObservation {
  const result = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "bin/node", sha256: "a".repeat(64) }],
    reportedVersion: "1.2.3",
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: { observedAt: () => OBSERVED_AT },
  });
  if (!result.ok) {
    throw new Error(`observation fixture refused: ${result.code}`);
  }
  return result.observation;
}

interface Pipeline {
  readonly recipe: VerificationRecipe;
  readonly inputManifest: WorkspaceInputManifest;
  readonly resultManifest: WorkspaceResultManifest;
  readonly outputRef: ArtifactRef;
  readonly observation: ProviderRuntimeObservation;
  readonly candidate: MemoryCandidate;
}

/** Stages real content, builds a real recipe, and rematerializes it through the real ports. */
function runPipeline(): Pipeline {
  const fs = new MemoryFs();
  let counter = 0;
  const store = createArtifactStore({
    root: ARTIFACT_ROOT,
    fs,
    nextStagingCounter: () => counter++,
  });
  const staged = store.stageArtifact(textBytes("export const base = 1;\n"));
  const stagedOutput = store.stageArtifact(textBytes('{"passed":true}'));
  if (!staged.ok || !stagedOutput.ok) {
    throw new Error("staging fixture failed");
  }
  const recipeResult = buildVerificationRecipe({
    argv: ["node", "verify.mjs", "--strict"],
    declaredInputs: [{ path: INPUT_PATH, ref: staged.ref }],
    declaredOutputPaths: [OUTPUT_PATH],
    verifierIdentity: {
      verifierId: "moe-verifier",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: SCHEMA_DIGEST,
    },
  });
  if (!recipeResult.ok) {
    throw new Error(`recipe fixture refused: ${recipeResult.code}`);
  }
  const candidate = new MemoryCandidate();
  const remat = rematerializeCandidate({
    recipe: recipeResult.recipe,
    baseIdentity: HEAD,
    producer: { kind: "BASE" },
    artifacts: store,
    artifactFs: fs,
    artifactRoot: ARTIFACT_ROOT,
    candidate,
  });
  if (!remat.ok) {
    throw new Error(`rematerialization refused: ${remat.code} ${remat.message}`);
  }
  return {
    recipe: recipeResult.recipe,
    inputManifest: remat.inputManifest,
    resultManifest: resultManifestFor(remat.inputManifest, staged.ref, stagedOutput.ref),
    outputRef: stagedOutput.ref,
    observation: observationFixture(),
    candidate,
  };
}

function resultManifestFor(
  inputManifest: WorkspaceInputManifest,
  inputRef: ArtifactRef,
  outputRef: ArtifactRef,
): WorkspaceResultManifest {
  const scope = observeScope({
    worktreeRoot: "fixture-root",
    baseIdentity: HEAD,
    declaredScopePaths: ["pkg/src"],
    gitObserver: fakeGit(),
    pathObserver: { realpath: (path) => path, exists: () => false },
    observedAt: OBSERVED_AT,
    observerVersion: "moe-runner-scope-observer/1",
  });
  if (!scope.ok) {
    throw new Error(`scope fixture refused: ${scope.code}`);
  }
  const result = buildResultManifest({
    inputManifest,
    scopeObservation: scope.observation,
    authoredPaths: [AUTHORED_PATH],
    resultTreeEntries: [
      {
        path: INPUT_PATH,
        sha256: inputRef.sha256,
        byteLength: inputRef.byteLength,
        origin: "INHERITED",
        kind: "REGULAR",
      },
      {
        path: AUTHORED_PATH,
        sha256: outputRef.sha256,
        byteLength: outputRef.byteLength,
        origin: "AUTHORED",
        kind: "REGULAR",
      },
    ],
    declaredArtifactRefs: [outputRef],
  });
  if (!result.ok) {
    throw new Error(`result manifest fixture refused: ${result.code} ${result.message}`);
  }
  return result.manifest;
}

function executionFor(
  pipeline: Pipeline,
  overrides: Partial<ObservedVerifierExecution> = {},
): ObservedVerifierExecution {
  return {
    argv: [...pipeline.recipe.argv],
    disposition: "COMPLETED",
    exitCode: 0,
    outputs: [{ path: OUTPUT_PATH, ref: pipeline.outputRef }],
    runtimeObservation: pipeline.observation,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

describe("evidence pipeline", () => {
  it("carries a recipe through rematerialization and an observed execution into a receipt", () => {
    const pipeline = runPipeline();

    // Rematerialization put exactly the declared closure in the candidate tree.
    expect([...pipeline.candidate.tree.keys()]).toEqual([INPUT_PATH]);

    const result = buildEvidenceReceipt({
      recipe: pipeline.recipe,
      execution: executionFor(pipeline),
      inputManifest: pipeline.inputManifest,
      resultManifest: pipeline.resultManifest,
      graphIdentity: "graph-node-1",
      leaseIdentity: "lease-1",
      effectIdentity: "effect-1",
      obligations: [
        { kind: "OUTPUT_PRESENT", support: { kind: "ARTIFACT", ref: pipeline.outputRef } },
        {
          kind: "RUNTIME_PINNED",
          support: {
            kind: "RUNTIME_OBSERVATION",
            observationSha256: pipeline.observation.observationDigest,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The receipt is evidence of THIS recipe, over THIS rematerialized tree.
    expect(result.receipt.argv).toEqual([...pipeline.recipe.argv]);
    expect(result.receipt.recipeSha256).toBe(pipeline.recipe.sha256);
    expect(result.receipt.inputTreeSha256).toBe(pipeline.inputManifest.sha256);
    expect(result.receipt.resultTreeSha256).toBe(pipeline.resultManifest.sha256);
    expect(result.receipt.runtimeObservationSha256).toBe(pipeline.observation.observationDigest);
    expect(result.receipt.outputs).toEqual([{ path: OUTPUT_PATH, ref: pipeline.outputRef }]);
  });

  it("refuses end to end when the run that happened used different argv", () => {
    const pipeline = runPipeline();

    const result = buildEvidenceReceipt({
      recipe: pipeline.recipe,
      execution: executionFor(pipeline, { argv: ["node", "verify.mjs"] }),
      inputManifest: pipeline.inputManifest,
      resultManifest: pipeline.resultManifest,
      graphIdentity: "graph-node-1",
      leaseIdentity: "lease-1",
      effectIdentity: "effect-1",
      obligations: [
        { kind: "OUTPUT_PRESENT", support: { kind: "ARTIFACT", ref: pipeline.outputRef } },
      ],
    });

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARGV_DIVERGENCE");
    expect(Object.hasOwn(result, "receipt")).toBe(false);
  });
});
