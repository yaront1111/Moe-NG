import { readFileSync } from "node:fs";

import type { CutoverActivationWiring } from "./daemon-command-registry.js";

/**
 * The environment variable naming the directory `cutover.activate` reads the live-quiesce
 * evidence record from (`live-quiesce-evidence.json`, see cutover-generation-snapshot.ts).
 * It is the SAME directory the readiness-manifest writer is pointed at with `--store-root`,
 * so the generations the activation compares against are read from where the manifest's
 * were. OPTIONAL on the registry's own terms: absent, the shipped daemon still registers
 * the kind and refuses every dispatch of it with CUTOVER_ACTIVATE_UNCONFIGURED, so no
 * activation can be committed against evidence nobody configured.
 */
export const CUTOVER_EVIDENCE_ROOT_ENV_KEY = "MOE_CUTOVER_EVIDENCE_ROOT" as const;

/**
 * The registry option, or nothing. Spread into BOTH command planes' options: the kind is
 * dispatched on `/1` (it is what makes `/2` authoritative), and the `/2` registry inherits
 * the same entry so a replay after the flip answers from the same wiring.
 */
export function cutoverActivationWiringOf(
  evidenceRoot: string | undefined,
): Readonly<{ cutoverActivation?: CutoverActivationWiring }> {
  if (evidenceRoot === undefined) return Object.freeze({});
  return Object.freeze({
    cutoverActivation: Object.freeze({
      evidenceRoot,
      readFileText: (path: string): string => readFileSync(path, "utf8"),
    }),
  });
}
