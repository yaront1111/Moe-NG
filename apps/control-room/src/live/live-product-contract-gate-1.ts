/**
 * THE PRODUCT CONTRACT GATE 1 READ CLIENT: POST /product-contract/gate-1/read with EXACTLY
 * { ref } and shape what the daemon says - verbatim - into GATE / REFUSED / ERROR. READS ONLY.
 *
 * WHAT THIS READ ACTUALLY SERVES, measured at HEAD rather than assumed: the GATE frame is
 * `{ gate, outcome: "GATE" }` and its `gate` is EXACTLY the four keys core stamps on a
 * satisfied Gate 1 - `{ advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest }`
 * (packages/core/src/product-contract/product-contract-acceptance-binding.ts:169-172). It is
 * a VERDICT on one named revision triple, not a dossier: no requirement, criterion, persona
 * or coverage state travels on it. The requirements and their criteria with coverage state
 * come from /documents/coverage/read, which already carries the triple this read needs.
 *
 * Discipline copied from live-document-coverage.ts: exact-key snapshots at every frame level,
 * a refusal carried out at its OWN layer, and any drift reddening the whole answer rather
 * than defaulting a field a human might act on. A decoder that tolerates an unexpected key
 * is exactly the mechanism that would stop detecting a stale daemon.
 */

const LIVE_GATE_1_LAYER = "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT";
const INVALID_RESPONSE_CODE = "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const PRODUCT_CONTRACT_GATE_1_READ_PATH = "/product-contract/gate-1/read";
const REQUEST_TIMEOUT_MS = 15_000;

const VIEW_KEYS = ["gate", "outcome"] as const;
const GATE_KEYS = ["advisoryOnly", "gate", "ok", "revisionDigest"] as const;

/** The immutable identity triple the daemon admits; the coverage frame carries it per contract. */
export interface ProductContractRevisionRefInput {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export type ProductContractGate1Outcome =
  | {
    readonly status: "GATE";
    /** Core stamps this on every satisfied Gate 1; the card carries it, never asserts it. */
    readonly advisoryOnly: true;
    readonly gate: "GATE_1";
    readonly revisionDigest: string;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

function refused(code: string, layer: string): ProductContractGate1Outcome {
  return Object.freeze({ code, layer, status: "REFUSED" as const });
}
function errored(code: string, layer: string): ProductContractGate1Outcome {
  return Object.freeze({ code, layer, status: "ERROR" as const });
}
function invalidResponse(): ProductContractGate1Outcome {
  return errored(INVALID_RESPONSE_CODE, LIVE_GATE_1_LAYER);
}

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-document-coverage.ts). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
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
 * The refusal envelopes this route can emit, each carried out at its own layer. The route
 * forwards an upstream code and layer UNTOUCHED, so the pair a reader sees names whoever
 * actually refused - core, the durable reader, the store, or the route's own two codes.
 */
function refusalFrom(response: unknown): ProductContractGate1Outcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED"
    && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED"
    || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError
    && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

/** Maps only an exact daemon GATE frame; every other answer is REFUSED or ERROR. PURE. */
export function mapProductContractGate1Answer(
  status: number, response: unknown,
): ProductContractGate1Outcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, VIEW_KEYS);
  if (record === null || record.outcome !== "GATE") return invalidResponse();
  const gate = exactDataRecord(record.gate, GATE_KEYS);
  if (gate === null || gate.advisoryOnly !== true || gate.gate !== "GATE_1" || gate.ok !== true
    || typeof gate.revisionDigest !== "string" || gate.revisionDigest.length === 0) {
    return invalidResponse();
  }
  return Object.freeze({
    advisoryOnly: true as const,
    gate: "GATE_1" as const,
    revisionDigest: gate.revisionDigest,
    status: "GATE" as const,
  });
}

/** POSTs exactly { ref } and maps the answer; `post` is injectable for tests. */
export async function readProductContractGate1(
  headers: Readonly<Record<string, string>>,
  ref: ProductContractRevisionRefInput,
  post?: (body: string) => Promise<Response>,
): Promise<ProductContractGate1Outcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(
    PRODUCT_CONTRACT_GATE_1_READ_PATH,
    { body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  ));
  let response: Response;
  try {
    response = await send(JSON.stringify({ ref: {
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    } }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_GATE_1_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapProductContractGate1Answer(response.status, body);
}
