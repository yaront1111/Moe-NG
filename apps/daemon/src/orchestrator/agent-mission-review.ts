/** Runtime guidance is shipped with the daemon; no Control Room development fixture is needed. */
export function reviewSubmissionMissionLines(nodeRef: string): readonly string[] {
  return Object.freeze([
    `The review_submit payload must have exactly subjectRef, round, findings, packageItems: ${JSON.stringify({
      subjectRef: nodeRef, round: "<expectedVersion + 1>", findings: [], packageItems: [],
    })}. Replace round with that numeric value. Use empty findings only after every assigned criterion is implemented and required checks pass.`,
    "Record unmet criteria, remaining work and unresolved product decisions as findings even when existing tests pass.",
    "For a compiled node, packageItems:[] requests the daemon's evidence preparation.",
    "The daemon captures the workspace and binds every approved criterion, the graph, plan,",
    "rubric and submitted bytes itself; proof remains UNKNOWN until its independent verifier runs.",
    "Do not invent hashes, receipts, criterion ids, package entries or verification success.",
    "Keep the workspace stable during submission. A missing source or claim is a refusal to report,",
    "never a reason to manufacture evidence. Record the actual review_submit answer before releasing.",
  ]);
}
