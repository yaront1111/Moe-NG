import type { PackSourceCode } from "./pack-source.js";
import { isSensitivePackSourcePath } from "./pack-source-sensitive.js";

function isPermittedGeneratedPath(path: string): boolean {
  const segments = path.split("/");
  return segments.includes("node_modules") || path.startsWith("apps/control-room/dist/");
}

export function postConsumerPackSourceRefusal(
  actualPaths: readonly string[],
  trackedPaths: readonly string[],
): PackSourceCode | null {
  const tracked = new Set(trackedPaths);
  for (const path of actualPaths) {
    if (tracked.has(path)) continue;
    if (isSensitivePackSourcePath(path)) return "PACK_SOURCE_SENSITIVE_PATH";
    if (!isPermittedGeneratedPath(path)) return "PACK_SOURCE_ROSTER_MISMATCH";
  }
  return null;
}
