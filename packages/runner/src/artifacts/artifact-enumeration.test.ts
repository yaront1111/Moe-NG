import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  MAX_ARTIFACT_ENUMERATION_ENTRIES,
  sha256Hex,
  type ArtifactFsPort,
} from "./artifact-contract.js";
import { createNodeArtifactFs } from "./artifact-node-fs.js";
import { createArtifactStore } from "./artifact-store.js";

/**
 * Enumeration is the one artifact operation that reports on things it did not
 * create, so its failure vocabulary carries more weight than its success path.
 *
 * The three facts the task rail separates — a MISSING directory, a successful
 * EMPTY listing, and an UNREADABLE entry — are asserted as three different
 * answers here. Collapsing any two is the defect: an empty array returned for a
 * missing directory would let a caller conclude "no artifacts exist" from
 * "I could not look", and nothing downstream could tell the difference.
 *
 * Every refusal pins the exact code AND the refusing layer, because two layers
 * can answer: ARTIFACT_FS_PORT owns what the filesystem said, ARTIFACT_STORE
 * owns what the layout means. A test asserting only `ok === false` would still
 * pass if the wrong layer started answering first.
 */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-runner-enum-"));
  roots.push(root);
  return root;
}

function storeAt(root: string, fs: ArtifactFsPort = createNodeArtifactFs()) {
  let counter = 0;
  return createArtifactStore({ root, fs, nextStagingCounter: () => (counter += 1) });
}

function seedObject(root: string, contents: string): string {
  const bytes = new TextEncoder().encode(contents);
  const address = sha256Hex(bytes);
  mkdirSync(join(root, "objects"), { recursive: true });
  writeFileSync(join(root, "objects", address), bytes);
  return address;
}

describe("createArtifactStore().enumerateArtifacts — success shapes", () => {
  it("reports staged objects with their address and byte length", () => {
    const root = temporaryRoot();
    const store = storeAt(root);
    const staged = store.stageArtifact(new TextEncoder().encode("alpha"));
    expect(staged.ok).toBe(true);

    const listing = store.enumerateArtifacts();
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    // Non-vacuity first: an empty result would satisfy every assertion below
    // that is phrased as "contains no bad entry".
    expect(listing.objects.length).toBeGreaterThan(0);
    expect(listing.entryCount).toBe(listing.objects.length + listing.staging.length);
    const object = listing.objects[0];
    expect(object?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(object?.byteLength).toBe(5);
  });

  it("distinguishes a successful EMPTY listing from a missing directory", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "objects"), { recursive: true });
    const empty = storeAt(root).enumerateArtifacts();
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.objects).toEqual([]);
    expect(empty.entryCount).toBe(0);
    // Observed-and-empty still carries a digest, so it is a positive fact.
    expect(empty.observationDigest).toMatch(/^[0-9a-f]{64}$/u);

    const missing = storeAt(temporaryRoot()).enumerateArtifacts();
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("RUNNER_ARTIFACT_MISSING");
    expect(missing.layer).toBe("ARTIFACT_FS_PORT");
  });

  it("orders entries by code unit, independent of the order the port returned", () => {
    const root = temporaryRoot();
    for (const contents of ["gamma", "alpha", "beta"]) seedObject(root, contents);
    const forward = storeAt(root).enumerateArtifacts();
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const addresses = forward.objects.map((entry) => entry.sha256);
    expect(addresses).toEqual([...addresses].sort());
    expect(addresses.length).toBe(3);

    // A port that lists in reverse must produce the identical observation.
    const base = createNodeArtifactFs();
    const reversed: ArtifactFsPort = Object.freeze({
      ...base,
      listDirectory: (path: string) => [...(base.listDirectory?.(path) ?? [])].reverse(),
    });
    const backward = storeAt(root, reversed).enumerateArtifacts();
    expect(backward.ok).toBe(true);
    if (!backward.ok) return;
    expect(backward.objects.map((entry) => entry.sha256)).toEqual(addresses);
    expect(backward.observationDigest).toBe(forward.observationDigest);
  });

  it("recognises the existing staging grammar without treating it as an object", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", `${"0".repeat(16)}.7.tmp`), "partial");
    const listing = storeAt(root).enumerateArtifacts();
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.objects).toEqual([]);
    expect(listing.staging.length).toBe(1);
    expect(listing.staging[0]?.name).toBe(`${"0".repeat(16)}.7.tmp`);
  });
});

interface EnumerationRefusal {
  readonly id: string;
  readonly code: string;
  readonly layer: string;
  readonly arrange: (root: string) => ArtifactFsPort | undefined;
}

const failingPort = (base: ArtifactFsPort, error: Error): ArtifactFsPort =>
  Object.freeze({
    ...base,
    listDirectory: () => {
      throw error;
    },
  });

const REFUSAL_CASES: readonly EnumerationRefusal[] = Object.freeze([
  {
    id: "objects-directory-absent",
    code: "RUNNER_ARTIFACT_MISSING",
    layer: "ARTIFACT_FS_PORT",
    arrange: () => undefined,
  },
  {
    id: "listing-unreadable",
    code: "RUNNER_ARTIFACT_VERIFY_FAILED",
    layer: "ARTIFACT_FS_PORT",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      return failingPort(createNodeArtifactFs(), Object.assign(new Error("EACCES"), { code: "EACCES" }));
    },
  },
  {
    id: "listing-capability-absent",
    code: "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE",
    layer: "ARTIFACT_STORE",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      const { listDirectory: _omitted, ...withoutListing } = createNodeArtifactFs();
      return Object.freeze(withoutListing) as ArtifactFsPort;
    },
  },
  {
    id: "entry-count-over-ceiling",
    code: "RUNNER_ARTIFACT_ENUMERATION_LIMIT",
    layer: "ARTIFACT_FS_PORT",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      const base = createNodeArtifactFs();
      return Object.freeze({
        ...base,
        listDirectory: () =>
          Array.from({ length: MAX_ARTIFACT_ENUMERATION_ENTRIES + 1 }, (_unused, index) => ({
            name: index.toString(16).padStart(64, "0"),
            kind: "FILE" as const,
          })),
      });
    },
  },
  {
    id: "unrecognised-entry-name",
    code: "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
    layer: "ARTIFACT_STORE",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      writeFileSync(join(root, "objects", "not-a-content-address"), "x");
      return undefined;
    },
  },
  {
    // The address grammar must be the ONLY thing that can reject this, or the
    // case measures a different guard than the one it names. The bytes are
    // deliberately unreadable: the grammar refuses BEFORE anything is read, so
    // widening it to admit uppercase makes the entry an object candidate and the
    // read answers instead — a different code AND a different layer. Written
    // against a readable file the case survives that mutation, because the
    // bytes-vs-address check then answers with the identical code and layer.
    // The listing is synthetic for the same reason: a name written to disk is
    // returned by the OS, and case folding there would decide the case instead.
    id: "uppercase-address",
    code: "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
    layer: "ARTIFACT_STORE",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      return Object.freeze({
        ...createNodeArtifactFs(),
        listDirectory: () => [{ name: "A".repeat(64), kind: "FILE" as const }],
        readAll: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      });
    },
  },
  {
    // The ONLY case that reaches classify()'s per-entry read. The name is valid
    // lowercase 64-hex on purpose: the grammar runs BEFORE readAll, so every
    // other entry with a throwing read — uppercase-address above included — is
    // answered by the grammar and never gets there. "an unreadable entry" and
    // "an unreadable listing" are two different branches, and listing-unreadable
    // covers only the second.
    id: "entry-unreadable",
    code: "RUNNER_ARTIFACT_VERIFY_FAILED",
    layer: "ARTIFACT_FS_PORT",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      return Object.freeze({
        ...createNodeArtifactFs(),
        listDirectory: () => [{ name: "d".repeat(64), kind: "FILE" as const }],
        readAll: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      });
    },
  },
  {
    id: "object-bytes-do-not-match-address",
    code: "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
    layer: "ARTIFACT_STORE",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects"), { recursive: true });
      writeFileSync(join(root, "objects", "b".repeat(64)), "these bytes hash to something else");
      return undefined;
    },
  },
  {
    id: "directory-where-an-object-should-be",
    code: "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
    layer: "ARTIFACT_STORE",
    arrange: (root: string) => {
      mkdirSync(join(root, "objects", "c".repeat(64)), { recursive: true });
      return undefined;
    },
  },
]);

describe("enumerateArtifacts — every refusal names its code and its layer", () => {
  it("runs every hand-authored case exactly once", () => {
    expect(REFUSAL_CASES.length).toBeGreaterThan(0);
    expect(REFUSAL_CASES.length).toBe(9);
    expect(new Set(REFUSAL_CASES.map((entry) => entry.id)).size).toBe(REFUSAL_CASES.length);
  });

  it.each(REFUSAL_CASES.map((entry) => [entry.id, entry] as const))(
    "refuses %s",
    (_id, entry) => {
      const root = temporaryRoot();
      const port = entry.arrange(root);
      const result = storeAt(root, port ?? createNodeArtifactFs()).enumerateArtifacts();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(entry.code);
      expect(result.layer).toBe(entry.layer);
      // No raw filesystem path may leak through a refusal message.
      expect(result.message).not.toContain(root);
    },
  );

  it("reports a symlinked entry rather than silently skipping it", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "objects"), { recursive: true });
    const target = join(root, "outside.bin");
    writeFileSync(target, "outside");
    try {
      symlinkSync(target, join(root, "objects", "d".repeat(64)));
    } catch {
      // Windows without developer mode refuses symlink creation for an
      // unprivileged process. Skipping the assertion silently would make this
      // case vacuous, so the absence of the capability is asserted instead.
      expect(process.platform).toBe("win32");
      return;
    }
    const result = storeAt(root).enumerateArtifacts();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RUNNER_ARTIFACT_ADDRESS_CORRUPT");
    expect(result.layer).toBe("ARTIFACT_STORE");
  });
});

describe("enumeration leaves the existing store surface untouched", () => {
  it("keeps stage, verify and delete behaving exactly as before", () => {
    const root = temporaryRoot();
    const store = storeAt(root);
    const bytes = new TextEncoder().encode("unchanged");
    const staged = store.stageArtifact(bytes);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(store.verifyArtifact(staged.ref)).toEqual({ ok: true });
    const deleted = store.deleteArtifact(staged.ref, {
      state: "ZERO_REFERENCES",
      scannedGenerations: ["gen-1"],
    });
    expect(deleted).toEqual({ ok: true, deleted: true });
  });

  it("bounds enumeration at a declared ceiling rather than an ambient one", () => {
    expect(Number.isSafeInteger(MAX_ARTIFACT_ENUMERATION_ENTRIES)).toBe(true);
    expect(MAX_ARTIFACT_ENUMERATION_ENTRIES).toBeGreaterThan(0);
  });
});
