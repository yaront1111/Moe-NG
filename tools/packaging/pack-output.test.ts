import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPackSnapshotsEqual,
  prepareWindowsArtifactOutput,
  snapshotPackTree,
} from "./pack-output.js";

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "moe-pack-output-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Windows pack output containment", () => {
  it("refuses a planted dist junction without touching its target", () => {
    const repositoryRoot = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = join(outside, "moe-windows.zip");
    writeFileSync(sentinel, "outside bytes");
    symlinkSync(outside, join(repositoryRoot, "dist"), process.platform === "win32" ? "junction" : "dir");

    expect(() => prepareWindowsArtifactOutput(repositoryRoot)).toThrow(
      expect.objectContaining({ code: "PACK_OUTPUT_PATH_UNSAFE", layer: "PACKAGING_OUTPUT" }),
    );
    expect(existsSync(sentinel)).toBe(true);
  });

  it("binds the archive verification roster and every regular file digest", () => {
    const staging = temporaryRoot();
    mkdirSync(join(staging, "apps"), { recursive: true });
    writeFileSync(join(staging, "apps", "daemon.js"), "trusted\n");
    const admitted = snapshotPackTree(staging, ["apps/daemon.js"]);

    writeFileSync(join(staging, ".env"), "SECRET=1\n");
    expect(() => snapshotPackTree(staging, ["apps/daemon.js"])).toThrow(
      expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT" }),
    );

    rmSync(join(staging, ".env"));
    writeFileSync(join(staging, "apps", "daemon.js"), "changed\n");
    const changed = snapshotPackTree(staging, ["apps/daemon.js"]);
    expect(() => assertPackSnapshotsEqual(admitted, changed)).toThrow(
      expect.objectContaining({ code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT" }),
    );
  });

  it("refuses a staged junction to an outside secret without reading or deleting it", () => {
    const staging = temporaryRoot();
    const outside = temporaryRoot();
    const sentinel = join(outside, "credentials.json");
    writeFileSync(sentinel, "outside secret\n");
    symlinkSync(outside, join(staging, "leak"), process.platform === "win32" ? "junction" : "dir");

    expect(() => snapshotPackTree(staging)).toThrow(expect.objectContaining({
      code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT",
    }));
    expect(readFileSync(sentinel, "utf8")).toBe("outside secret\n");
  });

  it("binds normalized file modes even when path, size and bytes are unchanged", () => {
    const staging = temporaryRoot();
    const executable = join(staging, "moe.cmd");
    writeFileSync(executable, "@echo off\n");
    chmodSync(executable, 0o444);
    const admitted = snapshotPackTree(staging);

    chmodSync(executable, 0o666);
    const changed = snapshotPackTree(staging);

    expect(admitted.entries[0]?.sha256).toBe(changed.entries[0]?.sha256);
    expect(() => assertPackSnapshotsEqual(admitted, changed)).toThrow(expect.objectContaining({
      code: "PACK_OUTPUT_SNAPSHOT_DRIFT", layer: "PACKAGING_OUTPUT",
    }));
  });

  it("refuses generated trees beyond every final artifact budget", () => {
    const cases = [
      { files: [["nested/file.txt", "x"]], limits: { maxEntries: 1 }, name: "entries" },
      { files: [["a.txt", ""], ["b.txt", ""]], limits: { maxFiles: 1 }, name: "files" },
      { files: [["large.txt", "1234"]], limits: { maxFileBytes: 3 }, name: "one file" },
      {
        files: [["first.txt", "123"], ["second.txt", "456"]],
        limits: { maxTotalBytes: 5 },
        name: "total bytes",
      },
    ] as const;
    expect(cases).toHaveLength(4);
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      const staging = temporaryRoot();
      for (const [path, contents] of testCase.files) {
        const parts = path.split("/");
        if (parts.length > 1) mkdirSync(join(staging, ...parts.slice(0, -1)), { recursive: true });
        writeFileSync(join(staging, ...parts), contents);
      }
      expect(
        () => snapshotPackTree(staging, undefined, testCase.limits),
        testCase.name,
      ).toThrow(expect.objectContaining({
        code: "PACK_OUTPUT_BUDGET_EXCEEDED", layer: "PACKAGING_OUTPUT",
      }));
    }
  });
});
