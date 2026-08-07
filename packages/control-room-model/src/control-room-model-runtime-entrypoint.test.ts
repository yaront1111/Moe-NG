import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

it("loads the package specifier in Node's strip-types runtime", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      new URL("./control-room-model-entrypoint-smoke-worker.mjs", import.meta.url),
      { execArgv: ["--experimental-strip-types"] },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`control-room model smoke worker exited with ${code}`));
      }
    });
  });

  expect(result).toEqual({
    descriptorFrozen: true,
    describeType: "function",
    errorFrozen: true,
    failureEnvelopeFrozen: true,
    invalidCode: "TRUTH_CLASS_INVALID",
    observedChipTestId: "cr.chip.observed",
    outcome: "IMPORTED",
    successEnvelopeFrozen: true,
    unknownBorderStyle: "dashed",
  });
});
