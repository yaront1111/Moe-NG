import { DurableStoreError } from "@moe/store";

import type {
  DocumentWorkServiceErrorCode,
  DocumentWorkServiceLayer,
  DocumentWorkServiceRefused,
} from "./document-work-service-contract.js";

export function refuse(
  code: DocumentWorkServiceErrorCode,
  layer: DocumentWorkServiceLayer,
): DocumentWorkServiceRefused {
  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    code,
    layer,
    ok: false,
    outcome: "REFUSED",
  });
}

export function durableStoreRefusal(error: unknown): DocumentWorkServiceRefused | null {
  return error instanceof DurableStoreError ? refuse(error.code, "DURABLE_STORE") : null;
}
