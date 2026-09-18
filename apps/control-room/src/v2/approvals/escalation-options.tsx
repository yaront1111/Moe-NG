import type { JSX } from "react";

/**
 * What each answer on the "Review exhausted" card does, in the operator's words. UnAI
 * 2026-09-17/18: the owner clicked "Allow one more attempt" repeatedly without knowing what it
 * rescued. The rule is the review kernel's (`@moe/review` review-findings.ts and
 * review-continuation.ts): a continuation funds exactly ONE more round, that round is accepted
 * when it carries no CRITICAL or MAJOR finding of this node's own, and MINOR findings are
 * recorded but never block. Static copy: it states no daemon fact and carries no authority.
 */
export const ALLOW_OPTION_COPY = "Allow one more attempt funds one more review round. That round is accepted if it carries no CRITICAL or MAJOR finding; MINOR notes are recorded but never block it.";
export const REPLAN_OPTION_COPY = "Replan from the findings retires this node and hands its findings to a successor goal for the planning agent. No further round runs here.";
export const GUIDANCE_OPTION_COPY = "Guidance is optional. Whatever you write below reaches the worker word for word with that one attempt; approved requirements and checks still apply.";

/** `guidanceEntry` is true exactly when the guidance textbox renders beneath this section. */
export function EscalationOptions({ guidanceEntry }: { readonly guidanceEntry: boolean }): JSX.Element {
  return (
    <section aria-label="What each answer does" data-testid="cr.needsyou.options">
      <h3>What each answer does</h3>
      <ul>
        <li className="cr2-needs-note">{ALLOW_OPTION_COPY}</li>
        <li className="cr2-needs-note">{REPLAN_OPTION_COPY}</li>
        {guidanceEntry ? <li className="cr2-needs-note">{GUIDANCE_OPTION_COPY}</li> : null}
      </ul>
    </section>
  );
}
