import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type {
  ArtifactFsPort,
  ArtifactReferenceProof,
  ArtifactStore,
} from "./artifact-contract.js";
import { createNodeArtifactFs } from "./artifact-node-fs.js";
import { createArtifactStore } from "./artifact-store.js";

const ROOT = join("D:", "runner-root");
const ADDRESS_PATTERN = /^[0-9a-f]{64}$/u;

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * In-memory fd-oriented port. Every boundary the protocol crosses is a named
 * operation so a test can fail exactly one of them and inspect what survived.
 */
class MemoryFs implements ArtifactFsPort {
  readonly files = new Map<string, Uint8Array>();
  readonly persisted = new Set<string>();
  readonly log: string[] = [];
  readonly renames: Array<readonly [string, string]> = [];
  readonly corruptReads = new Map<string, Uint8Array>();
  failOn: string | null = null;

  private nextFd = 10;
  private readonly open = new Map<number, { path: string; chunks: Uint8Array[] }>();

  private gate(op: string): void {
    this.log.push(op);
    if (this.failOn === op) {
      throw new Error(`injected ${op} fault`);
    }
  }

  openWrite(path: string): number {
    this.gate("openWrite");
    const fd = this.nextFd++;
    this.open.set(fd, { path, chunks: [] });
    return fd;
  }

  write(fd: number, bytes: Uint8Array): void {
    this.gate("write");
    const handle = this.open.get(fd);
    if (handle === undefined) throw new Error("write on unknown fd");
    handle.chunks.push(bytes);
    this.files.set(handle.path, concat(handle.chunks));
  }

  fsync(fd: number): void {
    this.gate("fsync");
    if (!this.open.has(fd)) throw new Error("fsync on unknown fd");
  }

  close(fd: number): void {
    this.log.push("close");
    this.open.delete(fd);
    if (this.failOn === "close") throw new Error("injected close fault");
  }

  exists(path: string): boolean {
    this.gate("exists");
    return this.files.has(path);
  }

  rename(from: string, to: string): void {
    this.gate("rename");
    const bytes = this.files.get(from);
    if (bytes === undefined) throw new Error("rename of missing source");
    this.files.delete(from);
    this.files.set(to, bytes);
    this.renames.push([from, to]);
  }

  persistAfterRename(path: string): void {
    this.gate("persistAfterRename");
    this.persisted.add(path);
  }

  readAll(path: string): Uint8Array {
    this.gate("readAll");
    const corrupt = this.corruptReads.get(path);
    if (corrupt !== undefined) return corrupt;
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error("read of missing file");
    return bytes;
  }

  unlink(path: string): void {
    this.log.push("unlink");
    this.files.delete(path);
    this.persisted.delete(path);
  }

  addressedPaths(): string[] {
    return [...this.files.keys()].filter((path) => ADDRESS_PATTERN.test(basename(path)));
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function makeStore(fs: MemoryFs, start = 0): ArtifactStore {
  let counter = start;
  return createArtifactStore({ root: ROOT, fs, nextStagingCounter: () => counter++ });
}

const ZERO_REFERENCES: ArtifactReferenceProof = Object.freeze({
  state: "ZERO_REFERENCES",
  scannedGenerations: Object.freeze(["live", "events@7", "backup@3"]),
});

describe("stageArtifact happy path", () => {
  it("returns a frozen ref only after the post-rename persistence point", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("hello artifact");
    const result = makeStore(fs).stageArtifact(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toEqual({ sha256: digestOf(bytes), byteLength: bytes.byteLength });
    expect(result.deduplicated).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ref)).toBe(true);

    expect(fs.log).toEqual([
      "openWrite",
      "write",
      "fsync",
      "close",
      "exists",
      "rename",
      "persistAfterRename",
      "readAll",
    ]);
    const finalPath = fs.addressedPaths();
    expect(finalPath).toHaveLength(1);
    expect(fs.persisted.has(finalPath[0]!)).toBe(true);
  });

  it("stages zero-length bytes", () => {
    const fs = new MemoryFs();
    const result = makeStore(fs).stageArtifact(new Uint8Array(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref.byteLength).toBe(0);
    expect(result.ref.sha256).toBe(digestOf(new Uint8Array(0)));
  });

  it("keeps the temp name in the final object's directory and never content-addressed", () => {
    const fs = new MemoryFs();
    makeStore(fs, 41).stageArtifact(textBytes("same directory"));

    expect(fs.renames).toHaveLength(1);
    const [from, to] = fs.renames[0]!;
    expect(dirname(from)).toBe(dirname(to));
    expect(ADDRESS_PATTERN.test(basename(from))).toBe(false);
    expect(basename(from)).toBe(`${digestOf(textBytes("same directory")).slice(0, 16)}.41.tmp`);
    expect(basename(to)).toBe(digestOf(textBytes("same directory")));
  });

  it("rejects a non-integer staging counter before touching the filesystem", () => {
    const fs = new MemoryFs();
    const store = createArtifactStore({ root: ROOT, fs, nextStagingCounter: () => -1 });
    const result = store.stageArtifact(textBytes("bad counter"));
    expect(result).toEqual({
      ok: false,
      code: "RUNNER_ARTIFACT_STAGING_INVALID",
      message: expect.any(String) as unknown as string,
    });
    expect(fs.log).toEqual([]);
  });
});

describe("stageArtifact fault injection", () => {
  const boundaries = [
    ["openWrite", "RUNNER_ARTIFACT_WRITE_FAILED"],
    ["write", "RUNNER_ARTIFACT_WRITE_FAILED"],
    ["fsync", "RUNNER_ARTIFACT_FLUSH_FAILED"],
    ["close", "RUNNER_ARTIFACT_CLOSE_FAILED"],
    ["exists", "RUNNER_ARTIFACT_VERIFY_FAILED"],
    ["rename", "RUNNER_ARTIFACT_RENAME_FAILED"],
    ["persistAfterRename", "RUNNER_ARTIFACT_PERSIST_FAILED"],
    ["readAll", "RUNNER_ARTIFACT_VERIFY_FAILED"],
  ] as const;

  for (const [op, code] of boundaries) {
    it(`fails closed at ${op} leaving no referenceable address`, () => {
      const fs = new MemoryFs();
      fs.failOn = op;
      const result = makeStore(fs).stageArtifact(textBytes("durable or nothing"));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(code);
      expect(Object.isFrozen(result)).toBe(true);
      expect(fs.addressedPaths()).toEqual([]);
      expect(fs.persisted.size).toBe(0);
    });
  }

  it("never returns a ref whose address was not persisted", () => {
    const fs = new MemoryFs();
    fs.failOn = "persistAfterRename";
    const result = makeStore(fs).stageArtifact(textBytes("unpersisted"));
    expect(result.ok).toBe(false);
    expect(fs.files.size).toBe(0);
  });
});

describe("stageArtifact duplicate content", () => {
  it("verifies and reuses an existing address without renaming over it", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("already stored");
    const address = join(ROOT, "objects", digestOf(bytes));
    fs.files.set(address, bytes);

    const result = makeStore(fs).stageArtifact(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deduplicated).toBe(true);
    expect(result.ref.sha256).toBe(digestOf(bytes));
    expect(fs.renames).toEqual([]);
    expect(fs.log).not.toContain("rename");
    expect(fs.log).toContain("unlink");
    expect(fs.files.size).toBe(1);
    expect(fs.files.get(address)).toEqual(bytes);
  });

  it("reports a corrupt address when the existing object does not match", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("true content");
    const address = join(ROOT, "objects", digestOf(bytes));
    fs.files.set(address, textBytes("imposter content"));

    const result = makeStore(fs).stageArtifact(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_ADDRESS_CORRUPT");
    expect(fs.renames).toEqual([]);
    expect(fs.files.get(address)).toEqual(textBytes("imposter content"));
    expect(fs.files.size).toBe(1);
  });
});

describe("stageArtifact post-rename verification", () => {
  it("empties the address before returning the verification failure", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("verify me");
    const address = join(ROOT, "objects", digestOf(bytes));
    fs.corruptReads.set(address, textBytes("flipped on disk"));

    const result = makeStore(fs).stageArtifact(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_VERIFY_FAILED");
    expect(fs.files.has(address)).toBe(false);
    expect(fs.addressedPaths()).toEqual([]);
  });

  it("rejects a truncated object whose length alone differs", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("full length payload");
    const address = join(ROOT, "objects", digestOf(bytes));
    fs.corruptReads.set(address, bytes.slice(0, 4));

    const result = makeStore(fs).stageArtifact(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_VERIFY_FAILED");
    expect(fs.files.has(address)).toBe(false);
  });
});

describe("verifyArtifact", () => {
  it("re-reads and compares the stored bytes", () => {
    const fs = new MemoryFs();
    const store = makeStore(fs);
    const bytes = textBytes("round trip");
    const staged = store.stageArtifact(bytes);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(store.verifyArtifact(staged.ref)).toEqual({ ok: true });
  });

  it("reports a missing object", () => {
    const fs = new MemoryFs();
    const result = makeStore(fs).verifyArtifact({ sha256: "a".repeat(64), byteLength: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_MISSING");
  });

  it("reports a corrupt address on digest mismatch", () => {
    const fs = new MemoryFs();
    const bytes = textBytes("stored");
    const address = join(ROOT, "objects", digestOf(bytes));
    fs.files.set(address, textBytes("rotten"));
    const result = makeStore(fs).verifyArtifact({
      sha256: digestOf(bytes),
      byteLength: bytes.byteLength,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_ADDRESS_CORRUPT");
  });

  it("rejects a malformed ref before any filesystem call", () => {
    const fs = new MemoryFs();
    for (const sha256 of ["../escape", "A".repeat(64), "abc", ""]) {
      const result = makeStore(fs).verifyArtifact({ sha256, byteLength: 1 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("RUNNER_ARTIFACT_REF_INVALID");
    }
    expect(fs.log).toEqual([]);
  });
});

describe("deleteArtifact reference guard", () => {
  function seed(fs: MemoryFs, value: string): { store: ArtifactStore; address: string } {
    const store = makeStore(fs);
    const bytes = textBytes(value);
    fs.files.set(join(ROOT, "objects", digestOf(bytes)), bytes);
    return { store, address: join(ROOT, "objects", digestOf(bytes)) };
  }

  it("deletes only under a ZERO_REFERENCES proof", () => {
    const fs = new MemoryFs();
    const { store, address } = seed(fs, "collectable");
    const result = store.deleteArtifact(
      { sha256: digestOf(textBytes("collectable")), byteLength: 11 },
      ZERO_REFERENCES,
    );
    expect(result).toEqual({ ok: true, deleted: true });
    expect(fs.files.has(address)).toBe(false);
  });

  it("refuses deletion when the reference state is uncertain", () => {
    const fs = new MemoryFs();
    const { store, address } = seed(fs, "uncertain");
    const result = store.deleteArtifact(
      { sha256: digestOf(textBytes("uncertain")), byteLength: 9 },
      { state: "UNCERTAIN", reason: "backup generation unreadable" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_REFS_UNCERTAIN");
    expect(fs.files.has(address)).toBe(true);
  });

  it("refuses deletion when references are known to exist", () => {
    const fs = new MemoryFs();
    const { store, address } = seed(fs, "referenced");
    const result = store.deleteArtifact(
      { sha256: digestOf(textBytes("referenced")), byteLength: 10 },
      { state: "REFERENCED" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_REFS_PRESENT");
    expect(fs.files.has(address)).toBe(true);
  });

  it("treats an empty scanned-generation set as uncertain", () => {
    const fs = new MemoryFs();
    const { store, address } = seed(fs, "unscanned");
    const result = store.deleteArtifact(
      { sha256: digestOf(textBytes("unscanned")), byteLength: 9 },
      { state: "ZERO_REFERENCES", scannedGenerations: [] },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_REFS_UNCERTAIN");
    expect(fs.files.has(address)).toBe(true);
  });

  it("is idempotent when the address is already absent", () => {
    const fs = new MemoryFs();
    const result = makeStore(fs).deleteArtifact(
      { sha256: "b".repeat(64), byteLength: 0 },
      ZERO_REFERENCES,
    );
    expect(result).toEqual({ ok: true, deleted: false });
  });
});

/**
 * The default adapter is the only place the durability claim meets a real
 * kernel, so the persistence boundary is exercised outside the repository tree.
 */
describe("createNodeArtifactFs against a real filesystem", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-runner-artifacts-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function realStore(start: number): ArtifactStore {
    let counter = start;
    return createArtifactStore({
      root,
      fs: createNodeArtifactFs(),
      nextStagingCounter: () => counter++,
    });
  }

  it("stages, dedups, verifies, and deletes real bytes", () => {
    const store = realStore(0);
    const bytes = textBytes("durable payload");
    const staged = store.stageArtifact(bytes);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.deduplicated).toBe(false);
    expect(staged.ref.sha256).toBe(digestOf(bytes));
    expect(existsSync(join(root, "objects", staged.ref.sha256))).toBe(true);

    const again = store.stageArtifact(bytes);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.deduplicated).toBe(true);

    expect(store.verifyArtifact(staged.ref)).toEqual({ ok: true });
    expect(store.deleteArtifact(staged.ref, ZERO_REFERENCES)).toEqual({ ok: true, deleted: true });
    expect(existsSync(join(root, "objects", staged.ref.sha256))).toBe(false);
  });

  it("leaves no temp file behind and stages empty content", () => {
    const store = realStore(100);
    const staged = store.stageArtifact(new Uint8Array(0));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(existsSync(join(root, "objects", `${staged.ref.sha256.slice(0, 16)}.100.tmp`))).toBe(
      false,
    );
    expect(store.verifyArtifact(staged.ref)).toEqual({ ok: true });
  });
});
