import { describe, expect, it } from "vitest";

import {
  PACK_BRIDGE_MISSING,
  PACK_DANGLING_IMPORT,
  PACK_DEV_DEPENDENCY_IMPORT,
  PACK_DEV_DEPENDENCY_PRESENT,
  PACK_REQUIRED_PATH_MISSING,
  PACK_TEST_ARTIFACT_PRESENT,
  PACK_VCS_ARTIFACT_PRESENT,
  PACK_WORKTREE_DIRTY,
  REQUIRED_STAGED_PATHS,
  inspectStagedTree,
  inspectWorktree,
} from "../../../tools/packaging/pack-inventory.js";
import type { PackInventoryInput } from "../../../tools/packaging/pack-inventory.js";

/** A staging tree that satisfies every rule; each test breaks exactly one thing. */
function clean(overrides: Partial<PackInventoryInput> = {}): PackInventoryInput {
  return {
    danglingImports: [],
    devDependencies: ["vitest", "typescript", "@types/node"],
    devDependencyImports: [],
    expectedBridges: ["packages/store/src/index-surface.js"],
    paths: [
      ...REQUIRED_STAGED_PATHS,
      "packages/store/src/index-surface.ts",
      "packages/store/src/index-surface.js",
      "node_modules/express/index.js",
      "node_modules/@modelcontextprotocol/sdk/package.json",
    ],
    ...overrides,
  };
}

function codes(input: PackInventoryInput): readonly string[] {
  const result = inspectStagedTree(input);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("inspectStagedTree admits a compliant tree", () => {
  it("accepts a tree that carries every required path and nothing forbidden", () => {
    const result = inspectStagedTree(clean());
    if (!result.ok) {
      throw new Error(`expected admission, got ${result.refusals.map((r) => r.message).join("; ")}`);
    }
    expect(result.fileCount).toBe(clean().paths.length);
  });

  it("names at least the CLI entry, the licence, the closure list and the link manifest", () => {
    expect(REQUIRED_STAGED_PATHS).toContain("apps/daemon/src/cli/moe-cli-main.ts");
    expect(REQUIRED_STAGED_PATHS).toContain("LICENSE");
    expect(REQUIRED_STAGED_PATHS).toContain("MANIFEST-CLOSURE.txt");
    expect(REQUIRED_STAGED_PATHS).toContain("moe-workspace-links.json");
  });
});

describe("inspectStagedTree refuses by name", () => {
  it("refuses a missing required path and names the path, not the rule", () => {
    const paths = clean().paths.filter((path) => path !== "LICENSE");
    const result = inspectStagedTree(clean({ paths }));
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([PACK_REQUIRED_PATH_MISSING]);
    expect(result.refusals[0]?.detail).toBe("LICENSE");
  });

  it("refuses a shipped unit test", () => {
    const input = clean({ paths: [...clean().paths, "packages/store/src/thing.test.ts"] });
    expect(codes(input)).toEqual([PACK_TEST_ARTIFACT_PRESENT]);
  });

  it("refuses a stray tsbuildinfo left by a typecheck", () => {
    const input = clean({ paths: [...clean().paths, "apps/daemon/tsconfig.scope.tsbuildinfo"] });
    expect(codes(input)).toEqual([PACK_TEST_ARTIFACT_PRESENT]);
  });

  it("refuses a .git directory anywhere in the tree", () => {
    const input = clean({ paths: [...clean().paths, "packages/store/.git/HEAD"] });
    expect(codes(input)).toEqual([PACK_VCS_ARTIFACT_PRESENT]);
  });

  it("refuses an unscoped dev dependency and names the package", () => {
    const input = clean({ paths: [...clean().paths, "node_modules/vitest/dist/index.js"] });
    const result = inspectStagedTree(input);
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([PACK_DEV_DEPENDENCY_PRESENT]);
    expect(result.refusals[0]?.detail).toBe("vitest");
  });

  it("refuses a SCOPED dev dependency, whose directory is two segments deep", () => {
    const input = clean({ paths: [...clean().paths, "node_modules/@types/node/index.d.ts"] });
    const result = inspectStagedTree(input);
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals[0]?.detail).toBe("@types/node");
  });

  it("does not mistake a production package for a dev dependency", () => {
    expect(codes(clean())).toEqual([]);
  });

  it("refuses a .js bridge the source offers but the staging tree lost", () => {
    const paths = clean().paths.filter((path) => !path.endsWith("index-surface.js"));
    const result = inspectStagedTree(clean({ paths }));
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([PACK_BRIDGE_MISSING]);
    expect(result.refusals[0]?.detail).toBe("packages/store/src/index-surface.js");
  });

  it("refuses a shipped source whose relative import lost its target", () => {
    const input = clean({
      danglingImports: ["packages/scheduler/src/admission/admission.ts -> ./admission-fixtures.js"],
    });
    const result = inspectStagedTree(input);
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([PACK_DANGLING_IMPORT]);
    expect(result.refusals[0]?.detail).toContain("./admission-fixtures.js");
  });

  it("refuses a shipped source that imports a dev dependency it cannot resolve", () => {
    const input = clean({ devDependencyImports: ["packages/mcp/src/conformance.ts -> vitest"] });
    const result = inspectStagedTree(input);
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([PACK_DEV_DEPENDENCY_IMPORT]);
    expect(result.refusals[0]?.detail).toContain("vitest");
  });

  it("reports every applicable refusal rather than stopping at the first", () => {
    const paths = clean().paths
      .filter((path) => path !== "LICENSE")
      .concat(["packages/store/src/thing.test.ts", "node_modules/vitest/index.js"]);
    expect(codes(clean({ paths }))).toEqual([
      PACK_REQUIRED_PATH_MISSING, PACK_TEST_ARTIFACT_PRESENT, PACK_DEV_DEPENDENCY_PRESENT,
    ]);
  });
});

describe("inspectWorktree refuses to ship a peer's uncommitted bytes", () => {
  const OWNED = Object.freeze(["apps/daemon/", "packages/", "adapters/", "LICENSE"]);

  it("admits a clean worktree", () => {
    expect(inspectWorktree([], OWNED)).toBe(null);
  });

  it("admits dirt outside the shipped paths", () => {
    expect(inspectWorktree([" M .moe/tasks/task-1.json", "?? notes.md"], OWNED)).toBe(null);
  });

  it("refuses a modified shipped file and names it", () => {
    const refusal = inspectWorktree([" M packages/store/src/index.ts"], OWNED);
    expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
    expect(refusal?.detail).toContain("packages/store/src/index.ts");
  });

  it("refuses an UNTRACKED shipped file, which a modified-only check would miss", () => {
    const refusal = inspectWorktree(["?? packages/store/src/new-thing.ts"], OWNED);
    expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
    expect(refusal?.detail).toContain("packages/store/src/new-thing.ts");
  });

  it("reads the destination of a rename, not only its origin", () => {
    const refusal = inspectWorktree(["R  docs/a.md -> packages/store/src/b.ts"], OWNED);
    expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
    expect(refusal?.detail).toContain("packages/store/src/b.ts");
  });

  it("names every dirty shipped path, so one pack run fixes them all", () => {
    const refusal = inspectWorktree(
      [" M packages/store/src/a.ts", "?? apps/daemon/src/b.ts"], OWNED,
    );
    expect(refusal?.detail).toContain("packages/store/src/a.ts");
    expect(refusal?.detail).toContain("apps/daemon/src/b.ts");
  });
});
