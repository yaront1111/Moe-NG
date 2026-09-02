import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planInit } from "../cli/moe-init.js";
import {
  PROJECT_MANAGER_CONFIG_INVALID,
  PROJECT_MANAGER_CONFIG_UNREADABLE,
  PROJECT_MANAGER_FILES_LAYER,
  PROJECT_MANAGER_ROOT_INVALID,
  createNodeProjectManagerFiles,
} from "./project-manager-files.js";

let scratch = "";

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "moe-manager-files-")));
});
afterEach(async () => { await rm(scratch, { force: true, recursive: true }); });

describe("createNodeProjectManagerFiles", () => {
  it("creates an exact non-disclosing config for a new Windows project", async () => {
    const target = join(scratch, "My First Project");
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const result = await files.create(target);
    if (!result.ok) throw new Error(result.code);
    const planned = planInit({
      force: false, probe: { entries: [], writable: true }, randomHex: () => "ab".repeat(32),
      targetDir: target,
    });
    if (!planned.ok) throw new Error("expected a valid init plan");
    expect(result.project).toEqual({
      configPath: join(target, "moe.config.json"),
      projectId: planned.projectId,
      root: target,
      storePath: join(target, "store.sqlite"),
    });
    expect(result.written).toEqual({
      createdRoot: true,
      paths: [join(target, "moe.config.json")],
      root: target,
    });
    expect(Object.isFrozen(result.written)).toBe(true);
    expect(Object.isFrozen(result.written.paths)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ab".repeat(32));
    expect(JSON.parse(await readFile(result.project.configPath, "utf8"))).toEqual({
      credential: "ab".repeat(32),
      projectId: planned.projectId,
      schemaVersion: "moe-cli-config/1",
      storePath: join(target, "store.sqlite"),
    });
  });

  it("registers an existing exact config without returning its credential", async () => {
    const target = join(scratch, "Existing");
    await mkdir(target);
    const credential = "cd".repeat(32);
    await writeFile(join(target, "moe.config.json"), JSON.stringify({
      credential,
      projectId: "existing",
      schemaVersion: "moe-cli-config/1",
      storePath: join(target, "store.sqlite"),
    }), "utf8");
    const result = await createNodeProjectManagerFiles().register(target);
    if (!result.ok) throw new Error(result.code);
    expect(result.project.projectId).toBe("existing");
    expect(result.written).toEqual({ createdRoot: false, paths: [], root: target });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("discards exact written paths and only removes a root created by this call", async () => {
    const target = join(scratch, "discard");
    const keepPath = join(target, "keep.txt");
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const result = await files.create(target);
    if (!result.ok) throw new Error(result.code);
    await writeFile(keepPath, "KEEP", "utf8");

    await files.discard(result.written);
    expect(await readdir(target)).toEqual(["keep.txt"]);
    expect(await readFile(keepPath, "utf8")).toBe("KEEP");
    await unlink(keepPath);
    await files.discard(result.written);
    expect(existsSync(target)).toBe(false);
    await files.discard(result.written);
    expect(existsSync(target)).toBe(false);
  });

  it("keeps an empty root that existed before create", async () => {
    const target = join(scratch, "preexisting-empty");
    await mkdir(target);
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const result = await files.create(target);
    if (!result.ok) throw new Error(result.code);
    expect(result.written.createdRoot).toBe(false);

    await files.discard(result.written);
    expect(existsSync(target)).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it.each(["", ".", "relative\\project", "\\\\server\\share\\project"])(
    "refuses invalid or non-local root %j before filesystem access",
    async (root) => {
      const result = await createNodeProjectManagerFiles().register(root);
      expect(result).toEqual({
        code: PROJECT_MANAGER_ROOT_INVALID, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
      });
    },
  );

  it("refuses a missing config with a stable code and no filesystem error detail", async () => {
    const result = await createNodeProjectManagerFiles().register(scratch);
    expect(result).toEqual({
      code: PROJECT_MANAGER_CONFIG_UNREADABLE, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
  });

  it.each([
    ["unknown field", { token: "secret" }],
    ["wrong schema", { schemaVersion: "moe-cli-config/2" }],
    ["short credential", { credential: "secret" }],
    ["relative store", { storePath: "store.sqlite" }],
  ])("refuses %s in an existing config", async (_name, override) => {
    const target = join(scratch, _name.replace(" ", "-"));
    await mkdir(target);
    await writeFile(join(target, "moe.config.json"), JSON.stringify({
      credential: "ef".repeat(32),
      projectId: "existing",
      schemaVersion: "moe-cli-config/1",
      storePath: join(target, "store.sqlite"),
      ...override,
    }), "utf8");
    const result = await createNodeProjectManagerFiles().register(target);
    expect(result).toEqual({
      code: PROJECT_MANAGER_CONFIG_INVALID, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
  });

  it("does not overwrite an existing project config", async () => {
    const target = join(scratch, "occupied");
    await mkdir(target);
    const configPath = join(target, "moe.config.json");
    await writeFile(configPath, "original", "utf8");
    const result = await createNodeProjectManagerFiles().create(target);
    expect(result).toEqual({
      code: "MOE_INIT_CONFIG_PRESENT", layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
    expect(await readFile(configPath, "utf8")).toBe("original");
  });
});
