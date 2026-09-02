/**
 * The words a person reads for a decision record: what the command did and who did it. A
 * kind or principal this table does not know renders as the daemon spelled it, never as a
 * guess. Every entry names a kind the daemon's registry actually routes.
 */

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "approval.decide": "decided the plan",
  "approval.decide_intent": "approved the plan",
  "escalation.decide": "allowed more review attempts",
  "goal.close": "closed the goal",
  "goal.create": "created a goal",
  "goal.create_with_source": "created a goal from a PRD",
  "integration.accept_output": "accepted the delivered work",
  "internal.integration.verifier_receipt": "recorded the verifier's receipt",
  "plan.propose": "proposed a plan",
  "planning.submit_decomposition": "submitted a compiled plan",
  "policy.install": "installed a policy slice",
  "policy.validate": "evaluated the policy",
  "product_contract.answer_clarification": "answered a contract question",
  "product_contract.approve_gate_1": "approved the Product Contract at Gate 1",
  "product_contract.propose_revision": "proposed a Product Contract",
  "project.activate": "activated the project",
  "project.bind_repository": "bound the repository",
  "project.register": "registered the project",
  "provider.probe": "probed the provider",
  "qualification.replan": "requested a re-plan",
  "review.submit": "submitted a review round",
  "session.close": "closed a seat",
  "session.open": "opened a seat",
  "session.renew": "renewed a seat",
  "work.claim": "took a work item",
  "work.release": "released a work item",
  "work.renew": "renewed a work item",
});

export function kindWords(commandKind: string): string {
  return KIND_WORDS[commandKind] ?? commandKind;
}

/** Who a principal is, in a person's words, keeping the id in reach for the mono line. */
export function principalWords(principalId: string): string {
  if (principalId === "operator-local" || principalId.startsWith("principal-")) return "the operator";
  if (principalId.startsWith("sess-wrap-")) return "an agent seat";
  if (principalId === "daemon:node-verifier") return "the daemon's verifier";
  if (principalId.startsWith("daemon:")) return "the daemon";
  if (principalId.startsWith("sess-")) return "a paired session";
  return principalId;
}

/** "3 min ago" from an ISO instant; the raw instant when it does not parse. */
export function agoWords(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}
