import { parentPort, workerData } from "node:worker_threads";

import * as storeModule from "./index.ts";

if (parentPort === null) {
  throw new Error("store entrypoint smoke worker requires a parent port");
}

const store = storeModule.SqliteEventStore.open(workerData.databasePath);
try {
  const dangerousMembers = [
    "database",
    "databasePath",
    "loadReceipt",
    "poison",
    "projectId",
    "state",
    "writeCommitEffects",
    "writeProjectAsserted",
  ].filter((member) => member in store);
  let shadowMutationRejected = false;
  try {
    store.projectId = "forged-project";
    store.writeProjectAsserted = true;
  } catch {
    shadowMutationRejected = true;
  }
  let writeCode = "NO_ERROR";
  try {
    store.commit({
      aggregateId: "forged-aggregate",
      commandBytes: new TextEncoder().encode("forged-command"),
      commandId: "forged-command",
      committedAt: "2026-08-06T20:00:00.000Z",
      events: [
        {
          eventId: "forged-event",
          eventType: "forged.event",
          payload: new TextEncoder().encode("forged-payload"),
        },
      ],
      expectedVersion: 0,
    });
  } catch (error) {
    writeCode =
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNKNOWN_ERROR";
  }
  const health = store.getHealth();
  if (workerData.mode !== "NO_RESULT") parentPort.postMessage({
    accessMode: health.accessMode,
    dangerousMembers,
    frozen: Object.isFrozen(store),
    outcome: "IMPORTED",
    ownKeys: Reflect.ownKeys(store).map(String).sort(),
    projectId: health.projectId,
    shadowMutationRejected,
    writeCode,
  });
  if (workerData.gate !== undefined) {
    const gate = new Int32Array(workerData.gate);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    Atomics.wait(gate, 1, 0);
  }
  if (workerData.mode === "ERROR") {
    throw Object.assign(new Error("store smoke fixture failure"), { code: "STORE_SMOKE_FIXTURE_THROW" });
  }
} finally {
  store.close();
}
if (workerData.mode === "NONZERO") process.exitCode = 23;
