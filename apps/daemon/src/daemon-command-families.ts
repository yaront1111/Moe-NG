import { ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND }
  from "./activation/activation-ingress-contracts.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap/bootstrap-contracts.js";
import { APPROVAL_DECIDE_INTENT_COMMAND_KIND }
  from "./planning/approval-intent-contracts.js";
import { EVENT_STREAM_RESUME_COMMAND_KIND } from "./http/event-resume-command.js";
import { SESSION_SCHEMA_VERSION } from "./identity/session-contracts.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION }
  from "./journal/journal-contracts.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "./product-contract/product-contract-gate-1-contract.js";
import { CONTINUATION_COMMAND_KIND } from "./recovery/continuation-command.js";
import { RECOVERY_COMPLETION_COMMAND_KIND, RECOVERY_COMPLETION_SCHEMA_VERSION }
  from "./recovery/recovery-completion-digest.js";
import { REVIEW_SCHEMA_VERSION } from "./review/review-contracts.js";
import { RESOURCE_CONFIRM_RELEASED_COMMAND_KIND }
  from "./work/resource-confirm-released-command.js";
import { RESOURCE_RECONCILE_COMMAND_KIND } from "./work/resource-reconcile-command.js";
import { STEP_LIFECYCLE_SCHEMA_VERSION } from "./work/step-lifecycle-contracts.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "./work/work-claim-contracts.js";
import {
  CAPABILITIES, GRAPH_FAMILY, REVIEW_FAMILY, SESSION_FAMILY, STEP_FAMILY, WORK_FAMILY,
  familyCapabilityOf, type WiredCommandKind,
} from "./daemon-command-vocabulary.js";
import { GRAPH_COMMAND_SCHEMA_VERSION } from "./daemon-command-graph-contracts.js";

/**
 * Which family answers a kind, and the two facts that follow from it: the request schema
 * version its codec pins and the capability its entry demands. Pure classification over
 * the vocabulary tables -- no store, no clock, no principal -- so a reader can settle
 * "what capability does this kind require" without reading a closure.
 *
 * `./daemon-command-registry.js` composes these facts into registry entries; the tables
 * themselves stay in `./daemon-command-vocabulary.js`, which remains the SINGLE place a
 * kind's mapping lives.
 */
export interface CommandFamilyFacts {
  readonly activation: boolean;
  /** The daemon-owned approval seam, answered by its own edge from an exact intent shape. */
  readonly approvalIntent: boolean;
  readonly confirmReleased: boolean;
  readonly continuation: boolean;
  readonly eventResume: boolean;
  /** One of the five graph MUTATION kinds, each answered by its own durable planning service. */
  readonly graph: boolean;
  readonly journal: boolean;
  /** The daemon-owned Gate 1 approval writer, answered by its own durable service. */
  readonly productContractGate1: boolean;
  readonly reconcile: boolean;
  readonly recovery: boolean;
  /** The capability the seam checks BEFORE the handler runs. */
  readonly requiredCapability: string;
  readonly review: boolean;
  /** The version stamped into the assembled request bytes for codec-backed families. */
  readonly schemaVersion: string;
  readonly session: boolean;
  readonly step: boolean;
  readonly work: boolean;
}

/** The family predicates, read once so the version and capability below agree with them. */
function membershipOf(kind: WiredCommandKind): Omit<
  CommandFamilyFacts, "requiredCapability" | "schemaVersion"
> {
  return {
    activation: kind === EFFECT_ACTIVATE_COMMAND_KIND,
    approvalIntent: kind === APPROVAL_DECIDE_INTENT_COMMAND_KIND,
    confirmReleased: kind === RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
    continuation: kind === CONTINUATION_COMMAND_KIND,
    eventResume: kind === EVENT_STREAM_RESUME_COMMAND_KIND,
    graph: kind in GRAPH_FAMILY,
    journal: kind === JOURNAL_APPEND_COMMAND_KIND,
    productContractGate1: kind === PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    reconcile: kind === RESOURCE_RECONCILE_COMMAND_KIND,
    recovery: kind === RECOVERY_COMPLETION_COMMAND_KIND,
    review: kind in REVIEW_FAMILY,
    session: kind in SESSION_FAMILY,
    step: kind in STEP_FAMILY,
    work: kind in WORK_FAMILY,
  };
}

function schemaVersionOf(member: ReturnType<typeof membershipOf>): string {
  if (member.graph) return GRAPH_COMMAND_SCHEMA_VERSION;
  if (member.productContractGate1) return PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION;
  return member.activation
    ? ACTIVATION_INGRESS_SCHEMA_VERSION
    : member.journal
      ? JOURNAL_APPEND_SCHEMA_VERSION
      : member.recovery
        ? RECOVERY_COMPLETION_SCHEMA_VERSION
        : member.review
          ? REVIEW_SCHEMA_VERSION
          : member.session
            ? SESSION_SCHEMA_VERSION
            : member.step
              ? STEP_LIFECYCLE_SCHEMA_VERSION
              : member.work ? WORK_CLAIM_SCHEMA_VERSION : BOOTSTRAP_SCHEMA_VERSION;
}

/**
 * ADMIN is the reach fence, NOT the human-only fence. `recovery.complete` is human-only
 * because its concrete session authority authenticates a signed, single-use HUMAN R3
 * step-up; an AGENT holding ADMIN reaches that gate and is refused there. A reader who
 * mistakes this function for the R3 fence will later weaken the approval check.
 */
function requiredCapabilityOf(
  kind: WiredCommandKind,
  member: ReturnType<typeof membershipOf>,
): string {
  if (member.activation || member.continuation || member.eventResume || member.journal
    || member.reconcile || member.step) {
    return CAPABILITIES.WORK;
  }
  if (member.confirmReleased || member.productContractGate1 || member.recovery) {
    return CAPABILITIES.ADMIN;
  }
  // Every remaining kind -- bootstrap, GRAPH, review, session and work-claim -- reads its
  // capability from the one table search `agentCapabilitiesFor` uses, so an entry's demanded
  // capability and an agent's granted set can never come from different tables.
  const family = familyCapabilityOf(kind);
  if (family === null) throw new Error(`command kind has no capability family: ${kind}`);
  return family;
}

/** Every family fact for one kind, derived from the vocabulary tables alone. */
export function commandFamilyFacts(kind: WiredCommandKind): CommandFamilyFacts {
  const member = membershipOf(kind);
  return Object.freeze({
    ...member,
    requiredCapability: requiredCapabilityOf(kind, member),
    schemaVersion: schemaVersionOf(member),
  });
}
