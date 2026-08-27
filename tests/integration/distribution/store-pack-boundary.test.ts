import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STORE_ROOT = join(REPOSITORY_ROOT, "packages/store");
const FIXTURE_PATH = join(STORE_ROOT, "test-fixtures/recovery-slot-manifest-v1.json");
const FIXTURE_SHA256 = "56e2189cd32aabddddc0a2bccab54a0f0bef847fcabc7ad0d08d2a1771b25892";

function executableFromPath(name: string): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidateRoot = directory.replace(/^"|"$/gu, "");
    if (!isAbsolute(candidateRoot)) continue;
    for (const candidate of process.platform === "win32" ? [`${name}.exe`, name] : [name]) {
      try {
        const resolved = realpathSync(join(candidateRoot, candidate));
        if (statSync(resolved).isFile()) return resolved;
      } catch { /* keep searching */ }
    }
  }
  throw new Error(`missing test executable: ${name}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packPaths(): readonly string[] {
  const result = spawnSync(executableFromPath("pnpm"), ["pack", "--dry-run", "--json"], {
    cwd: STORE_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm pack failed (${result.status}): ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed["files"])) {
    throw new Error("pnpm pack returned an unreadable file roster");
  }
  return parsed["files"].map((entry, index) => {
    if (!isRecord(entry) || typeof entry["path"] !== "string") {
      throw new Error(`pnpm pack file ${index} has no path`);
    }
    return entry["path"].replaceAll("\\", "/");
  });
}

function manifestFiles(): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(STORE_ROOT, "package.json"), "utf8"));
  if (!isRecord(parsed)) throw new Error("@moe/store package.json is not an object");
  return parsed["files"];
}

describe("task-1a7b1446 @moe/store publish boundary", () => {
  it("excludes test-only recovery JSON while preserving the fixture for tests", () => {
    expect(existsSync(FIXTURE_PATH), "the source fixture must remain available").toBe(true);
    const fixture = readFileSync(FIXTURE_PATH);
    expect(fixture.byteLength).toBe(405);
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(FIXTURE_SHA256);

    const paths = packPaths();
    expect(paths.length).toBeGreaterThan(200);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/recovery-slot-manifest.ts");
    expect(paths.filter((path) => /(^|\/)test-fixtures\//u.test(path))).toEqual([]);
    expect(paths.filter((path) => !path.startsWith("src/")
      && /(^|\/)[^/]*recovery[^/]*\.json$/iu.test(path))).toEqual([]);
    expect(paths.filter((path) => path.endsWith(".json") && !path.startsWith("src/")))
      .toEqual(["package.json", "tsconfig.json"]);
  }, 120_000);

  it("pins the package manifest to the production source allowlist", () => {
    expect(manifestFiles()).toEqual(["src", "tsconfig.json"]);
  });
});
