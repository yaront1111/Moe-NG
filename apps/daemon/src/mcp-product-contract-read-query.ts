import { createHash } from "node:crypto";
import { createRuntimeError } from "@moe/contracts";
import { authenticateHttpRequest } from "./http/http-adapter.js";
import type { Authenticator } from "./http/http-contract.js";
import type { CompilerGateRef } from "./http/affordance-compiler-lane.js";
import type { ProductContractReadPort } from "./product-contract/product-contract-read-port.js";
import { JSON_READ_PAGE_MAX_BYTES, JSON_READ_PAGE_MAX_CHARS, jsonReadPage } from "./mcp-json-read-page.js";

export const PRODUCT_CONTRACT_READ_PAGE_MAX_BYTES = JSON_READ_PAGE_MAX_BYTES;
export const PRODUCT_CONTRACT_READ_PAGE_MAX_CHARS = JSON_READ_PAGE_MAX_CHARS;
export const PRODUCT_CONTRACT_READ_PAGE_FORMAT = "moe-product-contract-json-page/1";
const KEYS: readonly string[] = Object.freeze(["goalRef", "offset", "limit", "gateRef", "contentSha256"]);
const REF_KEYS: readonly string[] = Object.freeze(["contractId", "revisionDigest", "revisionId"]);
const DIGEST = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const bytesOf = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const invalid = (): Uint8Array => bytesOf({ error: createRuntimeError({ code: "INPUT_INVALID" }), ok: false });

interface ReadRequest {
  readonly goalRef: string;
  readonly offset: number;
  readonly limit: number;
  readonly paged: boolean;
  readonly gateRef?: CompilerGateRef;
  readonly contentSha256?: string;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).length <= 512;
}

function decode(value: unknown): ReadRequest | null {
  const input = record(value, KEYS);
  if (input === null || !id(input["goalRef"])) return null;
  const offset = Object.hasOwn(input, "offset") ? input["offset"] : 0;
  const limit = Object.hasOwn(input, "limit") ? input["limit"] : PRODUCT_CONTRACT_READ_PAGE_MAX_CHARS;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || limit > PRODUCT_CONTRACT_READ_PAGE_MAX_CHARS) return null;
  const hasRef = Object.hasOwn(input, "gateRef"), hasDigest = Object.hasOwn(input, "contentSha256");
  if (hasRef !== hasDigest || (offset > 0 && !hasRef)) return null;
  const base = { goalRef: input["goalRef"], offset, limit, paged: Object.keys(input).length > 1 };
  if (!hasRef) return base;
  const ref = record(input["gateRef"], REF_KEYS), digest = input["contentSha256"];
  if (ref === null || Object.keys(ref).length !== 3 || !id(ref["contractId"]) || !id(ref["revisionId"])
    || typeof ref["revisionDigest"] !== "string" || !DIGEST.test(ref["revisionDigest"])
    || typeof digest !== "string" || !DIGEST.test(digest)) return null;
  return { ...base, gateRef: { contractId: ref["contractId"], revisionId: ref["revisionId"],
    revisionDigest: ref["revisionDigest"] }, contentSha256: digest };
}

export interface ProductContractReadQueryRequest {
  readonly authenticator: Authenticator;
  readonly body: unknown;
  readonly credential: string | null;
  readonly port: ProductContractReadPort | undefined;
  readonly protocolVersion: unknown;
}

/** JSON text pages retain every field and even a single maximum-length statement.
 * Offsets count UTF-16 code units, as the PRD read does. JSON encodes split surrogate
 * pairs losslessly; concatenating decoded text pages restores the exact source JSON.
 * Both approval and projection are pinned before serving any continuation bytes. */
export function answerProductContractReadQuery(request: ProductContractReadQueryRequest): Uint8Array {
  if (request.port === undefined) return invalid();
  const access = authenticateHttpRequest(request.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return bytesOf(access);
  const input = decode(request.body);
  if (input === null) return invalid();
  const answer = request.port.read(input.goalRef);
  if (!answer.ok) return bytesOf(answer);
  const text = JSON.stringify(answer);
  const contentSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (input.gateRef !== undefined && (input.gateRef.contractId !== answer.gateRef.contractId
    || input.gateRef.revisionId !== answer.gateRef.revisionId
    || input.gateRef.revisionDigest !== answer.gateRef.revisionDigest
    || input.contentSha256 !== contentSha256)) {
    return bytesOf({ ok: false, code: "PRODUCT_CONTRACT_READ_REVISION_CHANGED", layer: "PRODUCT_CONTRACT_READ" });
  }
  if (input.offset > text.length) return invalid();
  if (!input.paged && encoder.encode(text).length <= PRODUCT_CONTRACT_READ_PAGE_MAX_BYTES) return encoder.encode(text);
  const result = jsonReadPage(text, input.offset, input.limit, {
    ok: true, format: PRODUCT_CONTRACT_READ_PAGE_FORMAT, gateRef: answer.gateRef, contentSha256,
  });
  if (result === null) {
    return bytesOf({ ok: false, code: "PRODUCT_CONTRACT_READ_PAGE_UNAVAILABLE", layer: "PRODUCT_CONTRACT_READ" });
  }
  return result;
}
