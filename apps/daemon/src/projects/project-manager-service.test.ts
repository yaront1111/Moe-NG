import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROJECT_MANAGER_PROTOCOL_VERSION } from "./project-manager-http-contract.js";
import type { ProjectManagerProjectList } from "./project-manager-http-contract.js";
import {
  PROJECT_MANAGER_BUSY,
  PROJECT_MANAGER_LAYER,
  PROJECT_MANAGER_PROJECT_CREATED,
  PROJECT_MANAGER_PROJECT_REGISTERED,
  PROJECT_MANAGER_PROJECT_UNKNOWN,
  createProjectManagerService,
} from "./project-manager-service.js";
import type {
  ProjectManagerCatalogPort,
  ProjectRuntimeSupervisorPort,
} from "./project-manager-service.js";
import type { ProjectCatalog, ProjectCatalogEntry } from "./project-catalog.js";
import { createNodeProjectManagerFiles } from "./project-manager-files.js";
import type {
  ManagedProjectFilesResult,
  ProjectManagerFilesPort,
  WrittenProjectFiles,
} from "./project-manager-files.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = {
  configPath: "C:\\work\\alpha\\moe.config.json",
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
} as const;
const CREATED_WRITTEN: WrittenProjectFiles = Object.freeze({
  createdRoot: true,
  paths: Object.freeze([PROJECT.configPath]),
  root: PROJECT.root,
});
const REGISTERED_WRITTEN: WrittenProjectFiles = Object.freeze({
  createdRoot: false,
  paths: Object.freeze([]),
  root: PROJECT.root,
});
const EMPTY: ProjectCatalog = Object.freeze({ entries: [], schemaVersion: "moe-project-catalog/1" });
const accepted = Object.freeze({ code: "RUNTIME_ACCEPTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true });

function catalogPort(overrides: Partial<ProjectManagerCatalogPort> = {}): ProjectManagerCatalogPort {
  return {
    register: async (catalog, input) => {
      const entry: ProjectCatalogEntry = Object.freeze({ ...input, instanceId: INSTANCE_ID });
      return {
        catalog: Object.freeze({ entries: [...catalog.entries, entry], schemaVersion: catalog.schemaVersion }),
        entry,
        ok: true,
      };
    },
    save: async () => ({ ok: true }),
    ...overrides,
  };
}

function files(overrides: Partial<ProjectManagerFilesPort> = {}): ProjectManagerFilesPort {
  return {
    create: async () => ({ ok: true, project: PROJECT, written: CREATED_WRITTEN }),
    discard: async () => undefined,
    register: async () => ({ ok: true, project: PROJECT, written: REGISTERED_WRITTEN }),
    ...overrides,
  };
}

function runtime(overrides: Partial<ProjectRuntimeSupervisorPort> = {}): ProjectRuntimeSupervisorPort {
  return {
    list: (entries) => entries.map(({ instanceId, projectId, root, title }) => ({
      instanceId, lifecycle: "STOPPED" as const, projectId, root, title,
    })),
    open: vi.fn(async () => accepted),
    start: vi.fn(async () => accepted),
    stop: vi.fn(async () => accepted),
    ...overrides,
  };
}

describe("createProjectManagerService", () => {
  it.each([
    ["create", PROJECT_MANAGER_PROJECT_CREATED],
    ["register", PROJECT_MANAGER_PROJECT_REGISTERED],
  ] as const)("persists and publishes a %s only after the catalog save", async (kind, code) => {
    const order: string[] = [];
    const service = createProjectManagerService({
      catalog: EMPTY,
      catalogPort: catalogPort({
        register: async (catalog, input) => {
          order.push("register");
          return await catalogPort().register(catalog, input);
        },
        save: async () => { order.push("save"); return { ok: true }; },
      }),
      files: files({
        [kind]: async () => {
          order.push("files");
          return {
            ok: true,
            project: PROJECT,
            written: kind === "create" ? CREATED_WRITTEN : REGISTERED_WRITTEN,
          };
        },
      }),
      runtime: runtime(),
    });
    const result = await service[kind]({ root: PROJECT.root, title: "  Alpha  " });
    expect(result).toEqual({ code, layer: PROJECT_MANAGER_LAYER, ok: true });
    expect(order).toEqual(["files", "register", "save"]);
    expect(await service.list()).toEqual({
      projects: [{
        instanceId: INSTANCE_ID,
        lifecycle: "STOPPED",
        projectId: "alpha",
        root: PROJECT.root,
        title: "Alpha",
      }],
      schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION,
    });
  });

  it("does not publish an entry when the atomic catalog save refuses", async () => {
    const refused = Object.freeze({
      code: "PROJECT_CATALOG_WRITE_FAILED", layer: "PROJECT_CATALOG", ok: false as const,
    });
    const discard = vi.fn(async () => { throw new Error("cleanup unavailable"); });
    const service = createProjectManagerService({
      catalog: EMPTY,
      catalogPort: catalogPort({
        save: async () => refused,
      }),
      files: files({ discard }),
      runtime: runtime(),
    });
    const result = await service.create({ root: PROJECT.root, title: "Alpha" });
    expect(result).toBe(refused);
    expect(result).toEqual({
      code: "PROJECT_CATALOG_WRITE_FAILED", layer: "PROJECT_CATALOG", ok: false,
    });
    expect(discard).toHaveBeenCalledExactlyOnceWith(CREATED_WRITTEN);
    expect(((await service.list()) as ProjectManagerProjectList).projects).toEqual([]);
  });

  it("serializes catalog mutations and refuses overlap before touching files", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const service = createProjectManagerService({
      catalog: EMPTY,
      catalogPort: catalogPort(),
      files: files({
        create: async () => {
          calls += 1;
          await pending;
          return { ok: true, project: PROJECT, written: CREATED_WRITTEN };
        },
      }),
      runtime: runtime(),
    });
    const first = service.create({ root: PROJECT.root, title: "Alpha" });
    expect(await service.create({ root: "C:\\work\\beta", title: "Beta" })).toEqual({
      code: PROJECT_MANAGER_BUSY, layer: PROJECT_MANAGER_LAYER, ok: false,
    });
    expect(calls).toBe(1);
    release();
    await first;
  });

  it("routes lifecycle operations by opaque instance id and refuses unknown projects", async () => {
    const entry: ProjectCatalogEntry = { ...PROJECT, instanceId: INSTANCE_ID, title: "Alpha" };
    const start = vi.fn(async () => accepted);
    const stop = vi.fn(async () => accepted);
    const open = vi.fn(async () => ({ ...accepted, origin: "http://127.0.0.1:4000" }));
    const service = createProjectManagerService({
      catalog: { entries: [entry], schemaVersion: "moe-project-catalog/1" },
      catalogPort: catalogPort(),
      files: files(),
      runtime: runtime({ open, start, stop }),
    });
    expect(await service.start(INSTANCE_ID)).toEqual(accepted);
    expect(await service.stop(INSTANCE_ID)).toEqual(accepted);
    expect(await service.open(INSTANCE_ID)).toMatchObject({ ok: true, origin: "http://127.0.0.1:4000" });
    expect(start).toHaveBeenCalledWith(entry);
    expect(stop).toHaveBeenCalledWith(INSTANCE_ID);
    expect(open).toHaveBeenCalledWith(INSTANCE_ID);
    expect(await service.start("22222222-2222-4222-8222-222222222222")).toEqual({
      code: PROJECT_MANAGER_PROJECT_UNKNOWN, layer: PROJECT_MANAGER_LAYER, ok: false,
    });
  });

  it("fails closed on malformed intake before filesystem authority", async () => {
    const create = vi.fn(async (_root: string): Promise<ManagedProjectFilesResult> =>
      ({ ok: true, project: PROJECT, written: CREATED_WRITTEN }));
    const service = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort(), files: files({ create }), runtime: runtime(),
    });
    expect(await service.create({ root: PROJECT.root, title: "" })).toMatchObject({ ok: false });
    expect(await service.create({ root: PROJECT.root, title: "Alpha", credential: "secret" } as never))
      .toMatchObject({ ok: false });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("catalog refusal compensation", () => {
  let scratch = "";

  beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), "moe-manager-compensate-")); });
  afterEach(async () => { await rm(scratch, { force: true, recursive: true }); });

  it("removes fresh files when catalog registration refuses", async () => {
    const root = join(scratch, "fresh");
    const refusal = Object.freeze({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false as const,
    });
    const realFiles = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const service = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort({ register: async () => refusal }),
      files: realFiles, runtime: runtime(),
    });

    const result = await service.create({ root, title: "Alpha" });
    expect(result).toBe(refusal);
    expect(result).toEqual({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false,
    });
    expect(existsSync(root)).toBe(false);
    const retry = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort(), files: realFiles, runtime: runtime(),
    });
    expect(await retry.create({ root, title: "Alpha" })).toEqual({
      code: PROJECT_MANAGER_PROJECT_CREATED, layer: PROJECT_MANAGER_LAYER, ok: true,
    });
  });

  it("removes fresh files when the atomic catalog save refuses", async () => {
    const root = join(scratch, "save-refusal");
    const refusal = Object.freeze({
      code: "PROJECT_CATALOG_WRITE_FAILED", layer: "PROJECT_CATALOG", ok: false as const,
    });
    const realFiles = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const service = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort({ save: async () => refusal }),
      files: realFiles, runtime: runtime(),
    });

    const result = await service.create({ root, title: "Alpha" });
    expect(result).toBe(refusal);
    expect(result).toEqual({
      code: "PROJECT_CATALOG_WRITE_FAILED", layer: "PROJECT_CATALOG", ok: false,
    });
    expect(existsSync(root)).toBe(false);
    const retry = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort(), files: realFiles, runtime: runtime(),
    });
    expect(await retry.create({ root, title: "Alpha" })).toEqual({
      code: PROJECT_MANAGER_PROJECT_CREATED, layer: PROJECT_MANAGER_LAYER, ok: true,
    });
  });

  it("keeps a foreign sibling injected after file creation", async () => {
    const root = join(scratch, "foreign");
    const keepPath = join(root, "keep.txt");
    const refusal = Object.freeze({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false as const,
    });
    const service = createProjectManagerService({
      catalog: EMPTY,
      catalogPort: catalogPort({
        register: async () => { await writeFile(keepPath, "KEEP", "utf8"); return refusal; },
      }),
      files: createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) }),
      runtime: runtime(),
    });

    const result = await service.create({ root, title: "Alpha" });
    expect(result).toBe(refusal);
    expect(result).toEqual({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false,
    });
    expect(await readFile(keepPath, "utf8")).toBe("KEEP");
    expect(await readdir(root)).toEqual(["keep.txt"]);
    expect(existsSync(root)).toBe(true); // createdRoot is true; ENOTEMPTY preserves it.
  });

  it("keeps an empty root that this call did not create", async () => {
    const root = join(scratch, "empty");
    await mkdir(root);
    const refusal = Object.freeze({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false as const,
    });
    const service = createProjectManagerService({
      catalog: EMPTY, catalogPort: catalogPort({ register: async () => refusal }),
      files: createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) }),
      runtime: runtime(),
    });

    const result = await service.create({ root, title: "Alpha" });
    expect(result).toBe(refusal);
    expect(result).toEqual({
      code: "PROJECT_CATALOG_ROOT_CONFLICT", layer: "PROJECT_CATALOG", ok: false,
    });
    expect(existsSync(root)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
});
