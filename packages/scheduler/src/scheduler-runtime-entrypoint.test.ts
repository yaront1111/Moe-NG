import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

it("loads and executes the scheduler entrypoint in Node's strip-types runtime", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      new URL("./scheduler-entrypoint-smoke-worker.mjs", import.meta.url),
      { execArgv: ["--experimental-strip-types"] },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`scheduler entrypoint smoke worker exited with ${code}`));
      }
    });
  });

  expect(result).toEqual({
    admissionReadyWidth: 1,
    counterfactualEdgeCount: 0,
    counterfactualType: "function",
    dispatchableWidth: 1,
    internalSubpath: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    logicalReadyWidth: 1,
    outcome: "IMPORTED",
    stageCount: 1,
    validateType: "function",
  });
});
