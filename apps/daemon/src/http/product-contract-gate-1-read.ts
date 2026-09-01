/**
 * The reachable consumer edge for P2.10a's Product Contract Gate 1 resolver
 * (task-8e62300c). A project-scoped read route: it names a revision triple and
 * answers with whatever the resolver derives from durable state alone.
 *
 * THIS MODULE ADJUDICATES NOTHING ABOUT AUTHORITY. Core admits the ref, the
 * resolver reads the durable approval and revision, and core validates the
 * gate; each answer travels out with the code and layer its owner stamped.
 * Collapsing an upstream refusal into a local code here would be
 * indistinguishable from not detecting it.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { admitProductContractRevisionRef } from "@moe/core";
import type { ProductContractGate1Result, ProductContractRefusal } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type {
  ProductContractGate1ResolveResult,
} from "../product-contract/product-contract-gate-1-resolver.js";
import {
  resolveProductContractGate1,
} from "../product-contract/product-contract-gate-1-resolver.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const PRODUCT_CONTRACT_GATE_1_READ_PATH = "/product-contract/gate-1/read" as const;

/**
 * PRIVATE ON PURPOSE. An exported `*_LAYER` constant is a rostered security
 * boundary owing its own coverage arms; this route declares no boundary of its
 * own beyond the two codes below, both of which are local facts about the
 * caller, never about authority.
 */
const PRODUCT_CONTRACT_GATE_1_READ_LAYER = "PRODUCT_CONTRACT_GATE_1_READ" as const;

/** Body keys this route accepts. A caller names work; it never presents authority. */
const REQUEST_KEYS = Object.freeze(["ref"]);

/**
 * ROUTE-LOCAL codes only, and there are exactly two: capability and project
 * binding are this route's OWN questions about its caller.
 *
 * There is deliberately no local "unreadable". Both durable readers are total —
 * a `DurableStoreError` leaves them as its own code at `DURABLE_STORE`, and any
 * other throw as `STORAGE_DEGRADED` at the reader's own layer — so a store
 * failure already arrives with a stable code and a refusing layer. A catch here
 * could only replace one of those with a local code, which is the collapse DoD 3
 * forbids.
 */
export const PRODUCT_CONTRACT_GATE_1_READ_CODES = Object.freeze([
  "PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED",
  "PRODUCT_CONTRACT_GATE_1_READ_PROJECT_MISMATCH",
] as const);

export type ProductContractGate1ReadCode = (typeof PRODUCT_CONTRACT_GATE_1_READ_CODES)[number];

export type ProductContractGate1ReadLayer = typeof PRODUCT_CONTRACT_GATE_1_READ_LAYER;

export interface ProductContractGate1View {
  readonly gate: Extract<ProductContractGate1Result, { readonly ok: true }>;
  readonly outcome: "GATE";
}

/**
 * The forwarding shape. `code` and `layer` are whatever their owner stamped —
 * this route's own two codes carry its private layer, and every other pair
 * belongs to the reader, the revision reader, the durable store or core.
 */
export interface ProductContractGate1Refused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export type ProductContractGate1ReadResult =
  | ProductContractGate1Refused
  | ProductContractGate1View;

export interface ProductContractGate1ReadPort {
  readonly boundProjectId: string;
  readGate(refValue: unknown): ProductContractGate1ReadResult;
}

function refusedLocally(code: ProductContractGate1ReadCode): ProductContractGate1Refused {
  return Object.freeze({
    code, layer: PRODUCT_CONTRACT_GATE_1_READ_LAYER, outcome: "REFUSED" as const,
  });
}

/** Forwards an upstream refusal untouched: only the transport discriminant is added. */
function forwarded(
  refusal: Exclude<ProductContractGate1ResolveResult, { readonly ok: true }> |
    ProductContractRefusal,
): ProductContractGate1Refused {
  return Object.freeze({
    code: refusal.code, layer: refusal.layer, outcome: "REFUSED" as const,
  });
}

/**
 * Reads Gate 1 for ONE caller-named revision triple. The caller shapes nothing
 * else: not the project, not the store, and — because the resolver's input has
 * no such field — not the gate, the grant, the principal or the moment.
 */
export function readProductContractGate1(
  store: SqliteEventStore, projectId: string, refValue: unknown,
): ProductContractGate1ReadResult {
  const admitted = admitProductContractRevisionRef(refValue);
  if (!admitted.ok) return forwarded(admitted);
  const resolved = resolveProductContractGate1(store, { projectId, ref: admitted.ref });
  return resolved.ok
    ? Object.freeze({ gate: resolved, outcome: "GATE" as const })
    : forwarded(resolved);
}

export function createProductContractGate1ReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): ProductContractGate1ReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readGate: (refValue: unknown): ProductContractGate1ReadResult =>
      readProductContractGate1(config.store, config.projectId, refValue),
  });
}

type ProductContractGate1ListenerCode =
  | "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID"
  | "LISTENER_PRODUCT_CONTRACT_GATE_1_UNAVAILABLE";

export type ProductContractGate1ReadDispatch =
  | { readonly body: HttpPortRefused | HttpRefused | ProductContractGate1ReadResult;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: ProductContractGate1ListenerCode; readonly kind: "LISTENER_REFUSAL" };

/** The exact-key body fence. A request names `ref` and nothing else. */
function requestedRef(body: unknown): { readonly ok: boolean; readonly ref?: unknown } {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return { ok: false };
  const record = decoded.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { ok: false };
  const keys = Object.keys(record as Readonly<Record<string, unknown>>);
  if (keys.length !== REQUEST_KEYS.length || keys[0] !== REQUEST_KEYS[0]) return { ok: false };
  return { ok: true, ref: (record as Readonly<Record<string, unknown>>)["ref"] };
}

export function handleProductContractGate1ReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly productContractGate1?: ProductContractGate1ReadPort | undefined;
  },
  request: {
    readonly body: unknown; readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): ProductContractGate1ReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: refusedLocally("PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.productContractGate1;
  if (port === undefined) {
    return Object.freeze({
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_UNAVAILABLE", kind: "LISTENER_REFUSAL",
    });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({
      body: refusedLocally("PRODUCT_CONTRACT_GATE_1_READ_PROJECT_MISMATCH"),
      httpStatus: 200, kind: "REPLY",
    });
  }
  const requested = requestedRef(request.body);
  if (!requested.ok) {
    return Object.freeze({
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
  }
  return Object.freeze({ body: port.readGate(requested.ref), httpStatus: 200, kind: "REPLY" });
}
