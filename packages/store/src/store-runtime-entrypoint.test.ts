import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

it("loads the public TypeScript entrypoint in Node's strip-types runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-runtime-entrypoint-"));
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(
        new URL("./store-entrypoint-smoke-worker.mjs", import.meta.url),
        {
          execArgv: ["--experimental-strip-types"],
          workerData: { databasePath: join(directory, "store.sqlite") },
        },
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`store entrypoint smoke worker exited with ${code}`));
        }
      });
    });

    expect(result).toEqual({
      accessMode: "READ_ONLY_INSPECTION",
      dangerousMembers: [],
      frozen: true,
      outcome: "IMPORTED",
      ownKeys: [],
      projectId: null,
      shadowMutationRejected: true,
      writeCode: "PROJECT_SCOPE_REQUIRED",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
