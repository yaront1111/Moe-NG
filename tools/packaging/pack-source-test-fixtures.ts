import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type ObjectFormat = "sha1" | "sha256";
const FORMATS: readonly ObjectFormat[] = ["sha1", "sha256"];
const SEED_PREFIX = "moe-pack-fixture-seed-";

/**
 * Only repository preparation is reused. Each caller owns a physical copy, including
 * its index, refs, config and objects: no shared worktree, hardlinks or alternates.
 * Seed roots are private and never supplied to a test or the packaging consumer.
 */
export function createPackSourceFixturePool<T extends { readonly repositoryRoot: string }>(
  build: (root: string, format: ObjectFormat) => T,
  ownCaseRoot: (root: string) => void,
) {
  const seeds = new Map<ObjectFormat, T>();
  const seedRoots: string[] = [];
  return Object.freeze({
    prepare(): void {
      if (seedRoots.length !== 0) throw new Error("pack fixture pool already prepared");
      for (const format of FORMATS) {
        const root = realpathSync(mkdtempSync(join(tmpdir(), SEED_PREFIX)));
        seedRoots.push(root); // Retain ownership even if Git preparation fails.
        seeds.set(format, Object.freeze(build(root, format)));
      }
    },
    create(format: ObjectFormat = "sha1"): T {
      const seed = seeds.get(format);
      if (seed === undefined) throw new Error("pack fixture pool not prepared");
      const repositoryRoot = realpathSync(mkdtempSync(join(tmpdir(), `moe-pack-source-${format}-`)));
      ownCaseRoot(repositoryRoot); // A partial copy is still this case's cleanup responsibility.
      cpSync(seed.repositoryRoot, repositoryRoot, { recursive: true, force: false, errorOnExist: true });
      return Object.freeze({ ...seed, repositoryRoot });
    },
    dispose(): void {
      const tempRoot = realpathSync(tmpdir());
      for (const root of seedRoots) {
        if (dirname(root) !== tempRoot || !basename(root).startsWith(SEED_PREFIX)) {
          throw new Error("pack fixture seed ownership changed");
        }
        rmSync(root, { force: true, recursive: true });
      }
      seedRoots.length = 0;
      seeds.clear();
    },
  });
}
