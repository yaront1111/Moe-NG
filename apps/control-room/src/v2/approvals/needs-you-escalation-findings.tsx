import type { JSX } from "react";
import { MINOR_NEVER_BLOCKS, REVIEW_SUMMARY_FINDINGS_CAP, blockingFindingsOf, blocksAcceptance, findingsListCapped } from "./needs-you-escalation.js";
import type { EscalationFacts } from "./needs-you-escalation.js";

const UNAVAILABLE = Object.freeze({
  MISSING: "Latest review details have not arrived yet.",
  STALE: "Latest review details are refreshing to match this decision.",
  UNREADABLE: "Latest review details could not be read.",
});

/**
 * What the listed severities add up to for the decision. UnAI 2026-09-17/18: every round carried
 * only MINOR findings, which never block a round (`@moe/review`), yet the card read like a
 * deadlock and the operator clicked "Allow one more attempt" repeatedly without knowing what it
 * rescued. An all-MINOR list must say so in one line; a list with a blocking finding must say
 * what has to change before a round is accepted. A list at the daemon's cap
 * (`REVIEW_SUMMARY_FINDINGS_CAP`) may hide a blocking finding past it and the wire carries no
 * total, so it says "listed" and names the cap instead of claiming the round blocks nothing.
 */
function SeveritySummary({ facts }: { readonly facts: EscalationFacts }): JSX.Element {
  const total = facts.findings.length;
  const blocking = blockingFindingsOf(facts.findings);
  if (blocking === 0) {
    const allMinor = facts.findings.every((finding) => finding.severity === "MINOR");
    if (findingsListCapped(facts.findings)) {
      const cap = String(REVIEW_SUMMARY_FINDINGS_CAP);
      return (
        <p className="cr2-needs-note" data-testid="cr.needsyou.findings.capped" role="note">
          {`${allMinor ? `All ${cap} listed findings are MINOR` : `None of the ${cap} listed findings blocks this node`} (the daemon lists at most ${cap}, so a CRITICAL or MAJOR finding may be unlisted): MINOR notes never block a round; ${MINOR_NEVER_BLOCKS}.`}
        </p>
      );
    }
    return (
      <p className="cr2-needs-note" data-testid="cr.needsyou.findings.nonblocking" role="note">
        {allMinor
          ? `All ${String(total)} ${total === 1 ? "finding is" : "findings are"} MINOR: they never block a round; ${MINOR_NEVER_BLOCKS}.`
          : `None of these ${String(total)} findings blocks this node: MINOR notes never block a round and the rest are owned by other nodes; ${MINOR_NEVER_BLOCKS}.`}
      </p>
    );
  }
  return (
    <p className="cr2-needs-note" data-testid="cr.needsyou.findings.blocking" role="note">
      {`${String(blocking)} of ${String(total)} ${total === 1 ? "finding" : "findings"} ${blocking === 1 ? "blocks" : "block"} acceptance (CRITICAL or MAJOR): the next round is accepted only if no CRITICAL or MAJOR finding remains.`}
    </p>
  );
}

/** Reported issues inform a decision; their text never creates product authority. */
export function EscalationFindings({ facts }: { readonly facts: EscalationFacts }): JSX.Element {
  return (
    <section aria-label="Latest reported findings">
      <h3>Latest reported findings</h3>
      {facts.findingsState !== "CURRENT" ? (
        <p className="cr2-needs-detail" role="status">{UNAVAILABLE[facts.findingsState]}</p>
      ) : facts.findings.length === 0 ? (
        <p className="cr2-needs-detail">No findings were included in the latest review summary.</p>
      ) : (
        <>
          <p className="cr2-needs-note">{`Review summary: up to ${String(REVIEW_SUMMARY_FINDINGS_CAP)} findings.`}</p>
          <SeveritySummary facts={facts} />
          {(facts.stalledRounds?.length ?? 0) === 0 ? null : (
            <p className="cr2-needs-note" data-testid="cr.needsyou.stall" role="note">
              {`Rounds ${facts.stalledRounds!.join(", ")} reported the same findings on an unchanged workspace.`}
            </p>
          )}
          <ul>
            {facts.findings.map((finding, index) => (
              <li key={index} data-blocking={blocksAcceptance(finding) ? "true" : "false"} data-severity={finding.severity}>
                <p><strong>{`${finding.severity} · ${finding.ruleId}`}</strong></p>
                <p className="cr2-needs-note">{finding.subject}</p>
                {finding.attributedTo === undefined || finding.attributedTo === null ? null : (
                  <p className="cr2-needs-note" data-testid="cr.needsyou.finding.owner">
                    {`Owned by node ${finding.attributedTo.nodeKey} (criteria ${finding.attributedTo.criterionIds.join(", ")}); it does not count against this node.`}
                  </p>
                )}
                <p className="cr2-needs-detail" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{finding.detail}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="cr2-needs-note">Another attempt does not answer unresolved product questions.</p>
    </section>
  );
}
