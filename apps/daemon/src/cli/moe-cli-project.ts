import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { WORKSPACE_LINK_FILENAME, ensureWorkspaceLinks } from "./moe-cli-links.js";
import { MOE_CONFIG_FILENAME, parseMoeConfig } from "./moe-init.js";
import type { MoeConfig } from "./moe-init.js";

/**
 * The two things EVERY project-scoped verb does before it can do anything else:
 * read the project's config, and make the workspace links a packaged artifact
 * needs. They live here rather than in `moe-cli-main.ts` because `moe mcp` needs
 * them too, and importing them back from the entry module is a CYCLE: the entry
 * is loaded as `moe-cli-main.ts` but a sibling importing `./moe-cli-main.js`
 * gets a SECOND module record whose `isMainModule` is still true, so it re-runs
 * the entry's top-level `await` and the process deadlocks on its own module
 * graph. Measured live 2026-09-18: `moe mcp` exited 13 with "Detected unsettled
 * top-level await" and printed nothing at all.
 */

/** `start` was pointed at a directory `init` has never run in. */
export const MOE_CLI_CONFIG_ABSENT = "MOE_CLI_CONFIG_ABSENT" as const;

/**
 * Deliberately NARROWER than `CliIo`: these two readers need a sink and the
 * artifact root and nothing else, and a narrow parameter is what lets `moe mcp`
 * hand them a sink pointed at stderr without the entry module being involved.
 */
export interface CliProjectIo {
  readonly artifactRoot: string;
  readonly log: (line: string) => void;
}

export function readConfig(targetDir: string, io: CliProjectIo): MoeConfig | null {
  const configPath = resolve(targetDir, MOE_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    io.log(`${MOE_CLI_CONFIG_ABSENT}: ${configPath} — run 'moe init' there first`);
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    io.log(`${MOE_CLI_CONFIG_ABSENT}: ${(error as Error).message}`);
    return null;
  }
  const parsed = parseMoeConfig(raw);
  if (!parsed.ok) {
    io.log(parsed.message);
    return null;
  }
  return parsed.config;
}

/** Absent in a repository checkout, where pnpm already owns the links. */
function readLinkManifest(root: string): string | null {
  const path = resolve(root, WORKSPACE_LINK_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function preparePackagedLinks(
  io: CliProjectIo,
  command: "mcp" | "projects" | "recover-review" | "recover-replan" | "start",
): boolean {
  const links = ensureWorkspaceLinks(io.artifactRoot, readLinkManifest(io.artifactRoot));
  if (!links.ok) {
    io.log(links.message);
    return false;
  }
  if (links.created.length > 0) {
    io.log(`moe ${command}: linked ${String(links.created.length)} workspace packages`);
  }
  return true;
}
