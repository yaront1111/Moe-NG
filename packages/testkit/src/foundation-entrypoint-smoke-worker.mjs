import { parentPort } from "node:worker_threads";

import * as contracts from "../../contracts/src/index.ts";
import * as testkit from "./index.ts";

if (parentPort === null) {
  throw new Error("foundation entrypoint smoke worker requires a parent port");
}

let freezeProbe = "unexpected success";
try {
  await testkit.evaluatePhase0FreezeCandidate({
    authorizationClaimBytes: new TextEncoder().encode("{}"),
    manifestBytes: new TextEncoder().encode("{}"),
    now: () => "2026-08-06T00:00:00.000Z",
    readEvidenceObject: async () => {
      throw new Error("unreachable");
    },
  });
} catch (error) {
  freezeProbe = error instanceof Error ? error.message.split(":", 1)[0] : "non-error";
}

parentPort.postMessage({
  canonical: testkit.canonicalize({ z: 2, a: 1 }),
  contractVersion: contracts.PHASE0_EVIDENCE_MANIFEST_VERSION,
  digest: testkit.identifyEvidence(new TextEncoder().encode("abc")).digest,
  freezeCandidateVersion: contracts.PHASE0_FREEZE_CANDIDATE_VERSION,
  freezeProbe,
  freezeCandidateEvaluatorType: typeof testkit.evaluatePhase0FreezeCandidate,
  nodeCapturePortFactoryType: typeof testkit.createNodePhase0EvidenceCapturePort,
  outcome: "IMPORTED",
});
