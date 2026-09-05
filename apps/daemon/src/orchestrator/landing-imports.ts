/**
 * The untracked files a landing must carry so the commit it makes still builds.
 *
 * The lander commits exactly the paths a seat changed. A file that was already untracked
 * when the seat was staffed is operator dirt to the baseline and is never swept — right for
 * the operator's own work, wrong for a module the landed code IMPORTS: `evidence.ts` landed
 * on UnAI (cbca86a, 2026-09-05) importing `./identities.ts`, which no landing ever carried,
 * so HEAD did not build on a clean checkout and no later seat could land it either (it was
 * dirt to every baseline). Here the landed files' relative imports are resolved against the
 * untracked paths git reported, transitively, and those files ride the same commit.
 *
 * Only RELATIVE specifiers (`./`, `../`) in the JavaScript/TypeScript spellings are read;
 * a package or absolute import is somebody else's file. Only UNTRACKED targets are carried:
 * a tracked-but-modified import already has a committed version HEAD can build with, and
 * sweeping the operator's edits to it would be exactly the mistake the baseline prevents.
 */
import { posix } from "node:path";

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/gu;
const RESOLVED_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const INDEX_FILES = Object.freeze(["index.ts", "index.tsx", "index.js", "index.mjs"]);

/** Relative import specifiers in `text`, in source order, duplicates kept. */
export function relativeSpecifiers(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] as string;
    if (specifier.startsWith("./") || specifier.startsWith("../")) found.push(specifier);
  }
  return found;
}

/** Every path a specifier written in `from` could name, most literal first. */
export function candidatePaths(from: string, specifier: string): readonly string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stripped = base.replace(/\.(?:js|mjs|cjs|jsx)$/u, "");
  const candidates = [base];
  if (stripped !== base) candidates.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}.cts`);
  for (const extension of RESOLVED_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const index of INDEX_FILES) candidates.push(posix.join(base, index));
  return candidates;
}

/**
 * The untracked paths reachable from `landed` through relative imports, in discovery
 * order, none of them already in `landed`. `readText` answers a root-relative path's
 * current content, or null when it cannot be read (an unreadable file imports nothing).
 */
export function untrackedImports(
  landed: readonly string[],
  untracked: ReadonlySet<string>,
  readText: (path: string) => string | null,
): readonly string[] {
  const carried: string[] = [];
  const seen = new Set(landed);
  const queue = [...landed];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const text = readText(next);
    if (text === null) continue;
    for (const specifier of relativeSpecifiers(text)) {
      const target = candidatePaths(next, specifier).find((candidate) => untracked.has(candidate));
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      carried.push(target);
      queue.push(target);
    }
  }
  return carried;
}
