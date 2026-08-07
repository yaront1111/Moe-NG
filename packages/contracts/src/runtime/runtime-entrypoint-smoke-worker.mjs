import { parentPort } from "node:worker_threads";

import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  buildNextAllowedCommands,
  createRuntimeError,
  decodeRuntimeQueryEnvelopeBytes,
} from "@moe/contracts";

const encoder = new TextEncoder();
const query = encoder.encode(
  JSON.stringify({
    correlationId: "corr-1",
    payload: {},
    queryKind: "goal.get",
    schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    sessionCredential: "sess-1",
  }),
);

const affordances = buildNextAllowedCommands(
  { aggregate: "GOAL", state: "EXECUTION_ENABLED" },
  [
    {
      commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      commandId: "cmd-1",
      commandKind: "goal.pause",
      expectedVersion: 7,
      inputSchemaVersion: "goal.pause/1",
      targetAggregateId: "goal-1",
    },
  ],
);

const payload = {
  affordanceKinds: affordances.map((item) => item.commandKind),
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  outcome: "IMPORTED",
  queryOk: decodeRuntimeQueryEnvelopeBytes(query).ok,
  unknownErrorCode: createRuntimeError({ code: "NOPE", correlationId: "corr-1" }).code,
  unknownSourceIsEmpty:
    buildNextAllowedCommands({ aggregate: "GOAL", state: "NOPE" }, []) ===
    EMPTY_NEXT_ALLOWED_COMMANDS,
};

if (parentPort === null) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
  parentPort.postMessage(payload);
}
