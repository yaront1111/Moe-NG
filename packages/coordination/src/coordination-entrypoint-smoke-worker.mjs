import { parentPort } from "node:worker_threads";

import * as coordination from "./index.ts";

if (parentPort === null) {
  throw new Error("coordination entrypoint smoke worker requires a parent port");
}

const exportedNames = Object.keys(coordination).sort();
const undefinedExports = exportedNames.filter((name) => coordination[name] === undefined);
const leakedNames = [
  "SqliteEventStore",
  "canonicalEnvelopeBytes",
  "createMailboxReader",
  "decodeCoordinationEnvelope",
  "decodeStoredEnvelope",
  "digestBytes",
  "mailboxAggregateId",
  "readBinding",
  "refuse",
  "sendCommandId",
].filter((name) => name in coordination);

/** A structural stand-in for the durable store: enough to build the service under plain
 *  Node without pulling a database into the bridge probe. */
const emptyStore = {
  commit: () => {
    throw new Error("the smoke worker must never reach a durable commit");
  },
  getAggregateVersion: () => 0,
  getCommandReceipt: () => null,
  readAggregateEvents: () => ({ hasMore: false, items: [], nextCursor: null }),
};

const service = coordination.createCoordinationService({
  authenticate: () => null,
  mailbox: coordination.createDurableMailbox(emptyStore),
  now: () => 1_800_000_000_000,
  resolveEffectBinding: () => null,
  resolveRecipient: () => null,
});

const refused = service.send({
  envelope: {
    advisory: null,
    correlationId: "corr-1",
    data: { note: "hello" },
    kind: "EVENT",
    messageId: "msg-1",
    recipient: { effectId: null, role: "REVIEWER", sessionId: "session-reviewer" },
    sender: { effectId: null, role: "CODER", sessionId: "session-coder" },
    ttlMilliseconds: 60_000,
  },
  presentation: { proofMaterial: "never-stored-secret" },
  transportId: "transport-1",
});

parentPort.postMessage({
  exportedNames,
  leakedNames,
  outcome: "IMPORTED",
  refusedCode: refused.code,
  refusedLayer: refused.layer,
  serviceFrozen: Object.isFrozen(service),
  serviceMembers: Object.keys(service).sort(),
  undefinedExports,
});
