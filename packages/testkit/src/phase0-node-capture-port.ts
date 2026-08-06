import { realpath } from "node:fs/promises";

import {
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
} from "@moe/contracts";

import {
  type Phase0EvidenceCapturePort,
  type Phase0EvidenceObjectLocation,
  type Phase0PathAtCommitObservation,
  type Phase0RawEvidenceObject,
  type Phase0RawRepositorySnapshot,
  type Phase0RawSourceFile,
} from "./phase0-evidence-capture.js";
import { identifyEvidence } from "./evidence-digest.js";
import { lookupGitPathAtCommit, readGitRepositorySnapshot } from "./phase0-node-git.js";
import {
  canonicalConfiguredRoot,
  containedPath,
  nodePortError,
  readStableRegularFile,
  requireConfiguredRoot,
  requireStableRoot,
  validateObjectPath,
  validateRelativeSourcePath,
  writeContentAddressedObject,
} from "./phase0-node-paths.js";

export interface NodePhase0EvidenceCapturePortOptions {
  readonly sourceRepository: string;
  readonly targetRepository: string;
}

class NodePhase0EvidenceCapturePort implements Phase0EvidenceCapturePort {
  readonly #sourceRepository: string;
  readonly #targetRepository: string;

  public constructor(options: NodePhase0EvidenceCapturePortOptions) {
    this.#sourceRepository = canonicalConfiguredRoot(options.sourceRepository, "SOURCE");
    this.#targetRepository = canonicalConfiguredRoot(options.targetRepository, "TARGET");
    const rootsCollide = process.platform === "win32"
      ? this.#sourceRepository.toLowerCase() === this.#targetRepository.toLowerCase()
      : this.#sourceRepository === this.#targetRepository;
    if (rootsCollide) {
      nodePortError("PHASE0_NODE_REPOSITORY_ROOTS_COLLIDE", this.#sourceRepository);
    }
  }

  public async lookupPathAtCommit(
    sourceRepository: string,
    commit: string,
    relativePath: string,
  ): Promise<Phase0PathAtCommitObservation> {
    this.#requireSource(sourceRepository);
    validateRelativeSourcePath(relativePath);
    await requireStableRoot(this.#sourceRepository, "SOURCE");
    const identity = await lookupGitPathAtCommit(
      this.#sourceRepository,
      commit,
      relativePath,
    );
    return Object.freeze({
      commit,
      identity,
      relativePath,
      sourceRepository: this.#sourceRepository,
    });
  }

  public now(): string {
    return new Date().toISOString();
  }

  public async readEvidenceObject(
    targetRepository: string,
    objectPath: string,
  ): Promise<Phase0RawEvidenceObject> {
    this.#requireTarget(targetRepository);
    const validated = validateObjectPath(objectPath);
    await requireStableRoot(this.#targetRepository, "TARGET");
    const objectFile = containedPath(
      this.#targetRepository,
      validated.parts,
      "PHASE0_NODE_TARGET_PATH_ESCAPE",
    );
    const bytes = await readStableRegularFile(objectFile, "PHASE0_NODE_TARGET_PATH_ESCAPE");
    if (identifyEvidence(bytes).digest !== validated.digest) {
      nodePortError("PHASE0_NODE_OBJECT_DIGEST_MISMATCH", objectPath);
    }
    return Object.freeze({
      bytes,
      objectPath,
      targetRepository: this.#targetRepository,
    });
  }

  public async readRepositorySnapshot(
    sourceRepository: string,
    statusCommand: string,
  ): Promise<Phase0RawRepositorySnapshot> {
    this.#requireSource(sourceRepository);
    if (statusCommand !== PHASE0_GIT_STATUS_COMMAND) {
      nodePortError("PHASE0_NODE_STATUS_COMMAND_MISMATCH", statusCommand);
    }
    await requireStableRoot(this.#sourceRepository, "SOURCE");
    return readGitRepositorySnapshot(this.#sourceRepository, statusCommand);
  }

  public async readSourceFile(
    sourceRepository: string,
    relativePath: string,
  ): Promise<Phase0RawSourceFile> {
    this.#requireSource(sourceRepository);
    const segments = validateRelativeSourcePath(relativePath);
    await requireStableRoot(this.#sourceRepository, "SOURCE");
    const sourceFile = containedPath(
      this.#sourceRepository,
      segments,
      "PHASE0_NODE_SOURCE_PATH_ESCAPE",
    );
    const bytes = await readStableRegularFile(sourceFile, "PHASE0_NODE_SOURCE_PATH_ESCAPE");
    const resolvedPath = await realpath(sourceFile);
    return Object.freeze({
      bytes,
      relativePath,
      resolvedPath,
      sourceRepository: this.#sourceRepository,
    });
  }

  public async writeEvidenceObject(
    targetRepository: string,
    objectPath: string,
    bytes: Uint8Array,
  ): Promise<Phase0EvidenceObjectLocation> {
    this.#requireTarget(targetRepository);
    await writeContentAddressedObject(this.#targetRepository, objectPath, bytes);
    return Object.freeze({ objectPath, targetRepository: this.#targetRepository });
  }

  #requireSource(sourceRepository: string): void {
    requireConfiguredRoot(sourceRepository, this.#sourceRepository, "SOURCE");
  }

  #requireTarget(targetRepository: string): void {
    requireConfiguredRoot(targetRepository, this.#targetRepository, "TARGET");
  }
}

export function createNodePhase0EvidenceCapturePort(
  options: NodePhase0EvidenceCapturePortOptions,
): Phase0EvidenceCapturePort {
  return new NodePhase0EvidenceCapturePort(options);
}

export function createDefaultNodePhase0EvidenceCapturePort(
): Phase0EvidenceCapturePort {
  return createNodePhase0EvidenceCapturePort({
    sourceRepository: PHASE0_SOURCE_REPOSITORY,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  });
}
