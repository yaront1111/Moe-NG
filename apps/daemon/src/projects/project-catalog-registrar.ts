import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  PROJECT_CATALOG_LAYER,
  PROJECT_CATALOG_WRITE_FAILED,
  createNodeProjectCatalogPorts,
  loadProjectCatalog,
  registerCatalogProject,
  saveProjectCatalogAtomic,
} from "./project-catalog.js";
import type {
  ProjectCatalogCode,
  ProjectCatalogPorts,
  RegisterCatalogProjectInput,
} from "./project-catalog.js";

/**
 * The MANAGER CATALOG's one production write edge.
 *
 * `project-catalog.ts` owns the format, the conflict rules and the atomic save; it deliberately
 * takes a catalog VALUE and a path rather than reaching for either itself. This module is the
 * composition that turns those three pure calls into the single `register(entry)` a caller wants,
 * and it is the only place that decides WHERE the catalog lives.
 *
 * IT THROWS ITS REFUSAL RATHER THAN RETURNING IT, matching `RepositoryBoundPort`: the bootstrap
 * engine treats a throwing port as the effect failing and answers with its own
 * BOOTSTRAP_CATALOG_FAILED, so a returned refusal here would be silently discarded.
 * The catalog's own code and layer travel on the error for callers that catch it.
 */

export const PROJECT_CATALOG_ENV_KEY = "MOE_PROJECT_CATALOG";

/** Machine-scoped, not project-scoped: the catalog is the list of every product on this host. */
export function resolveProjectCatalogPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[PROJECT_CATALOG_ENV_KEY];
  return configured === undefined || configured === ""
    ? join(homedir(), ".moe-next", "projects.json")
    : configured;
}

export class ProjectCatalogRefusalError extends Error {
  readonly code: ProjectCatalogCode;
  readonly layer: typeof PROJECT_CATALOG_LAYER;
  constructor(code: ProjectCatalogCode) {
    super(code);
    this.name = "ProjectCatalogRefusalError";
    this.code = code;
    this.layer = PROJECT_CATALOG_LAYER;
  }
}

export type RegisterProjectInCatalog = (input: RegisterCatalogProjectInput) => Promise<void>;

export function createNodeProjectCatalogRegistrar(
  path: string = resolveProjectCatalogPath(),
  ports: ProjectCatalogPorts = createNodeProjectCatalogPorts(),
): RegisterProjectInCatalog {
  return async (input: RegisterCatalogProjectInput): Promise<void> => {
    // An absent catalog loads as the empty v1 catalog, so a first product registers cleanly.
    const loaded = await loadProjectCatalog(path, ports.fs);
    if (!loaded.ok) throw new ProjectCatalogRefusalError(loaded.code);
    const registered = await registerCatalogProject(loaded.catalog, input, ports);
    if (!registered.ok) throw new ProjectCatalogRefusalError(registered.code);
    // The atomic save opens a temp file BESIDE the catalog, so its directory must exist first.
    try { await mkdir(dirname(path), { recursive: true }); }
    catch { throw new ProjectCatalogRefusalError(PROJECT_CATALOG_WRITE_FAILED); }
    const saved = await saveProjectCatalogAtomic(path, registered.catalog, ports);
    if (!saved.ok) throw new ProjectCatalogRefusalError(saved.code);
  };
}
