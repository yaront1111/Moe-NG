import type { JsonObject } from "@moe/contracts";
import type { ReviewPackageItemInput } from "@moe/review";
import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import type { VerifierRunCapture } from "./node-verifier.js";
import { RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS } from "./verifier-recipe-verdict-lines.js";

/**
 * How much of the capture's tail the failure finding carries, in UTF-16 code units. 600 held
 * the bare verdict JSON and nothing else; the database runner's verdict now ends with up to
 * twelve scrubbed verdict lines, and this is DERIVED from their worst JSON-encoded size (every
 * character escaped) plus the rest of the verdict, so the lines always arrive whole and parse.
 */
export const VERIFIER_FAILURE_TAIL_UNITS = RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS + 200;

/** Preserve the verified source package; a failed execution never creates a PASSED receipt. */
export function verifierFailurePayload(
  subjectRef: string, round: number, capture: VerifierRunCapture, items: readonly ReviewPackageItemInput[],
): JsonObject {
  // A UTF-16 tail may start on an orphan surrogate. Keep the failure encodable by the ingress.
  const tail = capture.output.slice(-VERIFIER_FAILURE_TAIL_UNITS).toWellFormed();
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
