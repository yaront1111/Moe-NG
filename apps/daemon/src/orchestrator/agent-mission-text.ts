import type { JsonObject } from "@moe/contracts";

import {
  DESIGN_AGGREGATE_PREFIX, DESIGN_ENTITY_KEYS, DESIGN_JOURNEY_KEYS, DESIGN_NON_FUNCTIONAL_KEYS,
  DESIGN_REVISION_KEYS, DESIGN_ROUTE_KEYS, DESIGN_SCREEN_KEYS, DESIGN_SECTION_KEYS,
  MAX_DESIGN_TEXT,
} from "../design/design-contracts.js";
import { COMPILED_NODE_KEY_MAX_CHARS } from "../planning/compiled-authority-contracts.js";
import type { NodeMission } from "./agent-wrapper.js";
import { agentRoleForWorkspace } from "./agent-role-contract.js";

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
function readFacts(projectId: string | null, workspace: string | null = null): string {
  return `graph_get takes exactly {"projectId": "${projectId ?? "<your project id>"}"} and `
    + `nothing else. ${agentRoleForWorkspace(workspace).fileInstructions}`;
}

/**
 * THE PRD READ PROTOCOL, ONE DEFINITION, shared verbatim by every brief that pages the PRD.
 *
 * Lifted out of `compilerMission` byte-identically when the design brief needed the same
 * paragraph: a seat that stops at the first page silently designs against a TRUNCATED PRD and
 * cannot tell that it did, so the two briefs must not be free to drift into paraphrases of
 * each other. Copying the text would have made them look identical while allowing exactly that.
 */
function prdPaging(goal: string): readonly string[] {
  return [
    `Read the PRD for ${goal} with documents_source_read: payload {"goalRef": "...",`,
    "\"offset\": 0, \"limit\": 30000} answers one page (text, offset, totalLength, nextOffset)",
    "- follow nextOffset until null; a payload of only {\"goalRef\"} answers the whole text at",
    "once. Never invent a product decision the text does not state.",
  ];
}

/**
 * HOW A CLAIMING SEAT LETS GO, and why the version it releases at is not the obvious one.
 *
 * Shared by the two briefs whose SUBMIT takes their own step off the offer surface: measured
 * 2026-09-05, the compiler seat's post-submit re-read answered WORK_ITEM_UNKNOWN and it could
 * not release at all. A design submit flips the goal's rung from `design.submit` to
 * `planning.submit_decomposition` the same way, so the design seat meets the identical trap.
 */
function releaseAndRefuse(workItemId: string, projectId: string | null): readonly string[] {
  return [
    "Renew your claim with work_renew if you need longer, and finish by calling",
    `work_release with payload {"workItemId": "${workItemId}"}, targetAggregateId`,
    `"${workItemId}" and expectedVersion = the claimAggregateVersion your step shows in`,
    "work_get_context (re-read it right before releasing). If that re-read answers",
    "WORK_ITEM_UNKNOWN because your accepted submit moved the step off the surface, release",
    "with the claimAggregateVersion of your last successful read: a submit never moves the",
    "claim's own version. Every refusal carries",
    "a stable reason code - read it, correct the request, never work around a refusal,",
    "and report what the daemon actually answered.",
    RETRY_ON_CONFLICT,
    readFacts(projectId),
  ];
}

/**
 * WHAT A MISSION KNOWS ABOUT A GOAL'S DESIGN — three outcomes, and the third is the point.
 *
 * A seat that simply receives no design section cannot tell "the operator decided to plan
 * without one" from "the read failed", and a seat that cannot tell will guess. Modelling the
 * skip as its own variant rather than as an absent ref is what makes the guess impossible:
 * there is no value of this type that means "no design" ambiguously.
 *
 * SKIPPED mirrors the durable `DesignSkip` marker (design-contracts.ts:122) rather than
 * re-deciding what a skip is, and carries the operator's reason for the same purpose the
 * marker bounds it: an unexplained skip is a decision nobody can review later.
 */
export type DesignBrief =
  | {
    readonly entities: readonly string[];
    readonly outcome: "PRESENT";
    readonly ref: string;
    readonly screens: readonly string[];
  }
  | { readonly outcome: "SKIPPED"; readonly reason: string }
  | { readonly outcome: "ABSENT" };

/**
 * The design paragraph a PLANNING seat reads. Never empty: an omitted paragraph is precisely
 * the ambiguity `DesignBrief` exists to remove, so the ABSENT branch is stated out loud and an
 * unwired caller (`null`) is treated as ABSENT rather than as silence.
 *
 * Each branch is worded to be readable from the BYTES ALONE — no two share a phrase a seat
 * would have to disambiguate — because the only reader is a language model holding one string.
 */
function compilerDesignLines(design: DesignBrief | null): readonly string[] {
  if (design !== null && design.outcome === "PRESENT") {
    return [
      `A DESIGN EXISTS for this goal, submitted under design ref "${design.ref}". Read it with`,
      "design_read, payload {\"goalRef\": \"...\"} and nothing else: it answers the five sections",
      `${DESIGN_SECTION_KEYS.join(", ")} plus openDecisions. Plan the decomposition FROM it -`,
      "every screen and entity it draws must be implemented by some node, and each node's",
      "objective names the screens and entities that node implements.",
    ];
  }
  if (design !== null && design.outcome === "SKIPPED") {
    return [
      "NO DESIGN EXISTS for this goal BECAUSE THE DESIGN STEP WAS SKIPPED: the operator",
      `declared that this goal plans without one, stating "${design.reason}". This is a`,
      "decision, not a missing read - plan from the approved contract and the PRD alone, and",
      "do not wait for a design that is never coming.",
    ];
  }
  return [
    "NO DESIGN ACCOMPANIES THIS BRIEF, and the operator has not declared that it plans",
    "without one. Plan from the approved contract and the PRD alone; if one was submitted",
    "after you were staffed, design_read with payload {\"goalRef\": \"...\"} answers it.",
  ];
}

/**
 * The design paragraph a CODING seat reads. `null` is the one place it differs from ABSENT:
 * a node step's aggregate is a nodeRef and the wrapper cannot resolve it back to a goal, so a
 * null here means the caller knows nothing — and a claim about the design would be worse than
 * saying nothing at all. An explicit ABSENT is still stated out loud.
 */
function nodeDesignLines(design: DesignBrief | null): readonly string[] {
  if (design === null) return [];
  if (design.outcome === "SKIPPED") {
    return [
      `This goal plans WITHOUT a design: the operator declared it, stating "${design.reason}".`,
      "Implement exactly what your task states.",
    ];
  }
  if (design.outcome === "ABSENT") {
    return ["No design accompanies this brief. Implement exactly what your task states."];
  }
  // Listed only when non-empty: an empty list rendered inline reads as a dangling "draws ."
  // that a seat has to interpret, and interpreting is the failure this whole type prevents.
  const drawn = [
    ...(design.screens.length === 0 ? [] : [`screens ${design.screens.join(", ")}`]),
    ...(design.entities.length === 0 ? [] : [`entities ${design.entities.join(", ")}`]),
  ];
  return drawn.length === 0
    ? [
      `The design submitted under "${design.ref}" names no screens or entities yet, so cite`,
      "none: implement exactly what your task states and do not invent a screen the design",
      "does not draw.",
    ]
    : [
      `Your node implements part of the design submitted under "${design.ref}", which draws`,
      `${drawn.join(" and ")}. Name the ones your node implements in your report, and do not`,
      "invent a screen the design does not draw.",
    ];
}

/** Exported for its text contract: the agent learns the release payload shape from here. */
export function codeMission(
  workItemId: string, nodeRef: string, expiresAt: string, brief: NodeMission,
  hints: { accept: JsonObject | null; submit: JsonObject | null },
  projectId: string | null = null,
  design: DesignBrief | null = null,
): string {
  const lines = [
    `You are a moe-next coding agent. You hold the durable claim on code node "${nodeRef}"`,
    `(work item "${workItemId}") until ${expiresAt}. TASK — ${brief.title}:`,
    brief.instructions,
    ...nodeDesignLines(design),
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
    readFacts(projectId, brief.workspace),
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
  design: DesignBrief | null = null,
): string {
  const goal = goalRef === null ? "the goal your offer targets" : `goal "${goalRef}"`;
  const shared = [
    `You are a moe-next PLANNING agent. You hold the durable claim on work item`,
    `"${workItemId}" (command kind ${kind}) until ${expiresAt}.`,
    `First call work_get_context and find the daemon's offered command for your step.`,
    `The product authority is the PRD text and, once approved, the contract.`,
    ...prdPaging(goal),
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
      // THE DECOMPOSITION ARM ONLY. A design is submitted AFTER Gate 1 approves a contract,
      // so the propose_revision arm above runs at a moment when no design can exist yet and
      // a paragraph about one there would be noise the seat has to discount.
      ...compilerDesignLines(design),
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
  return [
    ...shared, ...step, ...operator, ...releaseAndRefuse(workItemId, projectId),
  ].join(" ");
}

/**
 * THE DESIGN SEAT'S BRIEF — the step between Gate 1 and the decomposition.
 *
 * The wrapper hands over the DESIGN AGGREGATE the surface offered (`design:<goalId>`), because
 * that is the only id the offer carries (`affordance-planning-offers.ts:179`). Both reads this
 * seat needs are keyed on the BARE goal ref, so the strip happens here rather than as a second
 * wrapper parameter a caller could pass inconsistently with the first.
 *
 * EVERY KEY NAME IS INTERPOLATED FROM THE CONTRACT ROSTERS, never retyped. `decodeDesignRevision`
 * compares by EXACT ARITY, so a brief naming a section the roster does not carry would read
 * perfectly while producing a seat whose every submit is refused DESIGN_SHAPE_INVALID — the two
 * would drift apart with both sides looking right.
 *
 * No payload-hint parameter, on `compilerMission`'s precedent: a hard-coded design proposed
 * against a real PRD is the same race the compiler retires.
 */
export function designMission(
  workItemId: string, kind: string, expiresAt: string, designRef: string | null,
  projectId: string | null = null,
): string {
  // An id that is not prefixed is NOT mangled — it is simply not a goal ref, and neither is a
  // bare `design:` with nothing after it. Both fall back to the generic phrase rather than
  // sending the seat to page the PRD for the empty goal.
  const goalRef = designRef !== null && designRef.startsWith(DESIGN_AGGREGATE_PREFIX)
    ? designRef.slice(DESIGN_AGGREGATE_PREFIX.length)
    : "";
  const goal = goalRef === "" ? "the goal your offer targets" : `goal "${goalRef}"`;
  const target = designRef === null
    ? "the targetAggregateId your offer names"
    : `targetAggregateId "${designRef}"`;
  return [
    `You are a moe-next DESIGN agent. You hold the durable claim on work item`,
    `"${workItemId}" (command kind ${kind}) until ${expiresAt}.`,
    `First call work_get_context and find the daemon's offered command for your step.`,
    "The product authority is the PRD text and the APPROVED Gate 1 contract. Call",
    "product_contract_read with payload {\"goalRef\": \"...\"}: it answers the APPROVED",
    "revision - gateRef, requirements, and criteria with their criterionIds and statements.",
    "Design the product those criteria describe; every criterion must be reachable through",
    "something you draw.",
    ...prdPaging(goal),
    `Submit via the offered command with ${target} and payload`,
    "{\"contractRef\": {...}, \"goalRef\": \"...\", \"revision\": {...}} - EXACTLY those three",
    "keys, and never name projectId, principalId, commandId, correlationId, decidedAt or",
    "expectedVersion inside the payload: those are server facts the daemon re-attaches from",
    "the envelope and the authenticated principal, and a payload naming one is refused at",
    "PAYLOAD_SHAPE before your submit is read. contractRef is the Gate 1 triple",
    "product_contract_read answered - contractId, revisionDigest, revisionId - and grants",
    "nothing: the daemon re-proves the approval from durable state on every submit, so it",
    "only says which revision you believe you designed against.",
    `The revision carries EXACTLY these ${String(DESIGN_REVISION_KEYS.length)} keys:`,
    `${DESIGN_REVISION_KEYS.join(", ")} - no more and no fewer, compared by exact arity.`,
    `The ${String(DESIGN_SECTION_KEYS.length)} design sections are`,
    `${DESIGN_SECTION_KEYS.join(", ")}, and openDecisions is REQUIRED and may be an empty`,
    `list. screens is a list of {${DESIGN_JOURNEY_KEYS.join(", ")}} whose screens are each`,
    `{${DESIGN_SCREEN_KEYS.join(", ")}}; componentList is a list of component names;`,
    `dataModel is a list of {${DESIGN_ENTITY_KEYS.join(", ")}}; apiSurface is a list of`,
    `{${DESIGN_ROUTE_KEYS.join(", ")}}; nonFunctional is ONE object`,
    `{${DESIGN_NON_FUNCTIONAL_KEYS.join(", ")}}. Every string in the revision is non-empty,`,
    `at most ${String(MAX_DESIGN_TEXT)} characters and free of NUL bytes.`,
    "The decomposition is planned FROM this design and each node cites the screens and",
    "entities it implements, so a screen you did not draw is a screen no node can build. If",
    "the contract genuinely leaves a design decision open, record it in openDecisions rather",
    "than guessing it into a screen.",
    ...releaseAndRefuse(workItemId, projectId),
  ].join(" ");
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
