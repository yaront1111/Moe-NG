import { PROJECT_MANAGER_PROTOCOL_VERSION } from "./project-manager-http-contract.js";
import type {
  ProjectManagerHttpResult,
  ProjectManagerIntake,
  ProjectManagerPort,
  ProjectManagerProject,
  ProjectManagerProjectList,
} from "./project-manager-http-contract.js";
import type {
  ProjectCatalog,
  ProjectCatalogEntry,
  ProjectCatalogRefused,
  RegisterCatalogProjectInput,
  RegisterCatalogProjectResult,
  SaveProjectCatalogResult,
} from "./project-catalog.js";
import type { ProjectManagerFilesPort } from "./project-manager-files.js";

export const PROJECT_MANAGER_LAYER = "PROJECT_MANAGER" as const;
export const PROJECT_MANAGER_BUSY = "PROJECT_MANAGER_BUSY" as const;
export const PROJECT_MANAGER_INTAKE_INVALID = "PROJECT_MANAGER_INTAKE_INVALID" as const;
export const PROJECT_MANAGER_PROJECT_UNKNOWN = "PROJECT_MANAGER_PROJECT_UNKNOWN" as const;
export const PROJECT_MANAGER_PROJECT_CREATED = "PROJECT_MANAGER_PROJECT_CREATED" as const;
export const PROJECT_MANAGER_PROJECT_REGISTERED = "PROJECT_MANAGER_PROJECT_REGISTERED" as const;

export interface ProjectManagerCatalogPort {
  register(
    catalog: ProjectCatalog,
    input: RegisterCatalogProjectInput,
  ): Promise<RegisterCatalogProjectResult>;
  save(catalog: ProjectCatalog): Promise<SaveProjectCatalogResult>;
}

export interface ProjectRuntimeSupervisorPort {
  list(entries: readonly ProjectCatalogEntry[]): readonly ProjectManagerProject[];
  open(instanceId: string): Promise<ProjectManagerHttpResult>;
  start(entry: ProjectCatalogEntry): Promise<ProjectManagerHttpResult>;
  stop(instanceId: string): Promise<ProjectManagerHttpResult>;
}

export interface CreateProjectManagerServiceOptions {
  readonly catalog: ProjectCatalog;
  readonly catalogPort: ProjectManagerCatalogPort;
  readonly files: ProjectManagerFilesPort;
  readonly runtime: ProjectRuntimeSupervisorPort;
}

type OperationResult = Readonly<{ readonly code: string; readonly layer: string; readonly ok: boolean }>;

function result(code: string, ok: boolean): OperationResult {
  return Object.freeze({ code, layer: PROJECT_MANAGER_LAYER, ok });
}

function refusal(code: string): OperationResult {
  return result(code, false);
}

function exactIntake(value: unknown): ProjectManagerIntake | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("root") || !keys.includes("title")) return null;
    const root = Reflect.getOwnPropertyDescriptor(value, "root");
    const title = Reflect.getOwnPropertyDescriptor(value, "title");
    if (root === undefined || title === undefined || !("value" in root) || !("value" in title)
      || typeof root.value !== "string" || typeof title.value !== "string") return null;
    const normalizedTitle = title.value.trim();
    if (root.value === "" || root.value.includes("\0") || normalizedTitle === ""
      || normalizedTitle.length > 128 || normalizedTitle.includes("\0")) return null;
    return Object.freeze({ root: root.value, title: normalizedTitle });
  } catch {
    return null;
  }
}

function knownEntry(catalog: ProjectCatalog, instanceId: string): ProjectCatalogEntry | null {
  return catalog.entries.find((entry) => entry.instanceId === instanceId) ?? null;
}

export function createProjectManagerService(
  options: CreateProjectManagerServiceOptions,
): ProjectManagerPort & { readonly snapshot: () => ProjectCatalog } {
  let catalog = options.catalog;
  let mutating = false;

  const mutate = async (
    kind: "create" | "register",
    input: unknown,
  ): Promise<OperationResult | ProjectCatalogRefused> => {
    if (mutating) return refusal(PROJECT_MANAGER_BUSY);
    const intake = exactIntake(input);
    if (intake === null) return refusal(PROJECT_MANAGER_INTAKE_INVALID);
    mutating = true;
    try {
      const prepared = await options.files[kind](intake.root);
      if (!prepared.ok) return prepared;
      const registered = await options.catalogPort.register(catalog, {
        ...prepared.project,
        title: intake.title,
      });
      if (!registered.ok) return registered;
      const saved = await options.catalogPort.save(registered.catalog);
      if (!saved.ok) return saved;
      catalog = registered.catalog;
      return result(
        kind === "create" ? PROJECT_MANAGER_PROJECT_CREATED : PROJECT_MANAGER_PROJECT_REGISTERED,
        true,
      );
    } finally {
      mutating = false;
    }
  };

  const requireEntry = (instanceId: string): ProjectCatalogEntry | OperationResult =>
    knownEntry(catalog, instanceId) ?? refusal(PROJECT_MANAGER_PROJECT_UNKNOWN);

  return Object.freeze({
    create: (input: ProjectManagerIntake) => mutate("create", input),
    list: async (): Promise<ProjectManagerProjectList> => Object.freeze({
      projects: Object.freeze([...options.runtime.list(catalog.entries)]),
      schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION,
    }),
    open: async (instanceId: string): Promise<ProjectManagerHttpResult> => {
      const entry = requireEntry(instanceId);
      return "instanceId" in entry ? await options.runtime.open(instanceId) : entry;
    },
    register: (input: ProjectManagerIntake) => mutate("register", input),
    snapshot: (): ProjectCatalog => catalog,
    start: async (instanceId: string): Promise<ProjectManagerHttpResult> => {
      const entry = requireEntry(instanceId);
      return "instanceId" in entry ? await options.runtime.start(entry) : entry;
    },
    stop: async (instanceId: string): Promise<ProjectManagerHttpResult> => {
      const entry = requireEntry(instanceId);
      return "instanceId" in entry ? await options.runtime.stop(instanceId) : entry;
    },
  });
}
