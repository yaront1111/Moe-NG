import type {
  CommandHandlerInput,
  DecisionKey,
  DecisionPortResult,
  DurableDecision,
} from "./http-contract.js";

/**
 * The ASYNC half of the command seam's vocabulary. Data and types only, and additive by
 * construction: every type in `./http-contract.js` keeps its exact shape, so the kinds
 * registered before this module existed are untouched by it.
 *
 * It lives beside `http-contract.ts` rather than inside it because that file measured 243
 * physical lines before this task and the epic's cap is per file.
 */

/**
 * A handler that answers with a promise. DISTINCT from `CommandHandler`, never a union
 * with it: the registry has to be able to tell the two apart BEFORE dispatch, and a union
 * would let a synchronous handler be registered as async and an async one as sync — the
 * second of which is exactly the failure this seam exists to make impossible.
 */
export type AsyncCommandHandler = (input: CommandHandlerInput) => Promise<DurableDecision>;

/**
 * The durable decision port's async counterpart. Optional on `CommandDecisionPort`, so
 * every port written before this module keeps typechecking and keeps behaving identically;
 * a port that does not implement it simply cannot serve an async entry, and the seam
 * refuses with `ASYNC_PORT_UNAVAILABLE_CODE` instead of inventing a decision.
 *
 * `commit` returns a promise, so the port owns REJECTION as well as replay: an async
 * handler whose promise rejects must come back as a refusal, never as an unhandled
 * rejection — a crash is not a refusal.
 */
export interface AsyncCommandDecisionPort {
  decideAsync(
    key: DecisionKey,
    requestDigest: string,
    commit: () => Promise<DurableDecision>,
  ): Promise<DecisionPortResult>;
}

/**
 * The seam's own refusal layer, in the daemon's `DAEMON_<AREA>` layer vocabulary. These
 * refusals are the seam's, not a port's, and naming the layer is what keeps them from
 * reading as a domain refusal that came up from below.
 */
export const DAEMON_COMMAND_SEAM = "DAEMON_COMMAND_SEAM" as const;

/**
 * Declared here, beside the seam's other vocabulary, so neither code can be minted at a
 * call site. Both are `PortRefusal` codes rather than `RuntimeError` codes: the wire error
 * registry is closed and lives in `@moe/contracts`, and a seam that mints its own runtime
 * error would be a second error language.
 */
export const ASYNC_ENTRY_REQUIRED_CODE = "COMMAND_ASYNC_ENTRY_REQUIRED" as const;
export const ASYNC_PORT_UNAVAILABLE_CODE = "COMMAND_ASYNC_PORT_UNAVAILABLE" as const;

/** Both refusals are decided facts about the wiring, so they carry one status. */
export const ASYNC_SEAM_REFUSAL_STATUS = 422;
