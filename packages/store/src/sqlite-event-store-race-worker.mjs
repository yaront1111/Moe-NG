import { parentPort, workerData } from "node:worker_threads";

import { SqliteEventStore } from "./sqlite-event-store.ts";

if (parentPort === null) {
  throw new Error("race worker requires a parent port");
}

const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ kind: "PREOPEN_READY" });
Atomics.wait(gate, 0, 0);
const store = SqliteEventStore.openForProject(workerData.databasePath, "moe-test-project");
parentPort.postMessage({ kind: "READY" });
Atomics.wait(gate, 1, 0);

let outcome;
try {
  const result = store.commit({
    aggregateId: "goal-race",
    commandBytes: new TextEncoder().encode(workerData.commandBytes),
    commandId: workerData.commandId,
    committedAt: workerData.committedAt,
    events: [
      {
        eventId: workerData.eventId,
        eventType: "goal.raced",
        payload: new TextEncoder().encode(workerData.eventId),
      },
    ],
    expectedVersion: 0,
  });
  outcome = {
    disposition: result.disposition,
    eventIds: result.eventIds,
    kind: "RESULT",
  };
} catch (error) {
  outcome = {
    code: error !== null && typeof error === "object" ? error.code : undefined,
    kind: "RESULT",
  };
} finally {
  store.close();
}
if (gate.length > 2) {
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2, 1);
}
parentPort.postMessage(outcome);
