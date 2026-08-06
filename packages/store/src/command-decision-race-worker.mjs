import { parentPort, workerData } from "node:worker_threads";

import { SqliteEventStore } from "./sqlite-event-store.ts";

if (parentPort === null) {
  throw new Error("command decision race worker requires a parent port");
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
  const result = store.commitExpectedVersionDecision({
    commandKind: "goal.race",
    committedResultBytes: encoder.encode(`result-${workerData.suffix}`),
    correlationId: `correlation-${workerData.suffix}`,
    decidedAt: workerData.decidedAt,
    events: [
      {
        eventId: `decision-event-${workerData.suffix}`,
        eventType: "goal.raced",
        payload: encoder.encode(`payload-${workerData.suffix}`),
      },
    ],
    expectedVersion: 0,
    key: {
      commandId: workerData.commandId,
      principalId: workerData.principalId,
      projectId: workerData.projectId,
    },
    requestBytes: encoder.encode(workerData.requestBytes),
    targetAggregateId: workerData.targetAggregateId,
  });
  outcome = {
    businessEventIds: result.decision.businessEventIds,
    decisionId: result.decision.decisionId,
    decisionSha256: result.decision.decisionSha256,
    disposition: result.disposition,
    effectDisposition: result.decision.effectDisposition,
    effectSha256: result.decision.effectSha256,
    kind: "RESULT",
    resultCode: result.decision.resultCode,
    resultSha256: result.decision.resultSha256,
  };
} catch (error) {
  outcome = {
    code: error !== null && typeof error === "object" ? error.code : undefined,
    kind: "RESULT",
  };
} finally {
  store.close();
}
parentPort.postMessage(outcome);
