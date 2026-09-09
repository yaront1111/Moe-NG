import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

import { createNodeProjectCatalogRegistrar } from "./project-catalog-registrar.js";
import type { RegisterCatalogProjectInput } from "./project-catalog.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function fixture(): Promise<{ directory: string; path: string; input: RegisterCatalogProjectInput }> {
  const directory = await mkdtemp(join(tmpdir(), "moe-catalog-registrar-"));
  directories.push(directory);
  const root = join(directory, "alpha");
  await mkdir(root);
  const configPath = join(root, "moe.config.json");
  await writeFile(configPath, "{}");
  const path = join(directory, "projects.json");
  await writeFile(path, JSON.stringify({ entries: [], schemaVersion: "moe-project-catalog/1" }));
  return { directory, path, input: { root, configPath, storePath: join(root, "store.sqlite"), projectId: "alpha", title: "Alpha" } };
}

function childRegistrar(path: string, input: RegisterCatalogProjectInput, holdRead: boolean) {
  const source = `
    import { createNodeProjectCatalogRegistrar } from ${JSON.stringify(new URL("./project-catalog-registrar.js", import.meta.url).href)};
    import { createNodeProjectCatalogPorts } from ${JSON.stringify(new URL("./project-catalog.js", import.meta.url).href)};
    const [path, input, hold] = process.argv.slice(1);
    const native = createNodeProjectCatalogPorts();
    const released = new Promise(resolve => process.once("message", resolve));
    const register = createNodeProjectCatalogRegistrar(path, { ...native, fs: { ...native.fs,
      async readText(path) {
        const text = await native.fs.readText(path);
        process.send({kind: "read"});
        if (hold === "true") await released;
        return text;
      }
    }});
    process.send({kind: "started"});
    try { await register(JSON.parse(input)); process.send({kind: "done", ok: true}); }
    catch (error) { process.send({kind: "done", ok: false, code: error.code}); }
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, path, JSON.stringify(input), String(holdRead)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true,
  });
  const started = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  const done = Promise.withResolvers<{ ok: boolean; code?: string }>();
  let result: { ok: boolean; code?: string } | undefined;
  child.on("message", (message: unknown) => {
    const value = message as { kind?: string; ok: boolean; code?: string };
    if (value.kind === "started") started.resolve();
    if (value.kind === "read") read.resolve();
    if (value.kind === "done") result = value;
  });
  child.on("error", (error) => { started.reject(error); read.reject(error); done.reject(error); });
  child.once("close", (code) => {
    if (code === 0 && result !== undefined) done.resolve(result);
    else done.reject(new Error(`catalog child exited ${String(code)}`));
  });
  return { child, started: started.promise, read: read.promise, done: done.promise };
}

it.each([false, true])("serializes separate-process registrations with conflicting paths=%s", async (conflicting) => {
  const { path, directory, input } = await fixture();
  const secondRoot = conflicting ? input.root : join(directory, "beta");
  await mkdir(secondRoot, { recursive: true });
  const secondConfig = join(secondRoot, "moe.config.json");
  await writeFile(secondConfig, "{}");
  const first = childRegistrar(path, input, true);
  let second: ReturnType<typeof childRegistrar> | undefined;
  try {
    await Promise.race([first.read, first.done.then(() => { throw new Error("first registrar did not read"); })]);
    second = childRegistrar(path, {
      root: secondRoot, configPath: secondConfig, storePath: join(secondRoot, "store.sqlite"),
      projectId: "beta", title: "Beta",
    }, false);
    await second.started;
    // Without serialization both processes read the same empty catalog. With it,
    // the contender waits while the first process owns the read/modify/write.
    await Promise.race([second.read, delay(250)]);
    first.child.send("release");
    const results = await Promise.all([first.done, second.done]);
    expect(results.filter((result) => result.ok)).toHaveLength(conflicting ? 1 : 2);
    if (conflicting) expect(results[1]).toMatchObject({ ok: false, code: "PROJECT_CATALOG_ROOT_CONFLICT" });
    const catalog = JSON.parse(await readFile(path, "utf8")) as { entries: { projectId: string }[] };
    expect(catalog.entries.map((entry) => entry.projectId).sort()).toEqual(conflicting ? ["alpha"] : ["alpha", "beta"]);
  } finally {
    for (const process of [first, second]) {
      if (process === undefined) continue;
      if (process.child.exitCode === null) process.child.kill();
      await process.done.catch(() => undefined);
    }
  }
}, 30_000);

it("releases registration ownership after a catalog refusal", async () => {
  const { path, input } = await fixture();
  await writeFile(path, "invalid catalog");
  const register = createNodeProjectCatalogRegistrar(path);
  await expect(register(input)).rejects.toMatchObject({ code: "PROJECT_CATALOG_MALFORMED" });
  await writeFile(path, JSON.stringify({ entries: [], schemaVersion: "moe-project-catalog/1" }));
  await expect(register(input)).resolves.toBeUndefined();
});

it("reports a stable write refusal if the lock cannot be opened", async () => {
  const { path, input } = await fixture();
  await mkdir(`${path}.lock.sqlite`);
  await expect(createNodeProjectCatalogRegistrar(path)(input)).rejects.toMatchObject({
    code: "PROJECT_CATALOG_WRITE_FAILED", layer: "PROJECT_CATALOG",
  });
  expect((JSON.parse(await readFile(path, "utf8")) as { entries: unknown[] }).entries).toHaveLength(0);
});

it("releases native lock ownership when its registrar process dies", async () => {
  const { path, input } = await fixture();
  const owner = childRegistrar(path, input, true);
  try {
    await Promise.race([owner.read, owner.done.then(() => { throw new Error("owner did not read"); })]);
    owner.child.kill();
    await owner.done.catch(() => undefined);
    await expect(createNodeProjectCatalogRegistrar(path)(input)).resolves.toBeUndefined();
    const catalog = JSON.parse(await readFile(path, "utf8")) as { entries: { projectId: string }[] };
    expect(catalog.entries.map((entry) => entry.projectId)).toEqual(["alpha"]);
  } finally {
    if (owner.child.exitCode === null) owner.child.kill();
    await owner.done.catch(() => undefined);
  }
}, 30_000);
