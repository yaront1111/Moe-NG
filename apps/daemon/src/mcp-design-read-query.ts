import { createHash } from "node:crypto";
import { createRuntimeError } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { DesignReadInput, DesignReadResult } from "./design/design-store.js";
import { readDesignRevision } from "./design/design-store.js";
import { authenticateHttpRequest } from "./http/http-adapter.js";
import type { Authenticator } from "./http/http-contract.js";
import { JSON_READ_PAGE_MAX_BYTES, JSON_READ_PAGE_MAX_CHARS, jsonReadPage } from "./mcp-json-read-page.js";

/**
 * The design slice's read, answered over MCP as `design.read`.
 *
 * WHY THIS LIVES BESIDE `mcp-dispatch-port.ts` RATHER THAN INSIDE IT: that module is the
 * dispatch TABLE plus five inline answerers and already stands at 376 lines against the
 * 400-line split bar. `mcp-work-context-query.ts` set the precedent for lifting an answerer
 * out; this follows it, so the table keeps room for the kinds after this one.
 *
 * `projectId` IS READ OFF THE AUTHENTICATED PRINCIPAL, NEVER OFF THE PAYLOAD, and that is a
 * security property rather than a convenience. `DesignReadInput` needs a projectId, and a
 * caller who could supply one would hold a cross-project read primitive: `readDesignRevision`
 * matches the stored record's projectId against the INPUT, so a forged input would simply
 * agree with itself. `planning/graph-query.ts:13-18` states the same rule for `graph.get` —
 * the principal check is what stops a principal authenticated for another project from being
 * answered by this daemon at all. The wire payload carries `{goalRef}`, an optional `version`,
 * and paging fields; a payload naming `projectId` is refused as an unknown key.
 */

/** The design read, narrowed to one method and closed over its store by the composer. */
export interface DesignReadPort {
  read(input: DesignReadInput): DesignReadResult;
}

/**
 * The production port, closed over one store — the shape `createProductContractReadPort`
 * established. The composer owns the store's lifetime; this holds no other authority, so a
 * daemon that composes no design store simply passes `undefined` and the kind refuses.
 */
export function createDesignReadPort(options: {
  readonly store: SqliteEventStore;
}): DesignReadPort {
  return Object.freeze({
    read: (input: DesignReadInput): DesignReadResult => readDesignRevision(options.store, input),
  });
}

/**
 * The payload's whole vocabulary. A key outside this set is refused rather than ignored: an
 * ignored key lets a caller believe a filter was applied that never was.
 */
const DESIGN_READ_PAYLOAD_KEYS: readonly string[] = Object.freeze(["goalRef", "version", "offset", "limit", "contentSha256"]);
export const DESIGN_READ_PAGE_FORMAT = "moe-design-json-page/1";
/** The paging refusals' layer, declared once so the TASK-LV literal census resolves both sites. */
const DESIGN_READ_LAYER = "DESIGN_READ" as const;

const encoder = new TextEncoder();

function bytesOf(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** The port's generic shape refusal, byte-identical to the one every sibling answerer emits. */
function queryRefusal(): Uint8Array {
  return bytesOf({ error: createRuntimeError({ code: "INPUT_INVALID" }), ok: false });
}

/**
 * The decoded payload, or `null` for "refuse".
 *
 * `Object.getOwnPropertyDescriptor` rather than a plain read, for the reason
 * `planning/graph-query.ts:145-157` gives about its own body: the payload is attacker-
 * controlled wire input, so an INHERITED or ACCESSOR-BEARING `goalRef` must not answer for
 * the caller. A getter would otherwise run inside this daemon and could return a different
 * value on its second read than the one this function validated.
 */
interface DesignPageRequest {
  goalRef: string;
  version?: number;
  offset: number;
  limit: number;
  contentSha256?: string;
  paged: boolean;
}

function decodePayload(payload: unknown): DesignPageRequest | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const prototype: unknown = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const request = payload as Record<string, unknown>;
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== "string" || !DESIGN_READ_PAYLOAD_KEYS.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
  }
  const goalRefDescriptor = Object.getOwnPropertyDescriptor(request, "goalRef");
  if (goalRefDescriptor === undefined) return null;
  const goalRef: unknown = goalRefDescriptor.value;
  if (typeof goalRef !== "string" || goalRef.length === 0) return null;
  const offset = Object.hasOwn(request, "offset") ? request["offset"] : 0;
  const limit = Object.hasOwn(request, "limit") ? request["limit"] : JSON_READ_PAGE_MAX_CHARS;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > JSON_READ_PAGE_MAX_CHARS) return null;
  const result: DesignPageRequest = { goalRef, offset, limit,
    paged: ["offset", "limit", "contentSha256"].some((key) => Object.hasOwn(request, key)) };
  if (Object.hasOwn(request, "version")) {
    const version = request["version"];
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
    result.version = version;
  }
  if (Object.hasOwn(request, "contentSha256")) {
    const digest = request["contentSha256"];
    if (result.version === undefined || typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) return null;
    result.contentSha256 = digest;
  }
  if (offset > 0 && result.contentSha256 === undefined) return null;
  return result;
}

export interface DesignReadQueryRequest {
  readonly authenticator: Authenticator;
  readonly body: unknown;
  readonly credential: string | null;
  readonly port: DesignReadPort | undefined;
  readonly protocolVersion: unknown;
}

/**
 * Answer one `design.read`.
 *
 * ORDER IS THE BEHAVIOUR and it mirrors the sibling answerers: an absent port refuses before
 * anything else, then authentication, then payload shape. Authentication precedes the shape
 * check so an unidentified caller never learns whether a payload was well formed, and the
 * absent-port check precedes authentication because a daemon composed without design support
 * has no answer to give either way.
 */
export function answerDesignReadQuery(request: DesignReadQueryRequest): Uint8Array {
  if (request.port === undefined) return queryRefusal();
  const access = authenticateHttpRequest(
    request.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return bytesOf(access);
  const decoded = decodePayload(request.body);
  if (decoded === null) return queryRefusal();
  const answer = request.port.read(
    decoded.version === undefined
      ? { goalRef: decoded.goalRef, projectId: access.principal.projectId }
      : {
        goalRef: decoded.goalRef,
        projectId: access.principal.projectId,
        version: decoded.version,
      },
  );
  if (!answer.ok) return bytesOf(answer);
  const text = JSON.stringify(answer);
  const contentSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (decoded.contentSha256 !== undefined && decoded.contentSha256 !== contentSha256) {
    return bytesOf({ ok: false, code: "DESIGN_READ_REVISION_CHANGED", layer: DESIGN_READ_LAYER });
  }
  if (decoded.offset > text.length) return queryRefusal();
  if (!decoded.paged && encoder.encode(text).length <= JSON_READ_PAGE_MAX_BYTES) return encoder.encode(text);
  return jsonReadPage(text, decoded.offset, decoded.limit, {
    ok: true, format: DESIGN_READ_PAGE_FORMAT, version: answer.record.version, contentSha256,
  }) ?? bytesOf({ ok: false, code: "DESIGN_READ_PAGE_UNAVAILABLE", layer: DESIGN_READ_LAYER });
}
