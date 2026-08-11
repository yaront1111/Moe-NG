import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

/**
 * `--experimental-strip-types` erases `export type` entirely, so a type-only
 * publication would satisfy tsc while leaving nothing importable. Every
 * assertion here is on a RUNTIME value reached through the package root.
 */
it("publishes the recovery install surface as real runtime values from the package root", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL("./recovery-install-entrypoint-worker.mjs", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`recovery install entrypoint worker exited with ${code}`));
      }
    });
  });

  expect(result).toEqual({
    codecVersion: "moe-recovery-binding/1",
    decodeType: "function",
    decodedSlot: "PENDING",
    encodeType: "function",
    installType: "function",
    layers: ["RECOVERY_BINDING_CODEC", "RECOVERY_INSTALL_TRANSACTION"],
    outcome: "IMPORTED",
    readType: "function",
    reasonCodeCount: 8,
    slots: ["ACTIVE", "PENDING"],
  });
});
