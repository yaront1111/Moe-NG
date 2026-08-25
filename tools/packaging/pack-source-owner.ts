import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const TEMPORARY_OWNER_PREFIX = "moe-pack-source-owner-";

export function makePackSourceTemporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), TEMPORARY_OWNER_PREFIX));
}

export function removePackSourceTemporaryRoot(root: string): void {
  rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
}

export function resolveOwnedPackSourceTemporaryRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error();
  const canonical = realpathSync(value);
  const tempRoot = realpathSync(tmpdir());
  const path = relative(tempRoot, canonical);
  if (!statSync(canonical).isDirectory() || !path.startsWith(TEMPORARY_OWNER_PREFIX)
    || path.includes(sep) || isAbsolute(path)) throw new Error();
  return canonical;
}
