import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const schedulerRoot = join(repositoryRoot, "packages", "scheduler");
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx|astro|mdx|svelte|vue)$/u;
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return files;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === schedulerRoot || path.includes(`${sep}node_modules${sep}`)) {
        continue;
      }
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && sourceExtension.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

it("keeps scheduler registrars behind the package-root import boundary", async () => {
  const violations: string[] = [];
  for (const root of ["adapters", "apps", "packages"]) {
    const files = await sourceFiles(join(repositoryRoot, root));
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      if (forbiddenInternalPath.test(contents)) {
        violations.push(relative(repositoryRoot, file));
      }
    }
  }
  expect(violations).toEqual([]);
});

it.each([
  "source.js",
  "source.jsx",
  "source.mjs",
  "source.cjs",
  "source.ts",
  "source.tsx",
  "source.mts",
  "source.cts",
  "source.astro",
  "source.mdx",
  "source.svelte",
  "source.vue",
])("scans package-capable source extension in %s", (fileName) => {
  expect(sourceExtension.test(fileName)).toBe(true);
});

it("exports only the supported scheduler root", async () => {
  const packageJson = JSON.parse(
    await readFile(join(schedulerRoot, "package.json"), "utf8"),
  ) as { readonly exports?: unknown };
  expect(packageJson.exports).toEqual({ ".": "./src/index.ts" });
});
