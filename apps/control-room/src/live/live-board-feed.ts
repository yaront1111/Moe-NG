/**
 * Polls the daemon's affordance surface and shapes what it says — verbatim.
 *
 * Discipline copied from live-event-feed.ts, with delivery and health kept
 * apart: an undelivered round trip is DISCONNECTED with the local code; a
 * DELIVERED answer the board cannot act on (the daemon's own REFUSED, or a body
 * this reader cannot vouch for) is LAGGING carrying the daemon's own fields;
 * only a valid SURFACE is CONNECTED. Steps and offered commands are copied
 * field-for-field so a dispatch later presents the daemon's own identity back
 * to it untouched.
 */

/**
 * An active durable claim on a step, copied verbatim off the wire. The board
 * renders it as the fact it is: an agent (or another operator) is holding this
 * work right now, and a dispatch would race that holder.
 */
export interface SurfaceStepClaim {
  readonly claimedBy: string;
  readonly expiresAt: string;
}

export interface SurfaceStep {
  readonly aggregateId: string | null;
  readonly claim: SurfaceStepClaim | null;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly status: "BLOCKED" | "COMMITTED" | "READY";
  readonly version: number | null;
}

export interface SurfaceFrame {
  /**
   * CONNECTED is a valid SURFACE and nothing else. LAGGING is a DELIVERED
   * answer the board cannot render as current — the daemon refused, or the body
   * is unreadable — which is neither a stale "still fine" nor a network fault.
   * DISCONNECTED is reserved for a round trip that never delivered.
   */
  readonly connection: "CONNECTED" | "DISCONNECTED" | "LAGGING";
  readonly detail: string;
  /** The daemon's NextAllowedCommand objects, untouched. */
  readonly offers: readonly Record<string, unknown>[];
  readonly outcome: string;
  /** Daemon-derived durable goal binding for the default planning run. */
  readonly planningGoalRef?: string | null;
  readonly steps: readonly SurfaceStep[];
}

export interface BoardFeedOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly onFrame: (frame: SurfaceFrame) => void;
  /**
   * Sends one poll. The `signal` is NOT optional and NOT advisory: the poll owns
   * the deadline, so an injected transport is bound by exactly the same bound as
   * the default one, and an unmount can cut the request it is holding.
   */
  readonly post?: ((body: string, signal: AbortSignal) => Promise<Response>) | undefined;
  /**
   * Upper bound in milliseconds on one poll's round trip (default 15_000),
   * covering the request AND the body read. Without it a daemon that accepts
   * the connection and never answers parks the loop forever: no rejection, so
   * no frame and no reschedule, and the board freezes on its last CONNECTED
   * frame. The deadline turns that hang into the rejection this loop already
   * maps to DISCONNECTED / TRANSPORT_REQUEST_FAILED, and the loop re-arms.
   */
  readonly requestTimeoutMs?: number | undefined;
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
}

export interface BoardFeed {
  start(): void;
  stop(): void;
}

const UNREADABLE_DETAIL = "LIVE_SURFACE_UNREADABLE";
const DEFAULT_TIMEOUT_MS = 15_000;
/** setTimeout's 32-bit ceiling: past it a delay silently clamps to ~1ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A daemon code or layer this surface will repeat: bounded, and a token only. */
const SAFE_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

/**
 * A claim must NAME its holder and its expiry to be rendered as one; anything
 * else — absent, null, or a shape this reader cannot vouch for — carries as
 * null rather than as a half-claim, and never fails the whole frame: a board
 * that goes UNREADABLE because one claim field drifted would hide the chain
 * behind the least important thing on it.
 */
function claimOf(value: unknown): SurfaceStepClaim | null {
  if (!isRecord(value)) return null;
  const claimedBy = text(value["claimedBy"]);
  const expiresAt = text(value["expiresAt"]);
  if (claimedBy === "" || expiresAt === "") return null;
  return Object.freeze({ claimedBy, expiresAt });
}

function stepOf(value: unknown): SurfaceStep | null {
  if (!isRecord(value)) return null;
  const status = value["status"];
  if (status !== "BLOCKED" && status !== "COMMITTED" && status !== "READY") return null;
  const kind = text(value["kind"]);
  if (kind === "") return null;
  const aggregateId = value["aggregateId"];
  if (aggregateId !== null && typeof aggregateId !== "string") return null;
  const missing = value["missing"];
  if (!Array.isArray(missing) || !missing.every((entry) => typeof entry === "string")) return null;
  const version = value["version"];
  if (version !== null
    && (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)) return null;
  return Object.freeze({
    aggregateId,
    claim: claimOf(value["claim"]),
    kind,
    missing: Object.freeze([...missing]) as readonly string[],
    status,
    version,
  });
}

function offerOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (text(value["commandId"]) === "" || text(value["commandKind"]) === ""
    || text(value["targetAggregateId"]) === "") return null;
  const expectedVersion = value["expectedVersion"];
  if (typeof expectedVersion !== "number"
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  return Object.freeze({ ...value });
}

function frame(
  connection: SurfaceFrame["connection"],
  outcome: string,
  detail: string,
  steps: readonly SurfaceStep[] = [],
  offers: readonly Record<string, unknown>[] = [],
  planningGoalRef: string | null = null,
): SurfaceFrame {
  return Object.freeze({
    connection, detail, offers: Object.freeze([...offers]), outcome, planningGoalRef,
    steps: Object.freeze([...steps]),
  });
}

/** A delivered answer this reader cannot vouch for: readable transport, not a fault. */
function unreadable(): SurfaceFrame {
  return frame("LAGGING", "UNREADABLE", UNREADABLE_DETAIL);
}

/**
 * Deterministic, non-secret refusal detail: the daemon's own code, plus the
 * refusing layer when it names one so a later reader cannot restamp ownership.
 * Anything outside the conservative token shape — free text, a credential, an
 * unbounded body — is dropped whole rather than echoed onto an operator surface.
 */
function refusalDetail(response: Readonly<Record<string, unknown>>): string {
  const code = safeToken(response["code"]);
  if (code === null) return UNREADABLE_DETAIL;
  const layer = safeToken(response["layer"]);
  return layer === null ? code : `${code} @ ${layer}`;
}

export function frameOfSurface(response: unknown): SurfaceFrame {
  if (!isRecord(response)) return unreadable();
  const outcome = text(response["outcome"]);
  if (outcome === "REFUSED") return frame("LAGGING", outcome, refusalDetail(response));
  if (outcome !== "SURFACE") return unreadable();
  const rawSteps = response["steps"];
  const rawOffers = response["nextAllowedCommands"];
  const rawPlanningGoalRef = response["planningGoalRef"];
  if (!Array.isArray(rawSteps) || !Array.isArray(rawOffers)) return unreadable();
  if (rawPlanningGoalRef !== undefined && rawPlanningGoalRef !== null
    && (typeof rawPlanningGoalRef !== "string" || rawPlanningGoalRef === "")) return unreadable();
  const steps: SurfaceStep[] = [];
  for (const rawStep of rawSteps) {
    const step = stepOf(rawStep);
    if (step === null) return unreadable();
    steps.push(step);
  }
  const offers: Record<string, unknown>[] = [];
  for (const rawOffer of rawOffers) {
    const offer = offerOf(rawOffer);
    if (offer === null) return unreadable();
    offers.push(offer);
  }
  return frame(
    "CONNECTED", outcome, "", steps, offers,
    typeof rawPlanningGoalRef === "string" ? rawPlanningGoalRef : null,
  );
}

/** A bad deadline must not become a zero-delay busy loop or a clamped ~1ms one. */
function deadlineOf(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    && requested > 0 && requested <= MAX_TIMEOUT_MS
    ? requested
    : DEFAULT_TIMEOUT_MS;
}

/** Rejects when the poll's deadline fires or its owner stops. Never resolves. */
function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason as Error); return; }
    signal.addEventListener("abort", () => { reject(signal.reason as Error); }, { once: true });
  });
}

export function createBoardFeed(options: BoardFeedOptions): BoardFeed {
  const post = options.post
    ?? ((body: string, signal: AbortSignal): Promise<Response> => fetch("/affordances/read", {
      body, headers: options.headers, method: "POST", signal,
    }));
  const schedule = options.schedule
    ?? ((run: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(run, delayMs);
      return () => { clearTimeout(timer); };
    });
  const deadlineMs = deadlineOf(options.requestTimeoutMs);
  let cancel: (() => void) | null = null;
  // Generation guard (same discipline as createLiveDocumentDossierFeed): a
  // restart resets `running`, so the boolean alone would let an orphaned poll
  // revive as a second permanent loop. `active` is the request that generation
  // owns, so stop() can cut it instead of merely disowning it.
  let active: AbortController | null = null;
  let generation = 0;
  let running = false;

  // Delivery and readability are different failures: once the daemon has
  // answered, a body that fails to parse is an UNREADABLE answer over a working
  // transport, not a disconnection.
  const answer = async (signal: AbortSignal): Promise<SurfaceFrame> => {
    const response = await post("{}", signal);
    try {
      return frameOfSurface(await response.json());
    } catch {
      return unreadable();
    }
  };

  const poll = async (run: number): Promise<void> => {
    const controller = new AbortController();
    active = controller;
    const timer = setTimeout(() => { controller.abort(); }, deadlineMs);
    let next: SurfaceFrame;
    try {
      // Race the WHOLE operation — round trip AND body read. A response whose
      // headers arrive and whose body never ends is as wedged as a request that
      // never delivers, and a late settlement of either loses to the abort.
      next = await Promise.race([answer(controller.signal), abortedBy(controller.signal)]);
    } catch {
      next = frame("DISCONNECTED", "UNDELIVERED", "TRANSPORT_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
      if (active === controller) active = null;
    }
    // A stop between the abort and here means this frame is a teardown artifact,
    // not a transport verdict: it must not render and must not re-arm.
    if (!running || run !== generation) return;
    options.onFrame(next);
    cancel = schedule(() => { void poll(run); }, options.intervalMs);
  };

  return Object.freeze({
    start: (): void => {
      if (running) return;
      running = true;
      generation += 1;
      void poll(generation);
    },
    stop: (): void => {
      running = false;
      generation += 1;
      cancel?.();
      cancel = null;
      const inflight = active;
      active = null;
      inflight?.abort();
    },
  });
}
