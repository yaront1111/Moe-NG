import type { FetchLike } from "@moe/control-room-client";
import { admitGoalBrief } from "@moe/contracts";
import type { GoalBrief } from "@moe/contracts";

/**
 * Reads the project-bound durable goal catalog from POST /goals/read.
 *
 * Project authority remains entirely at the daemon boundary: this client sends
 * an empty first request followed only by daemon-issued cursors, and carries the
 * authenticated headers supplied by the live handshake. It never accepts a
 * project id from UI state, puts one in the body, or rewrites a returned ref. The
 * daemon therefore chooses the catalog from the authenticated session's project
 * and the UI can only render that answer.
 */

const GOAL_CATALOG_READ_PATH = "/goals/read";
const LIVE_GOAL_CATALOG_UNREADABLE = "LIVE_GOAL_CATALOG_UNREADABLE";
const TRANSPORT_REQUEST_FAILED = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_GOAL_CATALOG_ROWS = 256;
const MAX_GOAL_CATALOG_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_GOAL_CATALOG_WIRE_BYTES = 2 * 1_024 * 1_024;
const CURSOR = /^(?:0|[1-9][0-9]{0,18})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface LiveGoalCatalogPrd {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: "text/markdown" | "text/plain";
  readonly sourceRef: string;
}

export interface LiveGoalCatalogEntry {
  readonly brief: GoalBrief | null;
  readonly goalId: string;
  readonly planningRunRef: string;
  readonly prd: LiveGoalCatalogPrd | null;
}

export interface GoalCatalogFrame {
  readonly connection: "CONNECTED" | "DISCONNECTED";
  readonly detail: string;
  readonly goals: readonly LiveGoalCatalogEntry[];
  readonly outcome: "GOALS" | "REFUSED" | "UNDELIVERED" | "UNREADABLE";
}

export interface ReadGoalCatalogOptions {
  /** A cursor issued as observedCursor/nextCursor by an earlier page. */
  readonly after?: string | undefined;
  /** The authenticated header set returned by the live handshake. */
  readonly headers: Readonly<Record<string, string>>;
  /** Injectable for focused tests; production uses the page's same-origin fetch. */
  readonly fetchImpl?: FetchLike | undefined;
  /** Requested row maximum; the daemon may return fewer to enforce its work budget. */
  readonly limit?: number | undefined;
  /** Applies only to the default/injected fetch call made by this reader. */
  readonly requestTimeoutMs?: number | undefined;
}

export interface GoalCatalogFeedOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly onFrame: (frame: GoalCatalogFrame, window: GoalCatalogWindow) => void;
  /** Injectable complete read for deterministic scheduling and stale-response tests. */
  readonly read?: (() => Promise<GoalCatalogFrame>) | undefined;
  /** Injectable cursor page reader for incremental-state tests. */
  readonly readPage?: ((after: string | null) => Promise<GoalCatalogPage>) | undefined;
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
}

export interface GoalCatalogFeed {
  /** Return to the bounded first page without retaining cursor history. */
  first(): void;
  /** Advance only when the current daemon page supplied a continuation cursor. */
  next(): void;
  /** Supersedes any in-flight generation and reads again immediately. */
  refresh(): void;
  start(): void;
  stop(): void;
}

export interface GoalCatalogWindow {
  /** One-based page reached by explicit operator navigation in this feed generation. */
  readonly currentPage: number;
  readonly hasEarlier: boolean;
  readonly hasMore: boolean;
}

function frame(
  connection: GoalCatalogFrame["connection"],
  outcome: GoalCatalogFrame["outcome"],
  detail: string,
  goals: readonly LiveGoalCatalogEntry[] = [],
): GoalCatalogFrame {
  return Object.freeze({
    connection,
    detail,
    goals: Object.freeze([...goals]),
    outcome,
  });
}

function unreadable(): GoalCatalogFrame {
  return frame("CONNECTED", "UNREADABLE", LIVE_GOAL_CATALOG_UNREADABLE);
}

/**
 * Returns an own-enumerable exact-key snapshot and rejects prototypes,
 * symbols, non-enumerable fields, and accessors. A decoded network object is
 * ordinarily plain; accepting anything richer would let unvouched behavior run
 * while the UI is deciding which project goal to open.
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Reads one own data property without invoking an accessor. */
function ownString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && nonEmptyString(descriptor.value)
      ? descriptor.value : null;
  } catch {
    return null;
  }
}

function refusalDetail(response: unknown): string | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && nonEmptyString(listener["code"])
    && nonEmptyString(listener["layer"])) return listener["code"];

  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route["outcome"] === "REFUSED"
    && nonEmptyString(route["code"]) && nonEmptyString(route["layer"])) return route["code"];

  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port["ok"] === false && port["outcome"] === "PORT_REFUSED"
    && nonEmptyString(port["stage"])) return ownString(port["refusal"], "code");

  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http !== null && http["ok"] === false && http["outcome"] === "REFUSED"
    && nonEmptyString(http["stage"])) return ownString(http["error"], "code");
  return null;
}

function entryOf(value: unknown): LiveGoalCatalogEntry | null {
  const record = exactDataRecord(value, ["brief", "goalId", "planningRunRef", "prd"]);
  if (record === null || !nonEmptyString(record["goalId"])
    || !nonEmptyString(record["planningRunRef"])) return null;
  let brief: GoalBrief | null = null;
  if (record["brief"] !== null) {
    const admitted = admitGoalBrief(record["brief"]);
    if (!admitted.ok) return null;
    const raw = exactDataRecord(record["brief"], ["instructions", "title"]);
    if (raw === null || raw["instructions"] !== admitted.brief.instructions
      || raw["title"] !== admitted.brief.title) return null;
    brief = admitted.brief;
  }
  let prd: LiveGoalCatalogPrd | null = null;
  if (record["prd"] !== null) {
    const raw = exactDataRecord(record["prd"], [
      "byteLength", "contentSha256", "displayPath", "mediaType", "sourceRef",
    ]);
    if (raw === null || !Number.isSafeInteger(raw["byteLength"])
      || (raw["byteLength"] as number) < 1
      || !nonEmptyString(raw["contentSha256"]) || !SHA256.test(raw["contentSha256"])
      || !nonEmptyString(raw["displayPath"]) || raw["displayPath"].length > 256
      || (raw["mediaType"] !== "text/markdown" && raw["mediaType"] !== "text/plain")
      || !nonEmptyString(raw["sourceRef"]) || raw["sourceRef"].length > 256) return null;
    prd = Object.freeze({
      byteLength: raw["byteLength"] as number,
      contentSha256: raw["contentSha256"],
      displayPath: raw["displayPath"],
      mediaType: raw["mediaType"],
      sourceRef: raw["sourceRef"],
    });
  }
  return Object.freeze({
    brief,
    goalId: record["goalId"],
    planningRunRef: record["planningRunRef"],
    prd,
  });
}

interface DecodedPage {
  readonly frame: GoalCatalogFrame;
  readonly nextCursor: string | null;
  readonly observedCursor: string | null;
}

export type GoalCatalogPage = DecodedPage;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

function entryBytes(entry: LiveGoalCatalogEntry): number {
  return ENCODER.encode(JSON.stringify(entry)).byteLength;
}

type BoundedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

function declaredBodyLength(response: Response): number | null | "INVALID" {
  try {
    const value = response.headers?.get("content-length") ?? null;
    if (value === null) return null;
    if (!/^[0-9]+$/u.test(value)) return "INVALID";
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : "INVALID";
  } catch {
    return "INVALID";
  }
}

/**
 * Reads decompressed response bytes through a hard cap before parsing JSON.
 * Content-Length is only an early refusal: it may be absent or dishonest, so
 * every streamed chunk is still counted and the reader is cancelled at the cap.
 */
async function readBoundedJson(response: Response): Promise<BoundedJson> {
  const declared = declaredBodyLength(response);
  if (declared === "INVALID" || (declared !== null && declared > MAX_GOAL_CATALOG_WIRE_BYTES)) {
    try { await response.body?.cancel(); } catch { /* refusal is already final */ }
    return { ok: false };
  }
  const body = response.body;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    return { ok: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      // Response and test streams may live in a different JS realm, where
      // `instanceof Uint8Array` is false for otherwise valid byte chunks.
      if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1) return { ok: false };
      total += value.byteLength;
      if (total > MAX_GOAL_CATALOG_WIRE_BYTES) {
        try { await reader.cancel(); } catch { /* refusal is already final */ }
        return { ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(DECODER.decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  } finally {
    try { reader.releaseLock(); } catch { /* reader may already be cancelled */ }
  }
}

/** Pure exact decoder for one bounded wire page. */
function decodeGoalCatalogPage(status: number, response: unknown): DecodedPage {
  // Refusals can be HTTP 200 (route) or non-200 (listener/auth). Recognise
  // their exact envelopes before the status gate so their stable code survives.
  const refused = refusalDetail(response);
  if (refused !== null) {
    return {
      frame: frame("CONNECTED", "REFUSED", refused), nextCursor: null, observedCursor: null,
    };
  }
  if (status !== 200) return { frame: unreadable(), nextCursor: null, observedCursor: null };

  const catalog = exactDataRecord(response, ["goals", "nextCursor", "observedCursor", "outcome"]);
  if (catalog === null || catalog["outcome"] !== "GOALS"
    || !Array.isArray(catalog["goals"])
    || catalog["goals"].length > MAX_GOAL_CATALOG_ROWS
    || typeof catalog["observedCursor"] !== "string"
    || !CURSOR.test(catalog["observedCursor"])
    || (catalog["nextCursor"] !== null
      && (typeof catalog["nextCursor"] !== "string"
        || !CURSOR.test(catalog["nextCursor"])
        || catalog["nextCursor"] !== catalog["observedCursor"]))) {
    return { frame: unreadable(), nextCursor: null, observedCursor: null };
  }

  const goals: LiveGoalCatalogEntry[] = [];
  const goalIds = new Set<string>();
  let decodedBytes = 0;
  for (const raw of catalog["goals"]) {
    const entry = entryOf(raw);
    if (entry === null || goalIds.has(entry.goalId)) {
      return { frame: unreadable(), nextCursor: null, observedCursor: null };
    }
    decodedBytes += entryBytes(entry);
    if (decodedBytes > MAX_GOAL_CATALOG_RESPONSE_BYTES) {
      return { frame: unreadable(), nextCursor: null, observedCursor: null };
    }
    goalIds.add(entry.goalId);
    goals.push(entry);
  }
  return {
    frame: frame("CONNECTED", "GOALS", "", goals),
    nextCursor: catalog["nextCursor"] as string | null,
    observedCursor: catalog["observedCursor"],
  };
}

/** Pure exact decoder for one catalog page, exposed for hostile-shape tests. */
export function mapGoalCatalogAnswer(status: number, response: unknown): GoalCatalogFrame {
  return decodeGoalCatalogPage(status, response).frame;
}

/** Reads exactly one bounded cursor page; it never walks or retains a catalog. */
export async function readGoalCatalogPage(
  options: ReadGoalCatalogOptions,
): Promise<GoalCatalogPage> {
  const send = options.fetchImpl ?? globalThis.fetch;
  const after = options.after ?? null;
  if ((after !== null && !CURSOR.test(after))
    || (options.limit !== undefined
      && (!Number.isSafeInteger(options.limit)
        || options.limit < 1 || options.limit > MAX_GOAL_CATALOG_ROWS))) {
    return { frame: unreadable(), nextCursor: null, observedCursor: null };
  }
  const request: Record<string, number | string> = {};
  if (after !== null) request["after"] = after;
  if (options.limit !== undefined) request["limit"] = options.limit;
  let response: Response;
  try {
    response = await send(GOAL_CATALOG_READ_PATH, {
      body: JSON.stringify(request),
      headers: options.headers,
      method: "POST",
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      frame: frame("DISCONNECTED", "UNDELIVERED", TRANSPORT_REQUEST_FAILED),
      nextCursor: null,
      observedCursor: null,
    };
  }
  const body = await readBoundedJson(response);
  if (!body.ok) {
    return { frame: unreadable(), nextCursor: null, observedCursor: null };
  }
  const decoded = decodeGoalCatalogPage(response.status, body.value);
  if (decoded.frame.outcome !== "GOALS" || decoded.observedCursor === null) return decoded;
  const requested = BigInt(after ?? "0");
  const observed = BigInt(decoded.observedCursor);
  if (observed < requested
    || (decoded.frame.goals.length === 0 && observed !== requested)
    || (decoded.frame.goals.length > 0 && observed <= requested)
    || (decoded.nextCursor !== null && decoded.frame.goals.length === 0)) {
    return { frame: unreadable(), nextCursor: null, observedCursor: null };
  }
  return decoded;
}

/** Compatibility projection for callers that only need the current page. */
export async function readGoalCatalog(
  options: ReadGoalCatalogOptions,
): Promise<GoalCatalogFrame> {
  return (await readGoalCatalogPage(options)).frame;
}

/**
 * Kept polling loop for one authenticated project. A generation guards every
 * completion: switching projects, refreshing after goal.create, or unmounting
 * makes any older response inert, even though fetch itself may already be in
 * flight and cannot be synchronously cancelled.
 */
export function createGoalCatalogFeed(options: GoalCatalogFeedOptions): GoalCatalogFeed {
  const schedule = options.schedule
    ?? ((run: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(run, delayMs);
      return () => { clearTimeout(timer); };
    });
  let cancel: (() => void) | null = null;
  let generation = 0;
  let running = false;
  let after: string | null = null;
  let currentPage = 1;
  let nextCursor: string | null = null;

  const reset = (): void => {
    after = null;
    currentPage = 1;
    nextCursor = null;
  };

  const window = (hasMore: boolean): GoalCatalogWindow => Object.freeze({
    currentPage,
    hasEarlier: after !== null,
    hasMore,
  });

  const poll = async (run: number): Promise<void> => {
    if (options.read !== undefined && options.readPage === undefined) {
      const next = await options.read();
      if (!running || run !== generation) return;
      options.onFrame(next, window(false));
      cancel = schedule(() => { void poll(run); }, options.intervalMs);
      return;
    }
    const page = await (options.readPage?.(after)
      ?? readGoalCatalogPage({
        ...(after === null ? {} : { after }),
        headers: options.headers,
      }));
    if (!running || run !== generation) return;
    if (page.frame.outcome !== "GOALS" || page.observedCursor === null) {
      nextCursor = null;
      options.onFrame(page.frame, window(false));
      cancel = schedule(() => { void poll(run); }, options.intervalMs);
      return;
    }
    nextCursor = page.nextCursor;
    options.onFrame(page.frame, window(nextCursor !== null));
    if (run === generation) {
      cancel = schedule(() => { void poll(run); }, options.intervalMs);
    }
  };

  const restart = (): void => {
    generation += 1;
    cancel?.();
    cancel = null;
    nextCursor = null;
    void poll(generation);
  };

  return Object.freeze({
    first: (): void => {
      if (!running || after === null) return;
      reset();
      restart();
    },
    next: (): void => {
      if (!running || nextCursor === null) return;
      after = nextCursor;
      currentPage = Math.min(currentPage + 1, Number.MAX_SAFE_INTEGER);
      restart();
    },
    refresh: (): void => { if (running) restart(); },
    start: (): void => {
      if (running) return;
      running = true;
      reset();
      restart();
    },
    stop: (): void => {
      running = false;
      generation += 1;
      cancel?.();
      cancel = null;
      reset();
    },
  });
}
