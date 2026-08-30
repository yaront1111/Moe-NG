import type { JsonObject } from "@moe/contracts";

import type { NodeMission } from "./agent-wrapper.js";

/**
 * The mission briefs handed to a spawned agent.
 *
 * Split out of agent-wrapper.ts on the staffing-fence task: composing the fence
 * pushed that file past the 400-line split threshold, and these two builders are
 * the most separable thing in it — pure text construction with no authority, no
 * store and no I/O. Moved verbatim; the only edit is the export keyword on
 * `mission`, which agent-wrapper.ts now imports rather than declares.
 *
 * The text is advisory. Nothing an agent reads here grants it a capability: the
 * daemon's decoder remains the sole payload authority, and every refusal the
 * agent meets carries a stable reason code from the layer that refused.
 */

/** Exported for its text contract: the agent learns the release payload shape from here. */
export function codeMission(
  workItemId: string, nodeRef: string, expiresAt: string, brief: NodeMission,
  hints: { accept: JsonObject | null; submit: JsonObject | null },
): string {
  const lines = [
    `You are a moe-next coding agent. You hold the durable claim on code node "${nodeRef}"`,
    `(work item "${workItemId}") until ${expiresAt}. TASK — ${brief.title}:`,
    brief.instructions,
    `Work in the directory ${brief.workspace} (your working directory). Verify by running:`,
    `${brief.test} — it must exit 0 before you report anything as done.`,
    "Then record your submission durably over the moe-next MCP tools:",
    "1) call work_get_context and find the review.submit offer whose targetAggregateId is",
    `"${nodeRef}"; call review_submit with EXACTLY that offer's commandId and`,
    "expectedVersion, round = expectedVersion + 1, and empty findings if your test run",
    "was clean.",
    `2) finish with work_release with payload {"workItemId": "${workItemId}"} and no`,
    "other fields.",
    "Do NOT call integration_accept_output — acceptance is EARNED from the daemon's own",
    "verifier run, never from your report. The daemon will verify your submission and",
    "either accept it or record a verifier-test-failed round for the next attempt.",
    "Every refusal carries a stable reason code — read it, correct the request, never",
    "work around a refusal, and report what the daemon actually answered.",
  ];
  if (hints.submit !== null) {
    lines.push(`Suggested review.submit payload shape: ${JSON.stringify(hints.submit)}`);
  }
  return lines.join(" ");
}

/**
 * The PLANNING agent's brief — the two compiler steps, and the discipline the
 * seams enforce spelled out so the model does not learn it by refusal. No
 * payload hint parameter ON PURPOSE: the demo `payloadFor` table must never
 * reach this lane (a hard-coded demo graph proposed against a real PRD is the
 * exact race the compiler retires).
 */
export function compilerMission(
  workItemId: string, kind: string, expiresAt: string, goalRef: string | null,
  gateRef: Readonly<Record<string, unknown>> | null = null,
): string {
  const goal = goalRef === null ? "the goal your offer targets" : `goal "${goalRef}"`;
  const shared = [
    `You are a moe-next PLANNING agent. You hold the durable claim on work item`,
    `"${workItemId}" (command kind ${kind}) until ${expiresAt}.`,
    `First call work_get_context and find the daemon's offered command for your step;`,
    `then call documents_source_read with payload {"goalRef": "..."} for ${goal}`,
    "and read the FULL product requirements text it answers - it is the only product",
    "authority you have. Never invent a product decision the text does not state.",
  ];
  const step = kind === "product_contract.propose_revision"
    ? [
      "Draft a Product Contract revision from that text: requirements (each a single",
      "testable statement), criteria (each bound to one requirement, statement spelled",
      "so a verifier can falsify it), sourceDocumentDigests naming the PRD's",
      "contentSha256 from your read. Submit via the offered command with payload",
      "{\"draft\": {...}, \"goalRef\": \"...\"}. lineage must be null.",
      "The human approves your contract at Gate 1 before anything is planned from it.",
    ]
    : [
      // The daemon resolved the approved triple from durable state (the lane
      // port); embedding it is convenience, not authority — the dispatcher
      // re-verifies the gate and digest on every submit.
      ...(gateRef === null ? [] : [
        `The Gate 1 approval for this goal is gateRef ${JSON.stringify(gateRef)}.`,
      ]),
      "Submit the decomposition STRUCTURE for the Gate-1-approved contract: payload",
      "{\"gateRef\": {contractId, revisionDigest, revisionId}, \"goalRef\": \"...\",",
      "\"structure\": {completionNodeKey, nodes: [...]}}. Plan the SMALLEST COMPLETE",
      "SLICE: exactly ONE node in an INITIAL run (the daemon refuses more - growth is",
      "the expansion machinery's), its criterionIds covering every criterion of the",
      "approved revision. The daemon compiles and drives the chain itself; you submit",
      "structure, never authority bytes, hashes or witnesses.",
      "If the answer parks with RUN_POLICY_UNCLASSIFIABLE, report it and stop - the",
      "operator installs the policy tiers; never work around a policy park.",
    ];
  const close = [
    "Renew your claim with work_renew if you need longer, and finish by calling",
    `work_release with payload {"workItemId": "${workItemId}"}. Every refusal carries`,
    "a stable reason code - read it, correct the request, never work around a refusal,",
    "and report what the daemon actually answered.",
  ];
  return [...shared, ...step, ...close].join(" ");
}

export function mission(
  workItemId: string, kind: string, expiresAt: string, hint: JsonObject | null,
): string {
  const lines = [
    `You are a moe-next agent. You hold the durable claim on work item "${workItemId}"`,
    `(command kind ${kind}) until ${expiresAt}.`,
    "Use the moe-next MCP tools: first call work_get_context to see the board and find",
    `the daemon's offered command for your step (commandKind ${kind}); then call the`,
    `${kind.replaceAll(".", "_")} tool passing EXACTLY the offer's commandId,`,
    "expectedVersion and targetAggregateId plus a correlationId and the payload.",
    "Renew your claim with work_renew if you need longer, and finish by calling",
    `work_release with payload {"workItemId": "${workItemId}"}. Every refusal carries`,
    "a stable reason code — read it, correct the request, never work around a refusal,",
    "and report what the daemon actually answered.",
  ];
  if (hint !== null) {
    lines.push(`Suggested development payload for ${kind}: ${JSON.stringify(hint)}`);
  }
  return lines.join(" ");
}
