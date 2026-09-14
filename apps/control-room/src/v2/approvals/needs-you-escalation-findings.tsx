import type { JSX } from "react";
import type { EscalationFacts } from "./needs-you-escalation.js";

const UNAVAILABLE = Object.freeze({
  MISSING: "Latest review details have not arrived yet.",
  STALE: "Latest review details are refreshing to match this decision.",
  UNREADABLE: "Latest review details could not be read.",
});

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
          <p className="cr2-needs-note">Review summary: up to 8 findings.</p>
          <ul>
            {facts.findings.map((finding, index) => (
              <li key={index}>
                <p><strong>{`${finding.severity} · ${finding.ruleId}`}</strong></p>
                <p className="cr2-needs-note">{finding.subject}</p>
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
