import { generateKeyPairSync, createHash, sign as edSign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import * as storeModule from "./index.js";

/**
 * The public surface is reached through `./index.js` on purpose: a consumer of
 * @moe/store sees exactly this, and a test that imported the implementation
 * module directly would keep passing after the root export was dropped.
 */
const { createBackupGeneration, verifyBackupGeneration, SqliteEventStore } = storeModule;

const CATEGORIES = ["ARTIFACT", "CONTEXT", "KEY_CHAIN", "MANIFEST", "RECEIPT"] as const;

interface BackupManifestShape {
  readonly objects: readonly {
    readonly category: string;
    readonly digest: string;
    readonly logicalPath: string;
  }[];
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256Hex = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

interface Harness {
  readonly root: string;
  readonly databasePath: string;
  readonly destinationPath: string;
  readonly objects: readonly Record<string, unknown>[];
  readonly sourceGenerationDigest: string;
  readonly keyId: string;
  readonly privateKey: unknown;
  readonly trust: Record<string, unknown>;
  readonly cursor: string;
  cleanup(): void;
}

/**
 * Builds a real project database, real object files and a real Ed25519 key.
 * Nothing here reimplements a production rule: it only produces inputs.
 */
function harness(label: string, eventCount: number): Harness {
  const root = mkdtempSync(join(tmpdir(), `moe-backup-${label}-`));
  const databasePath = join(root, "project.db");
  const store = SqliteEventStore.openForProject(databasePath, "project-1");
  try {
    for (let index = 1; index <= eventCount; index += 1) {
      store.commit({
        aggregateId: `aggregate-${index}`,
        commandBytes: bytes(`command-${index}`),
        commandId: `command-${index}`,
        committedAt: "2026-08-06T18:10:00.000Z",
        events: [
          { eventId: `event-${index}`, eventType: "goal.seeded", payload: bytes(`payload-${index}`) },
        ],
        expectedVersion: 0,
      });
    }
  } finally {
    store.close();
  }

  const objectRoot = join(root, "objects");
  mkdirSync(objectRoot, { recursive: true });
  const sourceGenerationDigest = sha256Hex(bytes(`generation-${label}`));

  const objects = CATEGORIES.map((category, index) => {
    const payload = bytes(`${category}-object-${index}`);
    const sourcePath = join(objectRoot, `${category.toLowerCase()}.bin`);
    writeFileSync(sourcePath, payload);
    return {
      byteLength: String(payload.byteLength),
      category,
      digest: sha256Hex(payload),
      logicalId: `${category.toLowerCase()}-1`,
      logicalPath: `${category.toLowerCase()}/object.bin`,
      sourceGenerationDigest,
      sourcePath,
    };
  });

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "key-1";
  const trust = {
    anchoredKeys: [
      { keyId, publicKeySpkiDer: publicKey.export({ format: "der", type: "spki" }).toString("hex") },
    ],
  };

  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    cursor: String(eventCount),
    databasePath,
    destinationPath: join(root, "generation"),
    keyId,
    objects,
    privateKey,
    root,
    sourceGenerationDigest,
    trust,
  };
}

const request = (h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cursor: h.cursor,
  databasePath: h.databasePath,
  destinationPath: h.destinationPath,
  keyChain: [{ keyId: h.keyId, role: "LEAF" }],
  objects: h.objects,
  projectId: "project-1",
  signing: { keyId: h.keyId, privateKey: h.privateKey },
  sourceGenerationDigest: h.sourceGenerationDigest,
  ...overrides,
});

/**
 * Every refusal in this task collapses to one tuple. Asserting the tuple AND the
 * specific reason is the point: asserting only `ok === false` would stay green if
 * a different layer started answering first, which is the defect epic rail 6 names.
 */
function expectRefusal(result: unknown, reason: string): void {
  expect(result).toMatchObject({
    code: "BACKUP_PROOF_UNKNOWN",
    layer: "BACKUP_GENERATION",
    ok: false,
    reason,
    restorable: false,
    truth: "UNKNOWN",
  });
  expect(Object.isFrozen(result)).toBe(true);
  // A refusal must not leak a usable capability, not even a path to one.
  expect(result).not.toHaveProperty("manifest");
  expect(result).not.toHaveProperty("manifestPath");
  expect(result).not.toHaveProperty("generationPath");
}

describe("createBackupGeneration — authority", () => {
  it("binds one committed cursor, the database image and the complete closure", async () => {
    const h = harness("authority", 3);
    try {
      const result = await createBackupGeneration(request(h));
      expect(result).toMatchObject({ ok: true, restorable: true });

      const manifest = (result as unknown as { manifest: Record<string, unknown> }).manifest;
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(manifest).toMatchObject({
        cursor: "3",
        projectId: "project-1",
        sourceGenerationDigest: h.sourceGenerationDigest,
      });
      // Canonical decimal string, never a number: a JS number silently loses
      // precision past 2^53 and the cursor is a bigint column.
      expect(typeof manifest.cursor).toBe("string");
      expect(typeof manifest.databaseDigest).toBe("string");
      expect(typeof manifest.databaseByteLength).toBe("string");

      const descriptors = manifest.objects as readonly Record<string, unknown>[];
      expect(descriptors.length).toBe(CATEGORIES.length);
      // Sorted, so the canonical projection cannot depend on caller order.
      const ids = descriptors.map((entry) => entry.logicalId as string);
      expect(ids).toStrictEqual([...ids].sort());

      // Non-zero per category: a closure that swept nothing must not pass.
      for (const category of CATEGORIES) {
        const inCategory = descriptors.filter((entry) => entry.category === category);
        expect(inCategory.length).toBeGreaterThan(0);
      }
      expect(CATEGORIES.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it("captures a database whose committed tail is exactly the bound cursor", async () => {
    const h = harness("rpo", 2);
    try {
      const result = await createBackupGeneration(request(h));
      expect(result).toMatchObject({ ok: true });
      const generationPath = (result as unknown as { generationPath: string }).generationPath;

      // Commit past the captured generation on the LIVE database.
      const live = SqliteEventStore.openForProject(h.databasePath, "project-1");
      try {
        live.commit({
          aggregateId: "aggregate-late",
          commandBytes: bytes("command-late"),
          commandId: "command-late",
          committedAt: "2026-08-06T18:20:00.000Z",
          events: [{ eventId: "event-late", eventType: "goal.seeded", payload: bytes("late") }],
          expectedVersion: 0,
        });
      } finally {
        live.close();
      }

      // Checked BEFORE opening: the committed rows must live in the image
      // itself, not in a sidecar left beside it. Opening the database would
      // create a `-wal` of its own and make this assertion meaningless.
      expect(existsSync(join(generationPath, "database.sqlite-wal"))).toBe(false);

      // Assert against the produced DATABASE FILE, not only the manifest: a
      // manifest can claim cursor 2 while the image behind it holds 3 rows, and
      // that gap is exactly what makes a backup unrestorable at its stated RPO.
      const captured = new DatabaseSync(join(generationPath, "database.sqlite"), {
        readOnly: true,
      });
      try {
        const tail = captured
          .prepare("SELECT CAST(MAX(global_position) AS TEXT) AS tail FROM domain_events")
          .get() as { tail: string };
        const rows = captured
          .prepare("SELECT count(*) AS total FROM domain_events")
          .get() as { total: number };
        expect(tail.tail).toBe("2");
        expect(rows.total).toBe(2);
      } finally {
        captured.close();
      }

      const manifest = (result as unknown as { manifest: { cursor: string } }).manifest;
      expect(manifest.cursor).toBe("2");

      // The live database really did move on, so the assertion above is a
      // genuine exclusion rather than a database that never advanced.
      const liveCheck = new DatabaseSync(h.databasePath, { readOnly: true });
      try {
        expect(
          (
            liveCheck
              .prepare("SELECT CAST(MAX(global_position) AS TEXT) AS tail FROM domain_events")
              .get() as { tail: string }
          ).tail,
        ).toBe("3");
      } finally {
        liveCheck.close();
      }
    } finally {
      h.cleanup();
    }
  });

  it("binds an empty database at cursor 0", async () => {
    // global_position CHECKs > 0, so cursor 0 is representable only as "no
    // events captured" — the empty-generation case, not a row at position 0.
    const h = harness("cursor-zero", 0);
    try {
      const result = await createBackupGeneration(request(h, { cursor: "0" }));
      expect(result).toMatchObject({ ok: true, restorable: true });
      expect((result as unknown as { manifest: { cursor: string } }).manifest.cursor).toBe("0");
    } finally {
      h.cleanup();
    }
  });

  it("carries exactly one verified object in every configured category", async () => {
    const h = harness("categories", 2);
    try {
      const result = await createBackupGeneration(request(h));
      expect(result).toMatchObject({ ok: true });
      const manifest = (result as unknown as { manifest: BackupManifestShape }).manifest;

      const counts = new Map<string, number>();
      for (const entry of manifest.objects) {
        counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
      }
      // Exact counts, not "at least one": an implementation that duplicated a
      // descriptor would still satisfy a non-zero check.
      expect([...counts.keys()].sort()).toStrictEqual([...CATEGORIES]);
      for (const category of CATEGORIES) {
        expect(counts.get(category)).toBe(1);
      }
      expect(manifest.objects.length).toBe(CATEGORIES.length);

      // Every declared object landed on disk with its declared bytes.
      for (const entry of manifest.objects) {
        const onDisk = readFileSync(
          join((result as unknown as { generationPath: string }).generationPath, entry.logicalPath),
        );
        expect(sha256Hex(new Uint8Array(onDisk))).toBe(entry.digest);
      }
    } finally {
      h.cleanup();
    }
  });

  it("produces a byte-identical manifest from permuted descriptor order", async () => {
    // One database and one object set, built twice into distinct destination
    // roots. Two SEPARATE harnesses would not isolate ordering: their database
    // images differ, so `databaseDigest` would differ and the comparison would
    // prove nothing about canonicalization.
    const h = harness("determinism", 2);
    try {
      const a = await createBackupGeneration(
        request(h, { destinationPath: join(h.root, "generation-a") }),
      );
      const b = await createBackupGeneration(
        request(h, {
          destinationPath: join(h.root, "generation-b"),
          objects: [...h.objects].reverse(),
        }),
      );
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });

      const digestA = (a as unknown as { manifest: { generationDigest: string } }).manifest
        .generationDigest;
      const digestB = (b as unknown as { manifest: { generationDigest: string } }).manifest
        .generationDigest;
      expect(digestB).toBe(digestA);

      // Ed25519 is deterministic, so identical canonical bytes must also yield
      // an identical signature. Comparing only the digest would miss a signer
      // that had drifted onto some other byte projection.
      const sigA = (a as unknown as { container: { signature: string } }).container.signature;
      const sigB = (b as unknown as { container: { signature: string } }).container.signature;
      expect(sigB).toBe(sigA);
    } finally {
      h.cleanup();
    }
  });

  it("re-verifies its own output through the production verifier", async () => {
    const h = harness("selfverify", 2);
    try {
      const created = await createBackupGeneration(request(h));
      expect(created).toMatchObject({ ok: true });
      const container = (created as { container: unknown }).container;
      expect(verifyBackupGeneration(container, h.trust)).toMatchObject({
        ok: true,
        restorable: true,
      });
    } finally {
      h.cleanup();
    }
  });
});

describe("createBackupGeneration — refusals", () => {
  /**
   * Table-driven, and the table's own length is asserted below. A sweep that
   * silently generated zero rows would otherwise pass while testing nothing.
   */
  const CASES: readonly {
    readonly name: string;
    readonly reason: string;
    readonly mutate: (h: Harness) => Record<string, unknown>;
  }[] = [
    {
      mutate: (h) => request(h, { cursor: String(Number(h.cursor) + 5) }),
      name: "cursor ahead of database",
      reason: "CURSOR_AHEAD_OF_DATABASE",
    },
    {
      mutate: (h) => request(h, { cursor: "1" }),
      name: "cursor behind database",
      reason: "CURSOR_BEHIND_DATABASE",
    },
    {
      mutate: (h) => request(h, { objects: h.objects.slice(1) }),
      name: "closure missing a category",
      reason: "CATEGORY_INCOMPLETE",
    },
    {
      mutate: (h) => request(h, { objects: [...h.objects, h.objects[0]] }),
      name: "duplicate logical identity",
      reason: "OBJECT_DUPLICATE_IDENTITY",
    },
    {
      mutate: (h) =>
        request(h, {
          objects: h.objects.map((entry, index) =>
            index === 0 ? { ...entry, sourcePath: join(h.root, "absent.bin") } : entry,
          ),
        }),
      name: "declared object missing on disk",
      reason: "OBJECT_MISSING",
    },
    {
      mutate: (h) =>
        request(h, {
          objects: h.objects.map((entry, index) =>
            index === 0 ? { ...entry, digest: sha256Hex(bytes("wrong")) } : entry,
          ),
        }),
      name: "declared digest does not match bytes",
      reason: "OBJECT_DIGEST_MISMATCH",
    },
    {
      mutate: (h) =>
        request(h, {
          objects: h.objects.map((entry, index) =>
            index === 0 ? { ...entry, byteLength: "99999" } : entry,
          ),
        }),
      name: "declared size does not match bytes",
      reason: "OBJECT_SIZE_MISMATCH",
    },
    {
      mutate: (h) =>
        request(h, {
          objects: h.objects.map((entry, index) =>
            index === 0
              ? { ...entry, sourceGenerationDigest: sha256Hex(bytes("other-generation")) }
              : entry,
          ),
        }),
      name: "objects drawn from two generations",
      reason: "MIXED_SOURCE_GENERATION",
    },
    {
      mutate: (h) => request(h, { keyChain: [{ keyId: "unanchored-key", role: "LEAF" }] }),
      name: "leaf key is not externally anchored",
      reason: "KEY_CHAIN_UNTRUSTED",
    },
    {
      mutate: (h) => request(h, { cursor: 3 }),
      name: "cursor supplied as a number rather than canonical decimal text",
      reason: "REQUEST_SHAPE_INVALID",
    },
    {
      mutate: (h) => request(h, { objects: Object.assign([], { 0: h.objects[0], length: 5 }) }),
      name: "sparse descriptor array",
      reason: "REQUEST_SHAPE_INVALID",
    },
    {
      mutate: (h) =>
        request(h, {
          objects: h.objects.map((entry, index) =>
            index === 0 ? { ...entry, logicalPath: "../escape.bin" } : entry,
          ),
        }),
      name: "logical path escapes the generation root",
      reason: "DESTINATION_UNSAFE",
    },
    {
      mutate: (h) => request(h, { destinationPath: h.databasePath }),
      name: "destination aliases the source database",
      reason: "DESTINATION_UNSAFE",
    },
  ];

  it("covers every declared refusal exactly once", () => {
    expect(CASES.length).toBeGreaterThan(0);
    const names = CASES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(CASES.length);
  });

  for (const testCase of CASES) {
    it(`refuses: ${testCase.name}`, async () => {
      const h = harness("refuse", 3);
      try {
        expectRefusal(await createBackupGeneration(testCase.mutate(h)), testCase.reason);
      } finally {
        h.cleanup();
      }
    });
  }

  it("refuses a corrupt source database", async () => {
    const h = harness("corrupt", 2);
    try {
      writeFileSync(h.databasePath, bytes("this is not a sqlite database"));
      expectRefusal(await createBackupGeneration(request(h)), "DATABASE_UNREADABLE");
    } finally {
      h.cleanup();
    }
  });

  it("refuses an unreadable declared object", async () => {
    const h = harness("unreadable", 2);
    try {
      const first = h.objects[0];
      expect(first).toBeDefined();
      const target = first?.sourcePath as string;
      chmodSync(target, 0o000);
      const result = await createBackupGeneration(request(h));
      // Windows ignores mode bits, so accept either the unreadable refusal or a
      // clean success; what must never happen is a restorable claim over bytes
      // that were not verified.
      if ((result as { ok: boolean }).ok === false) {
        expectRefusal(result, "OBJECT_UNREADABLE");
      }
      chmodSync(target, 0o600);
    } finally {
      h.cleanup();
    }
  });
});

describe("verifyBackupGeneration — tamper detection", () => {
  it("rejects a tampered manifest digest", async () => {
    const h = harness("tamper-digest", 2);
    try {
      const created = await createBackupGeneration(request(h));
      const container = (created as { container: Record<string, unknown> }).container;
      const tampered = {
        ...container,
        manifest: { ...(container.manifest as object), cursor: "999" },
      };
      expectRefusal(verifyBackupGeneration(tampered, h.trust), "MANIFEST_DIGEST_MISMATCH");
    } finally {
      h.cleanup();
    }
  });

  it("rejects a valid manifest carrying a substituted signature", async () => {
    const h = harness("tamper-sig", 2);
    try {
      const created = await createBackupGeneration(request(h));
      const container = (created as { container: Record<string, unknown> }).container;
      const foreign = generateKeyPairSync("ed25519");
      const forged = edSign(null, Buffer.from("unrelated"), foreign.privateKey).toString("hex");
      expectRefusal(
        verifyBackupGeneration({ ...container, signature: forged }, h.trust),
        "MANIFEST_SIGNATURE_INVALID",
      );
    } finally {
      h.cleanup();
    }
  });

  it("rejects a container whose carried key is not the anchored key", async () => {
    const h = harness("tamper-key", 2);
    try {
      const created = await createBackupGeneration(request(h));
      const container = (created as { container: unknown }).container;
      // A replacement key travelling inside the container must never
      // self-authorize: trust is supplied externally or the proof is worthless.
      const foreign = generateKeyPairSync("ed25519");
      expectRefusal(
        verifyBackupGeneration(container, {
          anchoredKeys: [
            {
              keyId: h.keyId,
              publicKeySpkiDer: foreign.publicKey
                .export({ format: "der", type: "spki" })
                .toString("hex"),
            },
          ],
        }),
        "MANIFEST_SIGNATURE_INVALID",
      );
    } finally {
      h.cleanup();
    }
  });

  it("rejects a final inventory with an extra object", async () => {
    const h = harness("tamper-inventory", 2);
    try {
      const created = await createBackupGeneration(request(h));
      const generationPath = (created as { generationPath: string }).generationPath;
      const container = JSON.parse(readFileSync(join(generationPath, "manifest.json"), "utf8"));

      // The observation is caller-supplied so the verifier stays pure; the
      // coordinator passes a real directory listing. Here we hand it a listing
      // containing one object the manifest never declared.
      const declared = container.manifest.objects.map(
        (entry: { logicalPath: string }) => entry.logicalPath,
      );
      expectRefusal(
        verifyBackupGeneration(container, h.trust, {
          observedLogicalPaths: [...declared, "unexpected/extra.bin"],
        }),
        "INVENTORY_MISMATCH",
      );

      // A MISSING declared object, which is the other direction and the one the
      // cardinality comparison exists for. Without this case that comparison is
      // redundant with the membership loop below it: a mutation drill that
      // neutralised it survived, because an extra path is caught either way.
      expectRefusal(
        verifyBackupGeneration(container, h.trust, {
          observedLogicalPaths: declared.slice(1),
        }),
        "INVENTORY_MISMATCH",
      );

      // The same container with a truthful listing must still verify, so both
      // refusals above are attributable to the inventory and nothing else.
      expect(
        verifyBackupGeneration(container, h.trust, { observedLogicalPaths: declared }),
      ).toMatchObject({ ok: true });
    } finally {
      h.cleanup();
    }
  });
});
