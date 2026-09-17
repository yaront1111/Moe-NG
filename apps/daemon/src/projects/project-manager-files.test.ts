import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planInit } from "../cli/moe-init.js";
import {
  PROJECT_MANAGER_CONFIG_INVALID,
  PROJECT_MANAGER_CONFIG_UNREADABLE,
  PROJECT_MANAGER_CONFIG_WRITE_FAILED,
  PROJECT_MANAGER_FILES_LAYER,
  PROJECT_MANAGER_ROOT_INVALID,
  createNodeProjectManagerFiles,
} from "./project-manager-files.js";

// Fault injection by exact path: one open that fails, one write that fails
// after its open created the file, one directory listing that is empty once,
// or one canonicalisation that fails once. Every other call reaches the real
// filesystem untouched.
const faults = vi.hoisted(() => ({
  emptyReaddirOnce: "", failOpen: "", failRealpathOnce: "", failWriteAfterOpen: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fsError = (message: string, code: string) => Object.assign(new Error(message), { code });
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === faults.failOpen) throw fsError("injected open failure", "EACCES");
      const handle = await actual.open(...args);
      if (String(args[0]) !== faults.failWriteAfterOpen) return handle;
      return Object.assign(handle, {
        writeFile: async () => { throw fsError("injected write failure", "ENOSPC"); },
      });
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === faults.emptyReaddirOnce) {
        faults.emptyReaddirOnce = "";
        return [];
      }
      return actual.readdir(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (String(args[0]) === faults.failRealpathOnce) {
        faults.failRealpathOnce = "";
        throw fsError("injected realpath failure", "EIO");
      }
      return actual.realpath(...args);
    },
  };
});

let scratch = "";

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "moe-manager-files-")));
});
afterEach(async () => {
  faults.emptyReaddirOnce = "";
  faults.failOpen = "";
  faults.failRealpathOnce = "";
  faults.failWriteAfterOpen = "";
  await rm(scratch, { force: true, recursive: true });
});

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
      createdDirectories: [target],
      paths: [join(target, "moe.config.json")],
      root: target,
    });
    expect(Object.isFrozen(result.written)).toBe(true);
    expect(Object.isFrozen(result.written.createdDirectories)).toBe(true);
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
    expect(result.written).toEqual({ createdDirectories: [], paths: [], root: target });
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

  it("records every ancestor the create made, leaf first, and discards them all", async () => {
    const target = join(scratch, "new", "deep", "proj");
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const result = await files.create(target);
    if (!result.ok) throw new Error(result.code);
    expect(result.written.createdDirectories).toEqual([
      target, join(scratch, "new", "deep"), join(scratch, "new"),
    ]);

    await files.discard(result.written);
    expect(existsSync(join(scratch, "new"))).toBe(false);
    expect(existsSync(scratch)).toBe(true);
  });

  it("keeps an empty root that existed before create", async () => {
    const target = join(scratch, "preexisting-empty");
    await mkdir(target);
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const result = await files.create(target);
    if (!result.ok) throw new Error(result.code);
    expect(result.written.createdDirectories).toEqual([]);

    await files.discard(result.written);
    expect(existsSync(target)).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it("removes every directory it made when the config cannot be opened for writing", async () => {
    const target = join(scratch, "new", "deep", "proj");
    faults.failOpen = join(target, "moe.config.json");
    const result = await createNodeProjectManagerFiles().create(target);
    expect(result).toEqual({
      code: PROJECT_MANAGER_CONFIG_WRITE_FAILED, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
    expect(existsSync(join(scratch, "new"))).toBe(false);
  });

  it("removes the empty config a failed write left behind, so a retry is not refused", async () => {
    const target = join(scratch, "new", "deep", "proj");
    const configPath = join(target, "moe.config.json");
    faults.failWriteAfterOpen = configPath;
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const failed = await files.create(target);
    expect(failed).toEqual({
      code: PROJECT_MANAGER_CONFIG_WRITE_FAILED, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(scratch, "new"))).toBe(false);

    faults.failWriteAfterOpen = "";
    const retried = await files.create(target);
    expect(retried.ok).toBe(true);
  });

  it("leaves a foreign config that landed after the probe untouched, and refuses", async () => {
    const target = join(scratch, "raced");
    const configPath = join(target, "moe.config.json");
    await mkdir(target);
    await writeFile(configPath, "FOREIGN", "utf8");
    faults.emptyReaddirOnce = target;
    const result = await createNodeProjectManagerFiles().create(target);
    expect(result).toEqual({
      code: PROJECT_MANAGER_CONFIG_WRITE_FAILED, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
    expect(await readFile(configPath, "utf8")).toBe("FOREIGN");
    expect(existsSync(target)).toBe(true);
  });

  it("removes the config it wrote when the result cannot be canonicalised, so a retry is not refused", async () => {
    const target = join(scratch, "canonical");
    const configPath = join(target, "moe.config.json");
    faults.failRealpathOnce = configPath;
    const files = createNodeProjectManagerFiles({ randomHex: () => "ab".repeat(32) });
    const failed = await files.create(target);
    expect(failed).toEqual({
      code: PROJECT_MANAGER_CONFIG_WRITE_FAILED, layer: PROJECT_MANAGER_FILES_LAYER, ok: false,
    });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(target)).toBe(false);

    const retried = await files.create(target);
    expect(retried.ok).toBe(true);
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
