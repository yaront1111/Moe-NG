import type { JsonObject } from "@moe/contracts";

import { COMPILED_NODE_KEY_MAX_CHARS } from "../planning/compiled-authority-contracts.js";
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

/**
 * The two facts every seat needs and no seat could deduce, appended to EVERY brief.
 *
 * A live planning seat burned its whole claim on these: told only
 * "EXPECTED_VERSION_CONFLICT" it had no version to resend at, so it swept versions upward and
 * wrote seven rejection rows into the decision ledger; and it guessed at graph_get's payload
 * until INPUT_INVALID, then tried to record a durable memory with a tool it does not have.
 * The refusal detail now NAMES the observed version (daemon-command-dispatch.ts `detailOf`),
 * which is what makes a single bounded retry possible — so the brief says to take it ONCE.
 */
const RETRY_ON_CONFLICT =
  "If a command is refused EXPECTED_VERSION_CONFLICT, its detail names actualVersion=<n>: "
  + "resend that one command ONCE with expectedVersion = n, then stop and report if it "
  + "refuses again.";

/**
 * The project id is the wrapper's to say: the MCP port carries none and no read a seat holds
 * answers it, so a brief that only said "<your project id>" left graph_get uncallable (a real
 * seat reported exactly that, 2026-09-05). The placeholder survives only for a caller that
 * did not name one.
 */
function readFacts(projectId: string | null): string {
  return `graph_get takes exactly {"projectId": "${projectId ?? "<your project id>"}"} and `
    + "nothing else. You have no file-write tool in this session: report findings in your "
    + "final message, do not try to write memories or files.";
}

/** Exported for its text contract: the agent learns the release payload shape from here. */
export function codeMission(
  workItemId: string, nodeRef: string, expiresAt: string, brief: NodeMission,
  hints: { accept: JsonObject | null; submit: JsonObject | null },
  projectId: string | null = null,
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
    RETRY_ON_CONFLICT,
    readFacts(projectId),
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
  instructions: string | null = null,
  projectId: string | null = null,
): string {
  const goal = goalRef === null ? "the goal your offer targets" : `goal "${goalRef}"`;
  const shared = [
    `You are a moe-next PLANNING agent. You hold the durable claim on work item`,
    `"${workItemId}" (command kind ${kind}) until ${expiresAt}.`,
    `First call work_get_context and find the daemon's offered command for your step.`,
    `The product authority is the PRD text and, once approved, the contract. Read the PRD for`,
    `${goal} with documents_source_read: payload {"goalRef": "...", "offset": 0, "limit": 30000}`,
    "answers one page (text, offset, totalLength, nextOffset) - follow nextOffset until null;",
    "a payload of only {\"goalRef\"} answers the whole text at once. Never invent a product",
    "decision the text does not state.",
  ];
  const step = kind === "product_contract.propose_revision"
    ? [
      "Draft a Product Contract revision from that text and submit it via the offered command",
      "with payload {\"draft\": {...}, \"goalRef\": \"...\"}. The draft carries EXACTLY these",
      "keys:",
      "authorRef (your principal id), contractId and revisionId (plain string ids you choose),",
      "lineage (lineage must be null), requirements: [{requirementId, statement,",
      "supersedesRequirementId: null}] (each a single testable statement), criteria:",
      "[{criterionId, requirementId, statement, supersedesCriterionId: null}] (each bound to",
      "one requirement, its statement spelled so a verifier can falsify it),",
      "retiredRequirementIds: [], retiredCriterionIds: [], and sourceDocumentDigests: an array",
      "of BARE lowercase sha256 hex strings - the contentSha256 documents_source_read answered",
      "for the PRD - never objects. Listing order does not matter; the daemon sorts.",
      "If the PRD leaves a MATERIAL product decision genuinely open (two readings that",
      "yield different criteria), do not guess: call product_contract_ask_clarification",
      "with {\"contractId\", \"question\", \"options\": [{optionId, label, projection:",
      "{criteria, requirements}} x2..64]} - each option a full candidate projection -",
      "then report and release; the human answers on the Gate 1 card. An IMMATERIAL",
      "refusal means decide it yourself and move on.",
      "The human approves your contract at Gate 1 before anything is planned from it.",
    ]
    : [
      // The daemon resolved the approved triple from durable state (the lane
      // port); embedding it is convenience, not authority — the dispatcher
      // re-verifies the gate and digest on every submit.
      ...(gateRef === null ? [] : [
        `The Gate 1 approval for this goal is gateRef ${JSON.stringify(gateRef)}.`,
      ]),
      "Call product_contract_read with payload {\"goalRef\": \"...\"}: it answers the",
      "APPROVED revision - gateRef, requirements, and criteria with their criterionIds and",
      "statements. Those ids are what your structure binds; read the PRD pages only where a",
      "criterion's statement needs its context.",
      "Submit the decomposition STRUCTURE for the Gate-1-approved contract: payload",
      "{\"gateRef\": {contractId, revisionDigest, revisionId}, \"goalRef\": \"...\",",
      "\"structure\": {completionNodeKey, nodes: [{nodeKey, objective, criterionIds,",
      "dependsOn}]}}. Plan the COMPLETE GRAPH as a dependency DAG: each criterion of",
      "the approved revision bound by a single node, none left unbound and none bound",
      "twice, and dependsOn naming the hard build order - a node lists the nodeKeys",
      "that must land before it. No self-edge, no unknown target, and nothing may",
      "depend on the completionNodeKey. Every node binds at least one criterion (a",
      "criterion-free join node is refused), a nodeKey is lowercase [a-z0-9-] of at most",
      `${String(COMPILED_NODE_KEY_MAX_CHARS)} characters, and listing order is not a plan fact:`,
      "the daemon sorts nodes, criterionIds and dependsOn itself. The daemon",
      "compiles and drives the chain itself and states every risk fact (capability,",
      "scopes, resources) from host policy; you submit the plan, never authority",
      "bytes, hashes, witnesses or host facts.",
      "If the answer parks with RUN_POLICY_UNCLASSIFIABLE, report it and stop - the",
      "operator installs the policy tiers; never work around a policy park.",
    ];
  const operator = instructions === null || instructions.trim() === "" ? [] : [
    "The operator's own instructions for this goal follow between the markers; honor them.",
    "When they describe a REPLAN, they carry the findings that exhausted the previous attempt:",
    "plan a DIFFERENT decomposition that addresses those findings, under NEW node keys.",
    `<<<OPERATOR INSTRUCTIONS\n${instructions.trim()}\nOPERATOR INSTRUCTIONS>>>`,
  ];
  const close = [
    "Renew your claim with work_renew if you need longer, and finish by calling",
    `work_release with payload {"workItemId": "${workItemId}"}, targetAggregateId`,
    `"${workItemId}" and expectedVersion = the claimAggregateVersion your step shows in`,
    "work_get_context (re-read it right before releasing). Every refusal carries",
    "a stable reason code - read it, correct the request, never work around a refusal,",
    "and report what the daemon actually answered.",
    RETRY_ON_CONFLICT,
    readFacts(projectId),
  ];
  return [...shared, ...step, ...operator, ...close].join(" ");
}

export function mission(
  workItemId: string, kind: string, expiresAt: string, hint: JsonObject | null,
  projectId: string | null = null,
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
    RETRY_ON_CONFLICT,
    readFacts(projectId),
  ];
  if (hint !== null) {
    lines.push(`Suggested development payload for ${kind}: ${JSON.stringify(hint)}`);
  }
  return lines.join(" ");
}
