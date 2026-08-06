import { parentPort, workerData } from "node:worker_threads";

import { SqliteEventStore } from "./sqlite-event-store.ts";

if (parentPort === null) {
  throw new Error("project binding first-open worker requires a parent port");
}

const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ kind: "READY" });
Atomics.wait(gate, 0, 0);

try {
  const store = SqliteEventStore.openForProject(
    workerData.databasePath,
    workerData.projectId,
  );
  try {
    const health = store.getHealth();
    parentPort.postMessage({
      accessMode: health.accessMode,
      kind: "RESULT",
      outcome: "OPENED",
      projectId: health.projectId,
      quickCheck: health.quickCheck,
      writeProjectAsserted: health.writeProjectAsserted,
    });
  } finally {
    store.close();
  }
} catch (error) {
  parentPort.postMessage({
    code:
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined,
    kind: "RESULT",
    outcome: "REJECTED",
    projectId: workerData.projectId,
  });
}
