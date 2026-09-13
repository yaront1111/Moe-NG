import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 128 * 1024;
function read(path: string): Buffer {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("exclude unusable");
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

/** Git-style lock/rename; preserve every byte outside this config's identifiable block. */
export function replaceRuntimeExcludeBlock(path: string, key: string, rules: readonly string[]): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent);
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw new Error("exclude parent unusable");
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  let owned = false;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    owned = true;
    const before = read(path);
    const start = Buffer.from(`# moe-runtime ${key} begin\n`);
    const end = Buffer.from(`# moe-runtime ${key} end\n`);
    const first = before.indexOf(start); const last = before.indexOf(end);
    if ((first < 0) !== (last < 0) || (first >= 0 && (last < first
      || (first > 0 && before[first - 1] !== 10) || (last > 0 && before[last - 1] !== 10)
      || before.indexOf(start, first + start.length) >= 0
      || before.indexOf(end, last + end.length) >= 0))) throw new Error("exclude block malformed");
    const block = Buffer.concat([start, Buffer.from(`${rules.join("\n")}\n`), end]);
    const after = first < 0
      ? Buffer.concat([before, before.length > 0 && before.at(-1) !== 10 ? Buffer.from("\n") : Buffer.alloc(0), block])
      : Buffer.concat([before.subarray(0, first), block, before.subarray(last + end.length)]);
    if (after.length > MAX_BYTES) throw new Error("exclude cap");
    if (after.equals(before)) return;
    writeFileSync(lock, after); fsyncSync(lock);
    if (!read(path).equals(before)) throw new Error("exclude changed");
    closeSync(lock); lock = undefined;
    renameSync(lockPath, path); owned = false;
  } finally {
    if (lock !== undefined) closeSync(lock);
    // A failed rename still leaves our closed lock to clean up. A failed open never
    // grants ownership of someone else's lock.
    if (owned) unlinkSync(lockPath);
  }
}
