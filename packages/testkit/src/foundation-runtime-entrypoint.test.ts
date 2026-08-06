import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

it("loads the contracts and testkit entrypoints in Node's strip-types runtime", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      new URL("./foundation-entrypoint-smoke-worker.mjs", import.meta.url),
      { execArgv: ["--experimental-strip-types"] },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`foundation entrypoint smoke worker exited with ${code}`));
      }
    });
  });

  expect(result).toEqual({
    canonical: '{"a":1,"z":2}',
    contractVersion: "moe-phase0-evidence-manifest/1",
    digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    outcome: "IMPORTED",
  });
});
