import type { RuntimeCommandKind } from "@moe/contracts";
import { CRITERION_APPROVE, CRITERION_VERIFY } from "./criterion-evidence/criterion-contracts.js";

import { EFFECT_ACTIVATE_COMMAND_KIND } from "./activation/activation-ingress-contracts.js";
import type { BootstrapCommandKind } from "./bootstrap/bootstrap-contracts.js";
import { CUTOVER_ACTIVATE_COMMAND_KIND } from "./cutover/cutover-activate-contracts.js";
import {
  ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_COMMAND_KIND_UNSET,
} from "./environment/environment-store.js";
import {
  PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
} from "./product-contract/product-contract-command-contracts.js";

import { APPROVAL_DECIDE_INTENT_COMMAND_KIND } from "./planning/approval-intent-contracts.js";
import { EXPANSION_REQUEST_KIND } from "./planning/expansion-request-contracts.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND,
} from "./evidence/foundation-verification-contracts.js";
import type { SessionCommandKind } from "./identity/session-contracts.js";
import { EVENT_STREAM_RESUME_COMMAND_KIND } from "./http/event-resume-command.js";
import { JOURNAL_APPEND_COMMAND_KIND } from "./journal/journal-contracts.js";

import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview/preview-contracts.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
} from "./product-contract/product-contract-gate-1-contract.js";
import { CONTINUATION_COMMAND_KIND } from "./recovery/continuation-command.js";
import { RECOVERY_COMPLETION_COMMAND_KIND } from "./recovery/recovery-completion-digest.js";
import type { ReviewCommandKind } from "./review/review-contracts.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import {
  RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
} from "./work/resource-confirm-released-command.js";
import { RESOURCE_RECONCILE_COMMAND_KIND } from "./work/resource-reconcile-command.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND,
  STEP_FINISH_COMMAND_KIND,
  STEP_START_COMMAND_KIND,
} from "./work/step-lifecycle-contracts.js";
import type { StepLifecycleCommandKind } from "./work/step-lifecycle-contracts.js";
import type { WorkClaimCommandKind } from "./work/work-claim-contracts.js";

/**
 * The command vocabulary: the static tables answering WHICH kind maps to what. A
 * kind declares its capability through one family map, the exact payload keys it
 * admits through PAYLOAD_KEYS, and whether it is operator-only through
 * OPERATOR_PRINCIPAL_KINDS. This module is the SINGLE place a kind's mapping lives:
 * `./daemon-command-registry.js` composes these tables into registry entries and
 * holds no mapping of its own, so a command is still added by registering an entry
 * rather than by editing the HTTP boundary or the composition root.
 *
 * `agentCapabilitiesFor` and `OPERATOR_CAPABILITIES` are re-exported by the registry
 * so every pre-existing consumer import path keeps resolving unchanged.
 */

export const CAPABILITIES = {
  ADMIN: "project.admin", GOAL: "goal.write", PLANNING: "planning.write",
  REVIEW: "review.write", WORK: "work.write",
} as const;

export const BOOTSTRAP_FAMILY: Readonly<Record<BootstrapCommandKind, string>> = Object.freeze({
  "approval.decide": CAPABILITIES.PLANNING, "goal.close": CAPABILITIES.GOAL,
  "repository.publish": CAPABILITIES.GOAL, "repository.bootstrap": CAPABILITIES.ADMIN,
  "goal.create": CAPABILITIES.GOAL, "goal.create_with_source": CAPABILITIES.GOAL,
  "plan.propose": CAPABILITIES.PLANNING,
  "policy.install": CAPABILITIES.ADMIN, "policy.validate": CAPABILITIES.ADMIN,
  "project.activate": CAPABILITIES.ADMIN, "project.bind_repository": CAPABILITIES.ADMIN,
  "project.register": CAPABILITIES.ADMIN, "provider.probe": CAPABILITIES.ADMIN,
});

export const REVIEW_FAMILY: Readonly<Record<ReviewCommandKind, string>> = Object.freeze({
  "escalation.decide": CAPABILITIES.REVIEW, "integration.accept_output": CAPABILITIES.REVIEW,
  "qualification.replan": CAPABILITIES.REVIEW, "review.submit": CAPABILITIES.REVIEW,
});

export const SESSION_FAMILY: Readonly<Record<SessionCommandKind, string>> = Object.freeze({
  "session.close": CAPABILITIES.ADMIN, "session.open": CAPABILITIES.ADMIN,
  "session.renew": CAPABILITIES.ADMIN,
});

export const WORK_FAMILY: Readonly<Record<WorkClaimCommandKind, string>> = Object.freeze({
  "work.claim": CAPABILITIES.WORK, "work.release": CAPABILITIES.WORK,
  "work.renew": CAPABILITIES.WORK,
});

export const STEP_FAMILY: Readonly<Record<StepLifecycleCommandKind, string>> = Object.freeze({
  [STEP_CHECKPOINT_COMMAND_KIND]: CAPABILITIES.WORK,
  [STEP_FINISH_COMMAND_KIND]: CAPABILITIES.WORK,
  [STEP_START_COMMAND_KIND]: CAPABILITIES.WORK,
});

/** The five graph MUTATION kinds. Already frozen in `RUNTIME_COMMAND_KINDS`, and deliberately NOT
 *  `BOOTSTRAP_COMMAND_KINDS` members: each is answered by its own durable planning service, so
 *  `runBootstrapCommand`'s table never sees one. `graph.get`/`graph.preview` are READS. */
export const GRAPH_MUTATION_COMMAND_KINDS = Object.freeze([
  "graph.approve",
  "graph.prepare_supersession",
  "graph.release_preparation",
  EXPANSION_REQUEST_KIND,
  "graph.supersede",
] as const satisfies readonly RuntimeCommandKind[]);

export type GraphMutationCommandKind = (typeof GRAPH_MUTATION_COMMAND_KINDS)[number];

/**
 * PLANNING for all five, DERIVED rather than picked by analogy: each moves the project's PLANNING
 * state — the active graph, a supersession preparation or a planning expansion hold — and
 * `approval.decide`, the approve-and-activate action `graph.approve` re-expresses on its own edge,
 * already demands exactly this capability.
 *
 * ADMIN WOULD BE THE WRONG FENCE AND NOT A TIGHTER ONE. ADMIN fences REACH, not humanity. What
 * makes the two authority-moving kinds human-only is OPERATOR_PRINCIPAL_KINDS below, which demands
 * the CONFIGURED operator identity no minted session can hold — the same reach/human split
 * `approval.decide` and `resource.confirm_released` use.
 */
export const GRAPH_FAMILY: Readonly<Record<GraphMutationCommandKind, string>> = Object.freeze({
  "graph.approve": CAPABILITIES.PLANNING,
  "graph.prepare_supersession": CAPABILITIES.PLANNING,
  "graph.release_preparation": CAPABILITIES.PLANNING,
  [EXPANSION_REQUEST_KIND]: CAPABILITIES.PLANNING,
  "graph.supersede": CAPABILITIES.PLANNING,
});

/**
 * The DAEMON-OWNED approval seam (task-6646f888), on its own table rather than inside
 * `BOOTSTRAP_FAMILY`: it is not a `BootstrapCommandKind` and must not become one. Bootstrap
 * membership carries a durable-SEQUENCE obligation (`bootstrap-durability.test.ts:138` asserts one
 * ordered request per kind), and this kind is answered by its own edge from an exact, disjoint
 * request shape -- the same reason `resource.reconcile` and `events.resume` stay outside it.
 *
 * PLANNING, matching `approval.decide`: it is the same authority on a different wire, so a
 * narrower or wider capability here would make the wire the fence instead of the principal.
 */
export const APPROVAL_INTENT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  [APPROVAL_DECIDE_INTENT_COMMAND_KIND]: CAPABILITIES.PLANNING,
});

/**
 * The PRD compiler lane. PLANNING capability for all four, matching the intent
 * seam's rationale: contract authorship and decomposition are planning acts on
 * their own wires.  additionally rides the operator fence
 * and the MCP exclusion - the capability is not the human gate.
 */
export const COMPILER_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  [PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND]: CAPABILITIES.PLANNING,
  [PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND]: CAPABILITIES.PLANNING,
  [PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND]: CAPABILITIES.PLANNING,
  [PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND]: CAPABILITIES.PLANNING,
});

/** REVIEW capability, on its own table: REVIEW_FAMILY membership would set review:true
 *  and dispatch this kind to runReviewCommand. Family membership is not the human gate. */
export const PREVIEW_FAMILY: Readonly<Record<typeof PREVIEW_DECIDE_COMMAND_KIND, string>> =
  Object.freeze({ [PREVIEW_DECIDE_COMMAND_KIND]: CAPABILITIES.REVIEW });
export const CRITERION_FAMILY = Object.freeze({ [CRITERION_APPROVE]: CAPABILITIES.ADMIN, [CRITERION_VERIFY]: CAPABILITIES.ADMIN });
export const REPOSITORY_RECOVERY_FAMILY = Object.freeze({ "repository.recover": CAPABILITIES.ADMIN });

/** ADMIN fences REACH -- it keeps scoped agent sessions out. It is NOT the human gate: what
 *  makes these two human-only is OPERATOR_PRINCIPAL_KINDS below, plus the MCP exclusion
 *  `mcp-tool-allowlist.js` DERIVES from that same set. Same reach/human split as
 *  `resource.confirm_released`. A reader who mistakes this line for the human fence will
 *  later hand an ADMIN agent a variable the deploy delivers to a production process. */
export const ENVIRONMENT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  [ENVIRONMENT_COMMAND_KIND_SET]: CAPABILITIES.ADMIN,
  [ENVIRONMENT_COMMAND_KIND_UNSET]: CAPABILITIES.ADMIN,
});

export type WiredCommandKind =
  | "repository.recover"
  | typeof CRITERION_APPROVE | typeof CRITERION_VERIFY
  | BootstrapCommandKind | GraphMutationCommandKind
  | typeof APPROVAL_DECIDE_INTENT_COMMAND_KIND
  | typeof PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND
  | typeof PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND
  | typeof PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND
  | typeof PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND
  | typeof PREVIEW_DECIDE_COMMAND_KIND
  | typeof CUTOVER_ACTIVATE_COMMAND_KIND
  | typeof ENVIRONMENT_COMMAND_KIND_SET | typeof ENVIRONMENT_COMMAND_KIND_UNSET
  | ReviewCommandKind | SessionCommandKind | WorkClaimCommandKind
  | typeof CONTINUATION_COMMAND_KIND | typeof EFFECT_ACTIVATE_COMMAND_KIND
  | typeof EVENT_STREAM_RESUME_COMMAND_KIND
  | typeof FOUNDATION_DISPATCH_COMMAND_KIND | typeof FOUNDATION_VERIFICATION_COMMAND_KIND
  | typeof JOURNAL_APPEND_COMMAND_KIND | typeof PRODUCT_CONTRACT_GATE_1_COMMAND_KIND
  | typeof RECOVERY_COMPLETION_COMMAND_KIND
  | typeof RESOURCE_CONFIRM_RELEASED_COMMAND_KIND | typeof RESOURCE_RECONCILE_COMMAND_KIND
  | StepLifecycleCommandKind;

/** The capability tables, searched in order and named ONCE -- no count in this sentence, because
 *  the number rotted twice. `daemon-command-families.js` reads the same list, so an entry's
 *  demanded capability and an agent's granted set can never come from different tables. A table
 *  that is NOT listed here is dead: `familyCapabilityOf` walks only this array and its kinds
 *  would resolve to a null capability. */
const FAMILY_TABLES: readonly Readonly<Record<string, string | undefined>>[] = Object.freeze([
  APPROVAL_INTENT_FAMILY, BOOTSTRAP_FAMILY, COMPILER_FAMILY, ENVIRONMENT_FAMILY, GRAPH_FAMILY,
  PREVIEW_FAMILY, REVIEW_FAMILY, SESSION_FAMILY, WORK_FAMILY, CRITERION_FAMILY,
  REPOSITORY_RECOVERY_FAMILY,
]);

/** The capability the kind's family demands, or null when no family claims the kind. */
export function familyCapabilityOf(kind: string): string | null {
  for (const table of FAMILY_TABLES) {
    const capability = table[kind];
    if (capability !== undefined) return capability;
  }
  return null;
}

export function agentCapabilitiesFor(kind: string): readonly string[] | null {
  if (kind === CRITERION_APPROVE || kind === CRITERION_VERIFY || kind === "repository.recover") return null;
  // Human wire: never staffable, whatever its family capability says.
  if (kind === PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND) return null;
  if (kind === PREVIEW_DECIDE_COMMAND_KIND) return null;
  if (kind === "node.deliver") {
    return Object.freeze([CAPABILITIES.REVIEW, CAPABILITIES.WORK]);
  }
  if (kind === EFFECT_ACTIVATE_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // Dispatching the attempt an agent already holds is work authority: the human gate on
  // this path is the launcher's own boundary admission, not a wider capability.
  if (kind === FOUNDATION_DISPATCH_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // Verifying an attempt is work authority for the same reason: every input the verifier
  // trusts is server-side sealed state -- the recipe, the activation, the attempt record --
  // and the payload names which verification plus WHERE the candidate tree sits. That root
  // is bound byte for byte to the record's sealed input manifest before anything activates
  // (`bindCandidateTree`), so a WORK caller can name a location but never choose the tree
  // a verdict is minted over. The human gate here is recipe sealing, not a wider
  // capability, so ADMIN would fence reach without fencing anything real.
  if (kind === FOUNDATION_VERIFICATION_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // Resuming an interrupted attempt is work authority, not admin: the human-only
  // gate on this path is the runner's boundary admission, not a wider capability.
  if (kind === CONTINUATION_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // Appending a dead-end journal is WORK authority, not admin: the agent holding
  // the attempt's lease is exactly who records why an approach failed.
  if (kind === JOURNAL_APPEND_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // Reconciling the resources of the attempt an agent already holds is that attempt's
  // own authority, and design 312 admits the kind even from a FENCED attempt. The
  // safety here is not a wider capability: the payload cannot state an outcome, and
  // the scheduler reducers decide what an adapter report means.
  if (kind === RESOURCE_RECONCILE_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  // ADMIN IS THE REACH FENCE, NOT THE HUMAN-ONLY FENCE. A proven release is not the
  // attempt's own authority the way reconcile is: it clears a quarantine the attempt's
  // OWN uncertainty created, so WORK would let an attempt free itself. ADMIN keeps
  // scoped agent sessions out of reach; what actually makes this human-only is
  // membership in OPERATOR_PRINCIPAL_KINDS below, which demands the CONFIGURED
  // operator identity. A reader who mistakes this line for the human gate will later
  // weaken the principal check and hand an ADMIN agent a release it never proved.
  if (kind === RESOURCE_CONFIRM_RELEASED_COMMAND_KIND) {
    return Object.freeze([CAPABILITIES.ADMIN, CAPABILITIES.WORK]);
  }
  // Reporting a step boundary on the attempt an agent already holds is that attempt's
  // OWN authority -- the same attempt-as-authenticated-reporter grant journal.append and
  // resource.reconcile carry. ADMIN would fence reach without fencing anything real:
  // these payloads admit three keys each and cannot state truthClass, an ordering index
  // or a completed state, so the daemon decides every fact the record carries and there
  // is no wider capability left to gate.
  if (kind in STEP_FAMILY) return Object.freeze([CAPABILITIES.WORK]);
  if (kind === RECOVERY_COMPLETION_COMMAND_KIND) {
    return Object.freeze([CAPABILITIES.ADMIN, CAPABILITIES.WORK]);
  }
  // Mirrors recovery.complete exactly, and for the same reason: ADMIN fences REACH,
  // and what makes a Gate 1 approval human-only is the signed single-use session
  // presentation its payload carries, which an AGENT principal cannot satisfy.
  if (kind === PRODUCT_CONTRACT_GATE_1_COMMAND_KIND) {
    return Object.freeze([CAPABILITIES.ADMIN, CAPABILITIES.WORK]);
  }
  const family = familyCapabilityOf(kind);
  if (family === null) return null;
  return family === CAPABILITIES.WORK
    ? Object.freeze([CAPABILITIES.WORK])
    : Object.freeze([family, CAPABILITIES.WORK]);
}

/** The exact per-kind ingress allow-lists, SPLIT OUT to `./daemon-command-payload-keys.js` when
 *  this module crossed the 400-line hard cap, and re-exported here so no consumer import path
 *  changes and this stays the one module a reader opens for a mapping (task-a2409cba). */
export { PAYLOAD_KEYS } from "./daemon-command-payload-keys.js";

export const OPERATOR_CAPABILITIES: readonly string[] = Object.freeze([
  CAPABILITIES.ADMIN, CAPABILITIES.GOAL, CAPABILITIES.PLANNING,
  CAPABILITIES.REVIEW, CAPABILITIES.WORK,
]);

/** The HUMAN-ONLY fence: the registry compares the AUTHENTICATED principal against the
 *  daemon's CONFIGURED operator id, which no minted session can hold whatever its
 *  capabilities say. `resource.confirm_released` belongs here because a proven release
 *  is a human's evidence about the physical world; ADMIN above only fences reach. */
export const OPERATOR_PRINCIPAL_KINDS: ReadonlySet<WiredCommandKind> = new Set([
  CRITERION_APPROVE, CRITERION_VERIFY,
  "repository.recover",
  "approval.decide",
  // The one-way GA activation. ADMIN would fence reach only, and this is the act that makes v2
  // authoritative for good -- exactly the human-only class this set exists for. It is also why
  // the kind is excluded from the MCP roster: `daemon-command-registry.js` records that the
  // human-review witness contract holds only while the human-only kinds stay MCP-unreachable.
  CUTOVER_ACTIVATE_COMMAND_KIND,
  // The intent seam is the SAME human act on a different wire, so it takes the same seat. It also
  // fences itself -- it refuses without the registry-minted witness -- and both are wanted: this
  // one refuses before dispatch, that one refuses a dispatch that somehow arrived witness-less.
  APPROVAL_DECIDE_INTENT_COMMAND_KIND,
  // A material product question is ANSWERED by the human the product belongs to;
  // an agent presenting an answer would be the quiet invention the clarification
  // fence exists to refuse. MCP-excluded on the same standing contract.
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  // Deciding a product preview is the operator's own act; an agent presenting
  // APPROVE/REJECT would staff the human gate. MCP-excluded on the same standing.
  PREVIEW_DECIDE_COMMAND_KIND,
  "goal.close",
  // AN AGENT MUST NEVER SET AN ENVIRONMENT VARIABLE: one it could write is one the deploy then
  // delivers to a production process. The MCP roster EXCLUDES both kinds by deriving itself from
  // this very set (`mcp-tool-allowlist.js`), and that exclusion -- not the ADMIN capability
  // above -- is the fence; `agent-spawn-contract.js` HUMAN_ONLY_STEPS refuses the spawn side.
  ENVIRONMENT_COMMAND_KIND_SET,
  ENVIRONMENT_COMMAND_KIND_UNSET,
  // Publishing pushes the operator's repository to a remote they named; bootstrap CREATES one at
  // a path they supplied. Their own code, and MCP-unreachable like the approvals.
  "repository.publish", "repository.bootstrap",
  // The two graph kinds that MOVE authority: one makes a graph the running one, the other
  // replaces the running one. Both are the human's approve action on their own edge -- the seat
  // `approval.decide` is reserved for. The other three propose, release or request and activate
  // nothing, so none is human-only.
  "graph.approve",
  "graph.supersede",
  "integration.accept_output",
  RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
  "session.open",
]);
