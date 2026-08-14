import { parentPort, workerData } from "node:worker_threads";

// Imported through the package ROOT: `--experimental-strip-types` erases
// `export type` entirely, so reaching the method this way also proves it is a
// real runtime value rather than a type-only publication.
import { SqliteEventStore } from "./index.ts";

if (parentPort === null) {
  throw new Error("recovery initial install race worker requires a parent port");
}

const gate = new Int32Array(workerData.gate);
const encoder = new TextEncoder();
parentPort.postMessage({ kind: "PREOPEN_READY" });
Atomics.wait(gate, 0, 0);
const store = SqliteEventStore.openForProject(workerData.databasePath, workerData.projectId);
parentPort.postMessage({ kind: "READY" });
Atomics.wait(gate, 1, 0);

let outcome;
try {
  const result = store.installInitialRecoveryBinding({
    bindingCodecVersion: workerData.bindingCodecVersion,
    incarnationRef: workerData.incarnationRef,
    installedAt: workerData.installedAt,
    keyEpochRef: workerData.keyEpochRef,
    payload: encoder.encode(`binding-for-${workerData.incarnationRef}`),
    slot: "ACTIVE",
  });
  outcome = {
    bindingDigest: result.bindingDigest,
    code: result.code,
    incarnationRef: result.binding === undefined ? undefined : result.binding.incarnationRef,
    initialInstallType: typeof SqliteEventStore.prototype.installInitialRecoveryBinding,
    kind: "RESULT",
    layer: result.layer,
    ok: result.ok,
    outcome: result.outcome,
    proposedRef: workerData.incarnationRef,
  };
} catch (error) {
  outcome = {
    code: error !== null && typeof error === "object" ? error.code : undefined,
    initialInstallType: typeof SqliteEventStore.prototype.installInitialRecoveryBinding,
    kind: "RESULT",
    outcome: "THREW",
    proposedRef: workerData.incarnationRef,
  };
} finally {
  // Closed BEFORE the result is posted: a still-open SQLite handle makes the
  // test's rmSync fail with EPERM on Windows and kills the vitest worker.
  store.close();
}
parentPort.postMessage(outcome);
