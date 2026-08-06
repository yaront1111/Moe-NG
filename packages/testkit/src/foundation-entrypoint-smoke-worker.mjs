import { parentPort } from "node:worker_threads";

import * as contracts from "../../contracts/src/index.ts";
import * as testkit from "./index.ts";

if (parentPort === null) {
  throw new Error("foundation entrypoint smoke worker requires a parent port");
}

parentPort.postMessage({
  canonical: testkit.canonicalize({ z: 2, a: 1 }),
  contractVersion: contracts.PHASE0_EVIDENCE_MANIFEST_VERSION,
  digest: testkit.identifyEvidence(new TextEncoder().encode("abc")).digest,
  outcome: "IMPORTED",
});
