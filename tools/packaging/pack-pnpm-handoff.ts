import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  PACK_STEP_FAILED, capturePackFileIdentity, pathInside,
  type PackFileIdentity,
} from "./pack-tool-identity.js";

export type PnpmHandoff =
  | Readonly<{ executable: string; kind: "native" }>
  | Readonly<{ entry: string; kind: "entry" }>
  | Readonly<{
    kind: "package";
    packageRoot: string;
    witnesses: readonly PackFileIdentity[];
  }>;

function unavailable(): never {
  throw new Error(`${PACK_STEP_FAILED}: pnpm handoff unavailable`);
}

function outsideRepository(repository: string, path: string): string {
  if (pathInside(repository, path)) unavailable();
  return path;
}

function packageHandoff(
  repository: string, binDirectory: string, shimName: string,
): PnpmHandoff {
  if (basename(binDirectory) !== ".bin") return unavailable();
  const installRoot = dirname(binDirectory);
  if (basename(installRoot) !== "node_modules") return unavailable();
  const destination = dirname(installRoot);
  const packageRoot = outsideRepository(repository, realpathSync(join(installRoot, "pnpm")));
  if (!pathInside(destination, packageRoot)) return unavailable();
  const shim = capturePackFileIdentity(realpathSync(join(binDirectory, shimName)));
  return Object.freeze({
    kind: "package" as const, packageRoot,
    witnesses: Object.freeze([shim]),
  });
}

/** Resolve only the explicit npm/action handoffs; never PATH and never a guessed shim. */
export function resolvePnpmHandoff(
  environment: NodeJS.ProcessEnv, repository: string, platform: NodeJS.Platform | string,
): PnpmHandoff {
  try {
    const invoked = environment["npm_execpath"];
    if (invoked !== undefined) {
      if (typeof invoked !== "string" || !isAbsolute(invoked)) return unavailable();
      const handoff = outsideRepository(repository, realpathSync(invoked));
      if (/\.exe$/iu.test(handoff)) {
        return Object.freeze({ executable: handoff, kind: "native" as const });
      }
      if (/\.cmd$/iu.test(handoff)) {
        return packageHandoff(repository, dirname(handoff), basename(handoff));
      }
      if (/\.(?:cjs|mjs|js)$/iu.test(handoff)) {
        return Object.freeze({ entry: handoff, kind: "entry" as const });
      }
      return unavailable();
    }
    const home = environment["PNPM_HOME"];
    if (typeof home !== "string" || !isAbsolute(home)) return unavailable();
    const binDirectory = realpathSync(home);
    return packageHandoff(repository, binDirectory,
      platform === "win32" ? "pnpm.cmd" : "pnpm");
  } catch {
    return unavailable();
  }
}
