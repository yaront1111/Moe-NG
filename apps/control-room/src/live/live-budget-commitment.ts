/**
 * The BUDGET-COMMITMENT read client: POSTs to task-80b6bf7c's
 * `/budget/commitment/read` and shapes what the daemon says — verbatim — into one
 * of three honest outcomes (COMMITMENT / REFUSED / ERROR).
 *
 * READ ONLY, and it DERIVES NOTHING. The commitment is built store-side by the
 * shared `budgetCommitmentMaterial` + `budgetCommitmentDigest` pair; a second
 * derivation here would be the single-builder violation the parent row exists to
 * avoid. This module's only job is to carry the answer across the wire without
 * losing what stamped it.
 *
 * Discipline copied from `live-planning-run.ts`:
 *  - `exactDataRecord`: an own-enumerable EXACT-key snapshot. A frame is accepted
 *    only when its key set is precisely the one this reader vouches for, so an
 *    extra or renamed field is a shape miss, never a silent pass.
 *  - refusals travel out at THEIR OWN layer, carried through unchanged rather
 *    than restamped into a client-local code that would hide which layer refused.
 *
 * The only outcomes this client OWNS are transport-failed and unreadable-frame.
 * Both are facts about this client, never about authority.
 */

const LIVE_BUDGET_COMMITMENT_LAYER_VALUE = "CONTROL_ROOM_LIVE_BUDGET_COMMITMENT";

export const LIVE_BUDGET_COMMITMENT_LAYER = LIVE_BUDGET_COMMITMENT_LAYER_VALUE;
export const BUDGET_COMMITMENT_INVALID_RESPONSE_CODE = "BUDGET_COMMITMENT_RESPONSE_INVALID";
export const BUDGET_COMMITMENT_TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";

/**
 * Spelled to match the landed daemon constant, verified in step 1 at HEAD
 * 2f177cc1: `apps/daemon/src/http/budget-commitment-read.ts:24` exports
 * `BUDGET_COMMITMENT_READ_PATH = "/budget/commitment/read"`. Copied from that
 * source, not from the plan's prose.
 */
export const BUDGET_COMMITMENT_READ_PATH = "/budget/commitment/read";

const REQUEST_TIMEOUT_MS = 15_000;

/** The exact key set of the route's success frame (BudgetCommitmentView on the wire). */
const COMMITMENT_KEYS = ["outcome", "ref"] as const;

export type BudgetCommitmentOutcome =
  | { readonly ref: string; readonly status: "COMMITMENT" }
  | { readonly code: string; readonly layer: string; readonly status: "REFUSED" }
  | { readonly code: string; readonly layer: string; readonly status: "ERROR" };

function refused(code: string, layer: string): BudgetCommitmentOutcome {
  return Object.freeze({ code, layer, status: "REFUSED" as const });
}

function errored(code: string, layer: string): BudgetCommitmentOutcome {
  return Object.freeze({ code, layer, status: "ERROR" as const });
}

function invalidResponse(): BudgetCommitmentOutcome {
  return errored(BUDGET_COMMITMENT_INVALID_RESPONSE_CODE, LIVE_BUDGET_COMMITMENT_LAYER_VALUE);
}

/**
 * An own-enumerable EXACT-key snapshot: the value must be a plain object whose
 * key set is precisely `expectedKeys`, every one an own, enumerable data
 * property. Anything else — a prototype, an array, a missing or extra key, an
 * accessor — returns null, so the caller never reads a field this reader has not
 * vouched for. (Copied verbatim from live-planning-run.ts.)
 */
function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/**
 * Recognises the refusal envelopes this route can emit and carries each out at
 * its OWN layer: the listener's two-key `{code, layer}` (a 400 invalid body or a
 * 503 uncomposed port) and the route's own three-key
 * `{code, layer, outcome:"REFUSED"}`, which carries BOTH the two route-local
 * codes and every upstream pair the derivation forwards. Any other answer is not
 * a refusal this reader can vouch for and returns null.
 */
function refusalFrom(response: unknown): BudgetCommitmentOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string"
    && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  return null;
}

/**
 * Maps one daemon answer. PURE — it performs no I/O, so every arm can drive it
 * directly rather than through a stub that could hand an object back unchanged.
 *
 * THE ORDERING IS THE CORRECTNESS. A refusal is recognised BEFORE the status
 * gate, because the route answers its own and every forwarded refusal at HTTP
 * 200 while listener faults arrive at 400 or 503. Gate on status first and a
 * 400/503 refusal is flattened into a generic invalid, losing the code and the
 * layer that named which boundary refused — and an arm asserting only "not ok"
 * would still pass, which is why this rule is written down rather than implied.
 */
export function mapBudgetCommitmentAnswer(
  status: number, response: unknown,
): BudgetCommitmentOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, COMMITMENT_KEYS);
  if (record === null || record.outcome !== "COMMITMENT"
    || typeof record.ref !== "string" || record.ref.length === 0) {
    return invalidResponse();
  }
  return Object.freeze({ ref: record.ref, status: "COMMITMENT" as const });
}

/**
 * POSTs `{runId}` to the daemon's budget-commitment read route and maps the
 * answer. The body is JSON of exactly `{runId}` because the route refuses any
 * extra field with LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID.
 *
 * `post` is injectable for tests; the default carries the authenticated header
 * set and its own deadline, so a daemon that accepts and never answers becomes a
 * mapped ERROR rather than a hung screen.
 */
export async function readBudgetCommitment(
  headers: Readonly<Record<string, string>>,
  runId: string,
  post?: (body: string) => Promise<Response>,
): Promise<BudgetCommitmentOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(BUDGET_COMMITMENT_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ runId }));
  } catch {
    return errored(BUDGET_COMMITMENT_TRANSPORT_FAILED_CODE, LIVE_BUDGET_COMMITMENT_LAYER_VALUE);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapBudgetCommitmentAnswer(response.status, body);
}
