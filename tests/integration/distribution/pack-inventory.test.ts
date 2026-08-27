import { describe, expect, it } from "vitest";

import {
  PACK_BRIDGE_MISSING,
  PACK_DANGLING_IMPORT,
  PACK_DEV_DEPENDENCY_IMPORT,
  PACK_DEV_DEPENDENCY_PRESENT,
  PACK_REQUIRED_PATH_MISSING,
  PACK_SENSITIVE_PATH_PRESENT,
  PACK_TEST_ARTIFACT_PRESENT,
  PACK_VCS_ARTIFACT_PRESENT,
  PACK_WORKTREE_DIRTY,
  REQUIRED_STAGED_PATHS,
  SHIPPED_PREFIXES,
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

  it.each(["fixture", "fixtures", "test-fixtures"])(
    "refuses a shipped %s directory",
    (directory) => {
      const input = clean({
        paths: [...clean().paths, `packages/store/${directory}/recovery-slot-manifest-v1.json`],
      });
      expect(codes(input)).toEqual([PACK_TEST_ARTIFACT_PRESENT]);
    },
  );

  it("refuses a stray tsbuildinfo left by a typecheck", () => {
    const input = clean({ paths: [...clean().paths, "apps/daemon/tsconfig.scope.tsbuildinfo"] });
    expect(codes(input)).toEqual([PACK_TEST_ARTIFACT_PRESENT]);
  });

  it("refuses a .git directory anywhere in the tree", () => {
    const input = clean({ paths: [...clean().paths, "packages/store/.git/HEAD"] });
    expect(codes(input)).toEqual([PACK_VCS_ARTIFACT_PRESENT]);
  });

  it.each([
    ".git-credentials",
    ".docker/config.json",
    "certificates/AuthKey_ABC123.p8",
    "release/credentials.csv",
    "operator/.kube/config",
    "release/github-token.json",
    "operator/.aws/credentials",
    "operator/.config/gcloud/application_default_credentials.json",
    "operator/.azure/TokenCache.dat",
    "operator/.credentials",
    "operator/auth.json",
    "operator/credentials.xml",
    "operator/service-account.json",
    "ssh/operator.ppk",
    ".env~",
    ".npmrc.bak",
    ".npmrc.tmp",
    ".vault-token",
    ".yarnrc.yml",
    "release/credentials.json.bak",
    "release/credentials.json.temp",
    "ssh/id_rsa.old",
    "certificates/service.key.backup",
    "release/serviceAccountKey.json",
    "operator/.config/gh/hosts.yml",
  ])("refuses sensitive credential path %s in the final staged inventory", (path) => {
    const input = clean({ paths: [...clean().paths, path] });
    expect(codes(input)).toEqual([PACK_SENSITIVE_PATH_PRESENT]);
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

/**
 * The conventional secret-bearing roster is GENERATED, not hand-typed, because a
 * hand-typed table is exactly what a hostile Windows spelling walks past. Each
 * axis below is one real evasion measured against this gate: ASCII case, the
 * leading-dot hiding convention, the secret-document extensions that make a
 * credential look like configuration, and the backslash separator a Windows
 * staging pass hands us verbatim.
 */
const SENSITIVE_BASES = ["token", "tokens", "secret", "secrets", "credential", "credentials"];
const SENSITIVE_EXTENSIONS = ["", ".json", ".yaml", ".yml", ".txt"];
const CASINGS = [
  (value: string) => value.toLowerCase(),
  (value: string) => value.toUpperCase(),
  (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
];

function generatedSensitiveCases(): readonly string[] {
  const cases: string[] = [];
  for (const base of SENSITIVE_BASES) {
    for (const extension of SENSITIVE_EXTENSIONS) {
      for (const casing of CASINGS) {
        for (const dot of ["", "."]) {
          for (const separator of ["/", "\\"]) {
            cases.push(`release${separator}${dot}${casing(`${base}${extension}`)}`);
          }
        }
      }
    }
  }
  return cases;
}

/** Shapes with no case/dot/separator axis of their own; spelled out to stay readable. */
const FIXED_SENSITIVE_CASES = [
  ".env", ".env.local", ".ENV", "x/.env.production",
  "id_rsa", "id_ed25519", "ID_RSA", "ssh\\id_rsa",
  "certificates/a.pem", "certificates/b.key", "certificates/c.ppk",
  "certificates/d.p12", "certificates/e.pfx",
  "certificates/A.PEM", "certificates/B.KEY", "certificates/C.PPK",
  "certificates/D.P12", "certificates/E.PFX",
  // POSIX hides these exactly as it hides `.token`, so stripping ONE dot only moves
  // the evasion one character to the right.
  "release/...token", "release/...SECRET", "release\\..credentials.json",
];

const SENSITIVE_CASES = [...generatedSensitiveCases(), ...FIXED_SENSITIVE_CASES];

describe("inspectStagedTree refuses the conventional secret-bearing roster", () => {
  it("generates every hostile spelling, so a silently empty sweep cannot read as a pass", () => {
    expect(SENSITIVE_CASES.length).toBe(381);
    expect(new Set(SENSITIVE_CASES).size).toBe(SENSITIVE_CASES.length);
  });

  it.each(SENSITIVE_CASES)("refuses sensitive staged path %s", (path) => {
    const result = inspectStagedTree(clean({ paths: [...clean().paths, path] }));
    if (result.ok) throw new Error(`expected a refusal for ${path}, got admission`);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe("PACK_SENSITIVE_PATH_PRESENT");
    expect(result.refusals[0]?.layer).toBe("PACKAGING_INVENTORY");
  });

  // The roster is a FROZEN conventional-filename list, not a substring hunt: every
  // path here contains "token" or "credential" and every one of them is ordinary
  // production source that a release is obliged to ship.
  it.each([
    "styles/tokens.css",
    "apps/x/session-token.ts",
    "packages/y/credential-codec.ts",
    "src/design-tokens.json",
    "node_modules/@scope/pkg/token.js",
    "src/tokenizer.ts",
    "src/token-bucket.ts",
    "tokens/index.ts",
  ])("admits legitimate production path %s", (path) => {
    expect(codes(clean({ paths: [...clean().paths, path] }))).toEqual([]);
  });

  it("reports the path and nothing else, because the gate never opens the candidate", () => {
    const result = inspectStagedTree(clean({ paths: [...clean().paths, "operator/.token.txt"] }));
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals[0]?.detail).toBe("operator/.token.txt");
    expect(result.refusals[0]?.message).toBe(
      "PACK_SENSITIVE_PATH_PRESENT: operator/.token.txt",
    );
  });

  it("stamps the layer on a refusal from a DIFFERENT rule, so it names the gate not the rule", () => {
    const result = inspectStagedTree(clean({ paths: [...clean().paths, "packages/store/.git/HEAD"] }));
    if (result.ok) throw new Error("expected a refusal, got admission");
    expect(result.refusals[0]?.code).toBe("PACK_VCS_ARTIFACT_PRESENT");
    expect(result.refusals[0]?.layer).toBe("PACKAGING_INVENTORY");
  });
});

describe("inspectWorktree refuses to ship a peer's uncommitted bytes", () => {
  // The PRODUCTION list, not a test-local copy: a copy would keep these cases green
  // while the pack script's own gate quietly narrowed.
  const OWNED = SHIPPED_PREFIXES;

  it("admits a clean worktree", () => {
    expect(inspectWorktree([], OWNED)).toBe(null);
  });

  it("admits dirt outside the shipped paths", () => {
    expect(inspectWorktree([" M .moe/tasks/task-1.json", "?? notes.md"], OWNED)).toBe(null);
  });

  it("refuses dirty packaging code because those bytes author the release artifact", () => {
    for (const line of [
      " M tools/packaging/pack-docs.ts",
      "?? tools/packaging/new-pack-stage.ts",
    ]) {
      const refusal = inspectWorktree([line], OWNED);
      expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
      expect(refusal?.detail).toContain(line.slice(3));
    }
  });

  it("does not widen packaging authority to unrelated tools", () => {
    expect(inspectWorktree([" M tools/import/import-shadow.ts"], OWNED)).toBe(null);
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

  it("refuses a modified lockfile, which decides the third-party closure pnpm deploy ships", () => {
    const refusal = inspectWorktree([" M pnpm-lock.yaml"], OWNED);
    expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
    expect(refusal?.detail).toContain("pnpm-lock.yaml");
  });

  it("refuses a modified root manifest, whose version and dependency fields reach the zip", () => {
    const refusal = inspectWorktree([" M package.json"], OWNED);
    expect(refusal?.code).toBe(PACK_WORKTREE_DIRTY);
    expect(refusal?.detail).toContain("package.json");
  });

  it("refuses the workspace definition and the pnpm config, which shape the deploy", () => {
    for (const line of [" M pnpm-workspace.yaml", " M .npmrc"]) {
      expect(inspectWorktree([line], OWNED)?.code).toBe(PACK_WORKTREE_DIRTY);
    }
  });

  it("reads the root manifest as an exact path, not as any file so named", () => {
    expect(inspectWorktree([" M tests/e2e/package.json"], OWNED)).toBe(null);
  });
});
