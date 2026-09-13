import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What `import.meta` carries for the entry decision; `main` is absent on Node before 24.2 / 22.18. */
export interface EntryMeta {
  readonly main?: boolean | undefined;
  readonly url: string;
}

function samePath(left: string, right: string, platform: string): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * Whether THIS module is the process entry.
 *
 * `import.meta.main` answers on Node >= 24.2 and >= 22.18 (nodejs.org/api/esm.html: added in
 * v24.2.0, v22.18.0). On 23.6-23.11 and 24.0-24.1 - Nodes that already strip types and so
 * LOAD moe-cli-main.ts - it is undefined, and a guard that read only that flag ran nothing:
 * `moe --help` and `moe start` exited 0 in silence, and the MOE_CLI_NODE_UNSUPPORTED refusal
 * INSTALL.md promises never ran, because `checkNodeVersion` is reached only from inside the
 * guard. An absent flag falls back to the idiom the flag replaced: argv[1] names this file,
 * by path or - the artifact may sit behind a junction - by real path.
 */
export function isMainModule(
  meta: EntryMeta, argv1: string | undefined, platform: string = process.platform,
): boolean {
  if (typeof meta.main === "boolean") return meta.main;
  if (argv1 === undefined) return false;
  const own = fileURLToPath(meta.url);
  const claimed = resolve(argv1);
  if (samePath(own, claimed, platform)) return true;
  const ownReal = realpathOrNull(own);
  const claimedReal = realpathOrNull(claimed);
  return ownReal !== null && claimedReal !== null && samePath(ownReal, claimedReal, platform);
}
