import { parentPort } from "node:worker_threads";

import { describeTruthClass } from "@moe/control-room-model";

const observed = describeTruthClass("OBSERVED");
const unknown = describeTruthClass("UNKNOWN");
const invalid = describeTruthClass("NOT_A_TRUTH_CLASS");

if (!observed.ok || !unknown.ok || invalid.ok) {
  throw new Error("control-room truth smoke received an invalid result shape");
}

const payload = {
  descriptorFrozen: Object.isFrozen(observed.descriptor),
  describeType: typeof describeTruthClass,
  errorFrozen: Object.isFrozen(invalid.error),
  failureEnvelopeFrozen: Object.isFrozen(invalid),
  invalidCode: invalid.error.code,
  observedChipTestId: observed.descriptor.chipTestId,
  outcome: "IMPORTED",
  successEnvelopeFrozen: Object.isFrozen(observed),
  unknownBorderStyle: unknown.descriptor.borderStyle,
};

if (parentPort === null) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
  parentPort.postMessage(payload);
}
