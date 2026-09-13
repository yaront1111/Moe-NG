import type { JsonObject } from "@moe/contracts";
import type { ReviewPackageItemInput } from "@moe/review";
import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import type { VerifierRunCapture } from "./node-verifier.js";

/** Preserve the verified source package; a failed execution never creates a PASSED receipt. */
export function verifierFailurePayload(
  subjectRef: string, round: number, capture: VerifierRunCapture, items: readonly ReviewPackageItemInput[],
): JsonObject {
  // A UTF-16 tail may start on an orphan surrogate. Keep the failure encodable by the ingress.
  const tail = capture.output.slice(-600).toWellFormed();
  return {
    findings: [{
      detail: `verifier run exited ${String(capture.exitCode)} (output sha256 ${capture.sha256}): ${tail}`,
      ruleId: VERIFIER_FAILURE_RULE,
      severity: "MAJOR",
      subject: { kind: "NODE", locator: subjectRef },
    }],
    packageItems: [
      ...items.map(({ digest, kind, locator }) => ({ digest, kind, locator })),
      { digest: capture.sha256, kind: "DAEMON_RECEIPT", locator: `verifier:${subjectRef}:round-${String(round)}` },
    ],
    round,
    subjectRef,
  };
}
