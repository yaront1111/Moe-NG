import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { known, unknown } from "./doctor-version-contract.js";
import type { ComponentEntry, ObservedValue } from "./doctor-version-contract.js";

/**
 * The filesystem half of the doctor's version boundary: root discovery, manifest
 * reading and the workspace sweep. Split out of `doctor-version.node.ts` to keep
 * both files under the 250-line cap, not because the concerns differ in kind —
 * everything here is still a total reader that answers with a coded UNKNOWN
 * rather than throwing.
 */
export const HOST = "DOCTOR_VERSION_HOST" as const;

export const unreadablePin = (): ObservedValue =>
  unknown("DOCTOR_DECLARED_PIN_UNREADABLE", HOST);

const WORKSPACE_FILE = "pnpm-workspace.yaml";

export const readTextOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const parseJsonOrNull = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const stringField = (
  source: Record<string, unknown> | null,
  key: string,
): ObservedValue => {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? known(value) : unreadablePin();
};

/**
 * Walks up to the workspace root. Never hard-coded: the daemon can be loaded
 * from a build output or a linked checkout, and a baked-in path would silently
 * report another tree's pins.
 */
export function resolveRepoRoot(
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let current = resolve(fromDir);
  for (;;) {
    if (existsSync(join(current, WORKSPACE_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface WorkspaceInventory {
  readonly components: readonly ComponentEntry[];
  readonly inventory: ObservedValue;
}

/**
 * A narrow reader for the one construct this repo's workspace file uses: a
 * `packages:` list of `- <glob>` entries. It is not a YAML parser and does not
 * pretend to be; an entry it cannot read contributes nothing rather than
 * inventing a root.
 */
const workspaceGlobRoots = (repoRoot: string): readonly string[] => {
  const raw = readTextOrNull(join(repoRoot, WORKSPACE_FILE));
  if (raw === null) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line)?.[1])
    .filter((glob): glob is string => glob !== undefined && glob.endsWith("/*"))
    .map((glob) => glob.slice(0, -"/*".length));
};

const childDirectories = (parent: string): readonly string[] => {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // A declared-but-absent glob root such as `adapters/` is normal, not an error.
    return [];
  }
};

/**
 * The inventory reports BOTH what it found and whether it could look. An empty
 * array alone cannot distinguish "this workspace declares no members" from "the
 * sweep never ran", and the second must never read as a satisfied inventory.
 */
export function readWorkspaceComponents(repoRoot: string | null): WorkspaceInventory {
  const empty: WorkspaceInventory = {
    components: [],
    inventory: unknown("DOCTOR_COMPONENT_INVENTORY_EMPTY", HOST),
  };
  if (repoRoot === null) return empty;

  const components: ComponentEntry[] = [];
  for (const globRoot of workspaceGlobRoots(repoRoot)) {
    const parent = join(repoRoot, globRoot);
    for (const child of childDirectories(parent)) {
      const manifestPath = join(parent, child, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = parseJsonOrNull(readTextOrNull(manifestPath));
      const name = manifest?.["name"];
      const version = manifest?.["version"];
      components.push({
        name: typeof name === "string" && name.length > 0 ? name : child,
        version:
          typeof version === "string" && version.length > 0 ? known(version) : unreadablePin(),
      });
    }
  }
  if (components.length === 0) return empty;
  return { components, inventory: known(String(components.length)) };
}
