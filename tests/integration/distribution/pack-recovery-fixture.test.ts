import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PACK_TEST_ARTIFACT_PRESENT, inspectStagedTree,
} from "../../../tools/packaging/pack-inventory.js";
import { snapshotPackTree } from "../../../tools/packaging/pack-output.js";
import { pruneTestArtifacts, walkFiles } from "../../../tools/packaging/pack-staging.js";
import { reshapeWindowsDeploy } from "../../../tools/packaging/pack-windows.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_RELATIVE = "tests/fixtures/store/recovery-slot-manifest-v1.json";
const DEPLOYED_FIXTURE =
  "node_modules/@moe/store/test-fixtures/recovery-slot-manifest-v1.json";
const FINAL_FIXTURE = "packages/store/test-fixtures/recovery-slot-manifest-v1.json";

let owner = "";
let deployDir = "";
let staging = "";

beforeAll(() => {
  owner = mkdtempSync(join(tmpdir(), "moe-pack-recovery-fixture-"));
  deployDir = join(owner, "deploy");
  staging = join(owner, "staging");
  const store = join(deployDir, "node_modules", "@moe", "store");
  mkdirSync(store, { recursive: true });
  cpSync(join(REPO_ROOT, "packages", "store", "src"), join(store, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "packages", "store", "package.json"), join(store, "package.json"));
  mkdirSync(deployDir, { recursive: true });
  cpSync(join(REPO_ROOT, "apps", "daemon", "src"), join(deployDir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "apps", "daemon", "package.json"), join(deployDir, "package.json"));
  mkdirSync(staging, { recursive: false });
});

afterAll(() => {
  if (owner !== "") rmSync(owner, { force: true, recursive: true });
});

describe("the historical recovery manifest stays test-only in the real Windows pack path", () => {
  it("remains readable but is absent from the production deploy-shaped store package", () => {
    const fixture = join(REPO_ROOT, FIXTURE_RELATIVE);
    expect(readFileSync(fixture, "utf8")).toContain('"moe-recovery-slot/1"');
    expect(existsSync(join(deployDir, "node_modules/@moe/store/src/recovery-slot-manifest.ts")))
      .toBe(true);
    expect(existsSync(join(deployDir, DEPLOYED_FIXTURE))).toBe(false);
    expect(walkFiles(deployDir).filter((path) =>
      path.endsWith("/recovery-slot-manifest-v1.json"))).toEqual([]);
  });

  it("refuses and prunes the exact final path before the admitted archive snapshot", () => {
    reshapeWindowsDeploy(deployDir, staging);
    expect(existsSync(join(staging, FINAL_FIXTURE))).toBe(false);

    const planted = join(staging, FINAL_FIXTURE);
    mkdirSync(dirname(planted), { recursive: true });
    cpSync(join(REPO_ROOT, FIXTURE_RELATIVE), planted);

    const before = inspectStagedTree({
      danglingImports: [],
      devDependencies: [],
      devDependencyImports: [],
      expectedBridges: [],
      paths: walkFiles(staging),
    });
    if (before.ok) throw new Error("expected the planted recovery fixture to be refused");
    expect(before.refusals).toContainEqual(expect.objectContaining({
      code: PACK_TEST_ARTIFACT_PRESENT,
      detail: FINAL_FIXTURE,
    }));

    expect(pruneTestArtifacts(staging)).toContain(FINAL_FIXTURE);
    const finalPaths = walkFiles(staging);
    expect(finalPaths).not.toContain(FINAL_FIXTURE);
    const after = inspectStagedTree({
      danglingImports: [],
      devDependencies: [],
      devDependencyImports: [],
      expectedBridges: [],
      paths: finalPaths,
    });
    if (!after.ok) {
      expect(after.refusals).not.toContainEqual(expect.objectContaining({
        code: PACK_TEST_ARTIFACT_PRESENT,
        detail: FINAL_FIXTURE,
      }));
    }
    expect(snapshotPackTree(staging, finalPaths).entries.map((entry) => entry.path))
      .not.toContain(FINAL_FIXTURE);
  });
});
