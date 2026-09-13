import { join } from "node:path";

/**
 * Where the wrapper's console goes: every seat's stdout and stderr are teed into it by
 * the stack host. Kept in this dependency-free module so the foreground CLI can name the
 * file without importing the host entry (which composes the whole daemon).
 */
export const WRAPPER_LOG_RELATIVE_PATH = join(".moe-next", "wrapper.log");

/** The one path both the host (which appends) and `moe start` (which points at it) use. */
export function wrapperLogPath(projectRoot: string): string {
  return join(projectRoot, WRAPPER_LOG_RELATIVE_PATH);
}
