import { parentPort } from "node:worker_threads";

import * as contracts from "@moe/contracts";
import * as testkit from "@moe/testkit";

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

const boundedJson = contracts.decodeBoundedJsonBytes(
  new TextEncoder().encode('{"root":true}'),
);

parentPort.postMessage({
  boundedJsonDecoderType: typeof contracts.decodeBoundedJsonBytes,
  boundedJsonNullPrototype:
    boundedJson.ok && typeof boundedJson.value === "object" && boundedJson.value !== null
      ? Object.getPrototypeOf(boundedJson.value) === null
      : false,
  boundedJsonOutcome: boundedJson.ok ? "ACCEPTED" : boundedJson.code,
  canonical: testkit.canonicalize({ z: 2, a: 1 }),
  contractVersion: contracts.PHASE0_EVIDENCE_MANIFEST_VERSION,
  digest: testkit.identifyEvidence(new TextEncoder().encode("abc")).digest,
  freezeCandidateVersion: contracts.PHASE0_FREEZE_CANDIDATE_VERSION,
  freezeProbe,
  freezeCandidateEvaluatorType: typeof testkit.evaluatePhase0FreezeCandidate,
  nodeCapturePortFactoryType: typeof testkit.createNodePhase0EvidenceCapturePort,
  outcome: "IMPORTED",
});
