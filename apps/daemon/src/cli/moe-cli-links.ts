import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The one thing a zip cannot carry: the `node_modules/@moe/*` links.
 *
 * MEASURED on Node 24.16.0 (Windows): a `.ts` file whose REALPATH is under
 * `node_modules` is refused outright —
 *
 *   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
 *   currently unsupported for files under node_modules, for
 *   ".../node_modules/@moe/contracts/src/index.ts"
 *
 * and there is no flag that waives it. The artifact ships sources, so the
 * workspace packages must live OUTSIDE `node_modules` and be reachable through
 * it: Node resolves a symlink to its realpath before deciding, so a junction
 * from `node_modules/@moe/x` to `packages/x` escapes the ban. `Compress-Archive`
 * stores no links at all, so they are made here, at init and again at start.
 *
 * In a repository checkout the manifest is absent and this module plans nothing:
 * pnpm already owns those links, and re-making them is not this CLI's business.
 */

export const MOE_CLI_LINK_MANIFEST_INVALID = "MOE_CLI_LINK_MANIFEST_INVALID" as const;
export const MOE_CLI_LINK_TARGET_MISSING = "MOE_CLI_LINK_TARGET_MISSING" as const;
export const MOE_CLI_LINK_FAILED = "MOE_CLI_LINK_FAILED" as const;

export const WORKSPACE_LINK_FILENAME = "moe-workspace-links.json" as const;
export const WORKSPACE_LINK_SCHEMA_VERSION = "moe-workspace-links/1" as const;

const SCOPE_PREFIX = "@moe/";

export type WorkspaceLinkRefusalCode =
  | typeof MOE_CLI_LINK_FAILED
  | typeof MOE_CLI_LINK_MANIFEST_INVALID
  | typeof MOE_CLI_LINK_TARGET_MISSING;

export interface WorkspaceLinkEntry {
  readonly linkPath: string;
  readonly specifier: string;
  readonly targetPath: string;
}

export interface WorkspaceLinkPlan {
  readonly entries: readonly WorkspaceLinkEntry[];
  readonly ok: true;
}

export interface WorkspaceLinkRefused {
  readonly code: WorkspaceLinkRefusalCode;
  readonly detail: string;
  readonly message: string;
  readonly ok: false;
}

export type WorkspaceLinkResolution = WorkspaceLinkPlan | WorkspaceLinkRefused;

export interface WorkspaceLinksMade {
  /** Specifiers whose link this run had to create; empty on a re-run. */
  readonly created: readonly string[];
  readonly ok: true;
}

export type WorkspaceLinksResult = WorkspaceLinkRefused | WorkspaceLinksMade;

function refuse(code: WorkspaceLinkRefusalCode, detail: string): WorkspaceLinkRefused {
  return Object.freeze({ code, detail, message: `${code}: ${detail}`, ok: false });
}

/**
 * A target must be repo-relative, must stay inside the extracted root, and must
 * NOT sit under `node_modules` — the last rule is the whole point of the module
 * and is enforced here rather than trusted from the pack script.
 */
function rejectTarget(target: string): string | null {
  if (target === "" || isAbsolute(target) || /^[a-z]:/iu.test(target)) return target;
  // Lower-cased on purpose: Windows resolves `Node_Modules` and `node_modules`
  // to the SAME directory, so a case-sensitive check here is a bypass, not a rule.
  const segments = target.replaceAll("\\", "/").toLowerCase().split("/");
  if (segments.includes("..") || segments.includes("node_modules")) return target;
  return null;
}

export function planWorkspaceLinks(root: string, manifest: string | null): WorkspaceLinkResolution {
  if (manifest === null) return Object.freeze({ entries: Object.freeze([]), ok: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch (error) {
    return refuse(MOE_CLI_LINK_MANIFEST_INVALID, (error as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return refuse(MOE_CLI_LINK_MANIFEST_INVALID, "root");
  }
  const record = parsed as { links?: unknown; schemaVersion?: unknown };
  if (record.schemaVersion !== WORKSPACE_LINK_SCHEMA_VERSION) {
    return refuse(MOE_CLI_LINK_MANIFEST_INVALID, "schemaVersion");
  }
  if (typeof record.links !== "object" || record.links === null || Array.isArray(record.links)) {
    return refuse(MOE_CLI_LINK_MANIFEST_INVALID, "links");
  }
  const links = record.links as Record<string, unknown>;
  const entries: WorkspaceLinkEntry[] = [];
  // Sorted so two runs over the same manifest plan the same sequence.
  for (const specifier of Object.keys(links).sort()) {
    if (!specifier.startsWith(SCOPE_PREFIX) || specifier.slice(SCOPE_PREFIX.length) === "") {
      return refuse(MOE_CLI_LINK_MANIFEST_INVALID, specifier);
    }
    const target = links[specifier];
    if (typeof target !== "string") return refuse(MOE_CLI_LINK_MANIFEST_INVALID, specifier);
    const bad = rejectTarget(target);
    if (bad !== null) return refuse(MOE_CLI_LINK_MANIFEST_INVALID, bad);
    entries.push(Object.freeze({
      linkPath: join(root, "node_modules", specifier),
      specifier,
      targetPath: join(root, target),
    }));
  }
  return Object.freeze({ entries: Object.freeze(entries), ok: true });
}

/**
 * `existsSync` follows the link, so a junction left dangling by a moved folder
 * reads as absent while `lstatSync` still finds it. Removing it first is what
 * turns "moved the extracted folder" from an EEXIST crash into a silent repair.
 */
function linkIsLive(linkPath: string): boolean {
  if (existsSync(linkPath)) return true;
  try {
    lstatSync(linkPath);
  } catch {
    return false;
  }
  rmSync(linkPath, { force: true, recursive: true });
  return false;
}

export function ensureWorkspaceLinks(root: string, manifest: string | null): WorkspaceLinksResult {
  const plan = planWorkspaceLinks(root, manifest);
  if (!plan.ok) return plan;
  const created: string[] = [];
  for (const entry of plan.entries) {
    if (linkIsLive(entry.linkPath)) continue;
    if (!existsSync(entry.targetPath)) {
      return refuse(MOE_CLI_LINK_TARGET_MISSING, entry.specifier);
    }
    try {
      mkdirSync(dirname(entry.linkPath), { recursive: true });
      // "junction" is the Windows-first choice deliberately: a directory junction
      // needs no Developer Mode and no elevation, unlike a real symlink.
      symlinkSync(entry.targetPath, entry.linkPath, "junction");
      created.push(entry.specifier);
    } catch (error) {
      // EEXIST means a concurrent `moe start` won the race and made the same
      // link. The loop's goal is met, so this is not a failure — but it is not
      // OUR creation either, and `created` must not claim it.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return refuse(MOE_CLI_LINK_FAILED, `${entry.specifier}: ${(error as Error).message}`);
      }
    }
  }
  return Object.freeze({ created: Object.freeze(created), ok: true });
}
