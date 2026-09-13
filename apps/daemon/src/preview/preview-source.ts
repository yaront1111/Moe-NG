import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { nodeGitRunner } from "../repository/git-landing-port.js";
import { extractCommittedPath } from "../repository/git-source-extract.js";

export interface PreviewSource {
  readonly directory: string;
  readonly files: readonly string[];
  readonly dispose: () => void;
  readonly verify: () => boolean;
}

interface SourceEntry { readonly path: string; readonly blob: string }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Stop may precede the OS reap on Windows. Retain live source and reclaim it after measured exit. */
export function releasePreviewSource(source: PreviewSource, alive: () => boolean): void {
  try { if (!alive()) { source.dispose(); return; } } catch { /* retain until exit and cleanup are measurable */ }
  const timer = setTimeout(() => releasePreviewSource(source, alive), 100);
  timer.unref?.();
}

function matches(directory: string, entries: readonly SourceEntry[], sha: string): boolean {
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return false;
    for (const entry of entries) {
      const segments = entry.path.split("/");
      let parent = directory;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      }
      const path = resolve(directory, ...segments);
      if (!path.startsWith(`${directory}${sep}`) || !lstatSync(path).isFile()) return false;
      const bytes = readFileSync(path);
      const hash = createHash(sha.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (hash !== entry.blob) return false;
    }
    return true;
  } catch { return false; }
}

/** Symlinks and submodules need their own immutable resolution contract before they can run. */
function sourceEntries(listing: string): readonly SourceEntry[] | null {
  const entries: SourceEntry[] = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/su.exec(record);
    if (match === null) return null;
    const path = match[3]!;
    if (isAbsolute(path) || /[\\\u0000-\u001f:]/u.test(path)
      || path.split("/").some(segment => segment === ".." || segment === "." || segment === "")) return null;
    entries.push({ path, blob: match[2]! });
  }
  return entries;
}

/**
 * Copy the selected commit out of Git's object store, never the operator's working tree.
 * The isolated bare checkout excludes local attributes and replacement refs. Raw blob hashes
 * additionally reject checkout transformations (including global smudge filters and encodings).
 * No mutable dependency directory is attached: a command must prepare any missing dependencies
 * inside this source directory under its existing configured execution authority.
 */
export async function preparePreviewSource(repository: string, sha: string): Promise<PreviewSource | null> {
  if (!isAbsolute(repository) || !SHA.test(sha)) return null;
  let directory: string | null = null;
  let retained = false;
  let temporaryRoot: string | null = null;
  const dispose = (): void => {
    if (directory !== null && temporaryRoot !== null
      && resolve(directory).startsWith(`${temporaryRoot}${sep}moe-preview-source-`)) {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    temporaryRoot = resolve(realpathSync(tmpdir()));
    const listed = await nodeGitRunner(repository, ["--no-replace-objects", "ls-tree", "-r", "-z", "--full-tree", sha]);
    if (listed.code !== 0) return null;
    const entries = sourceEntries(listed.stdout);
    if (entries === null) return null;
    directory = mkdtempSync(join(temporaryRoot, "moe-preview-source-"));
    if (await extractCommittedPath(nodeGitRunner, { destination: directory, path: ".", repository, sha }) !== "OK") {
      return null;
    }
    const selected = directory;
    const verify = (): boolean => matches(selected, entries, sha);
    if (!verify()) return null;
    retained = true;
    return Object.freeze({ directory, dispose, files: Object.freeze(entries.map(entry => entry.path)), verify });
  } catch {
    return null;
  } finally {
    if (!retained) dispose();
  }
}
