import { REVIEW_FINDING_SEVERITIES, REVIEW_FINDING_SUBJECT_KINDS } from "@moe/review";
import type { ReviewFinding } from "@moe/review";

/** Runtime guidance is shipped with the daemon; no Control Room development fixture is needed. */
export function reviewSubmissionMissionLines(nodeRef: string): readonly string[] {
  const example: ReviewFinding = {
    detail: "Describe the unmet requirement and what remains to implement or decide.",
    ruleId: "implementation-incomplete", severity: "MAJOR",
    subject: { kind: "NODE", locator: nodeRef },
  };
  // Only a compiled node has a sealed plan the daemon can check an attribution against.
  const compiled = nodeRef.startsWith("node:v1:");
  const attributedExample: ReviewFinding = {
    attributedTo: { criterionIds: ["<criterion id the owning node holds>"], nodeKey: "<owning node key>" },
    detail: "Name the failing check and the missing deliverable the owning node must provide.",
    ruleId: "dependency-deliverable-missing", severity: "MAJOR",
    subject: { kind: "ARTIFACT", locator: "<path of the failing check>" },
  };
  return Object.freeze([
    `The review_submit payload must have exactly subjectRef, round, findings, packageItems: ${JSON.stringify({
      subjectRef: nodeRef, round: "<expectedVersion + 1>", findings: [], packageItems: [],
    })}. Replace round with that numeric value. ${compiled
      ? "Submit no unattributed findings only after every assigned criterion is implemented and your verification command passes; attributed findings may accompany that round."
      : "Use empty findings only after every assigned criterion is implemented and required checks pass."}`,
    "Record unmet criteria, remaining work and unresolved product decisions as findings even when existing tests pass.",
    "Each finding has detail, ruleId, severity and subject:{kind,locator}; ruleId and locator must be non-empty strings.",
    `Allowed severity: ${REVIEW_FINDING_SEVERITIES.join(", ")}; subject.kind: ${REVIEW_FINDING_SUBJECT_KINDS.join(", ")}.`,
    `Finding example: ${JSON.stringify(example)}`,
    ...(compiled ? [`Attributed finding example (another node of your plan owns the gap): ${JSON.stringify(attributedExample)}`] : []),
    "Replace the example with the actual finding and use a distinct ruleId per issue. Keep the same ruleId and subject for the same unresolved issue across rounds.",
    "For an unresolved product decision, record the exact question and which assigned criterion it blocks. A finding does not create a clarification request or a human answer.",
    "For a compiled node, packageItems:[] requests the daemon's evidence preparation.",
    "The daemon captures the workspace and binds every approved criterion, the graph, plan,",
    "rubric and submitted bytes itself; proof remains UNKNOWN until its independent verifier runs.",
    "Do not invent hashes, receipts, criterion ids, package entries or verification success.",
    "Keep the workspace stable during submission. A missing source or claim is a refusal to report,",
    "never a reason to manufacture evidence. Record the actual review_submit answer before releasing.",
  ]);
}
