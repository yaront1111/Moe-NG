import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROJECT_CATALOG_CONFIG_CONFLICT,
  PROJECT_CATALOG_INSTANCE_ID_CONFLICT,
  PROJECT_CATALOG_LAYER,
  PROJECT_CATALOG_MALFORMED,
  PROJECT_CATALOG_ROOT_CONFLICT,
  PROJECT_CATALOG_SCHEMA_VERSION,
  PROJECT_CATALOG_STORE_CONFLICT,
  PROJECT_CATALOG_UUID_INVALID,
  PROJECT_CATALOG_WRITE_FAILED,
  createNodeProjectCatalogFs,
  loadProjectCatalog,
  registerCatalogProject,
  saveProjectCatalogAtomic,
} from "./project-catalog.js";
import type {
  ProjectCatalog,
  ProjectCatalogFsPort,
  ProjectCatalogPorts,
  RegisterCatalogProjectInput,
} from "./project-catalog.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_TEMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let scratch = "";

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "moe-project-catalog-")));
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

function emptyCatalog(): ProjectCatalog {
  return { entries: [], schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION };
}

function ports(mintUuid: () => string, fs = createNodeProjectCatalogFs()): ProjectCatalogPorts {
  return { fs, mintUuid };
}

async function project(
  parent: string,
  leaf: string,
  projectId = leaf,
): Promise<RegisterCatalogProjectInput> {
  const root = join(scratch, parent, leaf);
  await mkdir(root, { recursive: true });
  const configPath = join(root, "moe.config.json");
  await writeFile(configPath, "{}", "utf8");
  return { configPath, projectId, root, storePath: join(root, "store.sqlite"), title: leaf };
}

async function registered(
  catalog: ProjectCatalog,
  input: RegisterCatalogProjectInput,
  uuid: string,
  fs = createNodeProjectCatalogFs(),
): Promise<ProjectCatalog> {
  const result = await registerCatalogProject(catalog, input, ports(() => uuid, fs));
  if (!result.ok) throw new Error(`expected registration, got ${result.code}`);
  return result.catalog;
}

function virtualFs(raw: unknown, caseSensitive = true): ProjectCatalogFsPort {
  const base = createNodeProjectCatalogFs();
  return Object.freeze({
    ...base,
    caseSensitive,
    readText: async (): Promise<string> => JSON.stringify(raw),
    realpath: async (path: string): Promise<string> => path,
  });
}

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configPath: "/projects/one/moe.config.json",
    instanceId: UUID_A,
    projectId: "one",
    root: "/projects/one",
    storePath: "/projects/one/store.sqlite",
    title: "One",
    ...overrides,
  };
}

function encodedCatalog(entries: readonly unknown[]): Record<string, unknown> {
  return { entries, schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION };
}

describe("loadProjectCatalog", () => {
  it("treats an absent catalog as an exact empty v1 catalog", async () => {
    const result = await loadProjectCatalog(join(scratch, "missing.json"), createNodeProjectCatalogFs());
    expect(result).toEqual({
      catalog: { entries: [], schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION },
      ok: true,
    });
  });

  it("decodes exact non-secret entries and replaces aliases with real paths", async () => {
    const input = await project("parent", "demo");
    const catalogPath = join(scratch, "catalog.json");
    await writeFile(catalogPath, JSON.stringify(encodedCatalog([{
      ...input,
      instanceId: UUID_A,
      root: `${input.root}${sep}.${sep}`,
    }])), "utf8");

    const result = await loadProjectCatalog(catalogPath, createNodeProjectCatalogFs());
    if (!result.ok) throw new Error(`expected load, got ${result.code}`);
    expect(result.catalog.entries).toEqual([{
      ...input,
      configPath: await realpath(input.configPath),
      instanceId: UUID_A,
      root: await realpath(input.root),
      storePath: join(await realpath(dirname(input.storePath)), basename(input.storePath)),
    }]);
    expect([
      Object.isFrozen(result.catalog),
      Object.isFrozen(result.catalog.entries),
      Object.isFrozen(result.catalog.entries[0]),
    ]).toEqual([true, true, true]);
  });

  it.each([
    ["unknown catalog key", { ...encodedCatalog([]), credential: "secret" }],
    ["unknown entry credential", encodedCatalog([catalogEntry({ credential: "secret" })])],
    ["unknown entry token", encodedCatalog([catalogEntry({ token: "secret" })])],
    ["unknown entry origin", encodedCatalog([catalogEntry({ origin: "http://127.0.0.1" })])],
    ["unknown entry pid", encodedCatalog([catalogEntry({ pid: 7 })])],
    ["unknown entry status", encodedCatalog([catalogEntry({ status: "RUNNING" })])],
    ["wrong schema", { entries: [], schemaVersion: "moe-project-catalog/2" }],
    ["missing title", encodedCatalog([(() => {
      const { title: _title, ...rest } = catalogEntry();
      return rest;
    })()])],
    ["non-string field", encodedCatalog([catalogEntry({ projectId: 7 })])],
  ])("fails closed for %s", async (_label, raw) => {
    const result = await loadProjectCatalog("/catalog.json", virtualFs(raw));
    expect(result).toEqual({ code: PROJECT_CATALOG_MALFORMED, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it("keeps a missing project in the durable ledger instead of hiding every healthy project", async () => {
    const fs = virtualFs(encodedCatalog([catalogEntry()]));
    const failing: ProjectCatalogFsPort = Object.freeze({
      ...fs,
      realpath: async (): Promise<string> => { throw new Error("missing"); },
    });
    const result = await loadProjectCatalog("/catalog.json", failing);
    expect(result).toEqual({
      catalog: {
        entries: [catalogEntry()],
        schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
      },
      ok: true,
    });
  });

  it("still refuses a stored relative path as malformed", async () => {
    const result = await loadProjectCatalog("/catalog.json", virtualFs(encodedCatalog([
      catalogEntry({ root: "relative/project" }),
    ])));
    expect(result).toEqual({
      code: PROJECT_CATALOG_MALFORMED, layer: PROJECT_CATALOG_LAYER, ok: false,
    });
  });
});

describe("registerCatalogProject", () => {
  it("admits same-basename projects because the minted instance id is authoritative", async () => {
    const firstInput = await project("left", "demo", "demo");
    const secondInput = await project("right", "demo", "demo");
    const first = await registered(emptyCatalog(), firstInput, UUID_A);
    const second = await registerCatalogProject(first, secondInput, ports(() => UUID_B));
    if (!second.ok) throw new Error(`expected registration, got ${second.code}`);
    expect(second.entry.instanceId).toBe(UUID_B);
    expect(second.catalog.entries.map(({ instanceId, projectId }) => ({ instanceId, projectId })))
      .toEqual([
        { instanceId: UUID_A, projectId: "demo" },
        { instanceId: UUID_B, projectId: "demo" },
      ]);
  });

  it("refuses a duplicate physical root before config or store aliases", async () => {
    const firstInput = await project("left", "one");
    const first = await registered(emptyCatalog(), firstInput, UUID_A);
    const result = await registerCatalogProject(first, {
      ...firstInput,
      root: `${firstInput.root}${sep}.${sep}`,
      title: "Alias",
    }, ports(() => UUID_B));
    expect(result).toEqual({ code: PROJECT_CATALOG_ROOT_CONFLICT, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it("refuses a duplicate physical config independently of root", async () => {
    const firstInput = await project("left", "one");
    const secondInput = await project("right", "two");
    const first = await registered(emptyCatalog(), firstInput, UUID_A);
    const result = await registerCatalogProject(first, {
      ...secondInput,
      configPath: `${dirname(firstInput.configPath)}${sep}.${sep}${basename(firstInput.configPath)}`,
    }, ports(() => UUID_B));
    expect(result).toEqual({ code: PROJECT_CATALOG_CONFIG_CONFLICT, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it("refuses a duplicate store through a canonicalized parent", async () => {
    const firstInput = await project("left", "one");
    const secondInput = await project("right", "two");
    await mkdir(join(firstInput.root, "nested"));
    const first = await registered(emptyCatalog(), firstInput, UUID_A);
    const result = await registerCatalogProject(first, {
      ...secondInput,
      storePath: `${firstInput.root}${sep}nested${sep}..${sep}${basename(firstInput.storePath)}`,
    }, ports(() => UUID_B));
    expect(result).toEqual({ code: PROJECT_CATALOG_STORE_CONFLICT, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it.each([
    ["root", { root: "/projects/ONE", configPath: "/projects/two/moe.config.json", storePath: "/projects/two/store.sqlite" }, PROJECT_CATALOG_ROOT_CONFLICT],
    ["config", { root: "/projects/two", configPath: "/projects/one/MOE.CONFIG.JSON", storePath: "/projects/two/store.sqlite" }, PROJECT_CATALOG_CONFIG_CONFLICT],
    ["store", { root: "/projects/two", configPath: "/projects/two/moe.config.json", storePath: "/projects/one/STORE.SQLITE" }, PROJECT_CATALOG_STORE_CONFLICT],
  ])("refuses a case-only %s alias on a case-insensitive filesystem", async (_field, paths, code) => {
    const fs = virtualFs(encodedCatalog([]), false);
    const catalog: unknown = encodedCatalog([catalogEntry()]);
    const result = await registerCatalogProject(catalog, {
      ...paths,
      projectId: "two",
      title: "Two",
    }, ports(() => UUID_B, fs));
    expect(result).toEqual({ code, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it("refuses a repeated minted instance id", async () => {
    const firstInput = await project("left", "one");
    const secondInput = await project("right", "two");
    const first = await registered(emptyCatalog(), firstInput, UUID_A);
    const result = await registerCatalogProject(first, secondInput, ports(() => UUID_A));
    expect(result).toEqual({
      code: PROJECT_CATALOG_INSTANCE_ID_CONFLICT, layer: PROJECT_CATALOG_LAYER, ok: false,
    });
  });

  it("refuses a non-UUID mint without placing it in a path or catalog", async () => {
    const result = await registerCatalogProject(
      emptyCatalog(), await project("left", "one"), ports(() => "../credential"),
    );
    expect(result).toEqual({ code: PROJECT_CATALOG_UUID_INVALID, layer: PROJECT_CATALOG_LAYER, ok: false });
  });

  it("refuses secret-bearing registration input before minting", async () => {
    let mintCalls = 0;
    const input = { ...(await project("left", "one")), credential: "do-not-persist" };
    const result = await registerCatalogProject(emptyCatalog(), input, ports(() => {
      mintCalls += 1;
      return UUID_A;
    }));
    expect(result).toEqual({ code: PROJECT_CATALOG_MALFORMED, layer: PROJECT_CATALOG_LAYER, ok: false });
    expect(mintCalls).toBe(0);
  });
});

describe("saveProjectCatalogAtomic", () => {
  it("writes an exclusive same-directory temporary file before atomic replacement", async () => {
    const catalog = await registered(emptyCatalog(), await project("left", "one"), UUID_A);
    const catalogPath = join(scratch, "projects.json");
    await writeFile(catalogPath, "old bytes", "utf8");
    const base = createNodeProjectCatalogFs();
    const operations: string[] = [];
    let temporaryPath = "";
    const fs: ProjectCatalogFsPort = Object.freeze({
      ...base,
      openExclusiveWrite: async (path: string) => {
        temporaryPath = path;
        operations.push("open-exclusive");
        const handle = await base.openExclusiveWrite(path);
        return Object.freeze({
          close: async () => { operations.push("close"); await handle.close(); },
          sync: async () => { operations.push("sync"); await handle.sync(); },
          write: async (text: string) => { operations.push("write"); await handle.write(text); },
        });
      },
      rename: async (from: string, to: string) => {
        operations.push("rename");
        await base.rename(from, to);
      },
    });

    const result = await saveProjectCatalogAtomic(catalogPath, catalog, ports(() => UUID_TEMP, fs));
    expect(result).toEqual({ ok: true });
    expect(operations).toEqual(["open-exclusive", "write", "sync", "close", "rename"]);
    expect(dirname(temporaryPath)).toBe(dirname(catalogPath));
    expect(temporaryPath).not.toBe(catalogPath);
    const bytes = await readFile(catalogPath, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).not.toMatch(/credential|origin|pid|token|status/iu);
    const parsed = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "entries"]);
    expect(Object.keys((parsed["entries"] as Record<string, unknown>[])[0] ?? {})).toEqual([
      "instanceId", "title", "root", "configPath", "projectId", "storePath",
    ]);
  });

  it.each(["open", "write", "sync", "close", "rename"] as const)(
    "preserves the prior catalog and removes its temp when %s fails",
    async (fault) => {
      const catalog = await registered(emptyCatalog(), await project("left", "one"), UUID_A);
      const catalogPath = join(scratch, "projects.json");
      const original = `original-${fault}`;
      await writeFile(catalogPath, original, "utf8");
      const base = createNodeProjectCatalogFs();
      let renameCalls = 0;
      const fs: ProjectCatalogFsPort = Object.freeze({
        ...base,
        openExclusiveWrite: async (path: string) => {
          if (fault === "open") throw new Error("mutated open failure");
          const handle = await base.openExclusiveWrite(path);
          return Object.freeze({
            close: async () => {
              await handle.close();
              if (fault === "close") throw new Error("mutated close failure");
            },
            sync: async () => {
              await handle.sync();
              if (fault === "sync") throw new Error("mutated sync failure");
            },
            write: async (text: string) => {
              await handle.write(text);
              if (fault === "write") throw new Error("mutated write failure");
            },
          });
        },
        rename: async (from: string, to: string) => {
          renameCalls += 1;
          if (fault === "rename") throw new Error("mutated rename failure");
          await base.rename(from, to);
        },
      });

      const result = await saveProjectCatalogAtomic(catalogPath, catalog, ports(() => UUID_TEMP, fs));
      expect(result).toEqual({ code: PROJECT_CATALOG_WRITE_FAILED, layer: PROJECT_CATALOG_LAYER, ok: false });
      expect(await readFile(catalogPath, "utf8")).toBe(original);
      expect(renameCalls).toBe(fault === "rename" ? 1 : 0);
      expect((await readdir(scratch)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it("refuses secret-bearing catalog objects before opening a temporary file", async () => {
    const input = await project("left", "one");
    const secretCatalog = encodedCatalog([{ ...input, instanceId: UUID_A, token: "secret" }]);
    const base = createNodeProjectCatalogFs();
    let openCalls = 0;
    const fs: ProjectCatalogFsPort = Object.freeze({
      ...base,
      openExclusiveWrite: async (path: string) => {
        openCalls += 1;
        return await base.openExclusiveWrite(path);
      },
    });
    const result = await saveProjectCatalogAtomic(
      join(scratch, "projects.json"), secretCatalog, ports(() => UUID_TEMP, fs),
    );
    expect(result).toEqual({ code: PROJECT_CATALOG_MALFORMED, layer: PROJECT_CATALOG_LAYER, ok: false });
    expect(openCalls).toBe(0);
  });
});
