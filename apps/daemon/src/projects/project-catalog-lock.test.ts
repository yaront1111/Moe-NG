import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";

import { withProjectCatalogLock } from "./project-catalog-lock.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});

it("bounds contention without entering the update or releasing the existing owner's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moe-catalog-lock-"));
  directories.push(directory);
  const path = join(directory, "nested", "projects.json");
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = withProjectCatalogLock(path, async () => {
    acquired.resolve();
    await release.promise;
  });
  let updates = 0;
  try {
    await acquired.promise;
    // Relative and absolute callers must acquire ownership of the same catalog.
    await expect(withProjectCatalogLock(relative(process.cwd(), path), async () => { updates += 1; }, 30))
      .rejects.toMatchObject({ errcode: 5 });
    await expect(withProjectCatalogLock(path, async () => { updates += 1; }, 30))
      .rejects.toMatchObject({ errcode: 5 });
    expect(updates).toBe(0);
  } finally {
    release.resolve();
    await owner;
  }
  await withProjectCatalogLock(path, async () => { updates += 1; });
  expect(updates).toBe(1);
});
