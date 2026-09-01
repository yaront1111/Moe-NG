import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * The pack's IMPORT-CLOSURE gate, kept apart from the tree shaping in
 * `pack-staging.ts` because it answers a different question: not "what is in the
 * artifact" but "does what is in the artifact still resolve".
 *
 * It exists because a prune can succeed and still ruin the download — delete a
 * fixture and every surviving module that imported it dies with
 * `ERR_MODULE_NOT_FOUND` on the operator's machine, long after the pack printed
 * a size and exited 0.
 */

export interface ImportFaults {
  /** `<file> -> <specifier>` for a relative import with no target in the tree. */
  readonly dangling: readonly string[];
  /** `<file> -> <package>` for a shipped source importing a dev-only package. */
  readonly devDependency: readonly string[];
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u;
/**
 * All three shapes an edge takes here: `from "x"`, `import("x")` — dynamic AND
 * the type-position form this repo uses — and the side-effect `import "x";`.
 * Matching only the first would let a lost target hide behind the other two.
 */
const RELATIVE_PATTERNS = Object.freeze([
  /\bfrom\s*["'](\.[^"']*)["']/gu,
  /\bimport\s*\(\s*["'](\.[^"']*)["']/gu,
  /(?:^|\n)\s*import\s*["'](\.[^"']*)["']/gu,
]);
const BARE_PATTERNS = Object.freeze([
  /\bfrom\s*["']([^."'][^"']*)["']/gu,
  /\bimport\s*\(\s*["']([^."'][^"']*)["']/gu,
]);

function specifiersOf(text: string, patterns: readonly RegExp[]): readonly string[] {
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ""));
}

/** `./x.js` in a source file is `./x.ts` on disk, and either end satisfies the import. */
function importCandidates(from: string, specifier: string): readonly string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.js$/u, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}/index.js`, `${base}/index.ts`];
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

/**
 * Proves the pruned tree is still LOADABLE, which is the half of "ships no tests"
 * that a prune can silently break: delete a fixture and any surviving module that
 * imported it dies with `ERR_MODULE_NOT_FOUND` on the operator's machine, long
 * after the pack reported success. It is also what keeps the named test-support
 * list from going stale — an entry that should be there and is not shows up here
 * as a dangling edge and stops the pack.
 */
export function collectImportFaults(
  root: string, files: readonly string[], devDependencies: readonly string[],
): ImportFaults {
  const present = new Set(files);
  const dev = new Set(devDependencies);
  const dangling = new Set<string>();
  const devImports = new Set<string>();
  for (const file of files) {
    if (file.split("/").includes("node_modules") || !SOURCE_FILE.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiersOf(text, RELATIVE_PATTERNS)) {
      if (importCandidates(file, specifier).some((path) => present.has(path))) continue;
      dangling.add(`${file} -> ${specifier}`);
    }
    for (const specifier of specifiersOf(text, BARE_PATTERNS)) {
      const name = packageNameOf(specifier);
      if (dev.has(name)) devImports.add(`${file} -> ${name}`);
    }
  }
  return Object.freeze({
    dangling: Object.freeze([...dangling].sort()),
    devDependency: Object.freeze([...devImports].sort()),
  });
}
