/**
 * The PRD compiler's command vocabulary: the four kinds that turn a committed
 * PRD into an approvable plan without a hand-written slice spec.
 *
 * All four are LIVE — `propose_revision` (the writer: an agent submits a
 * Product Contract revision draft), `submit_decomposition` (the dispatcher: an
 * agent submits plan STRUCTURE and the daemon compiles + drives the chain),
 * and the clarification pair (`product-contract-clarification-service.ts`):
 * `ask_clarification` records an agent's MATERIAL question (core's materiality
 * is the only judge) and `answer_clarification` records the human's one durable
 * option choice. An open MATERIAL question withholds the Gate 1 approval
 * template, so a contract is never approved past an unanswered product
 * question.
 *
 * `answer_clarification` is a HUMAN act (the operator or a paired durable HUMAN
 * principal answers) and is excluded from the MCP roster on the same standing
 * contract as `approval.decide` — an agent transport must never present a human
 * answer.
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

/** The clarification kinds' exact ingress shapes. */
export const PRODUCT_CONTRACT_ASK_CLARIFICATION_PAYLOAD_KEYS = Object.freeze([
  "contractId", "options", "question",
] as const);
export const PRODUCT_CONTRACT_ANSWER_CLARIFICATION_PAYLOAD_KEYS = Object.freeze([
  "answerProjectionDigest", "clarificationId", "contractId",
] as const);

export const PRODUCT_CONTRACT_CLARIFICATION_UNBUILT_CODE =
  "PRODUCT_CONTRACT_CLARIFICATION_UNBUILT" as const;
