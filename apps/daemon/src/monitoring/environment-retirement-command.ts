import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { DurableDecision } from "../http/http-contract.js";
import type { EnvironmentRetirementRecord } from "./environment-retirement-record.js";

/**
 * The command edge for the OPERATOR-ONLY environment retirement write.
 *
 * WHAT THIS EDGE MAY DO: translate, and nothing else. It does NOT check the environment's name
 * grammar, whether the environment exists, or which deployment generation retirement should be
 * scoped to -- `environment-retirement-record.ts` owns all three and their FIXED ORDER (grammar
 * first, then existence in the deploy ledger), so a second opinion here would give a doubly
 * invalid request a whichever-ran-first answer and, worse, would drift from the SWEEP, which
 * resolves the very same retirement through the very same record. One authority on what
 * "retired" means, one place that decides it. It does not catch and re-wrap the record's
 * refusals either: each already carries the code AND the layer of the surface that answered, and
 * restamping them would report a store fault as an edge fault.
 *
 * WHY IT NEVER REACHES `requestOf`, the registry's shared request assembler: that path answers
 * malformed input from the bootstrap codec's roster, so a caller would be told INPUT_INVALID by
 * a surface that knows nothing about environments or retirement. Disjoint for the same reason
 * the interval edge beside it is -- an exact request shape and a closed refusal vocabulary the
 * shared assembler cannot express.
 */

/** One result code, and it IS the state: an accepted write is the environment retired. */
export const ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE = "ENVIRONMENT_RETIRED";

/**
 * The one field this edge reads and NO others. Deliberately narrower than
 * `RuntimeCommandEnvelope`: the PROJECT is not here because it comes from the authenticated
 * principal, and the record is constructed against it by the composition root.
 */
export interface EnvironmentRetirementEdgeEnvelope {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EnvironmentRetirementEdgeContext {
  readonly envelope: EnvironmentRetirementEdgeEnvelope;
  /** THE PORT. The edge holds no store, so there is no second write path it could take. */
  readonly retirements: EnvironmentRetirementRecord;
}

/**
 * THE WIRE IS JSON, so a field the record's signature types as `string` can arrive as null, an
 * object or absent entirely. This edge mints NO refusal of its own for that case, and that is
 * the whole trick: it substitutes a value the record's OWN admitter is documented to reject --
 * `""` fails `admitEnvironmentName`'s `/^[a-z][a-z0-9-]{0,62}$/` -- so the RECORD answers, with
 * the record's code at the record's layer.
 *
 * The alternative, minting `{code, layer}` here for a wrong-typed field, would put a second
 * author on the same refusal vocabulary; the day the record renamed a code, this edge would keep
 * emitting the old one and every arm asserting only a CODE would stay green while the two layers
 * disagreed about what happened.
 */
function admitted(payload: Readonly<Record<string, unknown>>): string {
  const environment = payload["environment"];
  return typeof environment === "string" ? environment : "";
}

/**
 * Serves `monitoring.retire_environment`. The record is IDEMPOTENT while the environment stays
 * retired -- a resubmitted command converges on "retired through the generation the daemon
 * observed" rather than appending a second fact -- so the disposition is DECIDED for the same
 * reason the interval edge's is: an edge that decided for itself that a write "already happened"
 * would be an idempotency authority reimplemented outside the store that owns one.
 *
 * RETIREMENT IS NOT DESTRUCTION, and no code here makes it so. The record appends one fact and
 * touches neither the deploy ledger nor the probe ring, so an operator can still read the
 * environment's deploy receipts and its recorded samples afterwards; what stops is the SWEEP
 * arming new probes for it. A retirement also ENDS on its own terms -- a later successful deploy
 * to the same environment supersedes the observed generation -- which is why this edge takes no
 * "un-retire" and none is missing.
 */
export function runEnvironmentRetirementCommand(
  context: EnvironmentRetirementEdgeContext,
): DurableDecision {
  const result = context.retirements.write(admitted(context.envelope.payload));
  if (!result.ok) {
    // FORWARDED UNRESTAMPED. `result.layer` is the record's own value, read off the refusal
    // rather than typed here, so a caller is told which surface answered and this edge cannot
    // silently become that surface. The code doubles as the detail: `DomainRefusal` documents
    // the code as the floor for an authority that says no more, and the record's refusals carry
    // no prose -- which is also why no submitted value can ride out on this path.
    throw new DomainRefusal(result.code, result.layer, result.code);
  }
  return Object.freeze({
    commandId: context.envelope.commandId,
    disposition: "DECIDED" as const,
    // Retirement is not an effect: the write IS the decision, and there is no downstream
    // activation for a caller to bind to. The SWEEP picks it up on its own next tick.
    effectId: null,
    resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
  });
}
