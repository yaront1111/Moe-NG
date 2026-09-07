import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { DurableDecision } from "../http/http-contract.js";
import type { ProbeIntervalRecord } from "./probe-interval-record.js";

/**
 * The command edge for the OPERATOR-ONLY per-environment probe-interval write.
 *
 * WHAT THIS EDGE MAY DO: translate, and nothing else. It does NOT check a bound, a range, an
 * environment name or an integer -- `probe-interval-record.ts` owns all four and their FIXED
 * ORDER (environment first, then interval), so a second opinion here would give a doubly-invalid
 * request a whichever-ran-first answer and, worse, would drift from the SCHEDULER, which resolves
 * the very same interval through the very same record. One legal interval, one place that decides
 * it. It does not catch and re-wrap the record's refusals either: each already carries the code
 * AND the layer of the surface that answered, and restamping them would report a store fault as
 * an edge fault.
 *
 * WHY IT NEVER REACHES `requestOf`, the registry's shared request assembler: that path answers
 * malformed input from the bootstrap codec's roster, so a caller would be told INPUT_INVALID by a
 * surface that knows nothing about probe intervals. This edge is disjoint for the same reason the
 * environment pair and the five graph mutations are -- an exact request shape and a closed
 * refusal vocabulary the shared assembler cannot express.
 */

/** One result code, and it IS the state: an accepted write is the interval the caller named. */
export const PROBE_INTERVAL_EDGE_RESULT_CODE = "PROBE_INTERVAL_SET";

/**
 * The two fields this edge reads and NO others. Deliberately narrower than
 * `RuntimeCommandEnvelope`: the PROJECT is not here because it comes from the authenticated
 * principal, and the record is constructed against it by the composition root.
 */
export interface ProbeIntervalEdgeEnvelope {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProbeIntervalEdgeContext {
  readonly envelope: ProbeIntervalEdgeEnvelope;
  /** THE PORT. The edge holds no store, so there is no second write path it could take. */
  readonly intervals: ProbeIntervalRecord;
}

/**
 * THE WIRE IS JSON, so a field the record's signature types as `string` or `number` can arrive as
 * null, an object or absent entirely. This edge mints NO refusal of its own for that case, and
 * that is the whole trick: it substitutes a value the record's OWN admitters are documented to
 * reject -- `""` fails `admitEnvironmentName`'s `/^[a-z][a-z0-9-]{0,62}$/`, and `NaN` fails
 * `admitProbeInterval`'s `Number.isInteger` before either bound is consulted -- so the RECORD
 * answers, with the record's code at the record's layer.
 *
 * The alternative, minting `{code, layer}` here for a wrong-typed field, would put a second
 * author on the same refusal vocabulary; the day the record renamed a code, this edge would keep
 * emitting the old one and every arm asserting only a CODE would stay green while the two layers
 * disagreed about what happened. Nothing about the ORDER of the two checks is decided here
 * either: a request with both fields wrong is answered by whichever the record checks first.
 */
function admitted(payload: Readonly<Record<string, unknown>>): readonly [string, number] {
  const environment = payload["environment"];
  const intervalMs = payload["intervalMs"];
  return [
    typeof environment === "string" ? environment : "",
    typeof intervalMs === "number" ? intervalMs : Number.NaN,
  ];
}

/**
 * Serves `monitoring.set_probe_interval`. The record REPLACES any prior value for the
 * environment, so a resubmitted command converges on the interval the caller named rather than
 * accumulating; the disposition is DECIDED for the same reason the environment edge's is, and
 * for a stronger one here: an edge that decided for itself that a write "already happened" would
 * be an idempotency authority reimplemented outside the store that owns one.
 */
export function runProbeIntervalCommand(context: ProbeIntervalEdgeContext): DurableDecision {
  const [environment, intervalMs] = admitted(context.envelope.payload);
  const result = context.intervals.write(environment, intervalMs);
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
    // The interval table is not an effect: the write IS the decision, and there is no downstream
    // activation for a caller to bind to. The SCHEDULER picks the new value up on its own terms.
    effectId: null,
    resultCode: PROBE_INTERVAL_EDGE_RESULT_CODE,
  });
}
