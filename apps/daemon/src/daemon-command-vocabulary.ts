import type { RuntimeCommandKind } from "@moe/contracts";

import { EFFECT_ACTIVATE_COMMAND_KIND, EFFECT_ACTIVATE_PAYLOAD_KEYS }
  from "./activation/activation-ingress-contracts.js";
import type { BootstrapCommandKind } from "./bootstrap/bootstrap-contracts.js";
import { EXPANSION_REQUEST_KIND, EXPANSION_REQUEST_PAYLOAD_KEYS }
  from "./planning/expansion-request-contracts.js";
import { FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_REQUEST_KEYS }
  from "./evidence/foundation-verification-contracts.js";
import type { SessionCommandKind } from "./identity/session-contracts.js";
import {
  EVENT_STREAM_RESUME_COMMAND_KIND, EVENT_STREAM_RESUME_PAYLOAD_KEYS,
} from "./http/event-resume-command.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_PAYLOAD_KEYS }
  from "./journal/journal-contracts.js";
import { FOUNDATION_DISPATCH_PAYLOAD_KEYS } from "./daemon-foundation-command.js";
import { CONTINUATION_COMMAND_KIND, CONTINUATION_PAYLOAD_KEYS }
  from "./recovery/continuation-command.js";
import { RECOVERY_COMPLETE_PAYLOAD_KEYS, RECOVERY_COMPLETION_COMMAND_KIND }
  from "./recovery/recovery-completion-digest.js";
import type { ReviewCommandKind } from "./review/review-contracts.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import {
  RESOURCE_CONFIRM_RELEASED_COMMAND_KIND, RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS,
} from "./work/resource-confirm-released-command.js";
import { RESOURCE_RECONCILE_COMMAND_KIND, RESOURCE_RECONCILE_PAYLOAD_KEYS }
  from "./work/resource-reconcile-command.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND, STEP_CHECKPOINT_PAYLOAD_KEYS, STEP_FINISH_COMMAND_KIND,
  STEP_FINISH_PAYLOAD_KEYS, STEP_START_COMMAND_KIND, STEP_START_PAYLOAD_KEYS,
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
  "goal.create": CAPABILITIES.GOAL, "plan.propose": CAPABILITIES.PLANNING,
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

export type WiredCommandKind =
  | BootstrapCommandKind | GraphMutationCommandKind
  | ReviewCommandKind | SessionCommandKind | WorkClaimCommandKind
  | typeof CONTINUATION_COMMAND_KIND | typeof EFFECT_ACTIVATE_COMMAND_KIND
  | typeof EVENT_STREAM_RESUME_COMMAND_KIND
  | typeof FOUNDATION_DISPATCH_COMMAND_KIND | typeof FOUNDATION_VERIFICATION_COMMAND_KIND
  | typeof JOURNAL_APPEND_COMMAND_KIND | typeof RECOVERY_COMPLETION_COMMAND_KIND
  | typeof RESOURCE_CONFIRM_RELEASED_COMMAND_KIND | typeof RESOURCE_RECONCILE_COMMAND_KIND
  | StepLifecycleCommandKind;

/** The five capability tables, searched in order and named ONCE. `daemon-command-families.js`
 *  reads the same list, so an entry's demanded capability and an agent's granted set can never
 *  come from different tables. */
const FAMILY_TABLES: readonly Readonly<Record<string, string | undefined>>[] = Object.freeze([
  BOOTSTRAP_FAMILY, GRAPH_FAMILY, REVIEW_FAMILY, SESSION_FAMILY, WORK_FAMILY,
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
  const family = familyCapabilityOf(kind);
  if (family === null) return null;
  return family === CAPABILITIES.WORK
    ? Object.freeze([CAPABILITIES.WORK])
    : Object.freeze([family, CAPABILITIES.WORK]);
}

export const PAYLOAD_KEYS: Readonly<Record<WiredCommandKind, readonly string[]>> =
  Object.freeze({
    "approval.decide": ["activation", "command", "graphRevisionRef", "record", "runId"],
    [EVENT_STREAM_RESUME_COMMAND_KIND]: EVENT_STREAM_RESUME_PAYLOAD_KEYS,
    [CONTINUATION_COMMAND_KIND]: CONTINUATION_PAYLOAD_KEYS,
    [EFFECT_ACTIVATE_COMMAND_KIND]: EFFECT_ACTIVATE_PAYLOAD_KEYS,
    [RECOVERY_COMPLETION_COMMAND_KIND]: RECOVERY_COMPLETE_PAYLOAD_KEYS,
    [JOURNAL_APPEND_COMMAND_KIND]: JOURNAL_APPEND_PAYLOAD_KEYS,
    [FOUNDATION_DISPATCH_COMMAND_KIND]: FOUNDATION_DISPATCH_PAYLOAD_KEYS,
    [FOUNDATION_VERIFICATION_COMMAND_KIND]: FOUNDATION_VERIFICATION_REQUEST_KEYS,
    [RESOURCE_RECONCILE_COMMAND_KIND]: RESOURCE_RECONCILE_PAYLOAD_KEYS,
    [RESOURCE_CONFIRM_RELEASED_COMMAND_KIND]: RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS,
    [STEP_START_COMMAND_KIND]: STEP_START_PAYLOAD_KEYS,
    [STEP_FINISH_COMMAND_KIND]: STEP_FINISH_PAYLOAD_KEYS,
    [STEP_CHECKPOINT_COMMAND_KIND]: STEP_CHECKPOINT_PAYLOAD_KEYS,
    "escalation.decide": ["escalationRef", "subjectRef"],
    "goal.close": ["closureWitness", "goalId", "zeroAuthorityWitness"],
    "goal.create": ["budgetAccountRef", "goalId", "planningRunRef", "witness"],
    // THE FIVE GRAPH MUTATION ALLOW-LISTS: caller INTENT ONLY. Each service decodes an EXACT
    // request that ALSO carries commandId, correlationId, decidedAt, principalId and projectId,
    // every one a SERVER fact re-attached by `daemon-command-graph-contracts.js`. Their absence
    // here is the guarantee: the seam refuses an unlisted key STRUCTURALLY at PAYLOAD_SHAPE, so
    // "a caller cannot name the principal, the project or the decision time" holds by
    // construction rather than by five separate downstream comparisons.
    "graph.approve": ["activation", "command", "graphRevisionRef", "record", "runId"],
    "graph.prepare_supersession": ["approvedTargetRevisionRef", "goalRef"],
    "graph.release_preparation": ["expectedPreparationVersion", "generation", "goalRef"],
    [EXPANSION_REQUEST_KIND]: EXPANSION_REQUEST_PAYLOAD_KEYS,
    "graph.supersede": [
      "command", "expectedPredecessorRevisionRef", "expectedPreparationVersion", "generation",
      "goalRef", "record", "successorGraphContentHash", "successorRevisionRef",
    ],
    "integration.accept_output": ["receiptId", "subjectRef"],
    "plan.propose": ["commands", "runId"],
    "policy.install": ["slice"], "policy.validate": ["input"],
    "project.activate": ["witness"], "project.bind_repository": ["observation"],
    "project.register": ["owner"], "provider.probe": ["observation"],
    "qualification.replan": [
      "nodes", "subjectRef", "successorPlanRef", "supportedCanonicalizerVersions",
    ],
    "review.submit": ["findings", "packageItems", "round", "subjectRef"],
    "session.close": ["sessionId"],
    "session.open": ["capabilities", "credentialSha256", "expiresAt", "sessionId"],
    "session.renew": ["expiresAt", "sessionId"],
    "work.claim": ["expiresAt", "workItemId"], "work.release": ["workItemId"],
    "work.renew": ["expiresAt", "workItemId"],
  });

export const OPERATOR_CAPABILITIES: readonly string[] = Object.freeze([
  CAPABILITIES.ADMIN, CAPABILITIES.GOAL, CAPABILITIES.PLANNING,
  CAPABILITIES.REVIEW, CAPABILITIES.WORK,
]);

/** The HUMAN-ONLY fence: the registry compares the AUTHENTICATED principal against the
 *  daemon's CONFIGURED operator id, which no minted session can hold whatever its
 *  capabilities say. `resource.confirm_released` belongs here because a proven release
 *  is a human's evidence about the physical world; ADMIN above only fences reach. */
export const OPERATOR_PRINCIPAL_KINDS: ReadonlySet<WiredCommandKind> = new Set([
  "approval.decide",
  "goal.close",
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
