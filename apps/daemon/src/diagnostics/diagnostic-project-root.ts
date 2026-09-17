import { sep } from "node:path";

/**
 * WHERE THIS PROCESS'S DIAGNOSTICS BELONG.
 *
 * The wrapper and the hosted entries are handed a store path, not a project root — but the
 * durable state an operator already associates with a project lives beside it, under `.moe`.
 * Deriving the root from the store keeps the logs with the project they describe instead of in
 * a temp directory nobody thinks to look in.
 *
 * Falls back to the working directory rather than guessing. A store outside `.moe` is a
 * deliberate arrangement, and writing into its parent would put diagnostics somewhere the
 * operator never asked for.
 */

const MOE_DIR = ".moe";
/** Either separator: a Windows path can carry both, and a POSIX test must still read. */
const SEPARATOR = /[\\/]/u;

export function diagnosticProjectRoot(storePath: string, cwd: string): string {
  if (storePath === "") return cwd;
  const segments = storePath.split(SEPARATOR);
  // Whole SEGMENTS, never a substring: `.moetest` is a different directory entirely.
  const at = segments.lastIndexOf(MOE_DIR);
  if (at <= 0) return cwd;
  const root = segments.slice(0, at).join(sep);
  // `/.moe/store.db` leaves nothing in front of it, which names no project to log against.
  return root === "" ? cwd : root;
}
