import { ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND }
  from "./activation/activation-ingress-contracts.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap/bootstrap-contracts.js";
import { CUTOVER_ACTIVATE_COMMAND_KIND } from "./cutover/cutover-activate-contracts.js";
import { APPROVAL_DECIDE_INTENT_COMMAND_KIND }
  from "./planning/approval-intent-contracts.js";
import {
  PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION,
  PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
} from "./product-contract/product-contract-command-contracts.js";
import { EVENT_STREAM_RESUME_COMMAND_KIND } from "./http/event-resume-command.js";
import { SESSION_SCHEMA_VERSION } from "./identity/session-contracts.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION }
  from "./journal/journal-contracts.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "./product-contract/product-contract-gate-1-contract.js";
import { PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_START_COMMAND_KIND }
  from "./preview/preview-contracts.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release/release-decide-contracts.js";
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
  CAPABILITIES, DESIGN_FAMILY, ENVIRONMENT_FAMILY, GRAPH_FAMILY, REVIEW_FAMILY, SESSION_FAMILY,
  STEP_FAMILY,
  WORK_FAMILY, familyCapabilityOf, type WiredCommandKind,
} from "./daemon-command-vocabulary.js";
import { GRAPH_COMMAND_SCHEMA_VERSION } from "./daemon-command-graph-contracts.js";
import { CRITERION_APPROVE, CRITERION_VERIFY, CRITERION_SCHEMA_VERSION } from "./criterion-evidence/criterion-contracts.js";

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
  readonly criterion: boolean;
  readonly activation: boolean;
  /** The daemon-owned approval seam, answered by its own edge from an exact intent shape. */
  readonly approvalIntent: boolean;
  /** The clarification pair - REGISTERED-BUT-REFUSING until the lifecycle lands. */
  readonly clarification: boolean;
  /** The compiler dispatcher: agent structure in, daemon-driven chain out. */
  readonly compilerDecompose: boolean;
  /** The Product Contract writer: agent revision draft in, durable commit out. */
  readonly compilerPropose: boolean;
  readonly confirmReleased: boolean;
  readonly continuation: boolean;
  /** The one-way GA activation, answered by its own service from a ports-bearing seam. */
  readonly cutover: boolean;
  /** The design authoring wire, answered by its own edge. The ONE SEAT kind in this batch: a
   *  planning agent submits it, so unlike its neighbours it carries no operator fence. It never
   *  reaches `requestOf` -- the design slice owns its own closed refusal vocabulary and would
   *  lose the code the assembler refused with. */
  readonly design: boolean;
  /** The two OPERATOR-ONLY environment-variable writes, answered by their own edge from an
   *  exact request shape. The SET payload carries a production secret, so this seam never
   *  reaches `requestOf`: a request record would put the value in durable command bytes. */
  readonly environment: boolean;
  readonly eventResume: boolean;
  /** One of the five graph MUTATION kinds, each answered by its own durable planning service. */
  readonly graph: boolean;
  readonly journal: boolean;
  /** The operator's product-preview verdict - REGISTERED-BUT-REFUSING until the runner lands. */
  readonly preview: boolean;
  /** The daemon-owned Gate 1 approval writer, answered by its own durable service. */
  readonly productContractGate1: boolean;
  readonly reconcile: boolean;
  readonly recovery: boolean;
  /** The operator's release decision, served by its own async entry. */
  readonly release: boolean;
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
    criterion: kind === CRITERION_APPROVE || kind === CRITERION_VERIFY,
    activation: kind === EFFECT_ACTIVATE_COMMAND_KIND,
    approvalIntent: kind === APPROVAL_DECIDE_INTENT_COMMAND_KIND,
    clarification: kind === PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND
      || kind === PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
    compilerDecompose: kind === PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
    compilerPropose: kind === PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
    confirmReleased: kind === RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
    continuation: kind === CONTINUATION_COMMAND_KIND,
    cutover: kind === CUTOVER_ACTIVATE_COMMAND_KIND,
    design: kind in DESIGN_FAMILY,
    environment: kind in ENVIRONMENT_FAMILY,
    eventResume: kind === EVENT_STREAM_RESUME_COMMAND_KIND,
    graph: kind in GRAPH_FAMILY,
    journal: kind === JOURNAL_APPEND_COMMAND_KIND,
    // AN EQUALITY WIDENED TO A PAIR, not a set membership: both preview kinds are in this
    // family. Narrowing it back to one kind still COMPILES and reds only in the family arm.
    preview: kind === PREVIEW_DECIDE_COMMAND_KIND || kind === PREVIEW_START_COMMAND_KIND,
    productContractGate1: kind === PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    reconcile: kind === RESOURCE_RECONCILE_COMMAND_KIND,
    recovery: kind === RECOVERY_COMPLETION_COMMAND_KIND,
    release: kind === RELEASE_DECIDE_COMMAND_KIND,
    review: kind in REVIEW_FAMILY,
    session: kind in SESSION_FAMILY,
    step: kind in STEP_FAMILY,
    work: kind in WORK_FAMILY,
  };
}

function schemaVersionOf(member: ReturnType<typeof membershipOf>): string {
  if (member.criterion) return CRITERION_SCHEMA_VERSION;
  if (member.graph) return GRAPH_COMMAND_SCHEMA_VERSION;
  if (member.productContractGate1) return PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION;
  if (member.clarification || member.compilerDecompose || member.compilerPropose) {
    return PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION;
  }
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
  // Stated AT the site, as `preview` is below: writing an environment variable demands ADMIN.
  // ADMIN fences REACH only -- `ENVIRONMENT_FAMILY` answers the same capability, and the two
  // must agree. What makes these two human-only is OPERATOR_PRINCIPAL_KINDS plus the MCP
  // exclusion derived from it, never this line.
  if (member.environment) return CAPABILITIES.ADMIN;
  // ADMIN for the same reason as the three above: it fences REACH, keeping scoped agent
  // sessions out. What makes `cutover.activate` human-only is OPERATOR_PRINCIPAL_KINDS, which
  // demands the CONFIGURED operator identity no minted session can hold.
  if (member.confirmReleased || member.cutover || member.productContractGate1
    || member.recovery) {
    return CAPABILITIES.ADMIN;
  }
  // Stated explicitly so the reason is readable AT the site: deciding a preview is a REVIEW
  // act. `PREVIEW_FAMILY` answers the same capability one line below; the two must agree, and
  // taking the branch here means a reader never has to open the vocabulary to learn why.
  if (member.preview) return CAPABILITIES.REVIEW;
  // Every remaining kind -- bootstrap, DESIGN, GRAPH, review, session and work-claim -- reads
  // its capability from the one table search `agentCapabilitiesFor` uses, so an entry's demanded
  // capability and an agent's granted set can never come from different tables. `design.submit`
  // takes NO branch above on purpose: a branch here would be a second place its capability is
  // decided, and the whole point of that kind is that the seat's granted set and the entry's
  // demanded one are the SAME PLANNING answer out of `DESIGN_FAMILY`.
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
