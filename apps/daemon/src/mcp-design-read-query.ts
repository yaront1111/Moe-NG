import { createRuntimeError } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { DesignReadInput, DesignReadResult } from "./design/design-store.js";
import { readDesignRevision } from "./design/design-store.js";
import { authenticateHttpRequest } from "./http/http-adapter.js";
import type { Authenticator } from "./http/http-contract.js";

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
 * answered by this daemon at all. The wire payload therefore carries only `{goalRef}` plus an
 * optional `version`, and a payload naming `projectId` is refused as an unknown key.
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
const DESIGN_READ_PAYLOAD_KEYS: readonly string[] = Object.freeze(["goalRef", "version"]);

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
function decodePayload(payload: unknown): { goalRef: string; version?: number } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const request = payload as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!DESIGN_READ_PAYLOAD_KEYS.includes(key)) return null;
  }
  const goalRefDescriptor = Object.getOwnPropertyDescriptor(request, "goalRef");
  if (goalRefDescriptor === undefined) return null;
  const goalRef: unknown = goalRefDescriptor.value;
  if (typeof goalRef !== "string" || goalRef.length === 0) return null;
  if (!Object.hasOwn(request, "version")) return { goalRef };
  const versionDescriptor = Object.getOwnPropertyDescriptor(request, "version");
  if (versionDescriptor === undefined) return null;
  const version: unknown = versionDescriptor.value;
  // `Number.isSafeInteger` rejects NaN, Infinity, 1.5 and 2**53 in one predicate. A version
  // outside the safe range could never match a stored record, so admitting it would turn a
  // malformed request into a DESIGN_REVISION_ABSENT that reads like a real answer.
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  return { goalRef, version };
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
  return bytesOf(request.port.read(
    decoded.version === undefined
      ? { goalRef: decoded.goalRef, projectId: access.principal.projectId }
      : {
        goalRef: decoded.goalRef,
        projectId: access.principal.projectId,
        version: decoded.version,
      },
  ));
}
