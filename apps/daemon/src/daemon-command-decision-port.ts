import type { CommandDecisionPort, DecisionPortResult } from "./http/http-contract.js";
import { refusalFor } from "./daemon-command-dispatch.js";

/**
 * The daemon's durable decision port: it runs the committed work and turns a thrown
 * domain refusal into a port refusal. It holds no command knowledge at all -- the commit
 * closure the registry hands it is the only thing that knows which service answers -- so
 * adding a command never touches this module.
 */
export function createCommandDecisionPort(): CommandDecisionPort {
  return {
    decide(_key, _requestDigest, commit): DecisionPortResult {
      try {
        return Object.freeze({ decision: commit(), outcome: "DECIDED" } as const);
      } catch (error) {
        return refusalFor(error);
      }
    },
    /** The async half. `await` inside the try is what makes a rejected handler promise a
     *  refusal instead of an unhandled rejection: a crash is not a refusal. */
    async decideAsync(_key, _requestDigest, commit): Promise<DecisionPortResult> {
      try {
        return Object.freeze({ decision: await commit(), outcome: "DECIDED" } as const);
      } catch (error) {
        return refusalFor(error);
      }
    },
  };
}
