import { CRITERION_APPROVE, CRITERION_APPROVE_KEYS, CRITERION_VERIFY, CRITERION_VERIFY_KEYS }
  from "./criterion-evidence/criterion-contracts.js";
import { EFFECT_ACTIVATE_COMMAND_KIND, EFFECT_ACTIVATE_PAYLOAD_KEYS }
  from "./activation/activation-ingress-contracts.js";
import { CUTOVER_ACTIVATE_COMMAND_KIND } from "./cutover/cutover-activate-contracts.js";
import {
  ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_COMMAND_KIND_UNSET,
} from "./environment/environment-store.js";
import {
  PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
} from "./product-contract/product-contract-command-contracts.js";
import { PRODUCT_CONTRACT_PROPOSE_PAYLOAD_KEYS }
  from "./product-contract/product-contract-propose-service.js";
import { SUBMIT_DECOMPOSITION_PAYLOAD_KEYS } from "./planning/compile-dispatcher.js";
import { APPROVAL_DECIDE_INTENT_COMMAND_KIND, APPROVAL_INTENT_PAYLOAD_KEYS }
  from "./planning/approval-intent-contracts.js";
import { EXPANSION_REQUEST_KIND, EXPANSION_REQUEST_PAYLOAD_KEYS }
  from "./planning/expansion-request-contracts.js";
import { FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_REQUEST_KEYS }
  from "./evidence/foundation-verification-contracts.js";
import {
  EVENT_STREAM_RESUME_COMMAND_KIND, EVENT_STREAM_RESUME_PAYLOAD_KEYS,
} from "./http/event-resume-command.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_PAYLOAD_KEYS }
  from "./journal/journal-contracts.js";
import { FOUNDATION_DISPATCH_PAYLOAD_KEYS } from "./daemon-foundation-command.js";
import {
  PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_DECIDE_PAYLOAD_KEYS,
} from "./preview/preview-contracts.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
} from "./product-contract/product-contract-gate-1-contract.js";
import { CONTINUATION_COMMAND_KIND, CONTINUATION_PAYLOAD_KEYS }
  from "./recovery/continuation-command.js";
import { RECOVERY_COMPLETE_PAYLOAD_KEYS, RECOVERY_COMPLETION_COMMAND_KIND }
  from "./recovery/recovery-completion-digest.js";
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
import type { WiredCommandKind } from "./daemon-command-vocabulary.js";
import { REPOSITORY_RECOVERY_PAYLOAD_KEYS } from "./repository/repository-recovery-contracts.js";

/**
 * WHICH EXACT PAYLOAD KEYS each wired kind admits, and nothing else about a kind.
 *
 * SPLIT OUT OF `./daemon-command-vocabulary.js` when that module crossed the 400-line hard cap
 * (task-a2409cba). The seam is RESPONSIBILITY, not line count: the vocabulary answers which
 * CAPABILITY a kind demands and whether it is OPERATOR-ONLY; this module answers what a caller
 * may NAME on the wire. `daemon-command-vocabulary.js` RE-EXPORTS `PAYLOAD_KEYS`, so every
 * existing import path keeps resolving and that module stays the one a reader opens for a
 * kind's mapping.
 *
 * THIS ROSTER IS THE HTTP INGRESS ALLOW-LIST (`http-command-ingress.ts:118-126`): an UNLISTED
 * key is refused INPUT_INVALID at PAYLOAD_SHAPE before any handler runs, so an absence here is
 * a STRUCTURAL guarantee rather than a downstream comparison. The registry asserts the ORDER of
 * each array, not merely its membership.
 *
 * The `WiredCommandKind` import below is TYPE-ONLY and therefore erased, so the vocabulary's
 * re-export does not create a runtime import cycle.
 */

export const PAYLOAD_KEYS: Readonly<Record<WiredCommandKind, readonly string[]>> =
  Object.freeze({
    [CRITERION_APPROVE]: CRITERION_APPROVE_KEYS,
    [CRITERION_VERIFY]: CRITERION_VERIFY_KEYS,
    "repository.recover": REPOSITORY_RECOVERY_PAYLOAD_KEYS,
    "approval.decide": ["activation", "command", "graphRevisionRef", "record", "runId"],
    // SPREAD from the seam's own constant, never retyped: the module compares the payload against
    // that list, so a second hand-written copy here would let the advertised roster and the
    // enforced one drift apart while both looked right.
    [APPROVAL_DECIDE_INTENT_COMMAND_KIND]: APPROVAL_INTENT_PAYLOAD_KEYS,
    [PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND]: SUBMIT_DECOMPOSITION_PAYLOAD_KEYS,
    [PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND]:
      PRODUCT_CONTRACT_ANSWER_CLARIFICATION_PAYLOAD_KEYS,
    [PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND]:
      PRODUCT_CONTRACT_ASK_CLARIFICATION_PAYLOAD_KEYS,
    [PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND]: PRODUCT_CONTRACT_PROPOSE_PAYLOAD_KEYS,
    [EVENT_STREAM_RESUME_COMMAND_KIND]: EVENT_STREAM_RESUME_PAYLOAD_KEYS,
    [CONTINUATION_COMMAND_KIND]: CONTINUATION_PAYLOAD_KEYS,
    [EFFECT_ACTIVATE_COMMAND_KIND]: EFFECT_ACTIVATE_PAYLOAD_KEYS,
    [RECOVERY_COMPLETION_COMMAND_KIND]: RECOVERY_COMPLETE_PAYLOAD_KEYS,
    [PRODUCT_CONTRACT_GATE_1_COMMAND_KIND]: PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
    [JOURNAL_APPEND_COMMAND_KIND]: JOURNAL_APPEND_PAYLOAD_KEYS,
    [FOUNDATION_DISPATCH_COMMAND_KIND]: FOUNDATION_DISPATCH_PAYLOAD_KEYS,
    [FOUNDATION_VERIFICATION_COMMAND_KIND]: FOUNDATION_VERIFICATION_REQUEST_KEYS,
    [RESOURCE_RECONCILE_COMMAND_KIND]: RESOURCE_RECONCILE_PAYLOAD_KEYS,
    [RESOURCE_CONFIRM_RELEASED_COMMAND_KIND]: RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS,
    [STEP_START_COMMAND_KIND]: STEP_START_PAYLOAD_KEYS,
    [STEP_FINISH_COMMAND_KIND]: STEP_FINISH_PAYLOAD_KEYS,
    [STEP_CHECKPOINT_COMMAND_KIND]: STEP_CHECKPOINT_PAYLOAD_KEYS,
    // CALLER INTENT ONLY, and one key wide by construction. `ActivateCutoverInput` names five
    // fields and four of them are SERVER facts the registry assembles -- projectId and
    // correlationId from authentication and the envelope, decidedAt and activatedAtEpochMs from
    // the daemon clock. `record` is the GO_ACTIVATE binding and the only thing a caller may
    // present, so an activation cannot name its own decision time or project.
    [CUTOVER_ACTIVATE_COMMAND_KIND]: ["record"],
    // THE ONLY PAYLOAD ON THIS BOARD THAT CARRIES A SECRET. `value` is admitted because the
    // operator must present one; NOTHING on the ingress path may echo it back -- not a refusal
    // detail, not the decision record, not a log line (`daemon-command-environment.js` carries
    // the canary that proves it). ORDERED, not merely membered: the registry asserts the order.
    [ENVIRONMENT_COMMAND_KIND_SET]: ["environment", "name", "value"],
    [ENVIRONMENT_COMMAND_KIND_UNSET]: ["environment", "name"],
    // CALLER INTENT ONLY, and the absences are the guarantee. `DesignSubmitInput` names nine
    // fields; six of them -- commandId, correlationId, decidedAt, expectedVersion, principalId
    // and projectId -- are SERVER facts the edge re-attaches from the envelope, the clock and
    // the authenticated principal, so a caller naming any of them is refused INPUT_INVALID at
    // PAYLOAD_SHAPE before the handler runs. `contractRef` IS admitted and grants NOTHING: the
    // store re-proves the Gate 1 approval from durable state on every submit
    // (`design/design-store.js:130`), so presenting a triple only says which one the seat
    // believes it authored against. `revision` stays `unknown` until `decodeDesignRevision`
    // narrows it -- this roster fences KEYS, never the shape inside them.
    "design.submit": ["contractRef", "goalRef", "revision"],
    "escalation.decide": ["decision", "escalationRef", "subjectRef"],
    "goal.close": ["closureWitness", "goalId", "zeroAuthorityWitness"],
    // PROSE ONLY. The goal, its planning run and its budget account are all derived from the
    // authenticated command identity, the project and principal come from authentication, and
    // project readiness is read from the durable activation — so `goalId`, `planningRunRef`,
    // `budgetAccountRef` and `witness` are absent here BY CONSTRUCTION: a caller naming one is
    // refused INPUT_INVALID at PAYLOAD_SHAPE before any handler runs.
    "goal.create": ["instructions", "title"],
    "goal.create_with_source": ["instructions", "source", "title"],
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
    [PREVIEW_DECIDE_COMMAND_KIND]: PREVIEW_DECIDE_PAYLOAD_KEYS,
    // RECOGNISED IN ORDER TO BE REFUSED, not accepted (task-4b9c394d). The daemon MINTS the
    // activation witness, so a well-behaved caller sends `{}`. `"witness"` stays listed because
    // this roster is the HTTP ingress ALLOW-LIST (http-command-ingress.ts:118-126): an UNLISTED
    // key is refused with a generic INPUT_INVALID at PAYLOAD_SHAPE before any handler runs,
    // which would make the specific, actionable ACTIVATION_WITNESS_CALLER_SUPPLIED @
    // DAEMON_INGRESS unreachable from the browser -- the one caller that most needs to be told
    // what it did wrong.
    "project.activate": ["witness"], "project.bind_repository": ["observation"],
    "project.register": ["owner"], "provider.probe": ["observation"],
    "repository.publish": ["approval", "goalId", "remoteUrl"],
    // `github` nests owner/name/visibility exactly as `observation` does above; `projectId` is
    // ABSENT BY CONSTRUCTION -- authenticated, so naming it is INPUT_INVALID at PAYLOAD_SHAPE.
    "repository.bootstrap": ["dir", "github", "productName", "profileVersion"],
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
