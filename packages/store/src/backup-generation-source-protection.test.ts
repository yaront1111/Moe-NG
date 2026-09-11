import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBackupGeneration, SqliteEventStore } from "./index.js";

const CATEGORIES = ["ARTIFACT", "CONTEXT", "KEY_CHAIN", "MANIFEST", "RECEIPT"] as const;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

interface Harness {
  readonly root: string; readonly databasePath: string; readonly destinationPath: string;
  readonly objects: readonly Record<string, unknown>[];
  readonly input: Record<string, unknown>;
  cleanup(): void;
}

/** Real SQLite, declared closure files, and signing key; every source belongs to this temp root. */
function harness(label: string, eventCount: number): Harness {
  const root = mkdtempSync(join(tmpdir(), `moe-backup-${label}-`));
  const databasePath = join(root, "project.db");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "source-protection-project");
    try {
      for (let index = 1; index <= eventCount; index += 1) {
        store.commit({
          aggregateId: `aggregate-${index}`, commandBytes: bytes(`command-${index}`),
          commandId: `command-${index}`, committedAt: "2026-09-11T10:00:00.000Z",
          events: [{
            eventId: `event-${index}`, eventType: "goal.seeded", payload: bytes(`payload-${index}`),
          }],
          expectedVersion: 0,
        });
      }
    } finally { store.close(); }
    const sourceGenerationDigest = digest(bytes(label));
    const objects = CATEGORIES.map((category) => {
      const payload = bytes(`source-${category}`);
      const sourcePath = join(root, `${category}.bin`);
      writeFileSync(sourcePath, payload);
      return {
        byteLength: String(payload.byteLength), category, digest: digest(payload),
        logicalId: category, logicalPath: `${category}/object.bin`,
        sourceGenerationDigest, sourcePath,
      };
    });
    const destinationPath = join(root, "generation");
    const { privateKey } = generateKeyPairSync("ed25519");
    return {
      cleanup: () => rmSync(root, { force: true, recursive: true }),
      databasePath, destinationPath, objects, root,
      input: {
        cursor: String(eventCount), databasePath, destinationPath,
        keyChain: [{ keyId: "source-key", role: "LEAF" }], objects,
        projectId: "source-protection-project",
        signing: { keyId: "source-key", privateKey }, sourceGenerationDigest,
      },
    };
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function request(h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...h.input, ...overrides };
}

function expectRefusal(result: unknown, reason: string): void {
  expect(result).toMatchObject({
    code: "BACKUP_PROOF_UNKNOWN", layer: "BACKUP_GENERATION", ok: false,
    reason, restorable: false, truth: "UNKNOWN",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty("manifest");
  expect(result).not.toHaveProperty("manifestPath");
  expect(result).not.toHaveProperty("generationPath");
}

function driveCaseAlias(path: string): string {
  const drive = path[0] ?? "";
  return (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + path.slice(1);
}

describe("createBackupGeneration — reserved sibling source protection", () => {
  const CASES = [
    { alias: "NONE", suffix: ".staging" },
    { alias: "NONE", suffix: ".previous" },
    { alias: "DESTINATION_LINK", suffix: ".staging" },
    { alias: "DESTINATION_LINK", suffix: ".previous" },
    { alias: "SOURCE_LINK", suffix: ".staging" },
    { alias: "SOURCE_LINK", suffix: ".previous" },
    ...(process.platform === "win32" ? [
      { alias: "CASE", suffix: ".staging" },
      { alias: "CASE", suffix: ".previous" },
    ] : []),
  ];

  it.each(CASES)("preserves a source inside $suffix with path alias $alias", async ({
    alias, suffix,
  }) => {
    const h = harness("reserved-source", 2);
    try {
      // A complete final generation makes interrupted-publish recovery remove
      // an occupied .previous sibling, exercising the actual destructive path.
      const physicalRoot = join(h.root, "physical");
      mkdirSync(physicalRoot);
      const destinationPath = join(physicalRoot, "generation");
      expect(await createBackupGeneration(request(h, { destinationPath })))
        .toMatchObject({ ok: true });
      const workingRoot = `${destinationPath}${suffix}`;
      const databasePath = join(workingRoot, "project.db");
      expect(workingRoot.startsWith(join(h.root, "physical", "generation"))).toBe(true);
      mkdirSync(workingRoot);
      const original = readFileSync(h.databasePath);
      renameSync(h.databasePath, databasePath);
      const manifestPath = join(destinationPath, "manifest.json");
      const published = readFileSync(manifestPath);
      const aliasRoot = join(h.root, "path-alias");
      if (alias.endsWith("_LINK")) {
        symlinkSync(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      }

      const result = await createBackupGeneration(request(h, {
        databasePath: alias === "SOURCE_LINK"
          ? join(aliasRoot, `generation${suffix}`, "project.db") : databasePath,
        destinationPath: alias === "DESTINATION_LINK"
          ? join(aliasRoot, "generation")
          : alias === "CASE" ? driveCaseAlias(destinationPath) : destinationPath,
      }));

      expect.soft(existsSync(databasePath), "the source database must remain present").toBe(true);
      if (existsSync(databasePath)) expect(readFileSync(databasePath)).toEqual(original);
      expectRefusal(result, "DESTINATION_UNSAFE");
      expect(readFileSync(manifestPath)).toEqual(published);
    } finally {
      h.cleanup();
    }
  });

  it("allows a new destination through an unrelated parent link", async () => {
    const h = harness("safe-linked-destination", 2);
    try {
      const physicalRoot = join(h.root, "physical");
      const aliasRoot = join(h.root, "path-alias");
      mkdirSync(physicalRoot);
      symlinkSync(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      const original = readFileSync(h.databasePath);
      const result = await createBackupGeneration(request(h, {
        destinationPath: join(aliasRoot, "new-parent", "generation"),
      }));
      expect(result).toMatchObject({ ok: true, restorable: true });
      expect(readFileSync(h.databasePath)).toEqual(original);
      expect(existsSync(join(physicalRoot, "new-parent", "generation", "manifest.json")))
        .toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it.each(["", ".staging", ".previous"])(
    "preserves a declared source object inside the destination%s path", async (suffix) => {
      const h = harness("reserved-object-source", 2);
      try {
        expect(await createBackupGeneration(request(h))).toMatchObject({ ok: true });
        const workingRoot = `${h.destinationPath}${suffix}`;
        const sourcePath = join(workingRoot, "source.bin");
        expect(workingRoot.startsWith(join(h.root, "generation"))).toBe(true);
        if (suffix !== "") mkdirSync(workingRoot);
        const first = h.objects[0];
        if (first === undefined) throw new Error("the fixture needs a declared source object");
        const originalPath = String(first.sourcePath);
        const original = readFileSync(originalPath);
        renameSync(originalPath, sourcePath);
        const manifestPath = join(h.destinationPath, "manifest.json");
        const published = readFileSync(manifestPath);

        const result = await createBackupGeneration(request(h, {
          objects: h.objects.map((entry, index) => index === 0 ? { ...entry, sourcePath } : entry),
        }));

        expect.soft(existsSync(sourcePath), "the declared source object must remain present")
          .toBe(true);
        if (existsSync(sourcePath)) expect(readFileSync(sourcePath)).toEqual(original);
        expectRefusal(result, "DESTINATION_UNSAFE");
        expect(readFileSync(manifestPath)).toEqual(published);
      } finally {
        h.cleanup();
      }
    },
  );
});
