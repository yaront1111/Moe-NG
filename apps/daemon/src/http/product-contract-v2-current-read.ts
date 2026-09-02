/** The activated `/2` current Product Contract query and its project-bound HTTP edge. */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type {
  ProductContractCurrentRevisionSlotV2,
  ProductContractRevisionV2,
  ProductContractV2Refusal,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  admitV2ActiveInstallation,
  type CutoverV2NotActiveRefusal,
} from "../cutover/cutover-v2-authority.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { exactDataRecord } from "../documents/document-work-safe-value.js";
import {
  readCurrentProductContractRevisionV2,
  type ProductContractV2ReaderRefusal,
} from "../product-contract/product-contract-v2-reader.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const PRODUCT_CONTRACT_V2_CURRENT_QUERY_KIND =
  "product_contract.current_revision" as const;
export const PRODUCT_CONTRACT_V2_CURRENT_READ_PATH =
  "/v2/product-contract/current" as const;
const LAYER = "PRODUCT_CONTRACT_V2_CURRENT_READ" as const;
const REQUEST_KEYS = Object.freeze(["contractId"] as const);

export const PRODUCT_CONTRACT_V2_CURRENT_READ_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_CURRENT_READ_CAPABILITY_DENIED",
  "PRODUCT_CONTRACT_V2_CURRENT_READ_PROJECT_MISMATCH",
] as const);
type LocalCode = (typeof PRODUCT_CONTRACT_V2_CURRENT_READ_CODES)[number];

export interface ProductContractV2CurrentView {
  readonly outcome: "CURRENT";
  readonly revision: ProductContractRevisionV2;
  readonly slot: ProductContractCurrentRevisionSlotV2;
}
export interface ProductContractV2CurrentRefused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}
export type ProductContractV2CurrentReadResult =
  | ProductContractV2CurrentRefused
  | ProductContractV2CurrentView;

export interface ProductContractV2CurrentReadPort {
  readonly boundProjectId: string;
  readCurrent(contractId: string): ProductContractV2CurrentReadResult;
}

function local(code: LocalCode): ProductContractV2CurrentRefused {
  return Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });
}
function forward(
  refusal: ProductContractV2ReaderRefusal | ProductContractV2Refusal
    | CutoverV2NotActiveRefusal,
): ProductContractV2CurrentRefused {
  return Object.freeze({
    code: refusal.code, layer: refusal.layer, outcome: "REFUSED" as const,
  });
}

export function readProductContractV2Current(
  store: SqliteEventStore,
  projectId: string,
  contractId: string,
): ProductContractV2CurrentReadResult {
  const active = admitV2ActiveInstallation(store, { projectId });
  if (!active.ok) return forward(active);
  const current = readCurrentProductContractRevisionV2(store, { contractId, projectId });
  return current.ok
    ? Object.freeze({ outcome: "CURRENT" as const,
      revision: current.revision, slot: current.slot })
    : forward(current);
}

export function createProductContractV2CurrentReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): ProductContractV2CurrentReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readCurrent: (contractId: string) =>
      readProductContractV2Current(config.store, config.projectId, contractId),
  });
}

type ListenerCode =
  | "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID"
  | "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE";
export type ProductContractV2CurrentReadDispatch =
  | Readonly<{ body: HttpPortRefused | HttpRefused | ProductContractV2CurrentReadResult;
      httpStatus: number; kind: "REPLY" }>
  | Readonly<{ code: ListenerCode; kind: "LISTENER_REFUSAL" }>;

function requestedContractId(body: unknown): string | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const record = exactDataRecord(decoded.value, REQUEST_KEYS);
  const contractId = record?.["contractId"];
  return typeof contractId === "string" && contractId.length > 0 && contractId.length <= 512
    && Buffer.byteLength(contractId, "utf8") <= 512
    && contractId.trim() === contractId && !contractId.includes("\0")
    && contractId.isWellFormed() && contractId.normalize("NFC") === contractId
    ? contractId
    : null;
}

export function handleProductContractV2CurrentReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly productContractV2Current?: ProductContractV2CurrentReadPort;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): ProductContractV2CurrentReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" as const });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.PLANNING)) {
    return Object.freeze({
      body: local("PRODUCT_CONTRACT_V2_CURRENT_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY" as const,
    });
  }
  const port = dependencies.productContractV2Current;
  if (port === undefined) {
    return Object.freeze({
      code: "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE", kind: "LISTENER_REFUSAL" as const,
    });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({
      body: local("PRODUCT_CONTRACT_V2_CURRENT_READ_PROJECT_MISMATCH"),
      httpStatus: 200, kind: "REPLY" as const,
    });
  }
  const contractId = requestedContractId(request.body);
  if (contractId === null) {
    return Object.freeze({
      code: "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID",
      kind: "LISTENER_REFUSAL" as const,
    });
  }
  return Object.freeze({
    body: port.readCurrent(contractId), httpStatus: 200, kind: "REPLY" as const,
  });
}
