/**
 * The words a person reads for a decision record: what the command did and who did it. A
 * kind or principal this table does not know renders as the daemon spelled it, never as a
 * guess. Every entry names a kind the daemon's registry actually routes.
 */

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  CLOSE_SESSION: "closed a browser seat",
  CREATE_PRINCIPAL: "minted a principal",
  OPEN_SESSION: "paired a browser seat",
  "approval.decide": "decided the plan",
  "approval.decide_intent": "approved the plan",
  "escalation.decide": "decided an exhausted review",
  "goal.close": "closed the goal",
  "goal.create": "created a goal",
  "goal.create_with_source": "created a goal from a PRD",
  "integration.accept_output": "accepted the delivered work",
  "internal.integration.verifier_receipt": "recorded the verifier's receipt",
  "internal.repository.landing_receipt": "landed the accepted work as a commit",
  "internal.repository.publish_receipt": "recorded the publish",
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
  "repository.publish": "asked to publish the landed commits",
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

/** The review routes in a person's words, as the runs screen says them. */
const VERDICT_ROUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ACCEPT: "passed the review",
  ESCALATE: "escalated the review",
  REJECT_IMPLEMENTATION: "sent the work back: implementation",
  REJECT_PLAN: "sent the work back: same finding again",
  UNKNOWN_EVIDENCE: "sent the work back: evidence unknown",
});

/**
 * What a decision DID, using its verdict where the record carries one: a review round names
 * its route, an escalation names its answer. Without a verdict the kind's own words stand.
 */
export function decisionWords(commandKind: string, verdict: string | null): string {
  if (verdict === null) return kindWords(commandKind);
  if (commandKind === "review.submit") return VERDICT_ROUTE_WORDS[verdict] ?? `reviewed: ${verdict}`;
  if (commandKind === "escalation.decide") {
    if (verdict === "REPLAN") return "sent the node to be replanned";
    if (verdict === "ALLOW_MORE_ATTEMPTS") return "allowed more review attempts";
    return `decided the exhausted review: ${verdict}`;
  }
  if (commandKind === "approval.decide" || commandKind === "approval.decide_intent") {
    return verdict === "APPROVE" ? "approved the plan" : verdict === "REJECT" ? "rejected the plan" : kindWords(commandKind);
  }
  return `${kindWords(commandKind)} (${verdict})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Seat and pairing records: true for the handshake's own decisions and every session command. */
export function isSeatRecord(commandKind: string, targetAggregateId: string): boolean {
  return commandKind.startsWith("session.") || commandKind === "OPEN_SESSION" || commandKind === "CREATE_PRINCIPAL"
    || commandKind === "CLOSE_SESSION" || targetAggregateId.startsWith("moe.session-authority");
}

/** What a seat is, from its id: the wrapper mints `sess-wrap-`, a browser pairing mints a uuid. */
export function seatWords(sessionId: string): string {
  if (sessionId.startsWith("sess-wrap-")) return "an agent seat";
  if (sessionId.startsWith("sess-double-")) return "a planning agent";
  if (UUID.test(sessionId)) return "a paired browser";
  return sessionId;
}

/** Who a principal is, in a person's words, keeping the id in reach for the mono line. */
export function principalWords(principalId: string): string {
  if (principalId === "operator-local" || principalId.startsWith("principal-")) return "the operator";
  if (principalId.startsWith("sess-wrap-")) return "an agent seat";
  if (principalId === "daemon:node-verifier") return "the daemon's verifier";
  if (principalId.startsWith("daemon:")) return "the daemon";
  if (principalId.startsWith("sess-")) return "a paired session";
  if (UUID.test(principalId)) return "a paired browser";
  return principalId;
}

/** "3 min ago" from an ISO instant; the raw instant when it does not parse. */
export function agoWords(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return freshnessWords(at, nowMs);
}

/** "3 s ago" / "just now" from two millisecond instants. Never a live region. */
export function freshnessWords(readAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - readAtMs) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${String(seconds)} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}
