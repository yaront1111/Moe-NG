import { createRuntimeError } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";

/**
 * Pre-dispatch session screening for the Streamable HTTP adapter.
 *
 * NON-AUTHORITATIVE BY CONSTRUCTION. Everything here is a cheap screen that runs before the
 * SDK transport sees a request. It exists because the SDK exposes no authentication hook, so
 * wrapping `handleRequest` is the only place a refusal can guarantee zero dispatch. It is NOT
 * the authority on whether a command may run: proof-of-possession — a valid stolen bearer
 * without the client-key signature cannot authorize a command — stays daemon-side behind the
 * dispatch port, and BOTH transports funnel into that same daemon check. That shared funnel,
 * not any duplicated logic here, is what makes stdio and HTTP behave identically.
 *
 * The port is VALIDATE-ONLY on purpose. There is no open, renew, or rotate method, because the
 * daemon owns session lifecycle through its own `session.*` commands. This adapter validates a
 * presented credential and binds a transport-level id to whatever session the daemon reports;
 * it never mints a daemon session.
 *
 * This module depends on `@moe/contracts` and nothing else — no MCP SDK, no core. Errors are
 * built from the frozen runtime registry so codes, retryability, recovery commands, and
 * transport bindings are never invented locally.
 */

/** Header the MCP Streamable HTTP transport uses to carry the transport-level session id. */
export const MCP_SESSION_ID_HEADER = "mcp-session-id";

const BEARER_SCHEME = "bearer";

/** The only refusal codes a session port may select. Anything else fails closed. */
export const HTTP_AUTH_REFUSAL_CODES = Object.freeze([
  "AUTHENTICATION_FAILED",
  "CAPABILITY_DENIED",
  "SESSION_EXPIRED",
  "SESSION_REPLAYED",
] as const);

export type HttpAuthRefusalCode = (typeof HTTP_AUTH_REFUSAL_CODES)[number];

export interface HttpAuthAccepted {
  readonly ok: true;
  /** Opaque daemon-side principal identity. Never a credential. */
  readonly principalRef: string;
  /** Opaque daemon-side session identity. Survives credential rotation. */
  readonly sessionRef: string;
}

export interface HttpAuthRefused {
  readonly code: HttpAuthRefusalCode;
  readonly ok: false;
}

export type HttpAuthVerdict = HttpAuthAccepted | HttpAuthRefused;

export interface HttpSessionPort {
  /**
   * Re-checked on EVERY request. Callers must not memoise the result: revalidating each time
   * is exactly what makes a rotated or revoked credential die on the very next request.
   */
  validateBearer(credential: string): HttpAuthVerdict | Promise<HttpAuthVerdict>;
  bindSession(mcpSessionId: string, verdict: HttpAuthAccepted): Promise<void> | void;
  closeSession(mcpSessionId: string): Promise<void> | void;
}

export interface HttpSessionEntry<TAttachment> {
  /** Transport and server instances owned by this session, opaque to this module. */
  readonly attachment: TAttachment;
  /**
   * Epoch-millisecond stamp of the last request routed to this entry; the bind counts as the
   * first activity. Idle reaping reads it. Optional only because entries are also built by
   * hand outside this factory: an unstamped entry fails toward staying alive, never toward
   * being torn down. Every entry this registry mints carries one.
   */
  readonly lastActivityAt?: number;
  readonly sessionId: string;
  readonly verdict: HttpAuthAccepted;
}

/**
 * Adapter-owned routing table. The SDK transport is one-session-per-instance — it compares an
 * incoming id against a single instance field — so serving more than one client requires this
 * registry to pick the right instance before the transport is ever consulted.
 */
export interface HttpSessionRegistry<TAttachment> {
  bind(
    mcpSessionId: string,
    verdict: HttpAuthAccepted,
    attachment: TAttachment,
    boundAt?: number,
  ): void;
  delete(mcpSessionId: string): void;
  entries(): readonly HttpSessionEntry<TAttachment>[];
  get(mcpSessionId: string): HttpSessionEntry<TAttachment> | undefined;
  /** Re-stamps `lastActivityAt`. A touch for an id this registry does not hold is a no-op. */
  touch(mcpSessionId: string, at: number): void;
}

export function createHttpSessionRegistry<TAttachment>(): HttpSessionRegistry<TAttachment> {
  const sessions = new Map<string, HttpSessionEntry<TAttachment>>();
  return {
    bind(mcpSessionId, verdict, attachment, boundAt = Date.now()): void {
      sessions.set(
        mcpSessionId,
        Object.freeze({ attachment, lastActivityAt: boundAt, sessionId: mcpSessionId, verdict }),
      );
    },
    delete(mcpSessionId): void {
      sessions.delete(mcpSessionId);
    },
    entries(): readonly HttpSessionEntry<TAttachment>[] {
      return [...sessions.values()];
    },
    get(mcpSessionId): HttpSessionEntry<TAttachment> | undefined {
      return sessions.get(mcpSessionId);
    },
    touch(mcpSessionId, at): void {
      const entry = sessions.get(mcpSessionId);
      if (entry === undefined) return;
      // Entries are frozen, so a touch REPLACES rather than mutates; a reference captured
      // before the touch keeps its own stamp, which is fine — only the registry's copy is
      // ever consulted for idleness.
      sessions.set(mcpSessionId, Object.freeze({ ...entry, lastActivityAt: at }));
    },
  };
}

export type SessionScreenOutcome<TAttachment> =
  | {
      /**
       * The validated credential, handed back so callers never re-parse the header. It is a
       * SECRET: it may be forwarded to the daemon, and it must never be logged or serialised
       * into a response. Refusal outcomes deliberately carry nothing from the request.
       */
      readonly credential: string;
      readonly entry: HttpSessionEntry<TAttachment> | undefined;
      readonly kind: "accepted";
      readonly sessionId: string | null;
      readonly verdict: HttpAuthAccepted;
    }
  | { readonly error: RuntimeError; readonly kind: "refused" }
  | { readonly kind: "unknown-session"; readonly sessionId: string };

export interface SessionScreenInput<TAttachment> {
  readonly port: HttpSessionPort;
  readonly registry: HttpSessionRegistry<TAttachment>;
  readonly request: Request;
}

type ScreenRefusal = { readonly error: RuntimeError; readonly kind: "refused" };

function refuse(code: HttpAuthRefusalCode | "INPUT_INVALID"): ScreenRefusal {
  return { error: createRuntimeError({ code }), kind: "refused" };
}

/**
 * Exactly one `Bearer <token>` credential, or nothing. A second whitespace-separated token is
 * rejected rather than trimmed, so a credential can never be smuggled past the parser as
 * trailing junk. The returned value is used once and never stored or logged.
 */
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const parts = header.split(" ");
  if (parts.length !== 2) return null;
  const [scheme, credential] = parts;
  if (scheme?.toLowerCase() !== BEARER_SCHEME) return null;
  return credential !== undefined && credential.length > 0 ? credential : null;
}

/**
 * The MCP endpoint takes NO query parameters at all, so any query string is refused before the
 * credential is even read. This is deliberately stricter than screening credential-shaped
 * parameter names: name matching is a guessing game, whereas "this endpoint has no query
 * surface" is decidable, and it discharges the rule that credentials never appear in URLs —
 * URLs reach access logs, proxies, and referrers. The refusal names neither key nor value.
 */
function hasQueryParameters(request: Request): boolean {
  const separator = request.url.indexOf("?");
  return separator !== -1 && separator < request.url.length - 1;
}

function isRefusalCode(value: unknown): value is HttpAuthRefusalCode {
  return (HTTP_AUTH_REFUSAL_CODES as readonly string[]).includes(value as string);
}

/**
 * Screens one request. Ordering is the security property: query surface, then credential
 * shape, then the daemon verdict, then the session binding. Every branch that is not
 * `accepted` performs zero dispatch, because dispatch happens strictly after this returns.
 */
export async function screenRequest<TAttachment>(
  input: SessionScreenInput<TAttachment>,
): Promise<SessionScreenOutcome<TAttachment>> {
  if (hasQueryParameters(input.request)) return refuse("INPUT_INVALID");

  const credential = readBearer(input.request);
  if (credential === null) return refuse("AUTHENTICATION_FAILED");

  const verdict = await input.port.validateBearer(credential);
  if (!verdict.ok) {
    return refuse(isRefusalCode(verdict.code) ? verdict.code : "AUTHENTICATION_FAILED");
  }

  const sessionId = input.request.headers.get(MCP_SESSION_ID_HEADER);
  if (sessionId === null) {
    return { credential, entry: undefined, kind: "accepted", sessionId: null, verdict };
  }

  const entry = input.registry.get(sessionId);
  if (entry === undefined) return { kind: "unknown-session", sessionId };

  // The binding is compared against the DAEMON identity, never the credential. A rotated
  // credential therefore keeps its session, while a valid credential for a different session
  // cannot borrow this one.
  const bound = entry.verdict;
  if (bound.principalRef !== verdict.principalRef || bound.sessionRef !== verdict.sessionRef) {
    return refuse("SESSION_REPLAYED");
  }
  return { credential, entry, kind: "accepted", sessionId, verdict };
}

/**
 * Binds a freshly minted transport-level session id to the daemon session. The port is told
 * FIRST and the entry becomes routable only after it accepts, so a failed bind can never leave
 * a session this adapter would route to.
 */
export async function bindDaemonSession<TAttachment>(
  registry: HttpSessionRegistry<TAttachment>,
  port: HttpSessionPort,
  mcpSessionId: string,
  verdict: HttpAuthAccepted,
  attachment: TAttachment,
  boundAt?: number,
): Promise<void> {
  await port.bindSession(mcpSessionId, verdict);
  registry.bind(mcpSessionId, verdict, attachment, boundAt);
}

/**
 * Reaps a session. The entry is removed FIRST so the session stops being routable even if the
 * daemon notification fails.
 */
export async function closeDaemonSession<TAttachment>(
  registry: HttpSessionRegistry<TAttachment>,
  port: HttpSessionPort,
  mcpSessionId: string,
): Promise<void> {
  registry.delete(mcpSessionId);
  await port.closeSession(mcpSessionId);
}
