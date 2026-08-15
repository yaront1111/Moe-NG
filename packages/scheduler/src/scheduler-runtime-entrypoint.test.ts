import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

const WORKER_PROBE_TIMEOUT_MS = 20_000;
const WORKER_TEST_TIMEOUT_MS = 30_000;

it("loads and executes the scheduler entrypoint in Node's strip-types runtime", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      new URL("./scheduler-entrypoint-smoke-worker.mjs", import.meta.url),
      { execArgv: ["--experimental-strip-types"] },
    );
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.removeAllListeners();
    };
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().then(outcome, reject);
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(
        `scheduler entrypoint smoke worker timed out after ${WORKER_PROBE_TIMEOUT_MS}ms`,
      )));
    }, WORKER_PROBE_TIMEOUT_MS);

    worker.once("message", (message) => settle(() => resolve(message)));
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`scheduler entrypoint smoke worker exited with ${code}`)));
      } else {
        settle(() => reject(new Error("scheduler entrypoint smoke worker exited without a result")));
      }
    });
  });

  expect(result).toEqual({
    admissionReadyWidth: 1,
    counterfactualEdgeCount: 0,
    counterfactualType: "function",
    dispatchableWidth: 1,
    fairnessBypassRefusal:
      "REFUSED:FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING:OPPORTUNITY_EVIDENCE",
    fairnessIssueCodeCount: 18,
    fairnessLayerCount: 5,
    fairnessRingRefusal: "REFUSED:FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES:RING",
    internalSubpath: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    logicalReadyWidth: 1,
    outcome: "IMPORTED",
    previewAuthority: "NONE",
    previewOutcome: "ANALYZED",
    previewType: "function",
    stageCount: 1,
    validateType: "function",
  });
}, WORKER_TEST_TIMEOUT_MS);
