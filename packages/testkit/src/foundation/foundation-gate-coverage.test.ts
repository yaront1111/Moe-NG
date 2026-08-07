/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY ratchet for the task gate itself.
 *
 * QA rejected the first pass of this specification because the filed
 * verification command (`pnpm --filter @moe/testkit ...`) is scoped to the
 * testkit package directory and structurally cannot reach the other owned
 * path, `tests/fault/foundation/**`. Three files and 43 tests were neither
 * executed nor typechecked by evidence filed as exit code 0.
 *
 * A prose promise not to do that again is worth nothing, so this file is the
 * mechanism: it reads the real tool configuration off disk and fails when any
 * owned file stops being covered by the filed gate. It lives under
 * `packages/testkit/src` deliberately — inside the narrow command — so the
 * coverage check can never itself fall outside the thing it checks.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** The owned paths of this task, exactly as the task record names them. */
const OWNED_DIRECTORIES = ["packages/testkit/src/foundation", "tests/fault/foundation"] as const;

/**
 * The commands filed as this task's verification evidence. Every owned file
 * must be reachable from one of them; every entry must cover something.
 */
const GATE_TEST_FILTERS = ["packages/testkit/src", "tests/fault/foundation"] as const;

/** The tsconfig projects that must, between them, typecheck every owned file. */
const GATE_TYPECHECK_PROJECTS = [
  "packages/testkit/tsconfig.json",
  "tests/fault/foundation/tsconfig.json",
] as const;

interface TsconfigShape {
  readonly extends?: string;
  readonly include?: readonly string[];
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

/** Minimal tsconfig-glob matcher: `**` spans directories, `*` does not. */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//u, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += character === undefined ? "" : character.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

async function readTsconfig(projectPath: string): Promise<TsconfigShape> {
  return JSON.parse(await readFile(join(repositoryRoot, projectPath), "utf8")) as TsconfigShape;
}

async function ownedFiles(): Promise<string[]> {
  return (await Promise.all(OWNED_DIRECTORIES.map(typescriptFiles))).flat();
}

describe("foundation gate covers every owned path", () => {
  it("finds owned files in both directories, so an empty scan cannot fake a pass", async () => {
    const files = await ownedFiles();
    expect(files.length).toBeGreaterThanOrEqual(13);
    for (const directory of OWNED_DIRECTORIES) {
      expect(files.filter((file) => file.startsWith(`${directory}/`)).length)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it("executes every owned test file through a filed gate filter", async () => {
    const testFiles = (await ownedFiles()).filter((file) => file.endsWith(".test.ts"));
    expect(testFiles.length).toBeGreaterThanOrEqual(5);
    const uncovered = testFiles.filter(
      (file) => !GATE_TEST_FILTERS.some((filter) => file.startsWith(`${filter}/`)),
    );
    expect(uncovered).toEqual([]);
    for (const filter of GATE_TEST_FILTERS) {
      expect(testFiles.some((file) => file.startsWith(`${filter}/`))).toBe(true);
    }
  });

  it("keeps the testkit package script equal to the narrow filter it is credited with", async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "packages/testkit/package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    const positional = manifest.scripts.test
      ?.split(/\s+/u)
      .filter((token) => token.includes("/") && !token.startsWith("-") && !token.startsWith(".."));
    expect(positional).toEqual(["packages/testkit/src"]);
  });

  it("matches the root vitest include against the owned fault directory", async () => {
    const config = await readFile(join(repositoryRoot, "vitest.config.ts"), "utf8");
    expect(config).toContain('"tests/**/*.test.ts"');
  });

  it("typechecks every owned file through a tsconfig project on the shared base", async () => {
    const projects = await Promise.all(
      GATE_TYPECHECK_PROJECTS.map(async (projectPath) => {
        const tsconfig = await readTsconfig(projectPath);
        return {
          directory: toPosix(relative(repositoryRoot, join(repositoryRoot, projectPath, ".."))),
          extendsBase: tsconfig.extends ?? "",
          include: tsconfig.include ?? [],
        };
      }),
    );
    for (const project of projects) {
      expect(project.extendsBase).toMatch(/tsconfig\.base\.json$/u);
      expect(project.include.length).toBeGreaterThan(0);
    }
    const uncovered = (await ownedFiles()).filter(
      (file) =>
        !projects.some(
          (project) =>
            file.startsWith(`${project.directory}/`) &&
            project.include.some((pattern) =>
              globToRegExp(pattern).test(file.slice(project.directory.length + 1)),
            ),
        ),
    );
    expect(uncovered).toEqual([]);
  });
});
