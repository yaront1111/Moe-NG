import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  refMatches,
  sha256Hex,
  type ArtifactFsPort,
  type ArtifactRef,
} from "../artifacts/artifact-contract.js";
import { createArtifactStore } from "../artifacts/artifact-store.js";
import { buildInputManifest } from "../workspace/workspace-manifest.js";
import type { WorkspaceInputManifest } from "../workspace/workspace-contract.js";
import type { DeclaredInput, VerificationRecipe } from "./evidence-contract.js";
import { buildVerificationRecipe } from "./verification-recipe.js";
import {
  rematerializeCandidate,
  type CandidateTreeEntry,
  type CandidateTreePort,
  type RematerializeCandidateInput,
} from "./candidate-rematerialization.js";

const ROOT = join("D:", "artifact-root");
const BASE = "0".repeat(40);
const SCHEMA_DIGEST = "c".repeat(64);

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Minimal in-memory ArtifactFsPort; the only real fs adapter lives in artifact-node-fs. */
class MemoryFs implements ArtifactFsPort {
  readonly files = new Map<string, Uint8Array>();
  private readonly swapAfterReads = new Map<string, { readonly after: number; readonly bytes: Uint8Array }>();
  private readonly readCounts = new Map<string, number>();

  /**
   * Lets the NEXT read of a path answer honestly and every later one answer with
   * different bytes — the swap that happens between the store's verification and
   * the materializing read. Anchored to the reads already consumed by staging,
   * because a fixed threshold would fire during setup instead.
   */
  armSwapAfterNextRead(path: string, bytes: Uint8Array): void {
    this.swapAfterReads.set(path, { after: (this.readCounts.get(path) ?? 0) + 1, bytes });
  }
  private nextFd = 10;
  private readonly open = new Map<number, { path: string; bytes: Uint8Array }>();

  openWrite(path: string): number {
    const fd = this.nextFd++;
    this.open.set(fd, { path, bytes: new Uint8Array(0) });
    return fd;
  }

  write(fd: number, bytes: Uint8Array): void {
    const handle = this.open.get(fd);
    if (handle === undefined) {
      throw new Error("write on unknown fd");
    }
    this.files.set(handle.path, bytes);
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
    const count = (this.readCounts.get(path) ?? 0) + 1;
    this.readCounts.set(path, count);
    const swap = this.swapAfterReads.get(path);
    if (swap !== undefined && count > swap.after) {
      return swap.bytes;
    }
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

/** In-memory candidate location. `plantAfterFirstWrite` models bytes appearing from elsewhere. */
class MemoryCandidate implements CandidateTreePort {
  readonly tree = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly removes: string[] = [];
  plantAfterFirstWrite: ReadonlyArray<readonly [string, Uint8Array]> = [];
  dropAfterFirstWrite: readonly string[] = [];
  failOn: "list" | "write" | null = null;
  private planted = false;

  list(): readonly CandidateTreeEntry[] {
    if (this.failOn === "list") {
      throw new Error("injected candidate list fault");
    }
    return [...this.tree.entries()].map(([path, bytes]) => ({
      path,
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    }));
  }

  write(path: string, bytes: Uint8Array): void {
    if (this.failOn === "write") {
      throw new Error("injected candidate write fault");
    }
    this.writes.push(path);
    this.tree.set(path, bytes);
    if (!this.planted) {
      this.planted = true;
      for (const [plantedPath, plantedBytes] of this.plantAfterFirstWrite) {
        this.tree.set(plantedPath, plantedBytes);
      }
      for (const dropped of this.dropAfterFirstWrite) {
        this.tree.delete(dropped);
      }
    }
  }

  remove(path: string): void {
    this.removes.push(path);
    this.tree.delete(path);
  }
}

interface Fixture {
  readonly fs: MemoryFs;
  readonly candidate: MemoryCandidate;
  readonly recipe: VerificationRecipe;
  readonly refs: ReadonlyMap<string, ArtifactRef>;
  readonly input: RematerializeCandidateInput;
}

const CONTENT: ReadonlyArray<readonly [string, string]> = [
  ["src/a.ts", "alpha bytes"],
  ["src/b.ts", "bravo bytes"],
];

function fixture(declaredOutputPaths: readonly string[] = ["out/report.json"]): Fixture {
  const fs = new MemoryFs();
  let counter = 0;
  const store = createArtifactStore({ root: ROOT, fs, nextStagingCounter: () => counter++ });
  const refs = new Map<string, ArtifactRef>();
  const declaredInputs: DeclaredInput[] = [];
  for (const [path, text] of CONTENT) {
    const staged = store.stageArtifact(textBytes(text));
    if (!staged.ok) {
      throw new Error(`staging fixture failed: ${staged.code}`);
    }
    refs.set(path, staged.ref);
    declaredInputs.push({ path, ref: staged.ref });
  }
  const built = buildVerificationRecipe({
    argv: ["node", "verify.mjs"],
    declaredInputs,
    declaredOutputPaths,
    verifierIdentity: {
      verifierId: "moe-verifier",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: SCHEMA_DIGEST,
    },
  });
  if (!built.ok) {
    throw new Error(`recipe fixture refused: ${built.code}`);
  }
  const candidate = new MemoryCandidate();
  return {
    fs,
    candidate,
    recipe: built.recipe,
    refs,
    input: {
      recipe: built.recipe,
      baseIdentity: BASE,
      producer: { kind: "BASE" },
      artifacts: store,
      artifactFs: fs,
      artifactRoot: ROOT,
      candidate,
    },
  };
}

const addressOf = (ref: ArtifactRef): string => join(ROOT, "objects", ref.sha256);

function manifestOrThrow(paths: readonly string[], refs: ReadonlyMap<string, ArtifactRef>): WorkspaceInputManifest {
  const result = buildInputManifest({
    baseIdentity: BASE,
    entries: paths.map((path) => {
      const ref = refs.get(path);
      if (ref === undefined) {
        throw new Error(`no fixture ref for ${path}`);
      }
      return { path, sha256: ref.sha256, byteLength: ref.byteLength, producer: { kind: "BASE" as const } };
    }),
  });
  if (!result.ok) {
    throw new Error(`manifest fixture refused: ${result.code}`);
  }
  return result.manifest;
}

describe("rematerializeCandidate", () => {
  it("materializes exactly the declared closure and binds the workspace input tree", () => {
    const { input, candidate, refs } = fixture();

    const result = rematerializeCandidate(input);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(candidate.writes).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.materializedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    // The tree identity is the workspace foundation's, not a second one.
    expect(result.inputManifest.sha256).toBe(manifestOrThrow(["src/a.ts", "src/b.ts"], refs).sha256);
    expect(candidate.removes).toEqual([]);
  });

  it("refuses a candidate location that is not empty with RUNNER_EVIDENCE_CANDIDATE_NOT_EMPTY", () => {
    const { input, candidate } = fixture();
    candidate.tree.set("stale/prior.txt", textBytes("left over"));

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_CANDIDATE_NOT_EMPTY");
    expect(result.ok === false && result.layer).toBe("REMATERIALIZATION");
    // A stale prior tree cannot silently contribute bytes: nothing is written at all.
    expect(candidate.writes).toEqual([]);
  });

  // FOREIGN and UNDECLARED are separate fixtures on purpose: one "bad bytes" case
  // would let either half regress unseen.
  it("refuses FOREIGN bytes at a path the recipe never declared", () => {
    const { input, candidate } = fixture();
    candidate.plantAfterFirstWrite = [["vendor/foreign.bin", textBytes("not ours")]];

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_FOREIGN_BYTES");
    expect(result.ok === false && result.path).toBe("vendor/foreign.bin");
  });

  it("refuses UNDECLARED bytes produced into a declared output slot no ref declares", () => {
    const { input, candidate } = fixture(["out/report.json"]);
    candidate.plantAfterFirstWrite = [["out/report.json", textBytes("produced early")]];

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_UNDECLARED_BYTES");
    expect(result.ok === false && result.path).toBe("out/report.json");
  });

  it("refuses when a declared path is absent from the rematerialized tree", () => {
    const { input, candidate } = fixture();
    candidate.dropAfterFirstWrite = ["src/a.ts"];

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_DECLARED_BYTES_MISSING");
    expect(result.ok === false && result.path).toBe("src/a.ts");
  });

  it("refuses when the artifact store cannot verify a declared ref", () => {
    const { input, fs, refs } = fixture();
    const ref = refs.get("src/a.ts");
    expect(ref).toBeDefined();
    const foreign = textBytes("swapped at rest");
    expect(refMatches(foreign, ref!)).toBe(false);
    fs.files.set(addressOf(ref!), foreign);

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARTIFACT_UNVERIFIABLE");
    expect(result.ok === false && result.layer).toBe("REMATERIALIZATION");
  });

  it("refuses when the bytes read back no longer match the ref that was just verified", () => {
    const { input, fs, refs } = fixture();
    const ref = refs.get("src/a.ts");
    expect(ref).toBeDefined();
    const swapped = textBytes("swapped after verification");
    // refMatches is the production surface; the fixture is proven hostile with it.
    expect(refMatches(swapped, ref!)).toBe(false);
    fs.armSwapAfterNextRead(addressOf(ref!), swapped);

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_REF_MISMATCH");
    expect(result.ok === false && result.path).toBe("src/a.ts");
  });

  it("refuses a recipe whose recorded digest does not describe the recipe it claims to", () => {
    const { input, recipe } = fixture();
    const tampered: VerificationRecipe = { ...recipe, sha256: "d".repeat(64) };

    const result = rematerializeCandidate({ ...input, recipe: tampered });

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH");
  });

  it("refuses an expected input manifest whose recorded digest has been edited", () => {
    const { input, refs } = fixture();
    const sealed = manifestOrThrow(["src/a.ts", "src/b.ts"], refs);
    const tampered: WorkspaceInputManifest = { ...sealed, sha256: "e".repeat(64) };

    const result = rematerializeCandidate({ ...input, expectedInputManifest: tampered });

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_MANIFEST_TAMPERED");
  });

  it("refuses a well-sealed expected manifest that describes a different input tree", () => {
    const { input, refs } = fixture();
    const divergent = manifestOrThrow(["src/a.ts"], refs);

    const result = rematerializeCandidate({ ...input, expectedInputManifest: divergent });

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_INPUT_TREE_DIVERGENCE");
  });

  it("leaves no bytes behind when it refuses after writing", () => {
    const { input, candidate } = fixture();
    candidate.plantAfterFirstWrite = [["vendor/foreign.bin", textBytes("not ours")]];

    const result = rematerializeCandidate(input);

    expect(result.ok).toBe(false);
    expect(candidate.writes.length).toBeGreaterThan(0);
    expect(candidate.removes).toEqual(candidate.writes);
    for (const written of candidate.writes) {
      expect(candidate.tree.has(written)).toBe(false);
    }
  });

  it("turns a throwing candidate port into a coded refusal", () => {
    const { input, candidate } = fixture();
    candidate.failOn = "write";

    const result = rematerializeCandidate(input);

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED");
  });

  it("exposes no input manifest on the refusal arm", () => {
    const { input, candidate } = fixture();
    candidate.tree.set("stale/prior.txt", textBytes("left over"));

    const result = rematerializeCandidate(input);

    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "inputManifest")).toBe(false);
  });
});
