import { describeThrown } from "@moe/contracts";
import type { DiagnosticThrown } from "@moe/contracts";

import type { CommandDecisionPort, DecisionKey, DecisionPortResult } from "./http/http-contract.js";
import { refusalFor } from "./daemon-command-dispatch.js";

/**
 * A commit that failed on the DURABLE STORE — a locked database, disk I/O, a projection that
 * would not apply — becomes a 503 refusal frame to the caller, whichever transport carried
 * the command. That frame was the whole story: the control room showed the code, the seat
 * saw the bytes, and the daemon's own log said nothing, because the listener records only the
 * refusals IT makes and the MCP bridge reports only a port that THROWS. The observer carries
 * the fault host-side beside the unchanged refusal.
 */
export interface CommandStoreFault {
  /** The store's own code (`OUTCOME_UNKNOWN`, `PROJECTION_APPLY_FAILED`, …). */
  readonly code: string;
  readonly detail: string;
  readonly key: DecisionKey;
  readonly thrown: DiagnosticThrown;
}

export type CommandStoreFaultObserver = (fault: CommandStoreFault) => void;

export interface CommandDecisionPortOptions {
  /** Host-side disclosure of a store fault under a commit. Absent means silent, as before. */
  readonly onStoreFault?: CommandStoreFaultObserver;
}

/**
 * One translation for both halves. `refusalFor` still re-throws an unrecognised error — that
 * path is unchanged and each transport reports it — and a thrown domain refusal is a verdict,
 * not a fault. Only a refusal the store made is observed, decided by the RESULT rather than
 * by the error's class, so a subclass that answers 409 to a client bug is never reported as
 * the store failing. The observer runs inside its own fence: a broken log must not turn an
 * answered refusal into a throw.
 */
function contained(
  error: unknown, key: DecisionKey, observe: CommandStoreFaultObserver | undefined,
): DecisionPortResult {
  const result = refusalFor(error);
  if (observe !== undefined && result.outcome === "REFUSED"
    && result.refusal.layer === "DURABLE_STORE" && result.refusal.httpStatus === 503) {
    try {
      observe({
        code: result.refusal.code, detail: result.refusal.detail, key, thrown: describeThrown(error),
      });
    } catch {
      // The refusal is the contract; the observer does not get to change it.
    }
  }
  return result;
}

/**
 * The daemon's durable decision port: it runs the committed work and turns a thrown
 * domain refusal into a port refusal. It holds no command knowledge at all -- the commit
 * closure the registry hands it is the only thing that knows which service answers -- so
 * adding a command never touches this module.
 */
export function createCommandDecisionPort(
  options: CommandDecisionPortOptions = {},
): CommandDecisionPort {
  const observe = options.onStoreFault;
  return {
    decide(key, _requestDigest, commit): DecisionPortResult {
      try {
        return Object.freeze({ decision: commit(), outcome: "DECIDED" } as const);
      } catch (error) {
        return contained(error, key, observe);
      }
    },
    /** The async half. `await` inside the try is what makes a rejected handler promise a
     *  refusal instead of an unhandled rejection: a crash is not a refusal. */
    async decideAsync(key, _requestDigest, commit): Promise<DecisionPortResult> {
      try {
        return Object.freeze({ decision: await commit(), outcome: "DECIDED" } as const);
      } catch (error) {
        return contained(error, key, observe);
      }
    },
  };
}
