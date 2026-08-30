/**
 * The PRD compiler's command vocabulary: the four kinds that turn a committed
 * PRD into an approvable plan without a hand-written slice spec.
 *
 * Two are LIVE — `propose_revision` (the writer: an agent submits a Product
 * Contract revision draft) and `submit_decomposition` (the dispatcher: an agent
 * submits plan STRUCTURE and the daemon compiles + drives the chain). Two are
 * REGISTERED-BUT-REFUSING until the clarification lifecycle row lands, the
 * `cutover.activate` idiom: the roster stays independent of what is built, so an
 * advertised kind is never silently unserved.
 *
 * `answer_clarification` is a HUMAN act (the operator answers a material product
 * question) and is excluded from the MCP roster on the same standing contract as
 * `approval.decide` — an agent transport must never present a human answer.
 *
 * Payload rosters for the live kinds are SPREAD from their seams' own constants,
 * never retyped here.
 */

export const PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND =
  "product_contract.propose_revision" as const;
export const PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND =
  "product_contract.ask_clarification" as const;
export const PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND =
  "product_contract.answer_clarification" as const;
export const PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND =
  "planning.submit_decomposition" as const;

export const PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION =
  "moe-product-contract-compiler/1" as const;

/** The clarification kinds' ingress shapes, closed now so the wire is stable
 *  before the lifecycle lands; every dispatch refuses UNBUILT until then. */
export const PRODUCT_CONTRACT_ASK_CLARIFICATION_PAYLOAD_KEYS = Object.freeze([
  "contractId", "options", "question",
] as const);
export const PRODUCT_CONTRACT_ANSWER_CLARIFICATION_PAYLOAD_KEYS = Object.freeze([
  "answerProjectionDigest", "clarificationId", "contractId",
] as const);

export const PRODUCT_CONTRACT_CLARIFICATION_UNBUILT_CODE =
  "PRODUCT_CONTRACT_CLARIFICATION_UNBUILT" as const;
