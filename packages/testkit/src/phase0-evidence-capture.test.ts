import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type GitObjectFormat,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { capturePhase0Evidence } from "./phase0-evidence-capture.js";

const DESIGN_METADATA = PHASE0_ROLE_METADATA[0]!;
const CHARTER_METADATA = PHASE0_ROLE_METADATA[1]!;
const BASE_HEAD = "454a6012e955e5d9d37f050330c4a58111be23f4";

interface RepositorySnapshot {
  readonly head: string;
  readonly objectFormat: GitObjectFormat;
  readonly sourceRepository: string;
  readonly statusCommand: string;
  readonly statusBytes: Uint8Array;
}

interface HeadPathIdentity {
  readonly objectType: string;
  readonly oid: string;
}

interface PathAtCommitObservation {
  readonly commit: string;
  readonly identity: HeadPathIdentity | null;
  readonly relativePath: string;
  readonly sourceRepository: string;
}

interface EvidenceObjectLocation {
  readonly objectPath: string;
  readonly targetRepository: string;
}

interface RawEvidenceObject extends EvidenceObjectLocation {
  readonly bytes: Uint8Array;
}

interface RawSourceFile {
  readonly bytes: Uint8Array;
  readonly relativePath: string;
  readonly resolvedPath: string;
  readonly sourceRepository: string;
}

class FakeCapturePort {
  public readonly files = new Map<string, Uint8Array>();
  public readonly commitPaths = new Map<string, HeadPathIdentity>();
  public readonly lookupCommits: string[] = [];
  public readonly objects = new Map<string, Uint8Array>();
  public aliasObjectStore = false;
  public ambientHead = BASE_HEAD;
  public clearObjectsOnNow = false;
  public corruptObjectReadAt = Number.POSITIVE_INFINITY;
  public reportedLookupCommit: string | null = null;
  public reportedLookupPath: string | null = null;
  public reportedLookupRepository: string | null = null;
  public reportedSourceFileRelativePath: string | null = null;
  public reportedSourceFileRepository: string | null = null;
  public reportedSourceResolvedPath: string | null = null;
  public reportedTargetRepository: string = PHASE0_TARGET_REPOSITORY;
  public readonly requestedSourceRepositories: string[] = [];
  public readonly requestedStatusCommands: string[] = [];
  public readonly requestedTargetRepositories: string[] = [];
  public useSnapshotGetters = false;
  public mutatePathOnSecondRead: string | null = null;
  public snapshots: RepositorySnapshot[];

  private aliasedObject: Uint8Array | null = null;
  private readonly readCounts = new Map<string, number>();
  private objectReadCount = 0;

  public constructor() {
    const statusBytes = new TextEncoder().encode("? phase0-inputs\0");
    this.snapshots = [
      {
        head: BASE_HEAD,
        objectFormat: "sha1",
        sourceRepository: PHASE0_SOURCE_REPOSITORY,
        statusCommand: PHASE0_GIT_STATUS_COMMAND,
        statusBytes,
      },
      {
        head: BASE_HEAD,
        objectFormat: "sha1",
        sourceRepository: PHASE0_SOURCE_REPOSITORY,
        statusCommand: PHASE0_GIT_STATUS_COMMAND,
        statusBytes,
      },
    ];

    for (const { relativePath, role } of PHASE0_ROLE_METADATA) {
      this.files.set(
        win32.join(PHASE0_SOURCE_REPOSITORY, relativePath),
        new TextEncoder().encode(`# ${role}\n`),
      );
    }
  }

  public async readSourceFile(
    sourceRepository: string,
    relativePath: string,
  ): Promise<RawSourceFile> {
    const absolutePath = win32.join(sourceRepository, relativePath);
    const count = (this.readCounts.get(absolutePath) ?? 0) + 1;
    this.readCounts.set(absolutePath, count);
    const bytes = this.files.get(absolutePath);
    if (bytes === undefined || bytes === null) {
      throw new Error(`missing fake source: ${absolutePath}`);
    }
    const sourceBytes = this.mutatePathOnSecondRead === absolutePath && count > 1
      ? new TextEncoder().encode("changed during capture\n")
      : bytes.slice();
    return {
      bytes: sourceBytes,
      relativePath: this.reportedSourceFileRelativePath ?? relativePath,
      resolvedPath: this.reportedSourceResolvedPath ?? absolutePath,
      sourceRepository: this.reportedSourceFileRepository ?? sourceRepository,
    };
  }

  public async readRepositorySnapshot(
    sourceRepository: string,
    statusCommand: string,
  ): Promise<RepositorySnapshot> {
    this.requestedSourceRepositories.push(sourceRepository);
    this.requestedStatusCommands.push(statusCommand);
    const snapshot = this.snapshots.shift();
    if (snapshot === undefined) {
      throw new Error("unexpected repository snapshot read");
    }
    if (!this.useSnapshotGetters) {
      return {
        ...snapshot,
        statusBytes: snapshot.statusBytes.slice(),
      };
    }

    let formatReads = 0;
    let headReads = 0;
    return Object.defineProperties({}, {
      head: {
        enumerable: true,
        get: () => {
          headReads += 1;
          return headReads === 1 ? snapshot.head : "NOT_A_HEAD";
        },
      },
      objectFormat: {
        enumerable: true,
        get: () => {
          formatReads += 1;
          return formatReads === 1 ? snapshot.objectFormat : "bogus";
        },
      },
      statusBytes: {
        enumerable: true,
        value: snapshot.statusBytes.slice(),
      },
      sourceRepository: {
        enumerable: true,
        value: snapshot.sourceRepository,
      },
      statusCommand: {
        enumerable: true,
        value: snapshot.statusCommand,
      },
    }) as RepositorySnapshot;
  }

  // Kept only to prove that capture never resolves an ambient, mutable HEAD.
  public async lookupHeadPath(relativePath: string): Promise<HeadPathIdentity | null> {
    return this.commitPaths.get(this.commitPathKey(this.ambientHead, relativePath)) ?? null;
  }

  public async lookupPathAtCommit(
    sourceRepository: string,
    commit: string,
    relativePath: string,
  ): Promise<PathAtCommitObservation> {
    this.lookupCommits.push(commit);
    return {
      commit: this.reportedLookupCommit ?? commit,
      identity: this.commitPaths.get(this.commitPathKey(commit, relativePath)) ?? null,
      relativePath: this.reportedLookupPath ?? relativePath,
      sourceRepository: this.reportedLookupRepository ?? sourceRepository,
    };
  }

  public setCommitPath(
    commit: string,
    relativePath: string,
    identity: HeadPathIdentity,
  ): void {
    this.commitPaths.set(this.commitPathKey(commit, relativePath), identity);
  }

  public async writeEvidenceObject(
    targetRepository: string,
    objectPath: string,
    bytes: Uint8Array,
  ): Promise<EvidenceObjectLocation> {
    this.requestedTargetRepositories.push(targetRepository);
    if (this.aliasObjectStore) {
      this.aliasedObject = bytes.slice();
    } else {
      this.objects.set(objectPath, bytes.slice());
    }
    return {
      objectPath,
      targetRepository: this.reportedTargetRepository,
    };
  }

  public async readEvidenceObject(
    targetRepository: string,
    objectPath: string,
  ): Promise<RawEvidenceObject> {
    this.requestedTargetRepositories.push(targetRepository);
    this.objectReadCount += 1;
    const bytes = this.aliasObjectStore ? this.aliasedObject : this.objects.get(objectPath);
    if (bytes === undefined || bytes === null) {
      throw new Error(`missing fake object: ${objectPath}`);
    }
    if (this.objectReadCount === this.corruptObjectReadAt) {
      return {
        bytes: new TextEncoder().encode("corrupted object\n"),
        objectPath,
        targetRepository: this.reportedTargetRepository,
      };
    }
    return {
      bytes: bytes.slice(),
      objectPath,
      targetRepository: this.reportedTargetRepository,
    };
  }

  public now(): string {
    if (this.clearObjectsOnNow) {
      this.objects.clear();
    }
    return "2026-08-06T06:00:00.000Z";
  }

  private commitPathKey(commit: string, relativePath: string): string {
    return `${commit}\0${relativePath}`;
  }
}

type CapturePhase0Evidence = (port: FakeCapturePort) => Promise<unknown>;

async function loadCapture(): Promise<CapturePhase0Evidence> {
  return capturePhase0Evidence as CapturePhase0Evidence;
}

function gitBlobOid(bytes: Uint8Array, format: GitObjectFormat): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

describe("capturePhase0Evidence", () => {
  it("derives and verifies the six-role manifest from exact bytes", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const manifest = (await capture(port)) as {
      readonly captureStatus: string;
      readonly entries: readonly {
        readonly objectPath: string;
        readonly owner: string;
        readonly relativePath: string;
        readonly role: string;
        readonly sourceState: { readonly state: string };
      }[];
      readonly sourceAfter: object;
      readonly sourceBefore: object;
    };

    expect(manifest.captureStatus).toBe("VERIFIED");
    expect(manifest.entries.map(({ role }) => role)).toEqual(
      PHASE0_ROLE_METADATA.map(({ role }) => role),
    );
    expect(manifest.entries.map(({ owner }) => owner)).toEqual(
      PHASE0_ROLE_METADATA.map(({ owner }) => owner),
    );
    expect(manifest.entries.map(({ sourceState }) => sourceState.state)).toEqual(
      Array.from({ length: 6 }, () => "ABSENT_AT_HEAD"),
    );
    expect(port.objects.size).toBe(7);
    expect(new Set(port.requestedSourceRepositories)).toEqual(
      new Set([PHASE0_SOURCE_REPOSITORY]),
    );
    expect(new Set(port.requestedStatusCommands)).toEqual(
      new Set([PHASE0_GIT_STATUS_COMMAND]),
    );
    expect(new Set(port.requestedTargetRepositories)).toEqual(
      new Set([PHASE0_TARGET_REPOSITORY]),
    );
    expect(
      manifest.entries.every(({ objectPath }) => /^objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(objectPath)),
    ).toBe(true);
    expect([
      Object.isFrozen(manifest),
      Object.isFrozen(manifest.entries),
      Object.isFrozen(manifest.entries[0]),
      Object.isFrozen(manifest.entries[0]?.sourceState),
      Object.isFrozen(manifest.sourceBefore),
      Object.isFrozen(manifest.sourceAfter),
    ]).toEqual([true, true, true, true, true, true]);
  });

  it("rejects source mutation during capture", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.mutatePathOnSecondRead = win32.join(
      PHASE0_SOURCE_REPOSITORY,
      DESIGN_METADATA.relativePath,
    );

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_SOURCE_CHANGED_DURING_CAPTURE: rebuild-design",
    );
  });

  it("rejects source bytes whose resolved path escapes the canonical repository", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.reportedSourceResolvedPath = "D:\\wrong-repository\\wrong.md";

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_SOURCE_PATH_MISMATCH: rebuild-design",
    );
  });

  it.each([
    [
      "reportedSourceFileRepository",
      "D:\\wrong-repository",
      "PHASE0_SOURCE_REPOSITORY_MISMATCH",
    ],
    [
      "reportedSourceFileRelativePath",
      "docs/plans/wrong.md",
      "PHASE0_SOURCE_RELATIVE_PATH_MISMATCH",
    ],
  ] as const)("rejects a mismatched source-file receipt %s", async (field, value, code) => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port[field] = value;

    await expect(capture(port)).rejects.toThrowError(`${code}: rebuild-design`);
  });

  it("rejects object-store corruption after write", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.corruptObjectReadAt = 2;

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_OBJECT_STORE_VERIFY_FAILED: rebuild-design",
    );
  });

  it("rejects an object store that aliases every content address to one slot", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.aliasObjectStore = true;

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_OBJECT_STORE_VERIFY_FAILED: final-rebuild-design",
    );
  });

  it("performs final object verification after every other port interaction", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.clearObjectsOnNow = true;

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_OBJECT_STORE_VERIFY_FAILED: final-repository-status-before",
    );
  });

  it("rejects an object-store receipt from the wrong target repository", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.reportedTargetRepository = "D:\\wrong-target";

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_TARGET_REPOSITORY_MISMATCH: repository-status-before",
    );
  });

  it("rejects duplicate document bytes across roles", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const firstPath = win32.join(PHASE0_SOURCE_REPOSITORY, DESIGN_METADATA.relativePath);
    const secondPath = win32.join(PHASE0_SOURCE_REPOSITORY, CHARTER_METADATA.relativePath);
    port.files.set(secondPath, port.files.get(firstPath)!.slice());

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_DUPLICATE_DOCUMENT_BYTES: rebuild-charter",
    );
  });

  it("rejects a repository mutation during capture", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.snapshots[1] = {
      ...port.snapshots[1]!,
      head: "a".repeat(40),
    };

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_REPOSITORY_CHANGED_DURING_CAPTURE: HEAD",
    );
  });

  it.each([
    ["sourceRepository", "D:\\wrong-repository", "PHASE0_SOURCE_REPOSITORY_MISMATCH"],
    ["statusCommand", "git status --short", "PHASE0_STATUS_COMMAND_MISMATCH"],
  ] as const)("rejects a snapshot with the wrong %s", async (field, value, code) => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.snapshots[0] = { ...port.snapshots[0]!, [field]: value };

    await expect(capture(port)).rejects.toThrowError(`${code}: before`);
  });

  it("verifies tracked bytes against the blob at HEAD", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const metadata = DESIGN_METADATA;
    const absolutePath = win32.join(PHASE0_SOURCE_REPOSITORY, metadata.relativePath);
    const bytes = port.files.get(absolutePath)!;
    port.setCommitPath(BASE_HEAD, metadata.relativePath, {
      objectType: "blob",
      oid: gitBlobOid(bytes, "sha1"),
    });

    const manifest = (await capture(port)) as {
      readonly entries: readonly {
        readonly role: string;
        readonly sourceState: { readonly blobOid?: string; readonly state: string };
      }[];
    };
    expect(manifest.entries[0]).toMatchObject({
      role: "rebuild-design",
      sourceState: {
        blobOid: gitBlobOid(bytes, "sha1"),
        state: "IDENTICAL_TO_HEAD",
        verifiedAtHead: true,
      },
    });
  });

  it("queries the captured commit rather than an ambient HEAD during ABA changes", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const absolutePath = win32.join(
      PHASE0_SOURCE_REPOSITORY,
      DESIGN_METADATA.relativePath,
    );
    const bytes = port.files.get(absolutePath)!;
    const transientHead = "b".repeat(40);
    port.ambientHead = transientHead;
    port.setCommitPath(BASE_HEAD, DESIGN_METADATA.relativePath, {
      objectType: "blob",
      oid: "a".repeat(40),
    });
    port.setCommitPath(transientHead, DESIGN_METADATA.relativePath, {
      objectType: "blob",
      oid: gitBlobOid(bytes, "sha1"),
    });

    await expect(capture(port)).rejects.toThrowError(
      "PHASE0_GIT_BLOB_MISMATCH: rebuild-design",
    );
    expect(port.lookupCommits).toEqual([BASE_HEAD]);
  });

  it.each([
    ["reportedLookupRepository", "D:\\wrong-repository", "PHASE0_SOURCE_REPOSITORY_MISMATCH"],
    ["reportedLookupCommit", "b".repeat(40), "PHASE0_COMMIT_LOOKUP_MISMATCH"],
    ["reportedLookupPath", "docs/plans/wrong.md", "PHASE0_PATH_LOOKUP_MISMATCH"],
  ] as const)("rejects a mismatched commit lookup %s", async (field, value, code) => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port[field] = value;

    await expect(capture(port)).rejects.toThrowError(`${code}: rebuild-design`);
  });

  it("snapshots repository and blob identity getters exactly once", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const absolutePath = win32.join(
      PHASE0_SOURCE_REPOSITORY,
      DESIGN_METADATA.relativePath,
    );
    const bytes = port.files.get(absolutePath)!;
    const expectedOid = gitBlobOid(bytes, "sha1");
    let oidReads = 0;
    port.useSnapshotGetters = true;
    port.setCommitPath(BASE_HEAD, DESIGN_METADATA.relativePath, {
      objectType: "blob",
      get oid() {
        oidReads += 1;
        return oidReads === 1 ? expectedOid : "FORGED";
      },
    });

    const manifest = (await capture(port)) as {
      readonly gitObjectFormat: string;
      readonly sourceBefore: { readonly head: string };
      readonly sourceAfter: { readonly head: string };
      readonly entries: readonly {
        readonly sourceState: { readonly blobOid?: string };
      }[];
    };

    expect(manifest.gitObjectFormat).toBe("sha1");
    expect(manifest.sourceBefore.head).toBe(BASE_HEAD);
    expect(manifest.sourceAfter.head).toBe(BASE_HEAD);
    expect(manifest.entries[0]?.sourceState.blobOid).toBe(expectedOid);
    expect(oidReads).toBe(1);
  });

  it("labels a staged-new source only by its immutable commit relationship", async () => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    const stagedNewStatus = new TextEncoder().encode(
      `1 A. N... 000000 100644 100644 ${"0".repeat(40)} ${"a".repeat(40)} docs/plans/new.md\0`,
    );
    port.snapshots = [
      { ...port.snapshots[0]!, statusBytes: stagedNewStatus },
      { ...port.snapshots[1]!, statusBytes: stagedNewStatus },
    ];

    const manifest = (await capture(port)) as {
      readonly entries: readonly {
        readonly sourceState: { readonly state: string };
      }[];
    };
    expect(manifest.entries[0]?.sourceState.state).toBe("ABSENT_AT_HEAD");
  });

  it.each([
    [{ objectType: "tree", oid: "a".repeat(40) }, "PHASE0_GIT_OBJECT_NOT_BLOB"],
    [{ objectType: "blob", oid: "a".repeat(40) }, "PHASE0_GIT_BLOB_MISMATCH"],
  ])("rejects false tracked provenance %#", async (headPath, code) => {
    const capture = await loadCapture();
    const port = new FakeCapturePort();
    port.setCommitPath(BASE_HEAD, DESIGN_METADATA.relativePath, headPath);

    await expect(capture(port)).rejects.toThrowError(new RegExp(`^${code}: rebuild-design$`));
  });
});
